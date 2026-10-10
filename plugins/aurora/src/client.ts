import { z } from 'zod';
import { FundingError } from '@synq/funding';

export const INTENTS_PROVIDERS = ['NEAR_1CLICK', 'AURORA_INTENTS'] as const;
export type IntentsProvider = (typeof INTENTS_PROVIDERS)[number];
export const DEFAULT_BASE_URL: Record<IntentsProvider, string> = {
  NEAR_1CLICK: 'https://1click.chaindefuser.com',
  AURORA_INTENTS: 'https://intents-api.aurora.dev',
};

const uint = z.string().regex(/^(0|[1-9][0-9]*)$/);
export const IntentsTokenSchema = z.looseObject({
  assetId: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  blockchain: z.string().min(1),
  symbol: z.string().min(1),
  price: z.number().optional(),
  priceUpdatedAt: z.string().optional(),
  contractAddress: z.string().optional(),
});
export type IntentsToken = z.output<typeof IntentsTokenSchema>;

export const QuoteRequestBodySchema = z.strictObject({
  dry: z.boolean(),
  swapType: z.enum(['EXACT_INPUT', 'EXACT_OUTPUT', 'FLEX_INPUT', 'ANY_INPUT']),
  slippageTolerance: z.number().int().min(0).max(10_000),
  originAsset: z.string().min(1),
  depositType: z.literal('ORIGIN_CHAIN'),
  destinationAsset: z.string().min(1),
  amount: uint,
  refundTo: z.string().min(1),
  refundType: z.literal('ORIGIN_CHAIN'),
  recipient: z.string().min(1),
  recipientType: z.literal('DESTINATION_CHAIN'),
  deadline: z.iso.datetime(),
  quoteWaitingTimeMs: z.number().int().min(0).max(30_000).optional(),
});
export type QuoteRequestBody = z.output<typeof QuoteRequestBodySchema>;

export const QuoteResponseSchema = z.looseObject({
  quote: z.looseObject({
    amountIn: uint,
    minAmountIn: uint.optional(),
    amountOut: uint,
    minAmountOut: uint,
    timeEstimate: z.number().nonnegative(),
    deadline: z.string().optional(),
    timeWhenInactive: z.string().optional(),
    depositAddress: z.string().optional(),
    depositMemo: z.string().optional(),
    refundFee: uint.optional(),
    withdrawFee: uint.optional(),
  }),
  quoteRequest: z.looseObject({
    dry: z.boolean(),
    originAsset: z.string(),
    destinationAsset: z.string(),
    amount: uint,
    recipient: z.string(),
    refundTo: z.string(),
    slippageTolerance: z.number(),
    deadline: z.string().optional(),
    appFees: z
      .array(z.looseObject({ recipient: z.string(), fee: z.number() }))
      .optional(),
  }),
  signature: z.string().optional(),
  timestamp: z.string(),
  correlationId: z.string().nullable().optional(),
});
export type QuoteResponse = z.output<typeof QuoteResponseSchema>;

export const PROVIDER_STATUSES = [
  'KNOWN_DEPOSIT_TX',
  'PENDING_DEPOSIT',
  'INCOMPLETE_DEPOSIT',
  'PROCESSING',
  'SUCCESS',
  'REFUNDED',
  'FAILED',
] as const;
export const StatusResponseSchema = z.looseObject({
  status: z.enum(PROVIDER_STATUSES),
  updatedAt: z.string().optional(),
  correlationId: z.string().nullable().optional(),
  swapDetails: z
    .looseObject({
      amountIn: uint.optional(),
      amountOut: uint.optional(),
      depositedAmount: uint.optional(),
      refundedAmount: uint.optional(),
      destinationChainTxHashes: z
        .array(z.looseObject({ hash: z.string() }))
        .optional(),
      originChainTxHashes: z
        .array(z.looseObject({ hash: z.string() }))
        .optional(),
    })
    .optional(),
});
export type StatusResponse = z.output<typeof StatusResponseSchema>;

