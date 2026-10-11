import { artifactHash } from '@synq/kernel';
import type { PublicClient } from 'viem';
import {
  MarketQuoteSchema,
  WorkflowStatusSchema,
  type NetworkProfile,
  type MarketQuote,
  type WorkflowStatus,
} from '@synq/schemas';
import type {
  MarketDataSource,
  RiskStateSource,
  WorkflowStatusReader,
} from '@synq/world-model';
import { KuruClobAdapter } from '@synq/plugin-kuru';
import { kuruDeployment } from '@synq/plugin-kuru';
import { MarketCatalog, quoteFrom } from '@synq/plugin-perpl';
import type { PerplRestClient } from '@synq/plugin-perpl';
import { RegistryRiskSource } from '@synq/plugin-chainlink-cre';
import { RpcRiskAttestationReader } from '@synq/plugin-chainlink-cre';
import {
  stableRiskGateConfig,
  riskAttestationDeployment,
} from '@synq/plugin-chainlink-cre';
import { officialAsset } from '@synq/chain-registry';

/** Only public venue reads; no signer or wallet is exposed to the Brain. */
export class VenueMarketSource implements MarketDataSource {
  constructor(
    private readonly network: NetworkProfile,
    private readonly client: PublicClient,
    private readonly perpl: Pick<
      PerplRestClient,
      'context' | 'ticker' | 'network'
    >,
    private readonly now = Date.now,
  ) {}
  async quotes(network: NetworkProfile): Promise<MarketQuote[]> {
    if (
      network.chainId !== this.network.chainId ||
      network.profile !== this.network.profile ||
      (await this.client.getChainId()) !== network.chainId
    )
      throw new Error('WORLD_MARKET_NETWORK_MISMATCH');
    const clob = new KuruClobAdapter(() => this.client);
    const quotes: MarketQuote[] = [];
    for (const market of kuruDeployment(network.profile).markets) {
      const params = await clob.marketParams(network.profile, market.pair);
      const health = await clob.health(network.profile, market.pair);
      if (health.status !== 'HEALTHY' || params.pricePrecision <= 0n) continue;
      const block = await this.client.getBlock();
      quotes.push(
        MarketQuoteSchema.parse({
          pair: market.pair,
          price: (
            ((health.bestBid + health.bestAsk) * 100_000_000n) /
            (2n * params.pricePrecision)
          ).toString(),
          priceDecimals: 8,
          chainId: network.chainId,
          source: 'kuru-clob-rpc',
          observedAt: Number(block.timestamp),
          maxAgeSeconds: 60,
        }),
      );
    }
    const catalog = new MarketCatalog(
      this.perpl.network,
      await this.perpl.context(),
      this.now(),
    );
    for (const market of catalog.all().filter((m) => m.open)) {
      const ticker = await this.perpl.ticker(market.id);
      const state = ticker.d[String(market.id)];
      if (!state) throw new Error('WORLD_PERPL_TICKER_MISSING');
      const quote = quoteFrom(market.id, state, 60_000, this.now());
      if (quote.at > this.now()) throw new Error('WORLD_PERPL_FUTURE');
      quotes.push(
        MarketQuoteSchema.parse({
          pair: `${market.base}/USD`,
          price: quote.mark.toString(),
          priceDecimals: market.priceDecimals,
          chainId: network.chainId,
          source: 'perpl-public-rest',
          observedAt: Math.floor(quote.at / 1000),
          maxAgeSeconds: 60,
        }),
      );
    }
    return quotes;
  }
}

export function productionRegistryRisk(
  network: NetworkProfile,
  client: PublicClient,
  now: () => number,
): RiskStateSource {
  if (network.profile !== 'sandbox/monad-testnet')
    return {
      async current() {
        return {
          state: {
            status: 'UNKNOWN',
            reasons: ['NO_TRUSTED_REGISTRY_DEPLOYMENT'],
            attestationRef: null,
            referenceDeviationBps: null,
          },
          observedAt: now(),
          maxAgeSeconds: 60,
        };
      },
    };
  const deployment = riskAttestationDeployment(network.profile);
  const trustedWorkflowId = `0x${'11'.repeat(32)}` as `0x${string}`;
  const reader = new RpcRiskAttestationReader(client, {
    confirmationDepth: 2,
    trustedForwarder: deployment.forwarder,
    forwarderKind: deployment.forwarderKind,
    trustedWorkflowId,
  });
  return new RegistryRiskSource(
    stableRiskGateConfig(network.profile, reader, 120),
    now,
    officialAsset('testnetAUSD').address as `0x${string}`,
  );
}

