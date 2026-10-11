import type { ProfileName } from '@synq/domain';
import type { KuruClobAdapter } from './clob.js';
import { kuruDeployment, type Address } from './deployment.js';
import { KuruError } from './errors.js';
import type { KuruFlowClient } from './flow-client.js';
import { SKILL_SOURCE } from './skill.js';

export type CapabilityStatus =
  | 'AVAILABLE'
  | 'DEGRADED'
  | 'UNAVAILABLE'
  | 'UNAVAILABLE_IN_NETWORK_PROFILE';
export type MarketCapability = {
  pair: string;
  address: Address;
  status: 'HEALTHY' | 'UNHEALTHY' | 'MISMATCH' | 'UNREADABLE';
  reason: string | null;
};
export type KuruCapabilityReport = {
  profile: ProfileName;
  chainId: number;
  checkedAt: number;
  skill: {
    status: CapabilityStatus;
    reason: string | null;
    semantics: 'USDC_SETTLED_BUY_SELL';
    allowlist: string[];
    source: typeof SKILL_SOURCE;
  };
  flow: {
    status: CapabilityStatus;
    reason: string | null;
    entrypoint: Address | null;
    pairs: string[];
  };
  clob: { status: CapabilityStatus; markets: MarketCapability[] };
  execution: { status: CapabilityStatus; reason: string };
  routes: { from: string; to: string; venues: string[] }[];
};

export const EXECUTION_PATH_REASON =
  'ExecutionModule executes only exact ERC20 transfers and native transfers; the bounded swap action (ADR-0017) is a proposal, so swaps are prepared and simulated only';
export const TESTNET_FLOW_REASON =
  'Kuru Flow quotes on Monad testnet return no candidate paths (observed 2026-10-10); no testnet entrypoint is registered';

/** Runtime discovery of what Kuru can do on a network profile, from the registry plus live HTTP and chain probes. */
export class KuruCapabilities {
  constructor(
    private readonly deps: {
      clob: KuruClobAdapter;
      flow?: KuruFlowClient;
      probeAddress: Address;
    },
  ) {}

  async discover(
    profile: ProfileName,
    now: number,
  ): Promise<KuruCapabilityReport> {
    const deployment = kuruDeployment(profile);
    const mainnet = profile === 'proof/monad-mainnet';
    const symbols = Object.keys(deployment.tokens);

    let flow: KuruCapabilityReport['flow'];
    if (!deployment.flowEntrypoint)
      flow = {
        status: 'UNAVAILABLE_IN_NETWORK_PROFILE',
        reason:
          profile === 'sandbox/monad-testnet'
            ? TESTNET_FLOW_REASON
            : 'no Kuru Flow entrypoint registered',
        entrypoint: null,
        pairs: [],
      };
    else if (!this.deps.flow)
      flow = {
        status: 'UNAVAILABLE',
        reason: 'no Flow client configured',
        entrypoint: deployment.flowEntrypoint,
        pairs: [],
      };
    else {
      try {
        await this.deps.flow.token(this.deps.probeAddress);
        const allowed = ['AUSD', 'USDC', 'WMON', 'MON'].filter((s) =>
          symbols.includes(s),
        );
        flow = {
          status: 'AVAILABLE',
          reason: null,
          entrypoint: deployment.flowEntrypoint,
          pairs: allowed.flatMap((a) =>
            allowed.filter((b) => b !== a).map((b) => `${a}->${b}`),
          ),
        };
      } catch (error) {
        flow = {
          status: 'UNAVAILABLE',
          reason: error instanceof KuruError ? error.code : 'probe failed',
          entrypoint: deployment.flowEntrypoint,
          pairs: [],
        };
      }
    }

    const markets: MarketCapability[] = [];
    for (const market of deployment.markets) {
      try {
        await this.deps.clob.marketParams(profile, market.pair);
        const health = await this.deps.clob.health(profile, market.pair);
        markets.push({
          pair: market.pair,
          address: market.address,
          status: health.status,
          reason: health.status === 'HEALTHY' ? null : health.reason,
        });
      } catch (error) {
        markets.push({
          pair: market.pair,
          address: market.address,
          status:
            error instanceof KuruError && error.code === 'MARKET_MISMATCH'
              ? 'MISMATCH'
              : 'UNREADABLE',
          reason: error instanceof KuruError ? error.code : 'read failed',
        });
      }
    }
    const healthy = markets.filter((m) => m.status === 'HEALTHY');
    const clob = {
      status: (markets.length === 0
        ? 'UNAVAILABLE_IN_NETWORK_PROFILE'
        : healthy.length === markets.length
          ? 'AVAILABLE'
          : healthy.length > 0
            ? 'DEGRADED'
            : 'UNAVAILABLE') as CapabilityStatus,
      markets,
    };

    const skill: KuruCapabilityReport['skill'] = {
      status: mainnet ? flow.status : 'UNAVAILABLE_IN_NETWORK_PROFILE',
      reason: mainnet
        ? flow.reason
        : 'the Kuru trading skill is Monad mainnet only',
      semantics: 'USDC_SETTLED_BUY_SELL',
      allowlist: mainnet ? ['USDC', 'WMON', 'AUSD'] : [],
      source: SKILL_SOURCE,
    };

    const routes: KuruCapabilityReport['routes'] = [];
    const add = (from: string, to: string, venue: string) => {
      const route = routes.find((r) => r.from === from && r.to === to);
      if (route) route.venues.push(venue);
      else routes.push({ from, to, venues: [venue] });
    };
    if (flow.status === 'AVAILABLE')
      for (const pair of flow.pairs) {
        const [from, to] = pair.split('->') as [string, string];
        add(from, to, 'kuru-flow');
      }
    if (skill.status === 'AVAILABLE')
      for (const token of ['WMON', 'AUSD']) {
        add('USDC', token, 'kuru-skill');
        add(token, 'USDC', 'kuru-skill');
      }
    for (const m of healthy) {
      const [base, quote] = m.pair.split('-') as [string, string];
      add(quote, base, 'kuru-clob');
      add(base, quote, 'kuru-clob');
    }

    return {
      profile,
      chainId: deployment.chainId,
      checkedAt: now,
      skill,
      flow,
      clob,
      execution: { status: 'UNAVAILABLE', reason: EXECUTION_PATH_REASON },
      routes,
    };
  }
}
