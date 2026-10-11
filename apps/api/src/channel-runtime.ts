import { formatDecimal } from '@synq/domain';
import { sendDirectory, type SendRecord } from '@synq/funding';
import type {
  ApprovalSummary,
  BrainReply,
  ChannelGateway,
  ChannelPorts,
  ReceiptSummary,
} from '@synq/channels';
import type { SendRouteDeps } from './send-routes.js';

export const MONAD_TESTNET_EXPLORER_TX =
  'https://testnet.monadexplorer.com/tx/';

type DraftRow = {
  draftDigest: string;
  intentHash: string;
  status: string;
};
export type ChannelApprovalSource = {
  drafts(groupId: string): Promise<DraftRow[]>;
  quorum(draftDigest: string): Promise<{
    required: number;
    counted: readonly unknown[];
    satisfied: boolean;
    draftStatus: 'PENDING' | 'INVALIDATED';
  }>;
};
export type ChannelExecutionSource = {
  executed(
    groupId: string,
  ): Promise<{ intentHash: string; transactionHash: string }[]>;
};

const sendLabel = (s: SendRecord) =>
  `Send ${s.preview.amountDecimal} ${s.preview.asset.symbol} to ${s.preview.recipient.label}`;

/**
 * Read-only views over the existing Send, identity and read-model runtime.
 * Approval counts come only from the identity ledger's verified approvals.
 */
export function productionChannelPorts(input: {
  send: Pick<SendRouteDeps, 'groups' | 'treasury'>;
  sends: { list(groupId: string): Promise<SendRecord[]> };
  approvals: ChannelApprovalSource;
  executed?: ChannelExecutionSource;
  executionMode: 'REAL_TESTNET' | 'SIMULATION';
  brain?: ChannelPorts['brain'];
}): ChannelPorts {
  const { send } = input;
  return {
    activeMember: async (groupId, principalId) => {
      const c = await send.groups.context(groupId);
      const m = c?.members.find((x) => x.principalId === principalId);
      return m ? { memberId: m.memberId } : null;
    },
    treasury: async (groupId) => {
      const v = await send.treasury.view(groupId);
      if (!v) return null;
      const d = v.coreAsset.decimals;
      const f = (x: string) => formatDecimal(BigInt(x), d);
      return {
        symbol: v.coreAsset.symbol,
        total: f(v.core.balance),
        free: f(v.core.free),
        reserved: f(v.core.reserved),
        pending: f(v.core.pendingDebits),
        account: v.account,
        chainId: v.chainId,
        asOf: `indexed block ${v.indexedThroughBlock}`,
      };
    },
    mandates: async (groupId) => {
      const c = await send.groups.context(groupId);
      if (!c) return [];
      const m = c.mandate;
      const d = m.inputAsset.decimals;
      return [
        {
          mandateId: m.mandateId,
          version: m.version,
          status: m.status,
          symbol: m.inputAsset.symbol,
          perActionCap: formatDecimal(BigInt(m.perActionCap), d),
          cumulativeBudget: formatDecimal(BigInt(m.cumulativeBudget), d),
          spent: 'see treasury',
        },
      ];
    },
    approvals: async (groupId) => {
      const [drafts, sends] = await Promise.all([
        input.approvals.drafts(groupId),
        input.sends.list(groupId),
      ]);
      const out: ApprovalSummary[] = [];
      for (const d of drafts
        .filter((x) => x.status === 'PENDING')
        .slice(0, 10)) {
        const q = await input.approvals.quorum(d.draftDigest).catch(() => null);
        if (!q) continue;
        const s = sends.find((x) => x.draftDigest === d.draftDigest);
        out.push({
          intentHash: d.intentHash,
          draftDigest: d.draftDigest,
          label: s ? sendLabel(s) : `intent ${d.intentHash.slice(0, 10)}`,
          counted: q.counted.length,
          required: q.required,
          status:
            q.draftStatus === 'INVALIDATED' || s?.state === 'REJECTED'
              ? 'INVALIDATED'
              : q.satisfied
                ? 'SATISFIED'
                : 'PENDING',
        });
      }
      return out;
    },
    receipts: async (groupId) => {
      const sends = await input.sends.list(groupId);
      const out: ReceiptSummary[] = sends
        .filter(
          (s) =>
            (s.state === 'CONFIRMED' || s.state === 'INDEXED') &&
            s.receipt &&
            s.intentHash,
        )
        .map((s) => ({
          intentHash: s.intentHash!,
          transactionHash: s.receipt!.transactionHash,
          state: s.state === 'INDEXED' ? 'RECONCILED' : 'CONFIRMED',
          label: sendLabel(s),
          executionMode: input.executionMode,
        }));
      for (const e of (await input.executed
        ?.executed(groupId)
        .catch(() => [])) ?? [])
        if (!out.some((r) => r.intentHash === e.intentHash))
          out.push({
            intentHash: e.intentHash,
            transactionHash: e.transactionHash,
            state: 'RECONCILED',
            label: `grant ${e.intentHash.slice(0, 10)}`,
            executionMode: input.executionMode,
          });
      return out;
    },
    sendRecipient: async (groupId, query) => {
      const c = await send.groups.context(groupId);
      if (!c) return null;
      const q = query.toLowerCase();
      const hit = sendDirectory(c).find(
        (r) =>
          r.sendable &&
          (r.recipientId.toLowerCase() === q ||
            r.label.toLowerCase() === q ||
            r.memberId?.toLowerCase() === q),
      );
      return hit ? { recipientId: hit.recipientId, label: hit.label } : null;
    },
    ...(input.brain ? { brain: input.brain } : {}),
  };
}

