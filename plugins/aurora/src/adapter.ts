import {
  FundingError,
  contentHash,
  type FundingRequest,
  type FundingRouteAdapter,
  type FundingSession,
  type IntentLegQuoter,
  type NormalizedQuote,
  type ProviderStatusPort,
  type RouteCapability,
  type TokenRef,
  type FeeLine,
} from '@synq/funding';
import {
  isMutationEnabledChain,
  profileForChainId,
} from '@synq/chain-registry';
import {
  IntentsApiClient,
  type IntentsToken,
  type QuoteResponse,
} from './client.js';

/** EVM chain id → intents `blockchain` label (from the live token list naming). */
export const INTENTS_BLOCKCHAIN: Readonly<Record<number, string>> = {
  1: 'eth',
  10: 'op',
  56: 'bsc',
  137: 'pol',
  143: 'monad',
  8453: 'base',
  42161: 'arb',
  43114: 'avax',
};

const same = (a: string | undefined, b: string) =>
  a !== undefined && a.toLowerCase() === b.toLowerCase();

export function findIntentsToken(
  tokens: readonly IntentsToken[],
  token: TokenRef,
): IntentsToken | null {
  const chain = INTENTS_BLOCKCHAIN[token.chainId];
  if (!chain) return null;
  return (
    tokens.find(
      (t) =>
        t.blockchain === chain &&
        t.decimals === token.decimals &&
        (token.address === 'native'
          ? t.contractAddress === undefined && t.symbol === token.symbol
          : same(t.contractAddress, token.address)),
    ) ?? null
  );
}

export type IntentsAdapterOptions = {
  client: IntentsApiClient;
  /** Validity the router grants a quote; dry quotes carry no provider deadline. */
  quoteTtlSeconds?: number;
  tokenCacheMs?: number;
  clock?: () => number;
};

/**
 * AURORA_INTENTS route (NEAR 1Click or Aurora Intents). Read-only: it lists
 * tokens and requests `dry: true` quotes only, so no deposit address is ever
 * created. AUSD is not in the live token list on any chain, so a request into
 * AUSD is reported UNAVAILABLE rather than approximated.
 */
export class IntentsRouteAdapter
  implements FundingRouteAdapter, IntentLegQuoter, ProviderStatusPort
{
  readonly route = 'AURORA_INTENTS' as const;
  readonly provider: string;
  private cache: { at: number; tokens: IntentsToken[] } | null = null;
  constructor(readonly options: IntentsAdapterOptions) {
    this.provider = options.client.provider;
  }

  private now() {
    return (this.options.clock ?? (() => Math.floor(Date.now() / 1000)))();
  }

  async tokens(): Promise<IntentsToken[]> {
    const ttl = this.options.tokenCacheMs ?? 60_000;
    if (this.cache && Date.now() - this.cache.at < ttl)
      return this.cache.tokens;
    const { tokens } = await this.options.client.tokens();
    this.cache = { at: Date.now(), tokens };
    return tokens;
  }

  private profileGate(chainId: number): string | null {
    if (isMutationEnabledChain(chainId))
      return 'NEAR/Aurora Intents have no testnet; destination profile is a sandbox chain';
    if (!profileForChainId(chainId))
      return `destination chain ${chainId} is not a Synq profile`;
    return null;
  }

  async capability(request: FundingRequest): Promise<RouteCapability> {
    return this.capabilityInto(request, request.destination.token);
  }

  private async capabilityInto(
    request: FundingRequest,
    destination: TokenRef,
  ): Promise<RouteCapability> {
    const base = { route: this.route, mode: 'MAINNET_READ_ONLY' as const };
    if (!this.options.client.hasCredentials)
      return {
        ...base,
        availability: 'PENDING_CREDENTIALS',
        reason: `${this.provider} API key absent`,
      };
    const gate = this.profileGate(request.destination.chainId);
    if (gate)
      return {
        ...base,
        availability: 'UNAVAILABLE_IN_NETWORK_PROFILE',
        reason: gate,
      };
    let tokens: IntentsToken[];
    try {
      tokens = await this.tokens();
    } catch (error) {
      return {
        ...base,
        availability: 'UNAVAILABLE',
        reason: `token list unavailable: ${String(error)}`,
      };
    }
    if (!findIntentsToken(tokens, destination))
      return {
        ...base,
        availability: 'UNAVAILABLE',
        reason: `${destination.symbol} ${destination.address} on chain ${destination.chainId} is not in the live ${this.provider} token list`,
      };
    if (!findIntentsToken(tokens, request.source.token))
      return {
        ...base,
        availability: 'UNAVAILABLE',
        reason: `source ${request.source.token.symbol} on chain ${request.source.token.chainId} is not in the live token list`,
      };
    return {
      ...base,
      availability: 'AVAILABLE',
      reason: `${this.provider} lists source and destination`,
    };
  }

  async supportsDestination(token: TokenRef): Promise<boolean> {
    if (!this.options.client.hasCredentials) return false;
    if (this.profileGate(token.chainId)) return false;
    try {
      return findIntentsToken(await this.tokens(), token) !== null;
    } catch {
      return false;
    }
  }

  quote(request: FundingRequest): Promise<NormalizedQuote> {
    return this.quoteInto(request, request.destination.token, this.route);
  }

  async quoteInto(
    request: FundingRequest,
    destination: TokenRef,
    route: NormalizedQuote['route'] = 'BRIDGE_TO_USDC_THEN_CONVERT',
  ): Promise<NormalizedQuote> {
    const capability = await this.capabilityInto(request, destination);
    if (capability.availability !== 'AVAILABLE')
      throw new FundingError('ROUTE_UNAVAILABLE', capability.reason);
    const tokens = await this.tokens();
    const origin = findIntentsToken(tokens, request.source.token)!;
    const target = findIntentsToken(tokens, destination)!;
    const ttl = this.options.quoteTtlSeconds ?? 120;
    const body = {
      dry: true,
      swapType: 'EXACT_INPUT' as const,
      slippageTolerance: request.maxSlippageBps,
      originAsset: origin.assetId,
      depositType: 'ORIGIN_CHAIN' as const,
      destinationAsset: target.assetId,
      amount: request.source.amount,
      refundTo: request.source.refundTo,
      refundType: 'ORIGIN_CHAIN' as const,
      recipient: request.destination.account,
      recipientType: 'DESTINATION_CHAIN' as const,
      deadline: new Date((request.now + 3600) * 1000).toISOString(),
      quoteWaitingTimeMs: 3000,
    };
    const { response } = await this.options.client.quote(body);
    return normalizeIntentsQuote({
      provider: this.provider,
      route,
      request,
      sent: body,
      response,
      source: request.source.token,
      destination,
      quotedAt: this.now(),
      ttlSeconds: ttl,
    });
  }

  async status(session: FundingSession) {
    if (!session.quote.depositAddress || session.quote.dry) return null;
    const s = await this.options.client.status(session.quote.depositAddress);
    return {
      status: s.status,
      updatedAt: s.updatedAt ?? new Date().toISOString(),
    };
  }
}

