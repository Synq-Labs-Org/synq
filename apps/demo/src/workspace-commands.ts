import type { WorkspaceTeam } from '@synq/workspaces/team';
import { createHash } from 'node:crypto';
import { redact } from '@synq/plugin-risk';
import { formatUnits } from 'viem';
import { arcCardBase, ContractorPaymentCardSchema } from '@synq/schemas';
import { renderTelegramCard } from '@synq/channels/cards';
import type { ChannelPorts, DirectReply } from '@synq/channels';
import { WorkspaceError, type WorkspaceChannelLinks } from '@synq/workspaces';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';
import type { WorkspaceInvoices } from '@synq/workspaces/invoices';
import type { WorkspaceBooks } from '@synq/workspaces/books';
import type { WorkspaceDeals } from '@synq/workspaces/deals';
import type { WorkspaceRevenue } from '@synq/workspaces/revenue';
import type { WorkspaceTreasury } from '@synq/execution-worker/workspace-treasury';
import { parseWorkspaceInvoice } from '@synq/workspaces/invoice-command';

const safeText = (text: string) => {
  const clean = redact(text).value;
  return typeof clean === 'string' ? clean : '[REDACTED]';
};
export { parseWorkspacePay } from '@synq/workspaces/payout-command';
import { parseWorkspacePay } from '@synq/workspaces/payout-command';
const commandKey = (scope: string) => {
  const h = createHash('sha256').update(scope).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
/** Verified channel identity proposes only; signatures and all execution authority remain outside chat. */
export function workspaceCommandPort(input: {
  links: WorkspaceChannelLinks;
  finance?: WorkspaceFinance;
  payouts?: WorkspacePayouts;
  team?: WorkspaceTeam;
  invoices?: () => WorkspaceInvoices | undefined;
  books?: WorkspaceBooks;
  deals?: () => WorkspaceDeals | undefined;
  revenue?: WorkspaceRevenue;
  treasury?: WorkspaceTreasury;
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
          route:
            p.data.route === 'SAFE_QUORUM'
              ? 'SAFE_QUORUM_TRANSFER'
              : 'VAULT_POLICY_PAY',
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
      const draft = parseWorkspaceInvoice(text);
      const invoices = input.invoices?.();
      if (draft) {
        if (!invoices)
          return review('Invoices are not connected on this server yet.');
        const day = new Date(store.now() * 1000)
          .toISOString()
          .slice(0, 10)
          .replaceAll('-', '');
        const inv = await invoices.create(ws, sender.principalId, {
          number: `TG-${day}-${commandKey(`${ws}:${q.chatId}:${q.eventId}`).slice(0, 6).toUpperCase()}`,
          payerName: draft.payerName,
          dueDate: draft.dueDate,
          lineItems: [
            {
              description: draft.description,
              quantity: 1,
              unitPrice: draft.amount,
            },
          ],
        });
        url.searchParams.set('invoice', inv.invoiceId);
        return review(
          `Draft invoice ${safeText(inv.number)} for ${formatUnits(BigInt(draft.amount), 6)} USDC to ${safeText(draft.payerName)}, due ${draft.dueDate}. Nothing is sent until an owner issues it with a wallet signature on the secure page.`,
        );
      }
      if (/^\/?invoices(?:@[a-z0-9_]+)?$/i.test(text) && invoices) {
        const rows = await invoices.list(ws, sender.principalId);
        return review(
          rows.length
            ? rows
                .slice(0, 8)
                .map(
                  (i) =>
                    `${safeText(i.number)} · ${safeText(i.payer.name)} · ${formatUnits(BigInt(i.total), 6)} USDC · ${i.status}${i.reconciliation === 'FINALIZED' ? ' · settled on chain' : ''}`,
                )
                .join('\n')
            : 'No invoices yet. Draft one: invoice <payer> <amount> USDC due <YYYY-MM-DD> for <work>.',
        );
      }
      if (/^\/?bills(?:@[a-z0-9_]+)?$/i.test(text) && input.books) {
        const b = await input.books.view(ws, sender.principalId);
        const open = b.payables.filter((p) => p.status === 'OPEN');
        return review(
          [
            open.length
              ? `Open vendor bills:\n${open
                  .slice(0, 8)
                  .map(
                    (p) =>
                      `${safeText(p.number)} · ${formatUnits(BigInt(p.amount), 6)} USDC · due ${p.dueOn}`,
                  )
                  .join('\n')}`
              : 'No open vendor bills recorded.',
            b.bills.length
              ? `Recurring:\n${b.bills
                  .map(
                    (r) =>
                      `${safeText(r.label)} · ${formatUnits(BigInt(r.amount), 6)} USDC every ${r.cadenceDays} days`,
                  )
                  .join('\n')}`
              : 'No recurring bills recorded.',
            'Bills count only after the owner quorum signs them on the secure page.',
          ].join('\n\n'),
        );
      }
      const deals = input.deals?.();
      if (/^\/?deals(?:@[a-z0-9_]+)?$/i.test(text) && deals) {
        const rows = await deals.list(ws, sender.principalId);
        return review(
          rows.length
            ? rows
                .slice(0, 8)
                .map(
                  (d) =>
                    `${safeText(d.title)} · ${formatUnits(BigInt(d.total), 6)} USDC · ${d.status}${d.escrow ? ` · escrow ${d.escrow.escrowDealId}` : ''}`,
                )
                .join('\n')
            : 'No deals involving your wallet. Each party signs and moves escrow from their own wallet on the secure page.',
        );
      }
      if (/^\/?splits(?:@[a-z0-9_]+)?$/i.test(text) && input.revenue) {
        const rows = await input.revenue.allocations(ws, sender.principalId);
        return review(
          rows.length
            ? rows
                .slice(0, 5)
                .map(
                  (a) =>
                    `${formatUnits(BigInt(a.received), 6)} USDC received · ${a.state} · ${
                      a.legs
                        .filter((l) => l.kind === 'TRANSFER')
                        .map(
                          (l) =>
                            `${l.purpose.toLowerCase().replaceAll('_', ' ')} ${formatUnits(BigInt(l.amount), 6)}`,
                        )
                        .join(', ') || 'no transfers'
                    }`,
                )
                .join('\n')
            : 'No automatic splits yet. They run when an invoice payment settles under the signed revenue policy.',
        );
      }
      if (/^\/?swaps?(?:@[a-z0-9_]+)?$/i.test(text) && input.treasury) {
        const ops = await input.treasury.list(ws, sender.principalId);
        return review(
          ops.length
            ? ops
                .slice(0, 5)
                .map(
                  (o) =>
                    `${formatUnits(BigInt(o.data.amountIn), 6)} ${o.data.from} → ${o.data.to} · ${o.state}${o.evidence?.received ? ` · received ${formatUnits(BigInt(String(o.evidence.received)), 6)}` : ''}`,
                )
                .join('\n')
            : 'No treasury swaps yet. Owners propose and sign them on the secure page.',
        );
      }
      const ask = /^\/?(?:team|ask)(?:@[a-z0-9_]+)?\s+(.+)$/is.exec(text);
      if (ask && input.team) {
        const reply = await input.team.ask(ws, sender.principalId, {
          message: ask[1],
          idempotencyKey: commandKey(
            `${ws}:${q.channel}:${q.chatId}:${q.eventId}`,
          ),
        });
        if ('payoutId' in reply && reply.payoutId)
          url.searchParams.set('payout', reply.payoutId);
        return review(safeText(reply.answer));
      }
      if (/^\/?treasury(?:@[a-z0-9_]+)?$/i.test(text) && input.balance) {
        const balance = await input.balance(ws);
        return review(
          `Workspace vault: ${formatUnits(BigInt(balance.amount), 6)} USDC on Arc testnet, observed at block ${balance.blockNumber}. Treasury actions require a separate owner signature.`,
        );
      }
      return review(
        'Workspace commands: /vendors, /pay status, /bills, /invoices, /deals, /splits, /swaps, /treasury, /team <question>. Propose a payout: pay <vendor name> <amount> USDC for <purpose> ref <invoice reference>. Draft an invoice: invoice <payer> <amount> USDC due <YYYY-MM-DD> for <work>. Only verified vendors are accepted. Chat never approves or signs.',
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
