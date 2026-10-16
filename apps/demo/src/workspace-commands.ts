import { createHash } from 'node:crypto';
import { redact } from '@synq/plugin-risk';
import { formatUnits, parseUnits } from 'viem';
import { arcCardBase, ContractorPaymentCardSchema } from '@synq/schemas';
import { renderTelegramCard } from '@synq/channels/cards';
import type { ChannelPorts, DirectReply } from '@synq/channels';
import { WorkspaceError, type WorkspaceChannelLinks } from '@synq/workspaces';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';

const safeText = (text: string) => {
  const clean = redact(text).value;
  return typeof clean === 'string' ? clean : '[REDACTED]';
};
export type WorkspacePayCommand = {
  vendor: string;
  amount: string;
  purpose: string;
  obligation: string;
};
export function parseWorkspacePay(text: string): WorkspacePayCommand | null {
  const m =
    /^(?:\/pay(?:@[a-z0-9_]+)?|pay(?:\s+(?:a\s+)?contractor)?)\s+(.+?)\s+((?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?)\s+usdc\s+for\s+(.+?)\s+(?:ref|#)\s*:?\s*(.+)$/i.exec(
      text.trim(),
    );
  if (!m) return null;
  return {
    vendor: m[1]!.trim(),
    amount: String(parseUnits(m[2]!, 6)),
    purpose: m[3]!.trim(),
    obligation: m[4]!.trim(),
  };
}
const commandKey = (scope: string) => {
  const h = createHash('sha256').update(scope).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Verified channel identity proposes only; signatures and all execution authority remain outside chat. */
export function workspaceCommandPort(input: {
  links: WorkspaceChannelLinks;
  finance?: WorkspaceFinance;
  payouts?: WorkspacePayouts;
  origin: string;
  mode: 'LIVE_ARC_TESTNET' | 'LOCAL_FIXTURE';
  balance?: (
    workspaceId: string,
  ) => Promise<{ amount: string; blockNumber: string }>;
}): NonNullable<ChannelPorts['workspaceMessage']> {
  return async (q) => {
    if (q.channel !== 'telegram') return null;
    const digest = createHash('sha256')
      .update(`telegram:${q.chatKind}:${q.chatId}`)
      .digest('hex');
    const bound = await input.links.workspaces.pool.query(
      "SELECT workspace_id FROM synq_ws_channel_bindings WHERE channel='telegram' AND channel_digest=$1",
      [digest],
    );
    if (!bound.rows[0]) return null;
    const ws = String(bound.rows[0].workspace_id),
      url = new URL('/workspaces', input.origin);
    url.searchParams.set('workspace', ws);
    const review = (text: string): DirectReply => ({
      text,
      buttons: [{ label: 'Open workspace', url: url.toString() }],
    });
    const sender = await input.links.resolve(q.chatId, q.chatKind, q.userId);
    if (!sender)
      return review(
        'Link your own wallet to this workspace on the secure Synq page. A username, phone number or chat reply never approves money.',
      );
    const store = input.links.workspaces;
    await store.throttle(`workspace-chat-principal:${sender.principalId}`, 30);
    await store.throttle(`workspace-chat:${ws}`, 60);
    const text = q.text.trim();
    if (/^(?:yes|ok|approve|confirm|\/approve)\b/i.test(text))
      return review(
        'Chat never approves money. Review the exact request on the secure page and sign with the required Safe owners.',
      );
    try {
      const pay = parseWorkspacePay(text);
      if (pay) {
        if (!input.finance || !input.payouts)
          return review(
            'Payout proposals are not connected on this server yet.',
          );
        const finance = await input.finance.list(ws, sender.principalId);
        const matches = finance.vendors.filter(
          (v) =>
            v.id === pay.vendor ||
            v.name.toLocaleLowerCase() === pay.vendor.toLocaleLowerCase(),
        );
        if (matches.length !== 1)
          return review(
            'Choose one verified vendor from workspace settings. The vendor name is missing or ambiguous.',
          );
        const p = await input.payouts.propose(ws, sender.principalId, {
          vendorId: matches[0]!.id,
          amount: pay.amount,
          purpose: pay.purpose,
          obligation: pay.obligation,
          idempotencyKey: commandKey(
            `${ws}:${q.channel}:${q.chatId}:${q.eventId}`,
          ),
        });
        url.searchParams.set('payout', p.data.id);
        const workspace = await store.get(ws, sender.principalId);
        const card = ContractorPaymentCardSchema.parse({
          ...arcCardBase(
            {
              groupId: ws,
              groupLabel: workspace.workspace.displayName,
              issuedAt: p.data.createdAt,
              executionMode: input.mode,
              actions: [
                {
                  kind: 'VIEW',
                  label: 'Review payout',
                  url: url.toString(),
                  style: 'PRIMARY',
                },
              ],
            },
            p.data.createdAt,
            'payout-proposal',
            p.data.id,
          ),
          type: 'CONTRACTOR_PAYMENT',
          chainId: 5042002,
          paymentId: p.data.id,
          recipient: {
            label: safeText(matches[0]!.name),
            address: p.data.recipient,
            verified: true,
          },
          amount: {
            amount: formatUnits(BigInt(p.data.amount), 6),
            symbol: 'USDC',
          },
          route: 'VAULT_POLICY_PAY',
          obligationRef: null,
          approvals: {
            counted: p.signedBy.length,
            required: workspace.workspace.threshold ?? 0,
          },
          status: (
            {
              REVIEW: 'AWAITING_APPROVAL',
              READY: 'APPROVED',
              HOLD: 'DENIED',
              SIGNED: 'SUBMITTED',
              PAID: 'CONFIRMED',
              FAILED: 'FAILED',
              NEEDS_REVIEW: 'DENIED',
              CANCELLED: 'DENIED',
            } as const
          )[p.state],
          transactionHash: p.txHash,
          evidenceHash: p.data.vendorChangeHash,
        });
        return renderTelegramCard(card);
      }
      if (/^\/?pay(?:@[a-z0-9_]+)?\s+status$/i.test(text) && input.payouts) {
        const rows = await input.payouts.list(ws, sender.principalId);
        return review(
          rows.length
            ? rows
                .slice(0, 5)
                .map(
                  (p) =>
                    `${formatUnits(BigInt(p.data.amount), 6)} USDC · ${safeText(p.data.purpose)} · ${p.state}`,
                )
                .join('\n')
            : 'No payout requests in this workspace.',
        );
      }
      if (/^\/?vendors?$/i.test(text) && input.finance) {
        const f = await input.finance.list(ws, sender.principalId);
        return review(
          f.vendors.length
            ? f.vendors
                .map(
                  (v) =>
                    `${safeText(v.name)} · ${v.status} · ${v.address.slice(0, 6)}…${v.address.slice(-4)}`,
                )
                .join('\n')
            : 'No verified vendors yet. Add one with the owner quorum on the secure page.',
        );
      }
      if (/^\/?treasury(?:@[a-z0-9_]+)?$/i.test(text) && input.balance) {
        const balance = await input.balance(ws);
        return review(
          `Workspace vault: ${formatUnits(BigInt(balance.amount), 6)} USDC on Arc testnet, observed at block ${balance.blockNumber}. Treasury actions require a separate owner signature.`,
        );
      }
      return review(
        'Workspace commands: /vendors, /pay status, /treasury. To propose a payout: pay <vendor name> <amount> USDC for <purpose> ref <invoice reference>. Only verified vendors are accepted. Chat never approves or signs.',
      );
    } catch (error) {
      return review(
        error instanceof WorkspaceError
          ? `Request refused: ${error.code.replaceAll('_', ' ').toLowerCase()}. No payment was approved by chat.`
          : 'The workspace request is unavailable. Open the secure page to check its status; do not assume a payment failed or retry with another invoice reference.',
      );
    }
  };
}
