import type { Pool, PoolClient } from 'pg';
import {
  IdentityError,
  grantDigest,
  type GrantApprovalGateway,
} from '@synq/identity/server';
import {
  HedgeGrantCodec,
  HedgeGrantError,
  HedgePolicy,
  artifactHash,
  hedgeIntentHash,
  onchainMandateId,
  onchainPluginId,
  type HedgeDecision,
  type HedgeFacts,
  type HedgeGrant,
  type HedgeIntent,
  type HedgeMandate,
} from '@synq/kernel';
import { GrantDraftSchema, type GrantDraft, type Mandate } from '@synq/schemas';
import type { OrderSpec } from '@synq/plugin-perpl';
import type { HedgeExecutionReceipt } from './executor.js';
import type { HedgeEvidence } from './evidence.js';

export type TrustedHedgeState = {
  intent: HedgeIntent;
  hedgeMandate: HedgeMandate;
  mandate: Mandate;
  facts: HedgeFacts;
};
export type HedgeProposalRecord = {
  groupId: string;
  hedgeId: string;
  intentId: string;
  clientOrderId: string | null;
  action: 'PROPOSE' | 'NONE' | 'BLOCKED';
  reason: string;
  intent: HedgeIntent | null;
  evidence: HedgeEvidence;
  createdAt: number;
};
export type PersistedHedge = {
  authorization: { state: TrustedHedgeState; decision: HedgeDecision };
  grant: HedgeGrant;
  parentId: string;
  treasury: string;
  perpCollateral: string;
  notional: string;
  state: 'RESERVED' | 'PREPARED' | 'TERMINAL';
  order: OrderSpec | null;
  head: number;
  windowEnd: number;
  since: number;
  submittedAt: number;
  receipt: HedgeExecutionReceipt | null;
};

