import {
  assetForRole,
  isMutationEnabledChain,
  profileForChainId,
} from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import { requireOfficialAusd } from './ausd.js';
import { contentHash } from './canonical.js';
import {
  bindConversionQuote,
  conversionIntent,
  type ConversionIntent,
  type ConversionVenue,
} from './conversion.js';
import { FundingError, isFundingError } from './errors.js';
import {
  FUNDING_ROUTES,
  FundingRequestSchema,
  type ExecutionMode,
  type FundingRequest,
  type FundingRequestInput,
  type FundingRoute,
  type FundingRouteAdapter,
  type IntentLegQuoter,
  type NormalizedQuote,
  type RouteCapability,
  type TokenRef,
} from './types.js';

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function tokenRefOf(asset: Asset): TokenRef {
  return {
    chainId: asset.chainId,
    address: asset.address.toLowerCase() as `0x${string}`,
    symbol: asset.symbol,
    decimals: asset.decimals,
  };
}

export function modeForChain(chainId: number): ExecutionMode {
  return isMutationEnabledChain(chainId) ? 'REAL_TESTNET' : 'MAINNET_READ_ONLY';
}

/** Rejects any quote whose destination, amounts or expiry differ from the request. */
export function assertQuoteMatches(
  request: FundingRequest,
  quote: NormalizedQuote,
  destination: TokenRef,
  now: number,
): void {
  if (
    quote.destination.chainId !== destination.chainId ||
    quote.destination.address !== destination.address ||
    quote.destination.decimals !== destination.decimals
  )
    throw new FundingError('DESTINATION_MISMATCH', 'quote destination token');
  if (!same(quote.recipient, request.destination.account))
    throw new FundingError('DESTINATION_MISMATCH', 'quote recipient');
  if (
    quote.source.chainId !== request.source.token.chainId ||
    quote.source.address !== request.source.token.address
  )
    throw new FundingError('QUOTE_INVALID', 'quote source token');
  if (quote.amountIn !== request.source.amount)
    throw new FundingError('QUOTE_INVALID', 'quote input amount');
  if (BigInt(quote.minAmountOut) > BigInt(quote.amountOut))
    throw new FundingError('QUOTE_INVALID', 'minAmountOut above amountOut');
  if (quote.expiresAt <= now) throw new FundingError('QUOTE_EXPIRED');
}

/** Bible §19 first route: a member already holding AUSD on the Monad profile chain. */
export class DirectMonadAusdAdapter implements FundingRouteAdapter {
  readonly route = 'DIRECT_MONAD_AUSD' as const;
  constructor(readonly quoteTtlSeconds = 600) {}
  private isDirect(request: FundingRequest): string | null {
    if (request.source.token.chainId !== request.destination.chainId)
      return 'source is on another chain';
    try {
      requireOfficialAusd(
        {
          chainId: request.source.token.chainId,
          address: request.source.token.address,
          decimals: request.source.token.decimals,
        },
        request.destination.chainId,
      );
      return null;
    } catch (error) {
      return isFundingError(error) ? error.code : String(error);
    }
  }
  async capability(request: FundingRequest): Promise<RouteCapability> {
    const reason = this.isDirect(request);
    return {
      route: this.route,
      availability: reason === null ? 'AVAILABLE' : 'UNAVAILABLE',
      reason: reason ?? 'member holds official AUSD on the destination chain',
      mode: modeForChain(request.destination.chainId),
    };
  }
  async quote(request: FundingRequest): Promise<NormalizedQuote> {
    const reason = this.isDirect(request);
    if (reason !== null) throw new FundingError('ROUTE_UNAVAILABLE', reason);
    const body = {
      route: this.route,
      requestId: request.requestId,
      amount: request.source.amount,
    };
    return {
      quoteId: contentHash(body),
      route: this.route,
      provider: 'erc20-transfer',
      mode: modeForChain(request.destination.chainId),
      dry: false,
      source: request.source.token,
      destination: request.destination.token,
      recipient: request.destination.account,
      amountIn: request.source.amount,
      amountOut: request.source.amount,
      minAmountOut: request.source.amount,
      fees: [],
      quotedAt: request.now,
      expiresAt: request.now + this.quoteTtlSeconds,
      timeEstimateSeconds: 2,
      depositAddress: request.destination.account,
      correlationId: request.requestId,
      artifactHash: contentHash(body),
    };
  }
}