export type WorkflowListing = {
  workflowId: string;
  type: string;
  status: { name: string };
  startTime: Date;
  memo?: Record<string, unknown>;
};
export type TemporalWorldPort = {
  list(): AsyncIterable<WorkflowListing>;
  nextEvent(workflowId: string): Promise<{ at: number | null }>;
};
/** Completeness is required: a truncated or failed visibility read is UNKNOWN, never an empty healthy list. */
export class TemporalWorkflowStatusSource implements WorkflowStatusReader {
  constructor(
    private readonly temporal: TemporalWorldPort,
    private readonly now: () => number,
    private readonly maxEntries = 1000,
  ) {}
  async list(groupId: string) {
    const workflows: WorkflowStatus[] = [];
    let count = 0;
    for await (const execution of this.temporal.list()) {
      if (++count > this.maxEntries)
        throw new Error('TEMPORAL_VISIBILITY_TRUNCATED');
      if (execution.memo?.synqGroupId !== groupId) continue;
      const running = execution.status.name === 'RUNNING';
      const next = running
        ? await this.temporal.nextEvent(execution.workflowId)
        : { at: null };
      workflows.push(
        WorkflowStatusSchema.parse({
          workflowId: execution.workflowId,
          type: execution.type,
          status:
            execution.status.name === 'CANCELED'
              ? 'CANCELLED'
              : execution.status.name,
          intentId:
            typeof execution.memo.synqIntentId === 'string'
              ? execution.memo.synqIntentId
              : null,
          startedAt: Math.floor(execution.startTime.getTime() / 1000),
          nextEventAt: next.at === null ? null : Math.floor(next.at / 1000),
        }),
      );
    }
    return { workflows, observedAt: this.now() };
  }
}

/** Portfolio reader lives in the executor process; this read-only bridge merges risk without exposing its API signer. */
export class CombinedRiskSource implements RiskStateSource {
  constructor(
    private readonly stable: RiskStateSource,
    private readonly portfolio: RiskStateSource,
  ) {}
  async current(groupId: string) {
    const [stable, portfolio] = await Promise.all([
      this.stable.current(groupId),
      this.portfolio.current(groupId),
    ]);
    const rank = { HEALTHY: 0, DEGRADED: 1, STALE: 2, UNKNOWN: 3 };
    return {
      state: {
        ...stable.state,
        status:
          rank[stable.state.status] >= rank[portfolio.state.status]
            ? stable.state.status
            : portfolio.state.status,
        reasons: [...stable.state.reasons, ...portfolio.state.reasons],
      },
      observedAt: Math.min(stable.observedAt, portfolio.observedAt),
      maxAgeSeconds: Math.min(stable.maxAgeSeconds, portfolio.maxAgeSeconds),
    };
  }
}

export class PostgresPortfolioRiskSource implements RiskStateSource {
  constructor(
    private readonly pool: {
      query(
        sql: string,
        values: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }>;
    },
    private readonly now: () => number,
    private readonly expectedMode: 'REAL_TESTNET' | 'SIMULATION',
  ) {}
  async current(groupId: string) {
    const unknown = () => ({
      state: {
        status: 'UNKNOWN' as const,
        reasons: ['PORTFOLIO_RISK_UNAVAILABLE'],
        attestationRef: null,
        referenceDeviationBps: null,
      },
      observedAt: this.now(),
      maxAgeSeconds: 60,
    });
    try {
      const row = (
        await this.pool.query(
          'SELECT execution_mode,evidence FROM synq_portfolio_observations WHERE group_id=$1',
          [groupId],
        )
      ).rows[0];
      if (!row || row.execution_mode !== this.expectedMode) return unknown();
      const evidence = row.evidence as {
        risk: { asOf: number; blocked: boolean; blockReasons: string[] };
        riskPacketHash: string;
        executionMode: string;
      };
      if (
        artifactHash(evidence.risk) !== evidence.riskPacketHash ||
        evidence.executionMode !== this.expectedMode ||
        !Number.isSafeInteger(evidence.risk.asOf) ||
        evidence.risk.asOf > this.now() * 1000 ||
        this.now() * 1000 - evidence.risk.asOf > 60_000 ||
        typeof evidence.risk.blocked !== 'boolean' ||
        !Array.isArray(evidence.risk.blockReasons) ||
        !/^0x[0-9a-f]{64}$/.test(evidence.riskPacketHash)
      )
        return unknown();
      return {
        state: {
          status: evidence.risk.blocked
            ? ('DEGRADED' as const)
            : ('HEALTHY' as const),
          reasons: evidence.risk.blockReasons,
          attestationRef: evidence.riskPacketHash,
          referenceDeviationBps: null,
        },
        observedAt: Math.floor(evidence.risk.asOf / 1000),
        maxAgeSeconds: 60,
      };
    } catch {
      return unknown();
    }
  }
}