export function normalizeIntentsQuote(input: {
  provider: string;
  route: NormalizedQuote['route'];
  request: FundingRequest;
  sent: {
    originAsset: string;
    destinationAsset: string;
    amount: string;
    recipient: string;
    refundTo: string;
    dry: boolean;
  };
  response: QuoteResponse;
  source: TokenRef;
  destination: TokenRef;
  quotedAt: number;
  ttlSeconds: number;
}): NormalizedQuote {
  const { response, sent } = input;
  const echo = response.quoteRequest;
  if (
    echo.destinationAsset !== sent.destinationAsset ||
    !same(echo.recipient, sent.recipient)
  )
    throw new FundingError(
      'DESTINATION_MISMATCH',
      'provider echoed another destination',
    );
  if (
    echo.originAsset !== sent.originAsset ||
    echo.amount !== sent.amount ||
    response.quote.amountIn !== sent.amount ||
    !same(echo.refundTo, sent.refundTo)
  )
    throw new FundingError('QUOTE_INVALID', 'provider echoed another source');
  if (echo.dry !== sent.dry)
    throw new FundingError('QUOTE_INVALID', 'dry flag changed');
  if (BigInt(response.quote.minAmountOut) > BigInt(response.quote.amountOut))
    throw new FundingError('QUOTE_INVALID', 'minAmountOut above amountOut');
  const deadlines = [
    response.quote.deadline,
    response.quote.timeWhenInactive,
  ].flatMap((d) => (d ? [Math.floor(Date.parse(d) / 1000)] : []));
  const expiresAt = Math.min(
    input.quotedAt + input.ttlSeconds,
    ...deadlines.filter((d) => Number.isFinite(d)),
  );
  const fees: FeeLine[] = [];
  const appBps = (echo.appFees ?? []).reduce((a, f) => a + f.fee, 0);
  if (appBps > 0)
    fees.push({
      kind: 'APP',
      token: input.source,
      amount: String((BigInt(sent.amount) * BigInt(appBps)) / 10_000n),
    });
  if (response.quote.refundFee)
    fees.push({
      kind: 'REFUND',
      token: input.source,
      amount: response.quote.refundFee,
    });
  if (response.quote.withdrawFee)
    fees.push({
      kind: 'WITHDRAW',
      token: input.destination,
      amount: response.quote.withdrawFee,
    });
  return {
    quoteId: contentHash({
      provider: input.provider,
      correlationId: response.correlationId ?? null,
      timestamp: response.timestamp,
      signature: response.signature ?? null,
    }),
    route: input.route,
    provider: input.provider,
    mode: sent.dry ? 'MAINNET_READ_ONLY' : 'CANARY_READY',
    dry: sent.dry,
    source: input.source,
    destination: input.destination,
    recipient: sent.recipient.toLowerCase(),
    amountIn: response.quote.amountIn,
    amountOut: response.quote.amountOut,
    minAmountOut: response.quote.minAmountOut,
    fees,
    quotedAt: input.quotedAt,
    expiresAt,
    timeEstimateSeconds: response.quote.timeEstimate,
    depositAddress: response.quote.depositAddress ?? null,
    correlationId: response.correlationId ?? null,
    artifactHash: contentHash(response),
  };
}
