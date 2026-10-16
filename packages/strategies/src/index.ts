import { keccak256, stringToHex, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  evaluateDca,
  parseDcaPolicy,
  PRICE_SCALE,
  type DcaAsset,
  type DcaDecision,
  type DcaEvaluationInput,
  type DcaHistory,
  type DcaPolicy,
  type DcaPolicyInput,
} from '@synq/strategy-engine';

/**
 * Arc treasury strategies on top of the deterministic DCA evaluator in
 * `@synq/strategy-engine` (no model call, no clock, no I/O).
 *
 * What this package adds for Arc:
 * - schedules are built from registry assets only (Arc USDC -> EURC through
 *   Circle App Kit Swap), never from model-supplied addresses;
 * - caps are owned by the owner: an agent may narrow a schedule (lower caps,
 *   less often, shorter, pause, stop) but any widening needs an owner approval
 *   bound to the exact new schedule digest;
 * - pause/stop/resume controls, where resume is owner-only;
 * - position accounting from settled fills, reconciled to chain balances.
 */

export const ARC_SWAP_VENUE = 'circle-app-kit-swap';

export class StrategyError extends Error {
  constructor(
    readonly code:
      | 'CAP_EXPANSION_REQUIRES_OWNER'
      | 'OWNER_APPROVAL_INVALID'
      | 'IMMUTABLE_FIELD'
      | 'STOPPED'
      | 'RESUME_REQUIRES_OWNER'
      | 'DUPLICATE_FILL'
      | 'ACCOUNTING',
    message: string = code,
  ) {
    super(message);
    this.name = 'StrategyError';
  }
}

function arcAsset(symbol: 'USDC' | 'EURC'): DcaAsset {
  const t = token('arc-testnet', symbol);
  return {
    symbol: t.symbol,
    address: t.address.toLowerCase() as DcaAsset['address'],
    decimals: t.decimals,
    chainId: t.chainId,
  };
}

export type ArcDcaSchedule = Readonly<{
  policy: DcaPolicy;
  version: number;
  /** keccak256 of the canonical policy; what an owner approval signs. */
  digest: Hex;
  stopped: boolean;
}>;

type Bigintish = bigint | string;
export type ArcDcaTerms = Readonly<{
  strategyId: string;
  startAt: number;
  expiresAt: number;
  frequencySeconds: number;
  baseTranche: Bigintish;
  maxTranche: Bigintish;
  minTranche: Bigintish;
  budget: Bigintish;
  maxDeployment: Bigintish;
  maxAllocationBps: number;
  maxSlippageBps: number;
  maxMarketDataAgeSeconds?: number;
}>;

export function scheduleDigest(policy: DcaPolicy): Hex {
  return keccak256(
    stringToHex(
      JSON.stringify(policy, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)),
    ),
  );
}

/** A USDC -> EURC schedule on Arc testnet from registry assets only. */
export function createArcDcaSchedule(terms: ArcDcaTerms): ArcDcaSchedule {
  const usdc = arcAsset('USDC');
  const eurc = arcAsset('EURC');
  const input: DcaPolicyInput = {
    strategyId: terms.strategyId,
    startAt: terms.startAt,
    expiresAt: terms.expiresAt,
    frequencySeconds: terms.frequencySeconds,
    budgetAsset: usdc,
    targetAsset: eurc,
    allowedAssets: [usdc.address, eurc.address],
    venue: ARC_SWAP_VENUE,
    allowedVenues: [ARC_SWAP_VENUE],
    baseTranche: terms.baseTranche,
    maxTranche: terms.maxTranche,
    minTranche: terms.minTranche,
    budget: terms.budget,
    maxDeployment: terms.maxDeployment,
    maxAllocationBps: terms.maxAllocationBps,
    maxSlippageBps: terms.maxSlippageBps,
    spike: { skipIf24hChangeAboveBps: 800 },
    dip: { multiplierBps: 10_000, triggerBelowTrailingBps: 1 },
    escalateIfAbsMoveAboveBps: 2_000,
    maxMarketDataAgeSeconds: terms.maxMarketDataAgeSeconds ?? 120,
    pause: {
      paused: false,
      pauseOnReferenceStatuses: ['DEGRADED', 'UNKNOWN', 'STALE'],
      pauseOnVenueUnhealthy: true,
    },
  };
  const policy = parseDcaPolicy(input);
  return Object.freeze({
    policy,
    version: 1,
    digest: scheduleDigest(policy),
    stopped: false,
  });
}

