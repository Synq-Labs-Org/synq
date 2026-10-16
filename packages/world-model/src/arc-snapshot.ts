import { CHAINS, type ChainName } from '@synq/chain-registry/arc';
import type {
  FieldFreshness,
  FieldMeta,
  Observed,
  Provenance,
} from '@synq/schemas';
import { FieldMetaSchema } from '@synq/schemas';
import {
  ageFreshness,
  errorCode,
  fieldMeta,
  observed,
  unknownField,
  worstFreshness,
} from './meta.js';

/**
 * Arc finance WorldSnapshot: what the Synq Supervisor and its specialists may
 * believe about a workspace before planning.
 *
 * Every field is `Observed<T>`: the value plus provenance, source, observedAt,
 * freshness and confidence. A reader that throws, is missing, or returns data
 * older than its field's max age yields UNKNOWN or STALE, never a silent
 * default. If any *critical* field (identity, wallets, Arc balances, reserves,
 * payables, mandates) is not FRESH the snapshot is not decision-grade and
 * agents must refuse to recommend money movement until it is refreshed.
 *
 * Providers are UNAVAILABLE unless their SDK is installed, every required
 * credential is present, and a health check succeeded recently. An installed
 * SDK alone never makes a capability available.
 */

export type Hex40 = `0x${string}`;

export type Reading<T> = Readonly<{
  value: T;
  provenance: Provenance;
  source: string;
  observedAt: number;
}>;
export type Reader<T> = () => Promise<Reading<T>> | Reading<T>;

export type ArcUser = Readonly<{ principalId: string; displayName: string }>;
export type ArcWorkspace = Readonly<{
  workspaceId: string;
  name: string;
  kind: 'FREELANCER' | 'BUSINESS' | 'GROUP';
}>;
export type ArcMembership = Readonly<{
  principalId: string;
  displayName: string;
  role: 'OWNER' | 'APPROVER' | 'ACCOUNTANT' | 'MEMBER';
  verified: boolean;
  via: string;
}>;
export type ArcWallet = Readonly<{
  address: Hex40;
  chain: ChainName;
  ownerPrincipalId: string;
  kind: 'OWNER_EOA' | 'AGENT_EOA' | 'CIRCLE_SCA' | 'CIRCLE_DCW' | 'SAFE_VAULT';
  role: 'TREASURY' | 'AGENT_OPERATIONAL' | 'PAYOUT';
  verifiedBy: string | null;
}>;
export type ChainBalance = Readonly<{
  chain: ChainName;
  account: Hex40;
  asset: 'USDC' | 'EURC';
  /** Base units (6 decimals for USDC/EURC) as a decimal string. */
  baseUnits: string;
}>;
export type GatewayBalance = Readonly<{
  chain: ChainName;
  depositor: Hex40;
  baseUnits: string;
}>;
export type CctpTransfer = Readonly<{
  transferId: string;
  from: ChainName;
  to: ChainName;
  baseUnits: string;
  status: 'BURNED' | 'ATTESTED' | 'MINT_PENDING';
  startedAt: number;
  invoiceRef: string | null;
}>;
export type Reserves = Readonly<{
  minimumReserve: string;
  reservations: string;
  escrow: string;
}>;
export type Receivable = Readonly<{
  invoiceId: string;
  number: string;
  payer: string;
  total: string;
  amountDue: string;
  dueDate: string;
  status: string;
}>;
export type Payable = Readonly<{
  vendorInvoiceId: string;
  vendorId: string;
  vendorName: string;
  number: string;
  amount: string;
  dueOn: string;
  payTo: Hex40;
  verifiedPayTo: Hex40 | null;
  status: 'OPEN' | 'SCHEDULED' | 'HELD' | 'PAID';
}>;
export type MandateSummary = Readonly<{
  mandateId: string;
  version: number;
  purposes: readonly string[];
  perActionCap: string;
  periodBudget: string;
  spentInPeriod: string;
  recipients: number;
  validUntil: number;
  revoked: boolean;
}>;
export type PendingApproval = Readonly<{
  approvalId: string;
  kind: 'OVER_CAP_PAYMENT' | 'INVOICE_ISSUANCE' | 'ADDRESS_CHANGE' | 'MANDATE';
  subject: string;
  requestedAt: number;
  requiredSigner: string;
}>;
export type ActiveWorkflow = Readonly<{
  workflowId: string;
  kind: string;
  status: 'RUNNING' | 'WAITING' | 'FAILED';
  startedAt: number;
  ref: string | null;
}>;
export type Reconciliation = Readonly<{
  status: 'RECONCILED' | 'UNRECONCILED' | 'UNKNOWN';
  unreconciled: number;
  lastRunAt: number | null;
  detail: string;
}>;
export type Blocker = Readonly<{
  code: string;
  detail: string;
  ref: string | null;
}>;
export type ProviderCondition =
  | 'OK'
  | 'SDK_MISSING'
  | 'NEEDS_CREDENTIALS'
  | 'UNCHECKED'
  | 'UNHEALTHY'
  | 'STALE_CHECK';
