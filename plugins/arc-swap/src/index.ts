import { z } from 'zod';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { money, type Money } from '@synq/domain';
import { token, type TokenSymbol } from '@synq/chain-registry/arc';
import {
  appKitAdapter,
  kitDecimalToUnits,
  type KitStep,
} from '@synq/plugin-circle-app-kit';

/**
 * Same-chain USDC<->EURC swaps on Arc testnet through Circle App Kit Swap.
 *
 * App Kit Swap is the only officially documented swap path on Arc testnet
 * (docs.arc.io/app-kit/swap). Uniswap v4 publishes Arc *mainnet* addresses
 * only, so no Uniswap testnet deployment is used. Arc docs warn that testnet
 * swap liquidity can be unstable; a missing or empty quote fails closed.
 *
 * The policy is set by the owner. An agent may request a swap inside it but
 * cannot change the recipient, the assets, the slippage ceiling or the cap;
 * the signing script runs every kit transaction through `swapPlan` checks.
 */

export const SWAP_HARD_MAX_SLIPPAGE_BPS = 300;
export const SWAP_QUOTE_MAX_AGE_MS = 60_000;

export class SwapError extends Error {
  constructor(
    readonly code:
      | 'PAIR_NOT_ALLOWED'
      | 'AMOUNT_ABOVE_CAP'
      | 'NON_POSITIVE_AMOUNT'
      | 'STALE_QUOTE'
      | 'NO_LIQUIDITY'
      | 'SLIPPAGE_ABOVE_POLICY'
      | 'RECIPIENT_MISMATCH'
      | 'MALFORMED_QUOTE'
      | 'POLICY_INVALID',
    message: string = code,
  ) {
    super(message);
    this.name = 'SwapError';
  }
}

const SwapSymbol = z.enum(['USDC', 'EURC']);
export type SwapPolicy = Readonly<{
  chain: 'arc-testnet';
  pairs: readonly (readonly [TokenSymbol, TokenSymbol])[];
  maxSlippageBps: number;
  maxAmountIn: Money;
  quoteMaxAgeMs?: number;
}>;

export function swapPolicy(p: SwapPolicy): SwapPolicy {
  if (
    !Number.isInteger(p.maxSlippageBps) ||
    p.maxSlippageBps < 1 ||
    p.maxSlippageBps > SWAP_HARD_MAX_SLIPPAGE_BPS
  )
    throw new SwapError(
      'POLICY_INVALID',
      `slippage must be 1..${SWAP_HARD_MAX_SLIPPAGE_BPS} bps`,
    );
  for (const [a, b] of p.pairs) {
    SwapSymbol.parse(a);
    SwapSymbol.parse(b);
    if (a === b) throw new SwapError('POLICY_INVALID', 'pair must differ');
  }
  return Object.freeze({ ...p, pairs: Object.freeze([...p.pairs]) });
}

const Decimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const KitEstimateSchema = z.looseObject({
  tokenIn: SwapSymbol,
  tokenOut: SwapSymbol,
  amountIn: Decimal,
  chain: z.literal('Arc_Testnet'),
  fromAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  toAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  stopLimit: z.looseObject({ amount: Decimal, token: SwapSymbol }),
  estimatedOutput: z.looseObject({ amount: Decimal, token: SwapSymbol }),
  fees: z
    .array(
      z.looseObject({
        token: z.string(),
        amount: Decimal,
        type: z.string(),
      }),
    )
    .default([]),
});

export type SwapQuote = Readonly<{
  amountIn: Money;
  estimatedOut: Money;
  /** Kit's own minimum (estimate minus requested slippage). */
  stopLimit: Money;
  providerFee: Money | null;
  /** The kit's gas estimate in USDC, as a display string (gas is native USDC). */
  gasEstimate: string | null;
  recipient: Address;
  observedAt: number;
}>;

/** Normalises `SwapKit.estimate` output to integer units bound to the registry. */
export function normalizeSwapEstimate(
  raw: unknown,
  opts: { observedAt: number; wallet: Address },
): SwapQuote {
  const e = KitEstimateSchema.parse(raw);
  const tin = token('arc-testnet', e.tokenIn);
  const tout = token('arc-testnet', e.tokenOut);
  if (
    e.stopLimit.token !== e.tokenOut ||
    e.estimatedOutput.token !== e.tokenOut
  )
    throw new SwapError('MALFORMED_QUOTE', 'output token mismatch');
  if (
    !isAddressEqual(e.toAddress as Address, opts.wallet) ||
    !isAddressEqual(e.fromAddress as Address, opts.wallet)
  )
    throw new SwapError(
      'RECIPIENT_MISMATCH',
      `quote pays ${e.toAddress}, wallet is ${opts.wallet}`,
    );
  const providerFee = e.fees.find(
    (f) => f.type === 'provider' && f.token === e.tokenIn,
  );
  const gas = e.fees.find((f) => f.type === 'gas');
  return Object.freeze({
    amountIn: money(tin, kitDecimalToUnits(e.amountIn, tin.decimals)),
    estimatedOut: money(
      tout,
      kitDecimalToUnits(e.estimatedOutput.amount, tout.decimals),
    ),
    stopLimit: money(
      tout,
      kitDecimalToUnits(e.stopLimit.amount, tout.decimals),
    ),
    providerFee: providerFee
      ? money(tin, kitDecimalToUnits(providerFee.amount, tin.decimals))
      : null,
    gasEstimate: gas ? `${gas.amount} ${gas.token}` : null,
    recipient: getAddress(e.toAddress),
    observedAt: opts.observedAt,
  });
}