export type FundingPlanStatus =
  | 'ROUTED'
  | 'CONVERSION_VENUE_PENDING'
  | 'CONVERSION_REJECTED'
  | 'UNAVAILABLE';
export type FundingPlan = {
  requestId: string;
  status: FundingPlanStatus;
  destinationAsset: Asset;
  capabilities: RouteCapability[];
  selected: FundingRoute | null;
  quote: NormalizedQuote | null;
  conversion: ConversionIntent | null;
  /** AUSD amount the plan may credit at most; credit itself waits for the destination receipt. */
  expectedCreditMin: string | null;
  reasons: string[];
};

export type FundingRouterOptions = {
  adapters: readonly FundingRouteAdapter[];
  /** Intents leg into Monad USDC for BRIDGE_TO_USDC_THEN_CONVERT. */
  intentLeg?: IntentLegQuoter;
  /** Monad-side USDC→AUSD venue (Kuru, filled later); absent ⇒ CONVERSION_VENUE_PENDING. */
  conversionVenue?: ConversionVenue;
};

/**
 * Capability- and quote-driven route selection. Every route reports its
 * availability truthfully; the first AVAILABLE route with a valid quote wins,
 * in the Bible §19 priority order. Nothing here moves value.
 */
export class FundingRouter {
  constructor(readonly options: FundingRouterOptions) {
    const routes = options.adapters.map((a) => a.route);
    if (new Set(routes).size !== routes.length)
      throw new FundingError('INVALID_TRANSITION', 'duplicate route adapter');
    if (routes.includes('BRIDGE_TO_USDC_THEN_CONVERT'))
      throw new FundingError(
        'INVALID_TRANSITION',
        'BRIDGE_TO_USDC_THEN_CONVERT is composed by the router',
      );
  }

  async plan(input: FundingRequestInput): Promise<FundingPlan> {
    const request = FundingRequestSchema.parse(input);
    const ausd = requireOfficialAusd(
      {
        chainId: request.destination.token.chainId,
        address: request.destination.token.address,
        decimals: request.destination.token.decimals,
      },
      request.destination.chainId,
    );
    const destination = tokenRefOf(ausd);
    const capabilities: RouteCapability[] = [];
    const reasons: string[] = [];
    for (const route of FUNDING_ROUTES) {
      if (route === 'BRIDGE_TO_USDC_THEN_CONVERT') continue;
      const adapter = this.options.adapters.find((a) => a.route === route);
      capabilities.push(
        adapter
          ? await adapter.capability(request).catch((error: unknown) => ({
              route,
              availability: 'UNAVAILABLE' as const,
              reason: `capability check failed: ${String(error)}`,
              mode: 'SIMULATION' as const,
            }))
          : {
              route,
              availability: 'UNAVAILABLE',
              reason: 'no adapter registered',
              mode: 'SIMULATION',
            },
      );
    }
    for (const capability of capabilities) {
      if (capability.availability !== 'AVAILABLE') continue;
      const adapter = this.options.adapters.find(
        (a) => a.route === capability.route,
      )!;
      try {
        const quote = await adapter.quote(request);
        assertQuoteMatches(request, quote, destination, request.now);
        return {
          requestId: request.requestId,
          status: 'ROUTED',
          destinationAsset: ausd,
          capabilities: [
            ...capabilities,
            await this.fallbackCapability(request),
          ],
          selected: capability.route,
          quote,
          conversion: null,
          expectedCreditMin: quote.minAmountOut,
          reasons,
        };
      } catch (error) {
        reasons.push(`${capability.route}: ${String(error)}`);
      }
    }
    return this.fallback(request, ausd, capabilities, reasons);
  }