/** Verifies an owner's EIP-712 approval of a schedule digest (identity layer). */
export interface OwnerApprovalPort {
  verifyScheduleApproval(input: {
    strategyId: string;
    version: number;
    digest: Hex;
    approval: unknown;
  }): Promise<boolean>;
}

export type Actor =
  | Readonly<{ kind: 'AGENT'; id: string }>
  | Readonly<{ kind: 'OWNER'; id: string; approval: unknown }>;

/** Fields that widen exposure when they go up (or down, for `frequencySeconds`). */
const CAPS_UP = [
  'budget',
  'maxDeployment',
  'maxTranche',
  'baseTranche',
  'maxAllocationBps',
  'maxSlippageBps',
  'expiresAt',
  'maxMarketDataAgeSeconds',
  'escalateIfAbsMoveAboveBps',
] as const;
const IMMUTABLE = [
  'strategyId',
  'startAt',
  'budgetAsset',
  'targetAsset',
  'venue',
] as const;

export type DcaAmendment = Partial<
  Pick<
    DcaPolicy,
    | (typeof CAPS_UP)[number]
    | 'frequencySeconds'
    | 'minTranche'
    | 'allowedAssets'
    | 'allowedVenues'
    | 'spike'
    | 'dip'
  >
> & { paused?: boolean } & Partial<Pick<DcaPolicy, (typeof IMMUTABLE)[number]>>;

/** Every way `next` is wider than `current`; empty means narrowing only. */
export function widenings(current: DcaPolicy, next: DcaPolicy): string[] {
  const out: string[] = [];
  for (const k of CAPS_UP)
    if ((next[k] as bigint | number) > (current[k] as bigint | number))
      out.push(k);
  if (next.frequencySeconds < current.frequencySeconds)
    out.push('frequencySeconds');
  if (next.allowedAssets.some((a) => !current.allowedAssets.includes(a)))
    out.push('allowedAssets');
  if (next.allowedVenues.some((v) => !current.allowedVenues.includes(v)))
    out.push('allowedVenues');
  if (
    next.spike.skipIf24hChangeAboveBps > current.spike.skipIf24hChangeAboveBps
  )
    out.push('spike');
  if (next.dip.multiplierBps > current.dip.multiplierBps) out.push('dip');
  if (current.pause.paused && !next.pause.paused) out.push('paused');
  return out;
}

/**
 * P15-05. An agent may only narrow. Widening, unpausing or touching an
 * immutable field needs the owner, whose approval must verify against the
 * digest of exactly the new schedule.
 */
export async function amendDcaSchedule(input: {
  schedule: ArcDcaSchedule;
  amendment: DcaAmendment;
  actor: Actor;
  approvals?: OwnerApprovalPort;
}): Promise<ArcDcaSchedule> {
  const { schedule, amendment, actor } = input;
  if (schedule.stopped)
    throw new StrategyError('STOPPED', 'a stopped schedule cannot change');
  for (const k of IMMUTABLE)
    if (
      k in amendment &&
      JSON.stringify(amendment[k]) !== JSON.stringify(schedule.policy[k])
    )
      throw new StrategyError('IMMUTABLE_FIELD', k);
  const { paused, ...rest } = amendment;
  const next = parseDcaPolicy({
    ...schedule.policy,
    ...rest,
    pause: {
      ...schedule.policy.pause,
      ...(paused === undefined ? {} : { paused }),
    },
  });
  const wider = widenings(schedule.policy, next);
  const digest = scheduleDigest(next);
  const version = schedule.version + 1;
  if (wider.length) {
    if (actor.kind !== 'OWNER')
      throw new StrategyError(
        'CAP_EXPANSION_REQUIRES_OWNER',
        `agent ${actor.id} cannot widen: ${wider.join(', ')}`,
      );
    const ok = await input.approvals?.verifyScheduleApproval({
      strategyId: next.strategyId,
      version,
      digest,
      approval: actor.approval,
    });
    if (!ok)
      throw new StrategyError(
        'OWNER_APPROVAL_INVALID',
        'owner approval does not verify for this exact schedule',
      );
  }
  return Object.freeze({ policy: next, version, digest, stopped: false });
}