export type ProviderStatus = Readonly<{
  providerId: string;
  label: string;
  status: 'AVAILABLE' | 'UNVERIFIED' | 'UNAVAILABLE';
  /** Why the status is what it is (credentials, health, staleness). */
  condition: ProviderCondition;
  sdkInstalled: boolean;
  credentialsPresent: boolean;
  /** Names only, never values. */
  missingCredentials: readonly string[];
  capabilities: readonly string[];
  reason: string;
}>;
/**
 * A financial action whose outcome is not yet confirmed (a broadcast payout
 * without a receipt, a CCTP burn without a mint, an x402 payment without a
 * settlement response). Retrying it could pay twice.
 */
export type PendingOutcome = Readonly<{
  ref: string;
  kind: 'ARC_PAYOUT' | 'CCTP' | 'GATEWAY' | 'X402' | 'BOOKING' | 'PURCHASE';
  /** Tool whose retry is unsafe; null = every financial tool. */
  tool: string | null;
  amountBaseUnits: string | null;
  since: number;
  detail: string;
}>;
/** How a team tool depends on providers and people (agent-runtime supplies these). */
export type ToolBinding = Readonly<{
  tool: string;
  providerId: string | null;
  needsHuman: boolean;
  financial: boolean;
}>;
export type ToolStatus =
  | 'AVAILABLE'
  | 'UNVERIFIED'
  | 'UNAVAILABLE'
  | 'NEEDS_CREDENTIALS'
  | 'UNHEALTHY'
  | 'NEEDS_HUMAN'
  | 'PENDING_OUTCOME';
export type ToolAvailability = Readonly<{
  tool: string;
  providerId: string | null;
  status: ToolStatus;
  /** Names only, never values. */
  missingCredentials: readonly string[];
  reason: string;
}>;

export type SupportedChain = Readonly<{
  chain: ChainName;
  chainId: number;
  environment: string;
  mutationEnabled: boolean;
  cctpDomain: number | null;
}>;

export type ArcWorldReaders = Partial<{
  user: Reader<ArcUser>;
  workspace: Reader<ArcWorkspace>;
  memberships: Reader<ArcMembership[]>;
  wallets: Reader<ArcWallet[]>;
  balances: Reader<ChainBalance[]>;
  gatewayAvailable: Reader<GatewayBalance[]>;
  cctpInFlight: Reader<CctpTransfer[]>;
  reserves: Reader<Reserves>;
  receivables: Reader<Receivable[]>;
  payables: Reader<Payable[]>;
  mandates: Reader<MandateSummary[]>;
  pendingApprovals: Reader<PendingApproval[]>;
  workflows: Reader<ActiveWorkflow[]>;
  reconciliation: Reader<Reconciliation>;
  blockers: Reader<Blocker[]>;
  pendingOutcomes: Reader<PendingOutcome[]>;
}>;

export type ProviderProbe = Readonly<{
  providerId: string;
  label: string;
  sdkInstalled: boolean;
  /** Every listed variable must be set; only presence is checked. */
  credentialEnv: readonly string[];
  capabilities: readonly string[];
  blockerRef?: string;
  check?: () => Promise<{ ok: boolean; detail: string; observedAt: number }>;
}>;

/** Arc-side providers the finance team may depend on. */
export const ARC_PROVIDERS: readonly Omit<
  ProviderProbe,
  'sdkInstalled' | 'check'
