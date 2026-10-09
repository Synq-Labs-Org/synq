import { z } from 'zod';
import {
  ACTION_MACHINE,
  transitionRecordSchema,
  type ActionState,
  type TransitionRecord,
} from '@synq/domain';
import {
  AddressSchema,
  AmountSchema,
  AssetIdentitySchema,
  ExecutionGrantSchema,
  HashSchema,
  MandateSchema,
  NetworkProfileSchema,
  type NetworkProfile,
} from '@synq/schemas';
import { AuditRecordSchema, type AuditRecord } from './audit.js';
import { artifactHash, canonicalJson, type Hash } from './canonical.js';
import { DelegationUsage, type DelegationState } from './delegation.js';
import { KernelError, parseAs, requireRule } from './errors.js';
import { grantDigestMatches } from './grants.js';
import {
  GRANT_STATES,
  Ledger,
  OUTSTANDING,
  emptyBudget,
  type BalanceRecord,
  type Budget,
  type GrantRecord,
} from './ledger.js';
import { ActionLifecycles } from './lifecycle.js';
import { MandateResolver, mandateKey, type MandateRecord } from './mandates.js';

const Int = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const BudgetSchema = z.strictObject({
  spentToken: AmountSchema,
  spentNative: AmountSchema,
  reservedToken: AmountSchema,
  reservedNative: AmountSchema,
  issued: Int,
  lastIssued: Int.nullable(),
});
const GrantRecordSchema = z.strictObject({
  grant: ExecutionGrantSchema,
  state: z.enum(GRANT_STATES),
  claim: z
    .strictObject({
      grantId: HashSchema,
      workerId: z.string().min(1).max(128),
      claimId: HashSchema,
      claimedAt: Int,
    })
    .nullable(),
  preparedCallHash: HashSchema.nullable(),
  submissions: z.array(HashSchema),
  execution: z
    .strictObject({
      transactionHash: HashSchema,
      blockNumber: AmountSchema,
      tokenAmount: AmountSchema,
      nativeValue: AmountSchema,
      outputAmount: AmountSchema,
    })
    .nullable(),
});
export const KernelSnapshotSchema = z.strictObject({
  version: z.literal(2),
  network: NetworkProfileSchema,
  executionModule: AddressSchema,
  lastNow: Int.nullable(),
  claimSequence: Int,
  mandates: z.array(
    z.strictObject({
      versions: z.array(MandateSchema).min(1),
      minValidVersion: Int,
      revoked: z.boolean(),
    }),
  ),
  budgets: z.array(z.tuple([z.string(), BudgetSchema])),
  balances: z.array(
    z.strictObject({
      account: AddressSchema,
      asset: AssetIdentitySchema,
      balance: AmountSchema,
      asOfBlock: AmountSchema,
    }),
  ),
  grants: z.array(GrantRecordSchema),
  nonces: z.array(z.string()),
  trustedEvidence: z.strictObject({
    riskPacketHashes: z.array(HashSchema),
    simulationHashes: z.array(HashSchema),
  }),
  delegations: z.array(
    z.tuple([
      z.string(),
      z.array(z.strictObject({ amount: AmountSchema, at: Int })),
    ]),
  ),
  lifecycles: z.array(
    z.tuple([z.string(), z.array(transitionRecordSchema(ACTION_MACHINE))]),
  ),
  audit: z.array(AuditRecordSchema),
});
export type KernelSnapshot = z.input<typeof KernelSnapshotSchema>;

export function snapshotState(state: {
  network: NetworkProfile;
  executionModule: `0x${string}`;
  lastNow: number | null;
  claimSequence: number;
  mandates: MandateRecord[];
  ledger: Ledger;
  trustedEvidence: { riskPacketHashes: string[]; simulationHashes: string[] };
  delegations: DelegationState;
  lifecycles: [string, TransitionRecord<ActionState>[]][];
  audit: AuditRecord[];
}): KernelSnapshot {
  return structuredClone({
    version: 2 as const,
    network: state.network,
    executionModule: state.executionModule,
    lastNow: state.lastNow,
    claimSequence: state.claimSequence,
    mandates: state.mandates,
    budgets: [...state.ledger.budgets],
    balances: [...state.ledger.balances.values()],
    grants: [...state.ledger.grants.values()],
    nonces: [...state.ledger.nonces],
    trustedEvidence: state.trustedEvidence,
    delegations: state.delegations,
    lifecycles: state.lifecycles,
    audit: state.audit,
  }) as KernelSnapshot;
}

export function stateHash(snapshot: KernelSnapshot): Hash {
  const {
    audit: _audit,
    lastNow: _lastNow,
    ...state
  } = KernelSnapshotSchema.parse(snapshot);
  return artifactHash(state);
}

function auditCoversState(parsed: z.output<typeof KernelSnapshotSchema>) {
  const head = parsed.audit.at(-1);
  if (
    !head ||
    head.kind !== 'SNAPSHOT' ||
    (head.payload as { stateHash?: unknown } | null)?.stateHash !==
      stateHash({ ...parsed, audit: [] })
  )
    return false;
  const authorized = new Set<string>();
  const reconciled = new Set<string>();
  for (const r of parsed.audit) {
    const p = r.payload as Record<string, unknown> | null;
    if (r.kind === 'AUTHORIZATION' && p?.status === 'AUTHORIZED')
      authorized.add(String(p.grantId));
    if (r.kind === 'RECONCILE' && p?.state === 'RECONCILED')
      reconciled.add(String(p.grantId));
  }
  const grants = new Set<string>(parsed.grants.map((g) => g.grant.grantId));
  return (
    authorized.size === grants.size &&
    [...authorized].every((id) => grants.has(id)) &&
    parsed.grants.every(
      (g) => g.state !== 'RECONCILED' || reconciled.has(g.grant.grantId),
    )
  );
}

