import { CHAINS, type ChainName } from '@synq/chain-registry/arc';

/**
 * Arc route ladder. Routes are not fungible: each is evaluated from evidence
 * (balances, signer kind, live fee quotes, health), never from a model's
 * preference. The cheapest feasible route within policy wins; when nothing is
 * feasible the plan is an honest HUMAN_HANDOFF with every reason listed.
 *
 * Amounts are 6-decimal USDC base units on every chain in this ladder.
 */

export const ARC_ROUTES = [
  'ARC_USDC_DIRECT',
  'CCTP_V2_TRANSFER',
  'GATEWAY_SPEND',
  'HUMAN_HANDOFF',
] as const;
export type ArcRoute = (typeof ARC_ROUTES)[number];

export type SignerKind = 'EOA' | 'CIRCLE_SCA' | 'OPERATOR_KEY' | 'PASSKEY';

export type FeeQuote = Readonly<{
  /** Fee charged by the route provider, in USDC base units. */
  fee: bigint;
  quotedAt: number;
  expiresAt: number;
  source: string;
}>;

export type RouteEvidence = Readonly<{
  receiverChain: ChainName;
  recipientAmount: bigint;
  signerKind: SignerKind;
  /** Freely spendable wallet USDC per chain (already net of reservations). */
  walletFree: Partial<Record<ChainName, bigint>>;
  /** Gateway unified balance that the API reports as available (pending deposits excluded). */
  gatewayAvailable: Partial<Record<ChainName, bigint>>;
  /** USDC to keep back for Arc gas when paying on Arc directly (Arc gas is paid in USDC). */
  arcGasReserve: bigint;
  /** Native gas available on non-Arc source chains, as a yes/no read from balances. */
  sourceGasOk: Partial<Record<ChainName, boolean>>;
  cctpQuotes: Partial<Record<ChainName, FeeQuote>>;
  gatewayQuotes: Partial<Record<ChainName, FeeQuote>>;
  health: Partial<Record<ArcRoute, 'UP' | 'DEGRADED' | 'DOWN'>>;
  now: number;
}>;

export type RoutePolicy = Readonly<{
  allowed: readonly ArcRoute[];
  /** Fee ceiling as basis points of the recipient amount. */
  maxFeeBps: number;
  /** Absolute fee ceiling in USDC base units. */
  maxFee: bigint;
}>;

export const DEFAULT_ROUTE_POLICY: RoutePolicy = {
  allowed: ['ARC_USDC_DIRECT', 'CCTP_V2_TRANSFER', 'GATEWAY_SPEND'],
  maxFeeBps: 100,
  maxFee: 2_000_000n,
};

export type RouteOption = Readonly<{
  route: Exclude<ArcRoute, 'HUMAN_HANDOFF'>;
  sourceChain: ChainName;
  destinationChain: ChainName;
  recipientAmount: bigint;
  fee: bigint;
  gross: bigint;
  /** Rough settlement latency, used only to break fee ties. */
  latencySeconds: number;
  quoteExpiresAt: number | null;
  legs: readonly string[];
}>;

export type Rejection = Readonly<{
  route: ArcRoute;
  sourceChain: ChainName | null;
  reasons: readonly string[];
}>;

export type PaymentPlan = Readonly<{
  chosen: RouteOption | { route: 'HUMAN_HANDOFF'; reasons: readonly string[] };
  alternatives: readonly RouteOption[];
  rejected: readonly Rejection[];
}>;

export class RouteError extends Error {
  constructor(
    readonly code:
      | 'QUOTE_EXPIRED'
      | 'ROUTE_CHANGED'
      | 'FEE_INCREASED'
      | 'BALANCE_CHANGED'
      | 'HANDOFF',
    message: string = code,
  ) {
    super(message);
    this.name = 'RouteError';
  }
}

const SOURCES: readonly ChainName[] = [
  'eth-sepolia',
  'base-sepolia',
  'arb-sepolia',
  'arc-testnet',
];