>[] = [
  {
    providerId: 'CIRCLE_WALLETS',
    label: 'Circle Developer-Controlled / Agent Wallets',
    credentialEnv: ['CIRCLE_API_KEY', 'CIRCLE_ENTITY_SECRET'],
    capabilities: ['AGENT_WALLET_CREATE', 'AGENT_WALLET_TRANSFER'],
    blockerRef: 'reports/blockers/P03-20261016-circle-credentials.md',
  },
  {
    providerId: 'CIRCLE_GATEWAY',
    label: 'Circle Gateway unified balance',
    credentialEnv: [],
    capabilities: ['GATEWAY_BALANCE_READ', 'GATEWAY_TRANSFER_TO_ARC'],
  },
  {
    providerId: 'CIRCLE_CCTP',
    label: 'Circle CCTP V2',
    credentialEnv: [],
    capabilities: ['CCTP_ATTESTATION_READ', 'CCTP_PAY_IN_TO_ARC'],
  },
  {
    providerId: 'ARC_RPC',
    label: 'Arc testnet JSON-RPC',
    credentialEnv: [],
    capabilities: ['ARC_BALANCE_READ', 'ARC_TRANSFER_BROADCAST'],
  },
];

export type FieldPolicy = Readonly<{
  maxAgeSeconds: number;
  critical: boolean;
}>;
export const ARC_FIELD_POLICY = {
  'identity.user': { maxAgeSeconds: 86_400, critical: true },
  'identity.workspace': { maxAgeSeconds: 86_400, critical: true },
  'identity.memberships': { maxAgeSeconds: 3_600, critical: true },
  'identity.wallets': { maxAgeSeconds: 3_600, critical: true },
  'treasury.balances': { maxAgeSeconds: 60, critical: true },
  'treasury.gatewayAvailable': { maxAgeSeconds: 300, critical: false },
  'treasury.cctpInFlight': { maxAgeSeconds: 300, critical: false },
  'treasury.reserves': { maxAgeSeconds: 300, critical: true },
  'obligations.receivables': { maxAgeSeconds: 900, critical: false },
  'obligations.payables': { maxAgeSeconds: 900, critical: true },
  'obligations.mandates': { maxAgeSeconds: 300, critical: true },
  'obligations.pendingApprovals': { maxAgeSeconds: 300, critical: false },
  'operations.workflows': { maxAgeSeconds: 300, critical: false },
  'operations.reconciliation': { maxAgeSeconds: 900, critical: false },
  'operations.blockers': { maxAgeSeconds: 3_600, critical: false },
  'operations.pendingOutcomes': { maxAgeSeconds: 300, critical: false },
  'capabilities.providers': { maxAgeSeconds: 300, critical: false },
} as const satisfies Record<string, FieldPolicy>;
export type ArcFieldPath = keyof typeof ARC_FIELD_POLICY;

export type ArcWorldSnapshot = Readonly<{
  schema: 'synq.arc.world/1';
  builtAt: number;
  primaryChain: ChainName;
  identity: {
    user: Observed<ArcUser | null>;
    workspace: Observed<ArcWorkspace | null>;
    memberships: Observed<ArcMembership[]>;
    wallets: Observed<ArcWallet[]>;
  };
  treasury: {
    balances: Observed<ChainBalance[]>;
    gatewayAvailable: Observed<GatewayBalance[]>;
    cctpInFlight: Observed<CctpTransfer[]>;
    reserves: Observed<Reserves | null>;
    /** Derived: confirmed primary-chain USDC minus reservations, escrow and reserve floor. */
    availableToSpend: Observed<string | null>;
  };
  obligations: {
    receivables: Observed<Receivable[]>;
    payables: Observed<Payable[]>;
    mandates: Observed<MandateSummary[]>;
    pendingApprovals: Observed<PendingApproval[]>;
  };
  capabilities: {
    providers: Observed<ProviderStatus>[];
    supportedChains: Observed<SupportedChain[]>;
    missing: string[];
    /** Team tools the caller bound to providers (input). */
    toolBindings: readonly ToolBinding[];
    /** Derived at use time: what each tool can do right now, and why not. */
    tools: ToolAvailability[];
  };
  operations: {
    workflows: Observed<ActiveWorkflow[]>;
    reconciliation: Observed<Reconciliation | null>;
    blockers: Observed<Blocker[]>;
    pendingOutcomes: Observed<PendingOutcome[]>;
  };
  decision: {
    decisionGrade: boolean;
    staleCritical: string[];
    reasons: string[];
  };
}>;

const lower = (s: string) => s.toLowerCase();

