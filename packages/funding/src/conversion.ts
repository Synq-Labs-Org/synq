import type { Asset } from '@synq/domain';
import { contentHash } from './canonical.js';
import { FundingError } from './errors.js';

export type ConversionQuote = {
  venue: string;
  quoteId: string;
  amountIn: string;
  amountOut: string;
  expiresAt: number;
  artifactHash: `0x${string}`;
};

/** Monad-side stable conversion venue port; filled by the Kuru adapter. */
export interface ConversionVenue {
  readonly venue: string;
  quote(input: {
    fromAsset: Asset;
    toAsset: Asset;
    amountIn: bigint;
    now: number;
  }): Promise<ConversionQuote>;
}

/**
 * Bible §98: a stable conversion is its own auditable intent, never hidden
 * inside a funding or payment receipt. Amounts are exact base units.
 */
export type ConversionIntent = {
  conversionId: `0x${string}`;
  fromAsset: Asset;
  toAsset: Asset;
  amountIn: string;
  /** Par-equivalent output before slippage, rescaled for decimals. */
  parAmountOut: string;
  minAmountOut: string;
  maxSlippageBps: number;
  status: 'UNQUOTED' | 'QUOTED' | 'REJECTED';
  venue: string | null;
  quote: ConversionQuote | null;
  realizedSlippageBps: number | null;
  reason: string | null;
};

function rescale(amount: bigint, from: number, to: number): bigint {
  if (from === to) return amount;
  return from > to
    ? amount / 10n ** BigInt(from - to)
    : amount * 10n ** BigInt(to - from);
}

export function conversionIntent(input: {
  fromAsset: Asset;
  toAsset: Asset;
  amountIn: bigint;
  maxSlippageBps: number;
  reference: string;
}): ConversionIntent {
  if (input.amountIn <= 0n) throw new FundingError('AMOUNT_INVALID');
  if (
    !Number.isInteger(input.maxSlippageBps) ||
    input.maxSlippageBps < 0 ||
    input.maxSlippageBps > 1000
  )
    throw new FundingError('SLIPPAGE_EXCEEDED', 'slippage bound out of range');
  if (input.fromAsset.chainId !== input.toAsset.chainId)
    throw new FundingError('NETWORK_MISMATCH', 'conversion is single-chain');
  const par = rescale(
    input.amountIn,
    input.fromAsset.decimals,
    input.toAsset.decimals,
  );
  const min = (par * BigInt(10_000 - input.maxSlippageBps)) / 10_000n;
  return {
    conversionId: contentHash({
      kind: 'ConversionIntent',
      reference: input.reference,
      from: input.fromAsset.canonicalAssetId,
      to: input.toAsset.canonicalAssetId,
      amountIn: String(input.amountIn),
    }),
    fromAsset: input.fromAsset,
    toAsset: input.toAsset,
    amountIn: String(input.amountIn),
    parAmountOut: String(par),
    minAmountOut: String(min),
    maxSlippageBps: input.maxSlippageBps,
    status: 'UNQUOTED',
    venue: null,
    quote: null,
    realizedSlippageBps: null,
    reason: null,
  };
}

/** Binds a venue quote to the intent; a quote below the slippage floor is rejected. */
export function bindConversionQuote(
  intent: ConversionIntent,
  quote: ConversionQuote,
  now: number,
): ConversionIntent {
  if (quote.amountIn !== intent.amountIn)
    throw new FundingError('QUOTE_INVALID', 'conversion input differs');
  if (quote.expiresAt <= now) throw new FundingError('QUOTE_EXPIRED');
  const out = BigInt(quote.amountOut);
  const par = BigInt(intent.parAmountOut);
  const realized = par === 0n ? 0 : Number(((par - out) * 10_000n) / par);
  if (out < BigInt(intent.minAmountOut))
    return {
      ...intent,
      status: 'REJECTED',
      venue: quote.venue,
      quote,
      realizedSlippageBps: realized,
      reason: `SLIPPAGE_EXCEEDED: ${realized} bps > ${intent.maxSlippageBps} bps`,
    };
  return {
    ...intent,
    status: 'QUOTED',
    venue: quote.venue,
    quote,
    realizedSlippageBps: Math.max(0, realized),
    reason: null,
  };
}
