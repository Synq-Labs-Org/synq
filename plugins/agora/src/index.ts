import { z } from 'zod';
import { ausdRegistry } from '@synq/chain-registry';

export const AGORA_BASE_URL = 'https://api.agora.finance';
export const AGORA_NETWORKS = [
  'arbitrum',
  'avalanche',
  'base',
  'binance-smart-chain',
  'core',
  'ethereum',
  'fraxtal',
  'gnosis',
  'immutable',
  'injective',
  'katana',
  'mantle',
  'monad',
  'plume',
  'polygon-pos',
  'solana',
  'sui',
] as const;
const decimalString = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);

export const AgoraMetricsSchema = z.looseObject({
  circulatingSupply: decimalString,
  totalSupply: decimalString,
  partial: z.boolean(),
  chains: z.array(
    z.looseObject({
      chainId: z.string().min(1),
      network: z.string().min(1),
      circulatingSupply: decimalString,
      totalSupply: decimalString,
    }),
  ),
});
export type AgoraMetrics = z.output<typeof AgoraMetricsSchema>;

const Entitlement = z.looseObject({
  type: z.enum(['instant_settlement', 'mint', 'rewards']),
  status: z.enum([
    'approved',
    'conditionally_approved',
    'pending_approval',
    'pending_removal',
    'rejected',
    'removed',
  ]),
});
/** `GET /v0/accounts` item (wallet | bank), per the Agora OpenAPI. */
export const AgoraAccountSchema = z.discriminatedUnion('kind', [
  z.looseObject({
    kind: z.literal('wallet'),
    id: z.string(),
    address: z.string(),
    addressFormat: z.enum(['ethereum', 'solana']),
    name: z.string().nullable().optional(),
    networks: z.array(
      z.looseObject({
        chain: z.enum(AGORA_NETWORKS),
        entitlements: z.array(Entitlement).optional(),
      }),
    ),
  }),
  z.looseObject({
    kind: z.literal('bank'),
    id: z.string(),
    currency: z.literal('usd'),
    name: z.string().nullable().optional(),
  }),
]);
export type AgoraAccount = z.output<typeof AgoraAccountSchema>;
const Currency = z.enum(['ausd', 'stablecoin', 'usd', 'usdc']);
/** `GET /v0/routes` item. */
export const AgoraRouteSchema = z.looseObject({
  id: z.string(),
  name: z.string().nullable().optional(),
  createdAt: z.string(),
  from: z.looseObject({ currency: Currency }),
  to: z.looseObject({
    currency: Currency,
    accountId: z.string(),
    chain: z.string().optional(),
  }),
  instructions: z.array(z.unknown()),
});
export type AgoraRoute = z.output<typeof AgoraRouteSchema>;
/** `GET /v0/transactions` item. */
export const AgoraTransactionSchema = z.looseObject({
  id: z.string(),
  initiatedAt: z.string(),
  settledAt: z.string().nullable(),
  isInstantSettlement: z.boolean(),
  legCount: z.number().int(),
  status: z.string(),
  type: z.string(),
  source: z.unknown(),
  recipient: z.unknown(),
});
export type AgoraTransaction = z.output<typeof AgoraTransactionSchema>;
const Page = <T extends z.ZodType>(item: T) =>
  z.looseObject({ data: z.array(item), nextCursor: z.string().nullable() });

export class AgoraError extends Error {
  constructor(
    readonly code:
      | 'PENDING_CREDENTIALS'
      | 'PROVIDER_ERROR'
      | 'PROVIDER_RESPONSE_INVALID',
    message: string = code,
  ) {
    super(message);
    this.name = 'AgoraError';
  }
}

export type AgoraStatus =
  | { status: 'AVAILABLE' }
  | { status: 'PENDING_CREDENTIALS'; reason: string };

/** Typed Agora API surface (accounts/routes/transactions) for future mint/redeem/transfer integrations. */
export interface AgoraApi {
  status(): AgoraStatus;
  metrics(): Promise<{ metrics: AgoraMetrics; fetchedAt: string }>;
  accounts(query?: {
    network?: string;
    kind?: 'bank' | 'wallet';
  }): Promise<AgoraAccount[]>;
  routes(query?: {
    toChain?: string;
    toCurrency?: string;
  }): Promise<AgoraRoute[]>;
  transactions(query?: {
    sourceChain?: string;
    type?: string;
  }): Promise<AgoraTransaction[]>;
  rewards(): RewardsAvailability;
}

export type RewardsAvailability = {
  status: 'UNAVAILABLE';
  reason: string;
  apy: null;
};

/**
 * AUSD is a cash-like stablecoin balance. Holding it does not stream reserve
 * yield (Bible §19/§99, AUSD-030/031); any reward needs a documented Agora
 * entitlement or a separate mandate-approved position.
 */