async function read<T>(
  path: ArcFieldPath,
  reader: Reader<T> | undefined,
  empty: T,
  now: number,
): Promise<Observed<T>> {
  const policy: FieldPolicy = ARC_FIELD_POLICY[path];
  if (!reader)
    return unknownField(empty, 'CONFIG', `unconfigured:${path}`, 'no source');
  let r: Reading<T>;
  try {
    r = await reader();
  } catch (error) {
    return unknownField(
      empty,
      'CONFIG',
      `failed:${path}`,
      `source failed: ${errorCode(error)}`,
    );
  }
  const freshness = ageFreshness(r.observedAt, now, policy.maxAgeSeconds);
  return observed(
    r.value,
    fieldMeta({
      provenance: r.provenance,
      source: r.source.slice(0, 128),
      observedAt: r.observedAt,
      freshness,
      ...(freshness === 'FRESH'
        ? {}
        : {
            reason:
              freshness === 'STALE'
                ? `observed ${now - r.observedAt}s ago; max ${policy.maxAgeSeconds}s`
                : 'observation time is in the future',
          }),
    }),
  );
}

async function probeProvider(
  probe: ProviderProbe,
  env: Readonly<Record<string, string | undefined>>,
  now: number,
): Promise<Observed<ProviderStatus>> {
  const missing = probe.credentialEnv.filter(
    (name) => (env[name] ?? '').trim().length === 0,
  );
  const base = {
    providerId: probe.providerId,
    label: probe.label,
    sdkInstalled: probe.sdkInstalled,
    credentialsPresent: missing.length === 0,
    missingCredentials: missing,
    capabilities: [...probe.capabilities],
  };
  const configMeta = (reason: string): FieldMeta =>
    fieldMeta({
      provenance: 'CONFIG',
      source: `provider-config:${probe.providerId}`,
      observedAt: now,
      freshness: 'FRESH',
      reason,
    });
  if (!probe.sdkInstalled)
    return observed(
      {
        ...base,
        status: 'UNAVAILABLE',
        condition: 'SDK_MISSING',
        reason: 'SDK not installed',
      },
      configMeta('SDK not installed'),
    );
  if (missing.length)
    return observed(
      {
        ...base,
        status: 'UNAVAILABLE',
        condition: 'NEEDS_CREDENTIALS',
        reason: `credentials missing: ${missing.join(', ')}${probe.blockerRef ? ` (see ${probe.blockerRef})` : ''}`,
      },
      configMeta('credentials missing'),
    );
  if (!probe.check)
    return observed(
      {
        ...base,
        status: 'UNVERIFIED',
        condition: 'UNCHECKED',
        reason: 'installed and configured but never health-checked',
      },
      configMeta('no health check'),
    );
  try {
    const r = await probe.check();
    const freshness = ageFreshness(
      r.observedAt,
      now,
      ARC_FIELD_POLICY['capabilities.providers'].maxAgeSeconds,
    );
    const status: ProviderStatus['status'] = !r.ok
      ? 'UNAVAILABLE'
      : freshness === 'FRESH'
        ? 'AVAILABLE'
        : 'UNVERIFIED';
    return observed(
      {
        ...base,
        status,
        condition: !r.ok
          ? 'UNHEALTHY'
          : freshness === 'FRESH'
            ? 'OK'
            : 'STALE_CHECK',
        reason: r.ok
          ? freshness === 'FRESH'
            ? r.detail.slice(0, 200)
            : 'last successful health check is stale'
          : `health check failed: ${r.detail.slice(0, 160)}`,
      },
      fieldMeta({
        provenance: 'PLUGIN',
        source: `health:${probe.providerId}`,
        observedAt: r.observedAt,
        freshness,
      }),
    );
  } catch (error) {
    return observed(
      {
        ...base,
        status: 'UNAVAILABLE',
        condition: 'UNHEALTHY',
        reason: `health check threw ${errorCode(error)}`,
      },
      fieldMeta({
        provenance: 'PLUGIN',
        source: `health:${probe.providerId}`,
        observedAt: now,
        freshness: 'FRESH',
        reason: 'health check threw',
      }),
    );
  }
}