  private async fallbackCapability(
    request: FundingRequest,
  ): Promise<RouteCapability> {
    const leg = this.options.intentLeg;
    const usdc = this.settlementUsdc(request.destination.chainId);
    if (!leg || !usdc)
      return {
        route: 'BRIDGE_TO_USDC_THEN_CONVERT',
        availability: 'UNAVAILABLE',
        reason: !leg ? 'no intents leg' : 'no USDC role on destination',
        mode: 'SIMULATION',
      };
    const supported = await leg.supportsDestination(tokenRefOf(usdc));
    return {
      route: 'BRIDGE_TO_USDC_THEN_CONVERT',
      availability: supported ? 'AVAILABLE' : 'UNAVAILABLE',
      reason: supported
        ? `${leg.provider} routes into USDC on Monad; conversion venue ${this.options.conversionVenue?.venue ?? 'PENDING'}`
        : `${leg.provider} does not route into USDC on this destination`,
      mode: modeForChain(request.destination.chainId),
    };
  }

  private settlementUsdc(chainId: number): Asset | null {
    const profile = profileForChainId(chainId);
    if (!profile) return null;
    try {
      return assetForRole(profile, 'web2SettlementAsset');
    } catch {
      return null;
    }
  }

  private async fallback(
    request: FundingRequest,
    ausd: Asset,
    capabilities: RouteCapability[],
    reasons: string[],
  ): Promise<FundingPlan> {
    const capability = await this.fallbackCapability(request);
    const all = [...capabilities, capability];
    const unavailable = (why: string): FundingPlan => ({
      requestId: request.requestId,
      status: 'UNAVAILABLE',
      destinationAsset: ausd,
      capabilities: all,
      selected: null,
      quote: null,
      conversion: null,
      expectedCreditMin: null,
      reasons: [...reasons, why],
    });
    if (capability.availability !== 'AVAILABLE')
      return unavailable(`BRIDGE_TO_USDC_THEN_CONVERT: ${capability.reason}`);
    const usdc = this.settlementUsdc(request.destination.chainId)!;
    const usdcRef = tokenRefOf(usdc);
    let leg: NormalizedQuote;
    try {
      leg = await this.options.intentLeg!.quoteInto(request, usdcRef);
      assertQuoteMatches(request, leg, usdcRef, request.now);
    } catch (error) {
      return unavailable(`BRIDGE_TO_USDC_THEN_CONVERT leg: ${String(error)}`);
    }
    let conversion = conversionIntent({
      fromAsset: usdc,
      toAsset: ausd,
      amountIn: BigInt(leg.minAmountOut),
      maxSlippageBps: request.maxSlippageBps,
      reference: `${request.requestId}:${leg.quoteId}`,
    });
    const venue = this.options.conversionVenue;
    if (!venue)
      return {
        requestId: request.requestId,
        status: 'CONVERSION_VENUE_PENDING',
        destinationAsset: ausd,
        capabilities: all,
        selected: 'BRIDGE_TO_USDC_THEN_CONVERT',
        quote: leg,
        conversion: {
          ...conversion,
          reason: 'no approved USDC→AUSD venue configured',
        },
        expectedCreditMin: null,
        reasons: [
          ...reasons,
          'AUSD is not routable by intents; USDC leg quoted, conversion venue pending',
        ],
      };
    conversion = bindConversionQuote(
      conversion,
      await venue.quote({
        fromAsset: usdc,
        toAsset: ausd,
        amountIn: BigInt(conversion.amountIn),
        now: request.now,
      }),
      request.now,
    );
    return {
      requestId: request.requestId,
      status: conversion.status === 'QUOTED' ? 'ROUTED' : 'CONVERSION_REJECTED',
      destinationAsset: ausd,
      capabilities: all,
      selected: 'BRIDGE_TO_USDC_THEN_CONVERT',
      quote: leg,
      conversion,
      expectedCreditMin:
        conversion.status === 'QUOTED' ? conversion.minAmountOut : null,
      reasons:
        conversion.status === 'QUOTED'
          ? reasons
          : [...reasons, conversion.reason ?? 'conversion rejected'],
    };
  }
}