export type IntentsClientConfig = {
  provider: IntentsProvider;
  baseUrl?: string;
  /** Aurora Intents Studio key (path segment). Required for AURORA_INTENTS. */
  apiKey?: string;
  /** Optional 1Click partner JWT (Authorization bearer). */
  jwt?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type HttpEvidence = {
  method: 'GET' | 'POST';
  url: string;
  status: number;
  fetchedAt: string;
  body: unknown;
};

/** HTTP client for the NEAR 1Click API and its Aurora Intents white-label (key in path). */
export class IntentsApiClient {
  readonly provider: IntentsProvider;
  private readonly base: string;
  constructor(readonly config: IntentsClientConfig) {
    this.provider = config.provider;
    this.base = (config.baseUrl ?? DEFAULT_BASE_URL[config.provider]).replace(
      /\/$/,
      '',
    );
  }

  get hasCredentials(): boolean {
    return this.provider === 'NEAR_1CLICK' || Boolean(this.config.apiKey);
  }

  /** Redacted endpoint description for evidence (never includes the key). */
  endpoint(kind: 'tokens' | 'quote' | 'status' | 'deposit'): string {
    return this.url(kind, true);
  }

  private url(
    kind: 'tokens' | 'quote' | 'status' | 'deposit',
    redact = false,
  ): string {
    if (this.provider === 'NEAR_1CLICK')
      return `${this.base}/v0/${kind === 'deposit' ? 'deposit/submit' : kind}`;
    if (!this.config.apiKey)
      throw new FundingError('CREDENTIALS_MISSING', 'Aurora Intents API key');
    const key = redact ? '{apiKey}' : encodeURIComponent(this.config.apiKey);
    return `${this.base}/api/${kind === 'deposit' ? 'deposit/submit' : kind}/${key}`;
  }

  private async request(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
  ): Promise<{ status: number; json: unknown }> {
    const f = this.config.fetch ?? fetch;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.config.jwt) headers.authorization = `Bearer ${this.config.jwt}`;
    let response: Response;
    try {
      response = await f(url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
    } catch (error) {
      throw new FundingError('PROVIDER_ERROR', String(error));
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      throw new FundingError('PROVIDER_RESPONSE_INVALID', 'non-JSON response');
    }
    if (!response.ok)
      throw new FundingError(
        'PROVIDER_ERROR',
        `${response.status} ${JSON.stringify(json).slice(0, 300)}`,
      );
    return { status: response.status, json };
  }

  async tokens(): Promise<{ tokens: IntentsToken[]; evidence: HttpEvidence }> {
    const url = this.url('tokens');
    const { status, json } = await this.request('GET', url);
    const list =
      this.provider === 'NEAR_1CLICK'
        ? json
        : (json as { tokens?: unknown } | null)?.tokens;
    const parsed = z.array(IntentsTokenSchema).safeParse(list);
    if (!parsed.success)
      throw new FundingError('PROVIDER_RESPONSE_INVALID', 'token list');
    return {
      tokens: parsed.data,
      evidence: {
        method: 'GET',
        url: this.endpoint('tokens'),
        status,
        fetchedAt: new Date().toISOString(),
        body: json,
      },
    };
  }

  async quote(
    body: QuoteRequestBody,
  ): Promise<{ response: QuoteResponse; evidence: HttpEvidence }> {
    const request = QuoteRequestBodySchema.parse(body);
    const { status, json } = await this.request(
      'POST',
      this.url('quote'),
      request,
    );
    const parsed = QuoteResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new FundingError('PROVIDER_RESPONSE_INVALID', 'quote');
    return {
      response: parsed.data,
      evidence: {
        method: 'POST',
        url: this.endpoint('quote'),
        status,
        fetchedAt: new Date().toISOString(),
        body: { request, response: json },
      },
    };
  }

  async status(depositAddress: string, depositMemo?: string) {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set('depositMemo', depositMemo);
    const { json } = await this.request(
      'GET',
      `${this.url('status')}?${query.toString()}`,
    );
    const parsed = StatusResponseSchema.safeParse(json);
    if (!parsed.success)
      throw new FundingError('PROVIDER_RESPONSE_INVALID', 'status');
    return parsed.data;
  }
}