function deriveAvailable(
  primary: ChainName,
  wallets: Observed<ArcWallet[]>,
  balances: Observed<ChainBalance[]>,
  reserves: Observed<Reserves | null>,
): Observed<string | null> {
  const source = 'derived:arc-usdc-treasury - reservations - escrow - reserve';
  const inputs = [balances.meta, reserves.meta, wallets.meta];
  const freshness = worstFreshness(inputs.map((m) => m.freshness));
  const times = inputs.map((m) => m.observedAt);
  const observedAt = times.some((t) => t === null)
    ? null
    : Math.min(...(times as number[]));
  const treasury = wallets.value
    .filter((w) => w.role === 'TREASURY' && w.chain === primary)
    .map((w) => lower(w.address));
  if (!reserves.value || !treasury.length || freshness === 'UNKNOWN')
    return observed(
      null,
      fieldMeta({
        provenance: 'KERNEL',
        source,
        observedAt,
        freshness: 'UNKNOWN',
        reason: 'treasury balance, wallets or reserves unknown',
      }),
    );
  const confirmed = balances.value
    .filter(
      (b) =>
        b.chain === primary &&
        b.asset === 'USDC' &&
        treasury.includes(lower(b.account)),
    )
    .reduce((a, b) => a + BigInt(b.baseUnits), 0n);
  const committed =
    BigInt(reserves.value.reservations) + BigInt(reserves.value.escrow);
  const free = confirmed - committed - BigInt(reserves.value.minimumReserve);
  return observed(
    (free > 0n ? free : 0n).toString(),
    fieldMeta({
      provenance: 'KERNEL',
      source,
      observedAt,
      freshness,
      ...(freshness === 'FRESH' ? {} : { reason: 'derived from stale input' }),
    }),
  );
}

export async function buildArcWorldSnapshot(input: {
  readers: ArcWorldReaders;
  providers: readonly ProviderProbe[];
  /** Used only for credential presence checks; values are never copied. */
  env: Readonly<Record<string, string | undefined>>;
  now: number;
  primaryChain?: ChainName;
  /** Team tools to report availability for (see `ToolBinding`). */
  tools?: readonly ToolBinding[];
}): Promise<ArcWorldSnapshot> {
  const { readers: r, now } = input;
  const primaryChain = input.primaryChain ?? 'arc-testnet';
  const [
    user,
    workspace,
    memberships,
    wallets,
    balances,
    gatewayAvailable,
    cctpInFlight,
    reserves,
    receivables,
    payables,
    mandates,
    pendingApprovals,
    workflows,
    reconciliation,
    blockerReading,
    pendingOutcomes,
    providers,
  ] = await Promise.all([
    read('identity.user', r.user, null, now),
    read('identity.workspace', r.workspace, null, now),
    read('identity.memberships', r.memberships, [], now),
    read('identity.wallets', r.wallets, [], now),
    read('treasury.balances', r.balances, [], now),
    read('treasury.gatewayAvailable', r.gatewayAvailable, [], now),
    read('treasury.cctpInFlight', r.cctpInFlight, [], now),
    read('treasury.reserves', r.reserves, null, now),
    read('obligations.receivables', r.receivables, [], now),
    read('obligations.payables', r.payables, [], now),
    read('obligations.mandates', r.mandates, [], now),
    read('obligations.pendingApprovals', r.pendingApprovals, [], now),
    read('operations.workflows', r.workflows, [], now),
    read('operations.reconciliation', r.reconciliation, null, now),
    read('operations.blockers', r.blockers, [], now),
    read('operations.pendingOutcomes', r.pendingOutcomes, [], now),
    Promise.all(input.providers.map((p) => probeProvider(p, input.env, now))),
  ]);
  const availableToSpend = deriveAvailable(
    primaryChain,
    wallets,
    balances,
    reserves,
  );
  const providerBlockers: Blocker[] = providers
    .filter((p) => p.value.status === 'UNAVAILABLE')
    .map((p) => ({
      code: `PROVIDER_UNAVAILABLE:${p.value.providerId}`,
      detail: p.value.reason,
      ref:
        input.providers.find((x) => x.providerId === p.value.providerId)
          ?.blockerRef ?? null,
    }));
  const blockers = observed(
    [...blockerReading.value, ...providerBlockers],
    blockerReading.meta,
  );
  const supportedChains = observed(
    Object.values(CHAINS).map((c) => ({
      chain: c.name,
      chainId: c.chainId,
      environment: c.environment,
      mutationEnabled: c.mutationEnabled,
      cctpDomain: c.cctpDomain,
    })),
    fieldMeta({
      provenance: 'CONFIG',
      source: 'chain-registry:arc',
      observedAt: now,
      freshness: 'FRESH',
    }),
  );
  const draft: ArcWorldSnapshot = {
    schema: 'synq.arc.world/1',
    builtAt: now,
    primaryChain,
    identity: { user, workspace, memberships, wallets },
    treasury: {
      balances,
      gatewayAvailable,
      cctpInFlight,
      reserves,
      availableToSpend,
    },
    obligations: { receivables, payables, mandates, pendingApprovals },
    capabilities: {
      providers,
      supportedChains,
      missing: [],
      toolBindings: [...(input.tools ?? [])],
      tools: [],
    },
    operations: { workflows, reconciliation, blockers, pendingOutcomes },
    decision: { decisionGrade: false, staleCritical: [], reasons: [] },
  };
  const snapshot = evaluateArcSnapshot(draft, now);
  for (const f of snapshotFields(snapshot)) FieldMetaSchema.parse(f.meta);
  return snapshot;
}