// Session advisory locks survive commits, but release automatically on process
// death. Preparation is committed before HTTP; recovered work only reconciles.
export class PostgresHedgeStore {
  constructor(readonly pool: Pool) {}
  async initialize(): Promise<void> {
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS synq_portfolio_observations (
      group_id text PRIMARY KEY, execution_mode text NOT NULL, evidence jsonb NOT NULL)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS synq_hedge_intents (
      intent_id text PRIMARY KEY, intent_hash text NOT NULL UNIQUE,
      group_id text NOT NULL, account_key text NOT NULL,
      record jsonb NOT NULL)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS synq_hedge_proposals (
      group_id text NOT NULL, hedge_id text NOT NULL,
      intent_id text NOT NULL UNIQUE, client_order_id text UNIQUE,
      record jsonb NOT NULL, PRIMARY KEY (group_id, hedge_id))`);
  }
  async observePortfolio(groupId: string, evidence: HedgeEvidence) {
    await this.pool.query(
      `INSERT INTO synq_portfolio_observations(group_id,execution_mode,evidence) VALUES($1,$2,$3)
      ON CONFLICT(group_id) DO UPDATE SET execution_mode=EXCLUDED.execution_mode,evidence=EXCLUDED.evidence
      WHERE (synq_portfolio_observations.evidence->'risk'->>'asOf')::bigint <= (EXCLUDED.evidence->'risk'->>'asOf')::bigint`,
      [groupId, evidence.executionMode, JSON.stringify(evidence)],
    );
  }
  // First writer wins: a retried planning step returns the persisted proposal.
  async proposeOnce(record: HedgeProposalRecord): Promise<HedgeProposalRecord> {
    await this.pool.query(
      `INSERT INTO synq_hedge_proposals(group_id,hedge_id,intent_id,client_order_id,record)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT (group_id, hedge_id) DO NOTHING`,
      [
        record.groupId,
        record.hedgeId,
        record.intentId,
        record.clientOrderId,
        JSON.stringify(record),
      ],
    );
    const saved = await this.proposal(record.groupId, record.hedgeId);
    if (!saved) throw new HedgeGrantError('GRANT_INVALID', 'proposal missing');
    return saved;
  }
  async proposal(
    groupId: string,
    hedgeId: string,
  ): Promise<HedgeProposalRecord | null> {
    const r = await this.pool.query<{ record: HedgeProposalRecord }>(
      'SELECT record FROM synq_hedge_proposals WHERE group_id=$1 AND hedge_id=$2',
      [groupId, hedgeId],
    );
    return r.rows[0]?.record ?? null;
  }
  async proposalBy(
    key: 'intent_id' | 'client_order_id',
    value: string,
  ): Promise<HedgeProposalRecord | null> {
    const r = await this.pool.query<{ record: HedgeProposalRecord }>(
      `SELECT record FROM synq_hedge_proposals WHERE ${key}=$1`,
      [value],
    );
    return r.rows[0]?.record ?? null;
  }
  async intent(id: string): Promise<PersistedHedge | null> {
    const r = await this.pool.query<{ record: PersistedHedge }>(
      'SELECT record FROM synq_hedge_intents WHERE intent_id=$1',
      [id],
    );
    return r.rows[0]?.record ?? null;
  }
  async locked<T>(
    key: string | readonly string[],
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    const keys = typeof key === 'string' ? [key] : [...key].sort();
    const locked: string[] = [];
    try {
      for (const value of keys) {
        await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [
          value,
        ]);
        locked.push(value);
      }
      return await fn(client);
    } finally {
      try {
        for (const value of locked.reverse())
          await client.query(
            'SELECT pg_advisory_unlock(hashtextextended($1, 0))',
            [value],
          );
      } finally {
        client.release();
      }
    }
  }
  async get(client: PoolClient, id: string): Promise<PersistedHedge | null> {
    const result = await client.query<{ record: PersistedHedge }>(
      'SELECT record FROM synq_hedge_intents WHERE intent_id=$1',
      [id],
    );
    return result.rows[0]?.record ?? null;
  }
  async group(client: PoolClient, groupId: string): Promise<PersistedHedge[]> {
    const result = await client.query<{ record: PersistedHedge }>(
      'SELECT record FROM synq_hedge_intents WHERE group_id=$1',
      [groupId],
    );
    return result.rows.map((r) => r.record);
  }
  async account(
    client: PoolClient,
    accountKey: string,
  ): Promise<PersistedHedge[]> {
    const result = await client.query<{ record: PersistedHedge }>(
      'SELECT record FROM synq_hedge_intents WHERE account_key=$1',
      [accountKey],
    );
    return result.rows.map((r) => r.record);
  }
  async insert(client: PoolClient, record: PersistedHedge): Promise<void> {
    await client.query(
      'INSERT INTO synq_hedge_intents(intent_id,intent_hash,group_id,account_key,record) VALUES($1,$2,$3,$4,$5)',
      [
        record.grant.intentId,
        record.grant.intentHash,
        record.grant.groupId,
        this.accountKey(record.grant),
        JSON.stringify(record),
      ],
    );
  }
  async save(client: PoolClient, record: PersistedHedge): Promise<void> {
    const r = await client.query(
      'UPDATE synq_hedge_intents SET record=$2 WHERE intent_id=$1 AND intent_hash=$3',
      [record.grant.intentId, JSON.stringify(record), record.grant.intentHash],
    );
    if (r.rowCount !== 1)
      throw new HedgeGrantError('GRANT_INVALID', 'persisted intent missing');
  }
  accountKey(g: HedgeGrant): string {
    return `${g.chainId}:${g.exchange}:${g.perplAccountId}`;
  }
}

export class DurableHedgeGrantAuthority {
  readonly codec: HedgeGrantCodec;
  constructor(
    readonly options: {
      store: PostgresHedgeStore;
      key: Uint8Array;
      loadTrusted: (intentId: string) => Promise<TrustedHedgeState>;
      approvals: Pick<
        GrantApprovalGateway,
        'pendingIntent' | 'quorum' | 'registerDraft'
      >;
      mode: 'REAL_TESTNET' | 'SIMULATION';
      // Verifying contract of the group's execution module for approval drafts.
      executionModule?: `0x${string}`;
    },
  ) {
    this.codec = new HedgeGrantCodec(options.key);
  }
  get executionMode() {
    return this.options.mode;
  }
  get store() {
    return this.options.store;
  }
  async issue(intentId: string): Promise<HedgeGrant> {
    const first = await this.options.loadTrusted(intentId);
    if (first.intent.intentId !== intentId)
      throw new HedgeGrantError('GRANT_BINDING', 'trusted intent');
    return this.store.locked(
      [
        `hedge-group:${first.intent.groupId}`,
        `hedge-account:${first.hedgeMandate.chainId}:${first.hedgeMandate.exchange}:${first.hedgeMandate.perplAccountId}`,
      ],
      async (client) => {
        const state = await this.options.loadTrusted(intentId);
        const { intent, hedgeMandate: hm, mandate } = state;
        if (
          intent.intentId !== intentId ||
          intent.groupId !== first.intent.groupId ||
          hm.chainId !== first.hedgeMandate.chainId ||
          hm.exchange !== first.hedgeMandate.exchange ||
          hm.perplAccountId !== first.hedgeMandate.perplAccountId
        )
          throw new HedgeGrantError('GRANT_BINDING', 'trusted state changed');
        const prior = await this.store.get(client, intentId);
        if (prior) {
          if (prior.grant.intentHash !== hedgeIntentHash(intent))
            throw new HedgeGrantError('GRANT_BINDING', 'intent changed');
          return prior.grant;
        }
        const rows = await this.store.group(client, intent.groupId);
        const pending = rows.filter((r) => r.state !== 'TERMINAL');
        const accountRows = await this.store.account(
          client,
          this.store.accountKey({
            chainId: hm.chainId,
            exchange: hm.exchange,
            perplAccountId: hm.perplAccountId,
          } as HedgeGrant),
        );
        const accountPending = accountRows.filter(
          (r) => r.state !== 'TERMINAL',
        );
        if (!['REDUCE', 'CLOSE', 'CANCEL'].includes(intent.kind)) {
          const priorActions = rows.filter(
            (r) => r.parentId === mandate.mandateId && !r.grant.reduceOnly,
          );
          if (
            priorActions.length >= mandate.maxExecutions ||
            priorActions.some(
              (r) =>
                state.facts.now - r.grant.issuedAt < mandate.minIntervalSeconds,
            )
          )
            throw new HedgeGrantError(
              'DECISION_NOT_AUTHORIZABLE',
              'parent execution count/interval',
            );
          const riskAsOf =
            (state.facts.risk as { asOf?: number } | undefined)?.asOf ?? 0;
          if (
            accountRows.some(
              (r) =>
                r.receipt &&
                r.receipt.reconciliation === 'SETTLED' &&
                riskAsOf < r.receipt.reconciledAt,
            )
          )
            throw new HedgeGrantError(
              'DECISION_NOT_AUTHORIZABLE',
              'risk snapshot predates settled venue state',
            );
        }
        const sum = (
          rs: PersistedHedge[],
          field: 'treasury' | 'perpCollateral' | 'notional',
        ) => rs.reduce((v, r) => v + BigInt(r[field]), 0n);
        const facts = { ...state.facts };
        facts.reservedTreasury = sum(pending, 'treasury').toString();
        facts.reservedPerpCollateral = sum(
          accountPending,
          'perpCollateral',
        ).toString();
        if (
          BigInt(facts.freeCoreTreasury) < 0n ||
          BigInt(facts.perpFreeCollateral) < 0n
        )
          throw new HedgeGrantError(
            'DECISION_NOT_AUTHORIZABLE',
            'reserved collateral exceeds free balance',
          );
        // The packet authenticates the original free balance; reserved collateral
        // is a separate policy budget, never a mutation of the packet/hash.
        facts.pendingNotional = sum(
          pending.filter((r) => r.parentId === mandate.mandateId),
          'notional',
        ).toString();
        facts.parentSpent = (
          BigInt(facts.parentSpent ?? '0') +
          sum(
            rows.filter(
              (r) =>
                r.parentId === mandate.mandateId &&
                r.state === 'TERMINAL' &&
                BigInt(r.receipt?.filledSize ?? '0') > 0n,
            ),
            'notional',
          )
        ).toString();
        facts.pendingHedgeNotional = sum(
          accountPending.filter(
            (r) =>
              r.grant.marketId === intent.marketId &&
              r.grant.side === intent.side,
          ),
          'notional',
        ).toString();
        const decision = new HedgePolicy().evaluate({
          intent,
          hedgeMandate: hm,
          mandate,
          facts,
        });
        if (
          decision.status !== 'REJECTED' &&
          decision.evidenceMode !== this.executionMode
        )
          throw new HedgeGrantError(
            'DECISION_NOT_AUTHORIZABLE',
            `${decision.evidenceMode} evidence for a ${this.executionMode} authority`,
          );
        if (decision.status === 'REJECTED')
          throw new HedgeGrantError(
            'DECISION_NOT_AUTHORIZABLE',
            decision.rejection?.code,
          );
        const approvers = await this.approvers(state, decision);
        const grant = this.codec.sign({
          decision,
          intent,
          hedgeMandate: hm,
          mandate,
          now: facts.now,
          approvers,
          executionMode: this.executionMode,
        });
        const collateral = BigInt(intent.collateral);
        const availablePerp =
          BigInt(facts.perpFreeCollateral) -
          BigInt(facts.reservedPerpCollateral);
        const fromPerp =
          collateral < availablePerp ? collateral : availablePerp;
        await this.store.insert(client, {
          authorization: { state: { ...state, facts }, decision },
          grant,
          parentId: mandate.mandateId,
          treasury: decision.treasuryReservation,
          perpCollateral: decision.riskReducing ? '0' : fromPerp.toString(),
          notional: decision.riskReducing ? '0' : intent.notional,
          state: 'RESERVED',
          order: null,
          head: 0,
          windowEnd: 0,
          since: 0,
          submittedAt: 0,
          receipt: null,
        });
        return grant;
      },
    );
  }
  private async approvers(
    state: TrustedHedgeState,
    decision: HedgeDecision,
  ): Promise<string[]> {
    const { intent, hedgeMandate: hm, mandate, facts } = state;
    let approvers: string[] = [];
    if (decision.requiredApprovals > 0) {
      const view = await this.options.approvals.pendingIntent(
        decision.intentHash,
      );
      const draft = view.draft;
      const g = draft.grant;
      const binding = mandate.bindings.find(
        (b) =>
          b.pluginId === 'perpl' &&
          b.action === 'PERP_HEDGE' &&
          b.target === hm.exchange,
      );
      if (
        draft.groupId !== mandate.groupId ||
        g.intentHash !== decision.intentHash ||
        g.calldataHash !== decision.intentHash ||
        g.chainId !== String(hm.chainId) ||
        g.target !== hm.exchange ||
        g.token !== hm.collateralAsset.address ||
        g.maxInputAmount !== intent.collateral ||
        g.account !== mandate.account ||
        g.groupId !== mandate.chainGroupId ||
        g.mandateId !== onchainMandateId(mandate) ||
        g.mandateVersion !== String(mandate.version) ||
        g.pluginId !== onchainPluginId('perpl') ||
        g.selector !== binding?.selector ||
        g.nativeValue !== '0' ||
        Number(g.validAfter) > facts.now ||
        Number(g.validUntil) <= facts.now ||
        Number(g.validUntil) > intent.expiresAt ||
        draft.requiredApprovals < decision.requiredApprovals
      )
        throw new HedgeGrantError(
          'APPROVALS_MISSING',
          'P05 draft not bound to hedge',
        );
      const quorum = await this.options.approvals.quorum(draft.digest);
      if (
        quorum.groupId !== mandate.groupId ||
        quorum.draftDigest !== draft.digest ||
        !quorum.satisfied ||
        quorum.required < decision.requiredApprovals
      )
        throw new HedgeGrantError('APPROVALS_MISSING', 'current P05 quorum');
      approvers = quorum.counted.map((a) => a.memberId);
    }
    return approvers;
  }
  // The P05 draft every approver signs for this exact hedge. Built here from
  // trusted state, never from a caller.
  draftFor(state: TrustedHedgeState, decision: HedgeDecision): GrantDraft {
    const { intent, hedgeMandate: hm, mandate: m } = state;
    const module = this.options.executionModule;
    const binding = m.bindings.find(
      (b) =>
        b.pluginId === 'perpl' &&
        b.action === 'PERP_HEDGE' &&
        b.target === hm.exchange,
    );
    if (!module || !binding || !m.operators[0])
      throw new HedgeGrantError('APPROVALS_MISSING', 'no approval route');
    const hash = decision.intentHash;
    const base = GrantDraftSchema.parse({
      schemaVersion: 1,
      groupId: m.groupId,
      hedgeIntent: intent,
      domain: {
        name: 'SynqExecutionModule',
        version: '1',
        chainId: m.network.chainId,
        verifyingContract: module,
      },
      requiredApprovals: decision.requiredApprovals,
      createdAt: intent.createdAt,
      grant: {
        groupId: m.chainGroupId,
        account: m.account,
        mandateId: onchainMandateId(m),
        mandateVersion: String(m.version),
        executor: m.operators[0],
        pluginId: onchainPluginId('perpl'),
        chainId: String(m.network.chainId),
        target: hm.exchange,
        selector: binding.selector,
        calldataHash: hash,
        token: m.inputAsset.address,
        maxInputAmount: intent.collateral,
        nativeValue: '0',
        minOutputAmount: '0',
        recipient: m.account,
        validAfter: String(intent.createdAt),
        validUntil: String(intent.expiresAt),
        nonce: BigInt(hash.slice(0, 18)).toString(),
        intentHash: hash,
      },
      digest: `0x${'00'.repeat(32)}`,
    });
    return { ...base, digest: grantDigest(base) };
  }
  // Current approval state for a proposed hedge, registering its draft once.
  async approvalStatus(intentId: string): Promise<{
    rejected: boolean;
    required: number;
    satisfied: boolean;
    draftDigest: string | null;
  }> {
    const issued = await this.store.intent(intentId);
    if (issued)
      return {
        rejected: false,
        required: issued.authorization.decision.requiredApprovals,
        satisfied: true,
        draftDigest: null,
      };
    const state = await this.options.loadTrusted(intentId);
    const decision = new HedgePolicy().evaluate(state);
    if (
      decision.status === 'REJECTED' ||
      decision.evidenceMode !== this.executionMode
    )
      return {
        rejected: true,
        required: 0,
        satisfied: false,
        draftDigest: null,
      };
    if (decision.requiredApprovals === 0)
      return {
        rejected: false,
        required: 0,
        satisfied: true,
        draftDigest: null,
      };
    let digest: string;
    try {
      digest = (await this.options.approvals.pendingIntent(decision.intentHash))
        .draft.digest;
    } catch (error) {
      if (!(error instanceof IdentityError) || error.code !== 'DRAFT_NOT_FOUND')
        throw error;
      const draft = this.draftFor(state, decision);
      await this.options.approvals.registerDraft({
        draft,
        asset: state.mandate.inputAsset,
      });
      digest = draft.digest;
    }
    const q = await this.options.approvals.quorum(digest);
    return {
      rejected: false,
      required: decision.requiredApprovals,
      satisfied: q.satisfied && q.required >= decision.requiredApprovals,
      draftDigest: digest,
    };
  }
  async revalidate(grant: HedgeGrant): Promise<void> {
    const state = await this.options.loadTrusted(grant.intentId);
    if (hedgeIntentHash(state.intent) !== grant.intentHash)
      throw new HedgeGrantError('GRANT_BINDING', 'intent changed');
    const decision = new HedgePolicy().evaluate(state);
    if (decision.evidenceMode !== this.executionMode)
      throw new HedgeGrantError('DECISION_NOT_AUTHORIZABLE', 'evidence mode');
    if (decision.status === 'REJECTED')
      throw new HedgeGrantError(
        'DECISION_NOT_AUTHORIZABLE',
        decision.rejection?.code,
      );
    const approvers = await this.approvers(state, decision);
    if (
      artifactHash(approvers.sort()) !==
      artifactHash([...grant.approvals].sort())
    )
      throw new HedgeGrantError(
        'APPROVALS_MISSING',
        'membership/approval changed',
      );
  }
}