type BrainItem = {
  kind: string;
  status: string;
  decision: {
    kind: 'ACTION' | 'MANDATE';
    status: string;
    code: string | null;
    draftDigest: string | null;
  } | null;
};
/** Adapts a Brain run (whose proposals reach the Kernel only via KernelProposalGateway). */
export function brainChannelPort(input: {
  run(request: {
    runId: string;
    groupId: string;
    memberId: string;
    text: string;
  }): Promise<{
    status: string;
    items: readonly BrainItem[];
    findings: readonly { kind: string }[];
  }>;
  drafts(groupId: string): Promise<DraftRow[]>;
}): NonNullable<ChannelPorts['brain']> {
  return async (request): Promise<BrainReply> => {
    const result = await input.run({
      runId: request.runId,
      groupId: request.groupId,
      memberId: request.memberId,
      text:
        request.intent === 'PROPOSE'
          ? `Proposal request: ${request.text}`
          : request.text,
    });
    const drafts = await input.drafts(request.groupId).catch(() => []);
    const proposals = result.items
      .filter((i) => i.decision)
      .map((i) => ({
        kind: i.decision!.kind,
        status: i.decision!.status,
        code: i.decision!.code,
        intentHash:
          drafts.find((d) => d.draftDigest === i.decision!.draftDigest)
            ?.intentHash ?? null,
      }));
    const findings = [...new Set(result.findings.map((f) => f.kind))];
    return {
      text: `Brain ${result.status}: ${result.items.length} item(s)${findings.length ? `; findings ${findings.join(', ')}` : ''}. Proposals go to the Kernel; nothing executes without passkey approvals.`,
      proposals,
    };
  };
}

/** Polls approval counts and receipts into linked chats until aborted. */
export async function runChannelNotifier(
  gateway: ChannelGateway,
  signal: AbortSignal,
  intervalMs = 5_000,
  onError?: (error: unknown) => void,
) {
  while (!signal.aborted) {
    await gateway.notify().catch((error) => onError?.(error));
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, intervalMs);
      signal.addEventListener('abort', () => (clearTimeout(t), resolve()), {
        once: true,
      });
    });
  }
}