const CRITICAL_PATHS = (
  Object.entries(ARC_FIELD_POLICY) as [ArcFieldPath, FieldPolicy][]
)
  .filter(([, p]) => p.critical)
  .map(([path]) => path);
/** A snapshot older than this is never decision-grade, whatever its fields say. */
export const MAX_DECISION_SNAPSHOT_AGE_SECONDS = Math.min(
  ...CRITICAL_PATHS.map((p) => ARC_FIELD_POLICY[p].maxAgeSeconds),
);

function reage<T>(
  o: Observed<T>,
  maxAgeSeconds: number,
  now: number,
): Observed<T> {
  const m = o.meta;
  if (m.freshness === 'UNKNOWN' || m.observedAt === null) return o;
  const aged = ageFreshness(m.observedAt, now, maxAgeSeconds);
  const freshness = worstFreshness([m.freshness, aged]);
  if (freshness === 'FRESH') return o;
  return observed(
    o.value,
    fieldMeta({
      provenance: m.provenance,
      source: m.source,
      observedAt: m.observedAt,
      freshness,
      reason:
        freshness === 'STALE'
          ? `observed ${now - m.observedAt}s ago; max ${maxAgeSeconds}s`
          : 'observation time is in the future',
    }),
  );
}

/**
 * Re-evaluates freshness and the decision at use time (`now`), from each
 * field's observedAt. Call it whenever a snapshot is used later than it was
 * built: freshness never improves with time, and a snapshot older than the
 * smallest critical max-age is not decision-grade.
 */
