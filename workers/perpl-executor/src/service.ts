import { IdSchema, type Mandate } from '@synq/schemas';
import {
  HedgeGrantError,
  HedgeIntentSchema,
  artifactHash,
  type HedgeGrant,
  type HedgeIntent,
  type HedgeMandate,
  type HedgeTriggerSchema,
} from '@synq/kernel';
import type { PerplPosition, PerplRestClient } from '@synq/plugin-perpl';
import { proposeHedge } from '@synq/risk-engine';
import type { z } from 'zod';
import {
  DurableHedgeGrantAuthority,
  type HedgeProposalRecord,
  type PostgresHedgeStore,
  type TrustedHedgeState,
} from './durable.js';
import {
  factsFromEvidence,
  hedgeMarketFrom,
  type PerplHedgeEvidenceReader,
} from './evidence.js';
import type { HedgeExecutionReceipt, PerplHedgeExecutor } from './executor.js';

export type HedgeMandates = { mandate: Mandate; hedgeMandate: HedgeMandate };
// Current Kernel-held mandates for a group; read again at every issuance.
export interface HedgeMandateSource {
  current(groupId: string): Promise<HedgeMandates>;
}
export function scopedHedgeIntentId(groupId: string, hedgeId: string): string {
  return IdSchema.parse(`hedge.${artifactHash({ groupId, hedgeId }).slice(2)}`);
}
type Network = Parameters<typeof factsFromEvidence>[1];

// The only trusted state the durable authority evaluates: the persisted
// proposal (intent plus the reader evidence it was sized from) and the
// current mandates. Nothing here comes from a workflow or Brain argument.
export function trustedHedgeStateLoader(deps: {
  store: PostgresHedgeStore;
  mandates: HedgeMandateSource;
  network: Network;
  now?: () => number;
}): (intentId: string) => Promise<TrustedHedgeState> {
  const now = deps.now ?? Date.now;
  return async (intentId) => {
    const proposal = await deps.store.proposalBy('intent_id', intentId);
    if (!proposal?.intent)
      throw new HedgeGrantError('GRANT_BINDING', 'no persisted proposal');
    const { mandate, hedgeMandate } = await deps.mandates.current(
      proposal.groupId,
    );
    return {
      intent: HedgeIntentSchema.parse(proposal.intent),
      mandate,
      hedgeMandate,
      facts: factsFromEvidence(proposal.evidence, deps.network, now()),
    };
  };
}

export type HedgeTrigger = z.output<typeof HedgeTriggerSchema>;
export type HedgePlanResult = {
  proposal: HedgeProposalRecord;
  maxSlippageBps: number;
};

export class PerplHedgeService {
  private readonly now: () => number;
  constructor(
    private readonly deps: {
      store: PostgresHedgeStore;
      reader: PerplHedgeEvidenceReader;
      mandates: HedgeMandateSource;
      authority: DurableHedgeGrantAuthority;
      executor: () => PerplHedgeExecutor;
      positions: Pick<PerplRestClient, 'positions'>;
      accountId: number;
      ttlSeconds?: number;
      leverageHundredths?: number;
      now?: () => number;
    },
  ) {
    if (deps.reader.executionMode !== deps.authority.executionMode)
      throw new HedgeGrantError('GRANT_BINDING', 'reader/authority mode');
    this.now = deps.now ?? Date.now;
  }

  async snapshot(groupId: string) {
    const { hedgeMandate } = await this.deps.mandates.current(groupId);
    const e = await this.deps.reader.read();
    const asset = e.risk.assets.find(
      (a) => a.asset === hedgeMandate.hedgedAsset,
    );
    return {
      exposure: asset?.spotValue ?? '0',
      riskStatus: e.risk.blocked ? ('DEGRADED' as const) : ('HEALTHY' as const),
      observedAt: e.risk.asOf,
      riskPacketHash: e.riskPacketHash,
      risk: e.risk,
    };
  }

  async plan(input: {
    groupId: string;
    hedgeId: string;
    trigger: HedgeTrigger;
  }): Promise<HedgePlanResult> {
    const { hedgeMandate } = await this.deps.mandates.current(input.groupId);
    const existing = await this.deps.store.proposal(
      input.groupId,
      input.hedgeId,
    );
    if (existing)
      return {
        proposal: existing,
        maxSlippageBps: hedgeMandate.maxSlippageBps,
      };
    const intentId = scopedHedgeIntentId(input.groupId, input.hedgeId);
    const evidence = await this.deps.reader.read();
    const now = this.now();
    const p = proposeHedge(
      evidence.risk,
      hedgeMandate,
      hedgeMarketFrom(evidence),
      {
        intentId,
        now,
        ttlSeconds: this.deps.ttlSeconds ?? 120,
        trigger: input.trigger,
        leverageHundredths: this.deps.leverageHundredths ?? 100,
      },
    );
    const action = p.action === 'PROPOSE' ? p.intent.kind : null;
    const proposal = await this.deps.store.proposeOnce({
      groupId: input.groupId,
      hedgeId: input.hedgeId,
      intentId,
      clientOrderId: action
        ? `synq.${input.groupId}.${input.hedgeId}.${workflowAction(action).toLowerCase()}`
        : null,
      action: p.action,
      reason:
        p.action === 'PROPOSE' ? `${p.intent.kind} ${p.intent.size}` : p.reason,
      intent: p.action === 'PROPOSE' ? p.intent : null,
      evidence,
      createdAt: now,
    });
    return { proposal, maxSlippageBps: hedgeMandate.maxSlippageBps };
  }

  proposalByClientOrderId(id: string) {
    return this.deps.store.proposalBy('client_order_id', id);
  }

  approvals(intentId: string) {
    return this.deps.authority.approvalStatus(intentId);
  }

  async submit(intentId: string): Promise<HedgeExecutionReceipt> {
    const grant = await this.deps.authority.issue(intentId);
    return this.deps.executor().execute(grant);
  }

  // Never submits anything new: an order prepared before a crash is only
  // reconciled by its persisted rq.
  async status(intentId: string): Promise<HedgeExecutionReceipt | null> {
    const record = await this.deps.store.intent(intentId);
    if (!record || !record.order) return null;
    if (record.state === 'TERMINAL' && record.receipt) return record.receipt;
    return this.deps.executor().execute(record.grant as HedgeGrant);
  }

  async reconcile(intentId: string): Promise<{
    reconciled: boolean;
    position: string;
    positions: PerplPosition[];
  }> {
    const record = await this.deps.store.intent(intentId);
    const receipt = record?.receipt ?? null;
    let positions: PerplPosition[];
    try {
      positions = (await this.deps.positions.positions()).d.filter(
        (p) => p.acc === this.deps.accountId && p.st === 1 && p.s > 0,
      );
    } catch {
      return { reconciled: false, position: 'UNKNOWN', positions: [] };
    }
    const market = record?.grant.marketId;
    const net = positions
      .filter((p) => p.mkt === market)
      .reduce((v, p) => v + (p.sd === 1 ? BigInt(p.s) : -BigInt(p.s)), 0n);
    return {
      reconciled:
        !record?.order ||
        (receipt !== null &&
          receipt.positionsStatus === 'KNOWN' &&
          ['SETTLED', 'FAILED', 'NO_ORDER'].includes(receipt.reconciliation)),
      position: net.toString(),
      positions,
    };
  }
}

export function workflowAction(
  kind: HedgeIntent['kind'],
): 'OPEN' | 'ADJUST' | 'CLOSE' {
  return kind === 'OPEN' ? 'OPEN' : kind === 'CLOSE' ? 'CLOSE' : 'ADJUST';
}