/** Anyone allowed to act on the schedule may pause it. */
export function pauseDcaSchedule(s: ArcDcaSchedule): ArcDcaSchedule {
  if (s.stopped) return s;
  const policy = parseDcaPolicy({
    ...s.policy,
    pause: { ...s.policy.pause, paused: true },
  });
  return Object.freeze({
    policy,
    version: s.version + 1,
    digest: scheduleDigest(policy),
    stopped: false,
  });
}

/** Terminal stop: no further executions, by anyone. */
export function stopDcaSchedule(s: ArcDcaSchedule): ArcDcaSchedule {
  const paused = pauseDcaSchedule(s);
  return Object.freeze({ ...paused, stopped: true });
}

export async function resumeDcaSchedule(input: {
  schedule: ArcDcaSchedule;
  actor: Actor;
  approvals?: OwnerApprovalPort;
}): Promise<ArcDcaSchedule> {
  if (input.actor.kind !== 'OWNER')
    throw new StrategyError('RESUME_REQUIRES_OWNER');
  return amendDcaSchedule({
    schedule: input.schedule,
    amendment: { paused: false },
    actor: input.actor,
    approvals: input.approvals,
  });
}

/** Deterministic decision; a stopped schedule never executes. */
export function evaluateArcDca(
  schedule: ArcDcaSchedule,
  input: Omit<DcaEvaluationInput, 'policy'>,
): DcaDecision | { kind: 'SKIP'; reasons: ['STOPPED'] } {
  if (schedule.stopped) return { kind: 'SKIP', reasons: ['STOPPED'] };
  return evaluateDca({ ...input, policy: schedule.policy });
}

export type DcaFill = Readonly<{
  slot: number;
  intentId: string;
  at: number;
  amountIn: bigint;
  amountOut: bigint;
  txHash: Hex;
}>;

/**
 * Position book from settled fills (amounts read from chain receipts, not
 * quotes). Average cost is budget units per whole target unit, 1e18 scaled,
 * matching the evaluator's price convention.
 */
export class DcaPositionBook {
  readonly fills: DcaFill[] = [];
  constructor(readonly schedule: ArcDcaSchedule) {}

  record(fill: DcaFill) {
    if (fill.amountIn <= 0n || fill.amountOut <= 0n)
      throw new StrategyError('ACCOUNTING', 'fill must move both assets');
    if (
      this.fills.some((f) => f.txHash === fill.txHash || f.slot === fill.slot)
    )
      throw new StrategyError('DUPLICATE_FILL', fill.txHash);
    this.fills.push(fill);
  }

  get spent() {
    return this.fills.reduce((a, f) => a + f.amountIn, 0n);
  }
  get acquired() {
    return this.fills.reduce((a, f) => a + f.amountOut, 0n);
  }

  averageCost(): bigint | null {
    if (this.acquired === 0n) return null;
    const p = this.schedule.policy;
    return (
      (this.spent * PRICE_SCALE * 10n ** BigInt(p.targetAsset.decimals)) /
      (this.acquired * 10n ** BigInt(p.budgetAsset.decimals))
    );
  }

  /** The evaluator's history view: settled fills count against caps. */
  history(exitedPrincipal = 0n): DcaHistory {
    return {
      executions: this.fills.map((f) => ({
        slot: f.slot,
        intentId: f.intentId,
        at: f.at,
        amountIn: f.amountIn,
        status: 'SETTLED' as const,
      })),
      exitedPrincipal,
    };
  }

  /** Book vs chain: target-asset balance gained since the schedule started. */
  reconcile(onchainTargetDelta: bigint) {
    if (onchainTargetDelta !== this.acquired)
      throw new StrategyError(
        'ACCOUNTING',
        `book ${this.acquired} != chain ${onchainTargetDelta}`,
      );
    return true;
  }
}