export function evaluateArcSnapshot(
  s: ArcWorldSnapshot,
  now: number,
): ArcWorldSnapshot {
  const at = <T>(path: ArcFieldPath, o: Observed<T>) =>
    reage(o, ARC_FIELD_POLICY[path].maxAgeSeconds, now);
  const identity = {
    user: at('identity.user', s.identity.user),
    workspace: at('identity.workspace', s.identity.workspace),
    memberships: at('identity.memberships', s.identity.memberships),
    wallets: at('identity.wallets', s.identity.wallets),
  };
  const balances = at('treasury.balances', s.treasury.balances);
  const reserves = at('treasury.reserves', s.treasury.reserves);
  const derivedFreshness = worstFreshness([
    s.treasury.availableToSpend.meta.freshness,
    balances.meta.freshness,
    reserves.meta.freshness,
    identity.wallets.meta.freshness,
  ]);
  const availableToSpend =
    derivedFreshness === s.treasury.availableToSpend.meta.freshness
      ? s.treasury.availableToSpend
      : observed(
          s.treasury.availableToSpend.value,
          fieldMeta({
            provenance: s.treasury.availableToSpend.meta.provenance,
            source: s.treasury.availableToSpend.meta.source,
            observedAt: s.treasury.availableToSpend.meta.observedAt,
            freshness: derivedFreshness,
            reason: 'derived from stale input',
          }),
        );
  const treasury = {
    balances,
    gatewayAvailable: at(
      'treasury.gatewayAvailable',
      s.treasury.gatewayAvailable,
    ),
    cctpInFlight: at('treasury.cctpInFlight', s.treasury.cctpInFlight),
    reserves,
    availableToSpend,
  };
  const obligations = {
    receivables: at('obligations.receivables', s.obligations.receivables),
    payables: at('obligations.payables', s.obligations.payables),
    mandates: at('obligations.mandates', s.obligations.mandates),
    pendingApprovals: at(
      'obligations.pendingApprovals',
      s.obligations.pendingApprovals,
    ),
  };
  const operations = {
    workflows: at('operations.workflows', s.operations.workflows),
    reconciliation: at(
      'operations.reconciliation',
      s.operations.reconciliation,
    ),
    blockers: at('operations.blockers', s.operations.blockers),
    pendingOutcomes: at(
      'operations.pendingOutcomes',
      s.operations.pendingOutcomes,
    ),
  };
  const providers = s.capabilities.providers.map((p) => {
    if (p.meta.provenance === 'CONFIG') return p;
    const aged = at('capabilities.providers', p);
    return aged.meta.freshness !== 'FRESH' && p.value.status === 'AVAILABLE'
      ? observed(
          {
            ...p.value,
            status: 'UNVERIFIED' as const,
            condition: 'STALE_CHECK' as const,
            reason: 'last successful health check is stale',
          },
          aged.meta,
        )
      : aged;
  });
  const metas: Record<string, FieldMeta> = {
    'identity.user': identity.user.meta,
    'identity.workspace': identity.workspace.meta,
    'identity.memberships': identity.memberships.meta,
    'identity.wallets': identity.wallets.meta,
    'treasury.balances': balances.meta,
    'treasury.reserves': reserves.meta,
    'obligations.payables': obligations.payables.meta,
    'obligations.mandates': obligations.mandates.meta,
    'treasury.availableToSpend': availableToSpend.meta,
  };
  const staleCritical: string[] = [];
  const reasons: string[] = [];
  for (const [path, m] of Object.entries(metas))
    if (m.freshness !== 'FRESH') {
      staleCritical.push(path);
      reasons.push(
        `${path} is ${m.freshness} (${m.source}${m.reason ? `: ${m.reason}` : ''})`,
      );
    }
  const snapshotAge = now - s.builtAt;
  if (snapshotAge > MAX_DECISION_SNAPSHOT_AGE_SECONDS) {
    staleCritical.push('snapshot');
    reasons.push(
      `snapshot built ${snapshotAge}s ago; max ${MAX_DECISION_SNAPSHOT_AGE_SECONDS}s before money can move`,
    );
  }
  const user = identity.user.value;
  if (!user) {
    staleCritical.push('identity.user');
    reasons.push('no current user');
  } else if (
    !identity.memberships.value.some(
      (m) => m.principalId === user.principalId && m.verified,
    )
  ) {
    staleCritical.push('identity.memberships');
    reasons.push('current user has no verified membership in the workspace');
  }
  if (!identity.workspace.value) {
    staleCritical.push('identity.workspace');
    reasons.push('no current workspace');
  }
  return {
    ...s,
    identity,
    treasury,
    obligations,
    operations,
    capabilities: {
      ...s.capabilities,
      providers,
      missing: providers
        .filter((p) => p.value.status !== 'AVAILABLE')
        .flatMap((p) => p.value.capabilities),
      tools: toolAvailability(
        s.capabilities.toolBindings,
        providers.map((p) => p.value),
        operations.pendingOutcomes,
      ),
    },
    decision: {
      decisionGrade: staleCritical.length === 0,
      staleCritical: [...new Set(staleCritical)],
      reasons,
    },
  };
}

/**
 * What each bound tool can do right now. Provider problems come first
 * (missing SDK, missing credentials, failed or stale health check); then an
 * unconfirmed financial outcome blocks retrying a financial tool; then a
 * tool that needs a human says so. Unknown pending-outcome state is never
 * read as "nothing pending".
 */