export type ApprovedSwap = Readonly<{
  quote: SwapQuote;
  /** Lowest acceptable output; any signed instruction below it is refused. */
  minOut: Money;
  impliedSlippageBps: number;
}>;

/**
 * Liquidity, freshness, pair, cap and slippage checks. The floor is computed
 * from the estimate and the policy ceiling, rounded down, and never below the
 * kit's own stop limit.
 */
export function approveSwap(
  quote: SwapQuote,
  policy: SwapPolicy,
  now: number,
): ApprovedSwap {
  const inSym = quote.amountIn.asset.symbol as TokenSymbol;
  const outSym = quote.estimatedOut.asset.symbol as TokenSymbol;
  if (!policy.pairs.some(([a, b]) => a === inSym && b === outSym))
    throw new SwapError('PAIR_NOT_ALLOWED', `${inSym}->${outSym}`);
  if (quote.amountIn.baseUnits <= 0n)
    throw new SwapError('NON_POSITIVE_AMOUNT');
  if (
    quote.amountIn.asset.assetId !== policy.maxAmountIn.asset.assetId ||
    quote.amountIn.baseUnits > policy.maxAmountIn.baseUnits
  )
    throw new SwapError('AMOUNT_ABOVE_CAP', String(quote.amountIn.baseUnits));
  const age = now - quote.observedAt;
  if (age < 0 || age > (policy.quoteMaxAgeMs ?? SWAP_QUOTE_MAX_AGE_MS))
    throw new SwapError('STALE_QUOTE', `${age} ms old`);
  if (quote.estimatedOut.baseUnits <= 0n || quote.stopLimit.baseUnits <= 0n)
    throw new SwapError('NO_LIQUIDITY', 'quote returns no output');
  if (quote.stopLimit.baseUnits > quote.estimatedOut.baseUnits)
    throw new SwapError('MALFORMED_QUOTE', 'stop limit above estimate');
  const impliedSlippageBps = Number(
    ((quote.estimatedOut.baseUnits - quote.stopLimit.baseUnits) * 10_000n) /
      quote.estimatedOut.baseUnits,
  );
  if (impliedSlippageBps > policy.maxSlippageBps)
    throw new SwapError(
      'SLIPPAGE_ABOVE_POLICY',
      `${impliedSlippageBps} bps > ${policy.maxSlippageBps}`,
    );
  const floor =
    (quote.estimatedOut.baseUnits * BigInt(10_000 - policy.maxSlippageBps)) /
    10_000n;
  const minOut =
    floor > quote.stopLimit.baseUnits ? floor : quote.stopLimit.baseUnits;
  return Object.freeze({
    quote,
    minOut: money(quote.estimatedOut.asset, minOut),
    impliedSlippageBps,
  });
}

/** Exactly the transactions the owner approved for this swap, in order. */
export function swapPlan(input: {
  owner: Address;
  approved: ApprovedSwap;
  nowSec: bigint;
}): KitStep[] {
  const { quote, minOut } = input.approved;
  if (!isAddressEqual(quote.recipient, input.owner))
    throw new SwapError('RECIPIENT_MISMATCH', quote.recipient);
  const adapter = appKitAdapter();
  const tin = quote.amountIn.asset.address;
  const tout = quote.estimatedOut.asset.address;
  return [
    {
      kind: 'ALLOWANCE',
      token: tin,
      spender: adapter,
      maxAmount: quote.amountIn.baseUnits,
      optional: true,
    },
    {
      kind: 'EXECUTE',
      adapter,
      beneficiary: input.owner,
      tokenIn: tin,
      maxAmountIn: quote.amountIn.baseUnits,
      tokenOut: tout,
      minOut: minOut.baseUnits,
      maxFeeIn: quote.providerFee?.baseUnits ?? 0n,
      allowedTokens: [tin, tout],
      nowSec: input.nowSec,
      maxDeadlineAheadSec: 3_600n,
    },
  ];
}

/**
 * Post-trade reconciliation: the output actually received must be at least
 * the approved minimum and the input spent exactly the approved amount.
 */
export function reconcileSwap(input: {
  approved: ApprovedSwap;
  spentIn: bigint;
  receivedOut: bigint;
}) {
  const { approved } = input;
  return {
    ok:
      input.spentIn === approved.quote.amountIn.baseUnits &&
      input.receivedOut >= approved.minOut.baseUnits,
    spentIn: input.spentIn,
    receivedOut: input.receivedOut,
    vsEstimate: input.receivedOut - approved.quote.estimatedOut.baseUnits,
  };
}