export function presentAusdBalance(amount: string): {
  asset: string;
  amount: string;
  classification: 'CASH_LIKE_STABLECOIN';
  yieldBearing: false;
  apy: null;
  note: string;
} {
  return {
    asset: ausdRegistry.canonicalSymbol,
    amount,
    classification: 'CASH_LIKE_STABLECOIN',
    yieldBearing: false,
    apy: null,
    note: 'AUSD does not pay reserve yield to holders; no rewards entitlement is configured.',
  };
}

export class AgoraClient implements AgoraApi {
  private session: { token: string; expiresAt: number } | null = null;
  constructor(
    readonly config: {
      baseUrl?: string;
      apiKey?: string;
      fetch?: typeof fetch;
      timeoutMs?: number;
    } = {},
  ) {}

  private get base() {
    return (this.config.baseUrl ?? AGORA_BASE_URL).replace(/\/$/, '');
  }

  status(): AgoraStatus {
    return this.config.apiKey
      ? { status: 'AVAILABLE' }
      : {
          status: 'PENDING_CREDENTIALS',
          reason: 'Agora API is production-only and needs an issued API key',
        };
  }

  private async get(path: string, auth: string | null): Promise<unknown> {
    const f = this.config.fetch ?? fetch;
    let response: Response;
    try {
      response = await f(`${this.base}${path}`, {
        method: path === '/v0/auth/token' ? 'POST' : 'GET',
        headers: {
          accept: 'application/json',
          ...(auth ? { authorization: `Bearer ${auth}` } : {}),
        },
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 20_000),
      });
    } catch (error) {
      throw new AgoraError('PROVIDER_ERROR', String(error));
    }
    const text = await response.text();
    if (!response.ok)
      throw new AgoraError(
        'PROVIDER_ERROR',
        `${response.status} ${text.slice(0, 200)}`,
      );
    try {
      return JSON.parse(text);
    } catch {
      throw new AgoraError('PROVIDER_RESPONSE_INVALID', 'non-JSON response');
    }
  }

  async metrics() {
    const parsed = AgoraMetricsSchema.safeParse(
      await this.get('/v0/metrics', null),
    );
    if (!parsed.success)
      throw new AgoraError('PROVIDER_RESPONSE_INVALID', 'metrics');
    return { metrics: parsed.data, fetchedAt: new Date().toISOString() };
  }

  private async token(): Promise<string> {
    if (!this.config.apiKey)
      throw new AgoraError('PENDING_CREDENTIALS', 'Agora API key absent');
    const now = Date.now();
    if (this.session && this.session.expiresAt - 30_000 > now)
      return this.session.token;
    const body = z
      .looseObject({
        sessionJwt: z.string().min(1),
      })
      .safeParse(await this.get('/v0/auth/token', this.config.apiKey));
    if (!body.success)
      throw new AgoraError('PROVIDER_RESPONSE_INVALID', 'auth token');
    this.session = {
      token: body.data.sessionJwt,
      expiresAt: now + 15 * 60_000,
    };
    return this.session.token;
  }

  private async list<T extends z.ZodType>(
    path: string,
    item: T,
    query: Record<string, string | undefined>,
  ): Promise<z.output<T>[]> {
    const params = new URLSearchParams(
      Object.entries(query).filter(
        (e): e is [string, string] => e[1] !== undefined,
      ),
    );
    const out: z.output<T>[] = [];
    let cursor: string | null = null;
    do {
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const page = Page(item).safeParse(
        await this.get(`${path}${qs ? `?${qs}` : ''}`, await this.token()),
      );
      if (!page.success)
        throw new AgoraError('PROVIDER_RESPONSE_INVALID', path);
      out.push(...(page.data.data as z.output<T>[]));
      cursor = page.data.nextCursor;
    } while (cursor && out.length < 1000);
    return out;
  }

  accounts(query: { network?: string; kind?: 'bank' | 'wallet' } = {}) {
    return this.list('/v0/accounts', AgoraAccountSchema, query);
  }
  routes(query: { toChain?: string; toCurrency?: string } = {}) {
    return this.list('/v0/routes', AgoraRouteSchema, query);
  }
  transactions(query: { sourceChain?: string; type?: string } = {}) {
    return this.list('/v0/transactions', AgoraTransactionSchema, query);
  }

  rewards(): RewardsAvailability {
    return {
      status: 'UNAVAILABLE',
      reason:
        'No Agora rewards entitlement is documented for Synq; AUSD balances are shown without yield.',
      apy: null,
    };
  }
}

/** Per-chain AUSD supply from the live public metrics (no auth). */
export function supplyOnChain(metrics: AgoraMetrics, caip2: string) {
  return metrics.chains.find((c) => c.chainId === caip2) ?? null;
}