export function toolAvailability(
  bindings: readonly ToolBinding[],
  providers: readonly ProviderStatus[],
  pending: Observed<PendingOutcome[]>,
): ToolAvailability[] {
  return bindings.map((b) => {
    const base = { tool: b.tool, providerId: b.providerId };
    const p = b.providerId
      ? providers.find((x) => x.providerId === b.providerId)
      : null;
    if (b.providerId && !p)
      return {
        ...base,
        status: 'UNAVAILABLE',
        missingCredentials: [],
        reason: `${b.providerId} is not configured in this deployment`,
      };
    if (p && p.status !== 'AVAILABLE') {
      const status: ToolStatus =
        p.condition === 'NEEDS_CREDENTIALS'
          ? 'NEEDS_CREDENTIALS'
          : p.condition === 'UNHEALTHY'
            ? 'UNHEALTHY'
            : p.condition === 'SDK_MISSING'
              ? 'UNAVAILABLE'
              : 'UNVERIFIED';
      return {
        ...base,
        status,
        missingCredentials: [...p.missingCredentials],
        reason: `${p.label}: ${p.reason}`,
      };
    }
    if (b.financial) {
      if (
        pending.meta.freshness === 'UNKNOWN' ||
        pending.meta.freshness === 'STALE' ||
        pending.meta.observedAt === null
      )
        return {
          ...base,
          status: 'UNVERIFIED',
          missingCredentials: [],
          reason: 'pending financial outcomes are unknown; not safe to retry',
        };
      const hit = pending.value.filter(
        (o) => o.tool === null || o.tool === b.tool,
      );
      if (hit.length)
        return {
          ...base,
          status: 'PENDING_OUTCOME',
          missingCredentials: [],
          reason:
            `unconfirmed: ${hit.map((o) => `${o.kind} ${o.ref}`).join(', ')}`.slice(
              0,
              300,
            ),
        };
    }
    if (b.needsHuman)
      return {
        ...base,
        status: 'NEEDS_HUMAN',
        missingCredentials: [],
        reason:
          'needs the owner (wallet signature or review) before it takes effect',
      };
    return {
      ...base,
      status: 'AVAILABLE',
      missingCredentials: [],
      reason: p ? p.reason : 'deterministic, in-process',
    };
  });
}

/**
 * Confirmed primary-chain treasury USDC minus reservations and escrow, before
 * the reserve floor. May be negative; null when unknown.
 */
export function cashBeforeBuffer(s: ArcWorldSnapshot): bigint | null {
  const reserves = s.treasury.reserves.value;
  const treasury = s.identity.wallets.value
    .filter((w) => w.role === 'TREASURY' && w.chain === s.primaryChain)
    .map((w) => lower(w.address));
  if (
    !reserves ||
    !treasury.length ||
    s.treasury.availableToSpend.value === null
  )
    return null;
  const confirmed = s.treasury.balances.value
    .filter(
      (b) =>
        b.chain === s.primaryChain &&
        b.asset === 'USDC' &&
        treasury.includes(lower(b.account)),
    )
    .reduce((a, b) => a + BigInt(b.baseUnits), 0n);
  return confirmed - BigInt(reserves.reservations) - BigInt(reserves.escrow);
}

export type FieldCitation = Readonly<{
  path: string;
  provenance: Provenance;
  source: string;
  observedAt: number | null;
  freshness: FieldFreshness;
  ageSeconds: number | null;
}>;

/** Every observed field of the snapshot with its metadata (for citations and audits). */
export function snapshotFields(
  s: ArcWorldSnapshot,
): { path: string; meta: FieldMeta }[] {
  const out: { path: string; meta: FieldMeta }[] = [];
  for (const [group, fields] of Object.entries({
    identity: s.identity,
    treasury: s.treasury,
    obligations: s.obligations,
    operations: s.operations,
  }))
    for (const [name, field] of Object.entries(fields))
      out.push({
        path: `${group}.${name}`,
        meta: (field as Observed<unknown>).meta,
      });
  s.capabilities.providers.forEach((p) =>
    out.push({
      path: `capabilities.providers.${p.value.providerId}`,
      meta: p.meta,
    }),
  );
  out.push({
    path: 'capabilities.supportedChains',
    meta: s.capabilities.supportedChains.meta,
  });
  return out;
}

export function cite(
  s: ArcWorldSnapshot,
  path: string,
  now: number = s.builtAt,
): FieldCitation {
  const hit = snapshotFields(s).find((f) => f.path === path);
  if (!hit) throw new Error(`unknown snapshot field ${path}`);
  return {
    path,
    provenance: hit.meta.provenance,
    source: hit.meta.source,
    observedAt: hit.meta.observedAt,
    freshness: hit.meta.freshness,
    ageSeconds: hit.meta.observedAt === null ? null : now - hit.meta.observedAt,
  };
}

export function providerStatus(
  s: ArcWorldSnapshot,
  providerId: string,
): ProviderStatus['status'] {
  return (
    s.capabilities.providers.find((p) => p.value.providerId === providerId)
      ?.value.status ?? 'UNAVAILABLE'
  );
}

/** Six-decimal base units to a display string ("1234.5"). */
export function usdcDisplay(baseUnits: string | bigint): string {
  const v = BigInt(baseUnits);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