function feeWithinPolicy(
  fee: bigint,
  amount: bigint,
  p: RoutePolicy,
): string[] {
  const out: string[] = [];
  if (fee > p.maxFee) out.push(`FEE_ABOVE_CAP ${fee} > ${p.maxFee}`);
  if (fee * 10_000n > amount * BigInt(p.maxFeeBps))
    out.push(`FEE_ABOVE_BPS ${fee} on ${amount} exceeds ${p.maxFeeBps}bps`);
  return out;
}

function quoteReasons(q: FeeQuote | undefined, now: number): string[] {
  if (!q) return ['NO_QUOTE'];
  return q.expiresAt <= now ? [`QUOTE_EXPIRED at ${q.expiresAt}`] : [];
}

/** Evaluate every route and rank the feasible ones: lowest fee, then lowest latency. */
export function planArcPayment(
  e: RouteEvidence,
  policy: RoutePolicy = DEFAULT_ROUTE_POLICY,
): PaymentPlan {
  const options: RouteOption[] = [];
  const rejected: Rejection[] = [];
  const dest = CHAINS[e.receiverChain];
  const reject = (
    route: ArcRoute,
    sourceChain: ChainName | null,
    reasons: string[],
  ) => rejected.push({ route, sourceChain, reasons });
  const common = (route: ArcRoute) => {
    const r: string[] = [];
    if (!policy.allowed.includes(route)) r.push('NOT_ALLOWED_BY_POLICY');
    if (e.health[route] === 'DOWN') r.push('ROUTE_DOWN');
    return r;
  };
  if (e.recipientAmount <= 0n) {
    return {
      chosen: { route: 'HUMAN_HANDOFF', reasons: ['NON_POSITIVE_AMOUNT'] },
      alternatives: [],
      rejected: [],
    };
  }
  if (!dest.mutationEnabled) {
    return {
      chosen: {
        route: 'HUMAN_HANDOFF',
        reasons: [`${e.receiverChain} is read-only`],
      },
      alternatives: [],
      rejected: [],
    };
  }

  // 1. Direct USDC on the receiver chain (Arc): the gas reserve comes out of the same USDC.
  {
    const r = common('ARC_USDC_DIRECT');
    if (e.receiverChain !== 'arc-testnet') r.push('RECEIVER_NOT_ON_ARC');
    const free = e.walletFree['arc-testnet'] ?? 0n;
    if (free < e.recipientAmount + e.arcGasReserve)
      r.push(
        `INSUFFICIENT_ARC_USDC ${free} < ${e.recipientAmount} + gas ${e.arcGasReserve}`,
      );
    if (r.length) reject('ARC_USDC_DIRECT', 'arc-testnet', r);
    else
      options.push({
        route: 'ARC_USDC_DIRECT',
        sourceChain: 'arc-testnet',
        destinationChain: 'arc-testnet',
        recipientAmount: e.recipientAmount,
        fee: 0n,
        gross: e.recipientAmount,
        latencySeconds: 1,
        quoteExpiresAt: null,
        legs: ['transfer on Arc'],
      });
  }

  for (const src of SOURCES) {
    if (src === e.receiverChain) continue;
    const srcProfile = CHAINS[src];
    // 2. CCTP V2: burn on source (payer pays the fee from the burned amount), mint on destination.
    {
      const r = common('CCTP_V2_TRANSFER');
      if (srcProfile.cctpDomain === null || dest.cctpDomain === null)
        r.push('NO_CCTP_DOMAIN');
      if (!srcProfile.mutationEnabled) r.push('SOURCE_READ_ONLY');
      if (e.signerKind !== 'EOA') r.push(`SIGNER_${e.signerKind}_UNSUPPORTED`);
      const q = e.cctpQuotes[src];
      r.push(...quoteReasons(q, e.now));
      const fee = q?.fee ?? 0n;
      const gross = e.recipientAmount + fee;
      const free = e.walletFree[src] ?? 0n;
      if (free < gross) r.push(`INSUFFICIENT_SOURCE_USDC ${free} < ${gross}`);
      if (src !== 'arc-testnet' && e.sourceGasOk[src] !== true)
        r.push('NO_SOURCE_GAS');
      if (q) r.push(...feeWithinPolicy(fee, e.recipientAmount, policy));
      if (r.length) reject('CCTP_V2_TRANSFER', src, r);
      else
        options.push({
          route: 'CCTP_V2_TRANSFER',
          sourceChain: src,
          destinationChain: e.receiverChain,
          recipientAmount: e.recipientAmount,
          fee,
          gross,
          latencySeconds: 30,
          quoteExpiresAt: q!.expiresAt,
          legs: [
            `burn on ${src}`,
            'attestation (read)',
            `mint on ${e.receiverChain}`,
          ],
        });
    }
    // 3. Gateway: spend from an already-available unified balance; pending deposits never count.
    {
      const r = common('GATEWAY_SPEND');
      if (e.signerKind !== 'EOA') r.push(`SIGNER_${e.signerKind}_UNSUPPORTED`);
      const q = e.gatewayQuotes[src];
      r.push(...quoteReasons(q, e.now));
      const fee = q?.fee ?? 0n;
      const gross = e.recipientAmount + fee;
      const avail = e.gatewayAvailable[src] ?? 0n;
      if (avail < gross)
        r.push(`INSUFFICIENT_GATEWAY_AVAILABLE ${avail} < ${gross}`);
      if (q) r.push(...feeWithinPolicy(fee, e.recipientAmount, policy));
      if (r.length) reject('GATEWAY_SPEND', src, r);
      else
        options.push({
          route: 'GATEWAY_SPEND',
          sourceChain: src,
          destinationChain: e.receiverChain,
          recipientAmount: e.recipientAmount,
          fee,
          gross,
          latencySeconds: 5,
          quoteExpiresAt: q!.expiresAt,
          legs: [
            `sign burn intent against ${src} balance`,
            'Gateway attestation (API)',
            `mint on ${e.receiverChain}`,
          ],
        });
    }
  }

  options.sort((a, b) =>
    a.fee !== b.fee
      ? a.fee < b.fee
        ? -1
        : 1
      : a.latencySeconds - b.latencySeconds,
  );
  const [best, ...alternatives] = options;
  if (!best)
    return {
      chosen: {
        route: 'HUMAN_HANDOFF',
        reasons: rejected.map(
          (x) =>
            `${x.route}${x.sourceChain ? `@${x.sourceChain}` : ''}: ${x.reasons.join('; ')}`,
        ),
      },
      alternatives: [],
      rejected,
    };
  return { chosen: best, alternatives, rejected };
}

