import {
  createPublicClient,
  custom,
  http,
  type PublicClient,
  type Transport,
} from 'viem';
import { fail } from './errors.js';
import { NETWORK } from './network.js';

/**
 * Chains the public-RPC fallback may serve. Testnet only: a mainnet chain is
 * never routed through SYNQ_MM_RPC_URL, whatever the gateway answers.
 */
export const FALLBACK_CHAIN_IDS: ReadonlySet<number> = new Set([
  NETWORK.chainId,
]);

/**
 * SYNQ_MM_RPC_URL: optional https JSON-RPC endpoint for Monad testnet, used
 * only when the Agent Wallet gateway rejects the chain. The URL may carry an
 * API key, so it is never echoed back in errors.
 */
export function rpcUrlFromEnv(
  env: Record<string, string | undefined>,
): string | null {
  const raw = env.SYNQ_MM_RPC_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail('CONFIG_INVALID', 'SYNQ_MM_RPC_URL is not a URL');
  }
  if (url.protocol !== 'https:')
    fail('CONFIG_INVALID', 'SYNQ_MM_RPC_URL must be an https URL');
  if (url.username || url.password)
    fail('CONFIG_INVALID', 'SYNQ_MM_RPC_URL must not embed credentials');
  return url.toString();
}

/** The gateway answered "this chain is not served" (e.g. 400 Invalid chainId). */
export function gatewayRejectsChain(error: unknown): boolean {
  for (let e = error, depth = 0; e && depth < 8; depth++) {
    const o = e as {
      status?: unknown;
      message?: unknown;
      details?: unknown;
      cause?: unknown;
    };
    const text = `${typeof o.message === 'string' ? o.message : ''} ${typeof o.details === 'string' ? o.details : ''}`;
    if (
      /invalid\s*chain\s*id|unsupported\s*chain|chain\s*not\s*supported/i.test(
        text,
      )
    )
      return true;
    if (o.status === 400 && /chain/i.test(text)) return true;
    e = o.cause;
  }
  return false;
}

/** A public RPC whose chain id is verified (eth_chainId) before any use. */
export class RpcFallback {
  private verified: Promise<PublicClient> | null = null;
  private readonly client: PublicClient;
  constructor(
    endpoint: string | Transport,
    readonly chainId: number = NETWORK.chainId,
  ) {
    if (!FALLBACK_CHAIN_IDS.has(chainId))
      fail('WRONG_CHAIN', `no RPC fallback is allowed for chain ${chainId}`);
    this.client = createPublicClient({
      transport:
        typeof endpoint === 'string'
          ? http(endpoint, { retryCount: 1, timeout: 20_000 })
          : endpoint,
    }) as PublicClient;
  }

  static fromEnv(env: Record<string, string | undefined>): RpcFallback | null {
    const url = rpcUrlFromEnv(env);
    return url ? new RpcFallback(url) : null;
  }

  /** The fallback client, after its eth_chainId matched; a mismatch is never retried. */
  ready(): Promise<PublicClient> {
    this.verified ??= (async () => {
      let reported: number;
      try {
        reported = await this.client.getChainId();
      } catch {
        this.verified = null;
        return fail(
          'CONFIG_INVALID',
          'SYNQ_MM_RPC_URL did not answer eth_chainId',
        );
      }
      if (reported !== this.chainId)
        fail(
          'WRONG_CHAIN',
          `SYNQ_MM_RPC_URL reports chain ${reported}; Synq requires ${this.chainId}`,
        );
      return this.client;
    })();
    return this.verified;
  }
}

/**
 * Per-chain read client: the Agent Wallet gateway first; once the gateway
 * rejects a fallback-eligible (testnet) chain, the verified public RPC serves
 * that chain's reads and receipt polling. Signing never leaves the wallet.
 */
export class ChainReads {
  private readonly clients = new Map<number, PublicClient>();
  private readonly onFallback = new Set<number>();
  constructor(
    private readonly gateway: (chainId: number) => PublicClient,
    private readonly fallback: RpcFallback | null,
  ) {}

  /** True once reads for this chain moved to SYNQ_MM_RPC_URL. */
  usingFallback(chainId: number): boolean {
    return this.onFallback.has(chainId);
  }

  publicClient(chainId: number): PublicClient {
    const eligible =
      this.fallback !== null &&
      this.fallback.chainId === chainId &&
      FALLBACK_CHAIN_IDS.has(chainId);
    if (!eligible) return this.gateway(chainId);
    const cached = this.clients.get(chainId);
    if (cached) return cached;
    const gateway = this.gateway(chainId);
    const fallback = this.fallback!;
    const client = createPublicClient({
      transport: custom(
        {
          request: async (args) => {
            if (this.onFallback.has(chainId))
              return (await fallback.ready()).request(args as never);
            try {
              return await gateway.request(args as never);
            } catch (error) {
              if (!gatewayRejectsChain(error)) throw error;
              const ready = await fallback.ready();
              this.onFallback.add(chainId);
              return ready.request(args as never);
            }
          },
        },
        { retryCount: 0 },
      ),
      pollingInterval: gateway.pollingInterval,
      cacheTime: gateway.cacheTime,
    }) as PublicClient;
    this.clients.set(chainId, client);
    return client;
  }
}