function consistentRecord(r: GrantRecord): boolean {
  const g = r.grant;
  const claimed = r.claim !== null && r.claim.grantId === g.grantId;
  switch (r.state) {
    case 'RESERVED':
      return (
        r.claim === null &&
        r.preparedCallHash === null &&
        r.submissions.length === 0 &&
        !r.execution
      );
    case 'CONSUMED':
      return (
        claimed &&
        r.preparedCallHash === null &&
        r.submissions.length === 0 &&
        !r.execution
      );
    case 'PREPARED':
    case 'REVERTED':
      return claimed && r.preparedCallHash !== null && !r.execution;
    case 'RELEASED':
      return r.execution === null;
    case 'RECONCILED':
      return (
        claimed &&
        r.execution !== null &&
        BigInt(r.execution.tokenAmount) <= BigInt(g.maxInputAmount) &&
        BigInt(r.execution.nativeValue) <= BigInt(g.nativeValue)
      );
  }
}

export function restoreState(raw: unknown) {
  let parsed: z.output<typeof KernelSnapshotSchema>;
  try {
    parsed = parseAs(KernelSnapshotSchema, raw, 'SNAPSHOT_INVALID');
  } catch (error) {
    if (error instanceof KernelError) throw error;
    throw new KernelError('SNAPSHOT_INVALID');
  }
  requireRule(auditCoversState(parsed), 'SNAPSHOT_INVALID');
  const mandates = MandateResolver.fromRecords(parsed.mandates);
  const ledger = new Ledger();
  const keys = new Set(parsed.mandates.map((m) => mandateKey(m.versions[0]!)));
  const expectedNonces = new Set<string>();
  const totals = new Map<string, Budget>();
  for (const record of parsed.grants) {
    const g = record.grant;
    requireRule(
      !ledger.grants.has(g.grantId) &&
        grantDigestMatches(g) &&
        consistentRecord(record) &&
        keys.has(mandateKey(g)) &&
        g.draft.domain.verifyingContract === parsed.executionModule &&
        g.chainId === parsed.network.chainId,
      'SNAPSHOT_INVALID',
    );
    const nonce = JSON.stringify([g.chainId, g.account, g.nonce]);
    requireRule(!expectedNonces.has(nonce), 'SNAPSHOT_INVALID');
    expectedNonces.add(nonce);
    ledger.grants.set(g.grantId, structuredClone(record));
    const total = totals.get(mandateKey(g)) ?? emptyBudget();
    const outstanding = OUTSTANDING.includes(record.state);
    totals.set(mandateKey(g), {
      reservedToken: (
        BigInt(total.reservedToken) +
        (outstanding ? BigInt(g.maxInputAmount) : 0n)
      ).toString(),
      reservedNative: (
        BigInt(total.reservedNative) +
        (outstanding ? BigInt(g.nativeValue) : 0n)
      ).toString(),
      spentToken: (
        BigInt(total.spentToken) + BigInt(record.execution?.tokenAmount ?? '0')
      ).toString(),
      spentNative: (
        BigInt(total.spentNative) + BigInt(record.execution?.nativeValue ?? '0')
      ).toString(),
      issued: total.issued + 1,
      lastIssued: Math.max(total.lastIssued ?? 0, g.issuedAt),
    });
  }
  requireRule(
    expectedNonces.size === parsed.nonces.length &&
      parsed.nonces.every((n) => expectedNonces.has(n)),
    'SNAPSHOT_INVALID',
  );
  for (const n of parsed.nonces) ledger.nonces.add(n);
  const budgetKeys = new Set(parsed.budgets.map(([k]) => k));
  requireRule(budgetKeys.size === parsed.budgets.length, 'SNAPSHOT_INVALID');
  for (const [key, total] of totals)
    requireRule(budgetKeys.has(key) || total.issued === 0, 'SNAPSHOT_INVALID');
  for (const [key, budget] of parsed.budgets) {
    requireRule(
      canonicalJson(budget) === canonicalJson(totals.get(key) ?? emptyBudget()),
      'SNAPSHOT_INVALID',
    );
    ledger.budgets.set(key, budget);
  }
  const balanceKeys = new Set<string>();
  for (const balance of parsed.balances as BalanceRecord[]) {
    const key = JSON.stringify([
      balance.account,
      balance.asset.canonicalAssetId,
    ]);
    requireRule(!balanceKeys.has(key), 'SNAPSHOT_INVALID');
    balanceKeys.add(key);
    ledger.balances.set(key, structuredClone(balance));
  }
  for (const balance of ledger.balances.values())
    requireRule(
      BigInt(balance.balance) >=
        ledger.outstanding(balance.account, balance.asset),
      'SNAPSHOT_INVALID',
    );
  const lifecycles = ActionLifecycles.restore(parsed.lifecycles);
  for (const record of ledger.grants.values())
    requireRule(
      lifecycles
        .history(record.grant.intentId)
        .some((t) => t.to === 'AUTHORIZED'),
      'SNAPSHOT_INVALID',
    );
  let delegations: DelegationUsage;
  try {
    delegations = DelegationUsage.restore(parsed.delegations);
  } catch {
    throw new KernelError('SNAPSHOT_INVALID');
  }
  const last = parsed.audit.at(-1);
  requireRule(
    !last || (parsed.lastNow !== null && parsed.lastNow >= last.recordedAt),
    'SNAPSHOT_INVALID',
  );
  return {
    network: parsed.network,
    executionModule: parsed.executionModule,
    lastNow: parsed.lastNow,
    claimSequence: parsed.claimSequence,
    mandates,
    ledger,
    delegations,
    lifecycles,
    audit: parsed.audit,
    trustedEvidence: parsed.trustedEvidence,
  };
}