/**
 * Commit barrier: re-plan on fresh evidence right before signing. The chosen
 * route must still be feasible, its quote unexpired and its fee not higher
 * than what the owner approved.
 */
export function revalidateAtCommit(
  approved: RouteOption,
  fresh: RouteEvidence,
  policy: RoutePolicy = DEFAULT_ROUTE_POLICY,
): RouteOption {
  if (approved.quoteExpiresAt !== null && approved.quoteExpiresAt <= fresh.now)
    throw new RouteError(
      'QUOTE_EXPIRED',
      `quote expired at ${approved.quoteExpiresAt}`,
    );
  if (
    fresh.recipientAmount !== approved.recipientAmount ||
    fresh.receiverChain !== approved.destinationChain
  )
    throw new RouteError('ROUTE_CHANGED', 'payment changed since approval');
  const plan = planArcPayment(fresh, policy);
  const all = 'fee' in plan.chosen ? [plan.chosen, ...plan.alternatives] : [];
  const same = all.find(
    (o) => o.route === approved.route && o.sourceChain === approved.sourceChain,
  );
  if (!same) {
    const why = plan.rejected.find(
      (x) =>
        x.route === approved.route && x.sourceChain === approved.sourceChain,
    );
    throw new RouteError(
      'BALANCE_CHANGED',
      `approved route no longer feasible: ${why?.reasons.join('; ') ?? 'unknown'}`,
    );
  }
  if (same.fee > approved.fee)
    throw new RouteError(
      'FEE_INCREASED',
      `${same.fee} > approved ${approved.fee}`,
    );
  return same;
}
