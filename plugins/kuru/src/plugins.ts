import { keccak256, type Hex, type PublicClient } from 'viem';
import { chainRegistry, contractEntries } from '@synq/chain-registry';
import type {
  ExecutionGrant,
  PluginHealth,
  PluginManifestInput,
  Simulation,
} from '@synq/domain';
import type {
  PluginContext,
  PreparedAction,
  SynqPlugin,
} from '@synq/plugin-sdk';
import type { KuruClobAdapter } from './clob.js';
import { EXECUTION_PATH_REASON } from './capabilities.js';
import { kuruDeployment, type Address } from './deployment.js';
import { KuruError, requireKuru } from './errors.js';
import type { KuruFlowClient } from './flow-client.js';
import { verifyPreparedSwap, type PreparedSwap } from './flow.js';
import { simulateSwap } from './simulate.js';

const mainnet = chainRegistry.profiles['proof/monad-mainnet'].network.chainId;
const testnet = chainRegistry.profiles['sandbox/monad-testnet'].network.chainId;
const common = {
  version: '0.1.0',
  riskClass: 'FINANCIAL_EXECUTION',
  requiresSimulation: true,
  maxGrantTtlSeconds: 60,
  dependencies: { viem: '2.57.4' },
} as const;

export const kuruFlowManifest: PluginManifestInput = {
  ...common,
  id: 'kuru-flow',
  capabilities: ['READ_MARKET', 'QUOTE', 'SPOT_TRADE'],
  chains: [mainnet],
  sourceDocs: [
    'https://docs.kuru.io/api-reference/calculate-best-path-quote',
    'https://docs.kuru.io/contracts/Contract-addresses',
  ],
  sourceIds: ['S104', 'SYNQ-091', 'SYNQ-092'],
  health: { maxStalenessSeconds: 60, checks: ['RPC', 'PROVIDER_API'] },
};
export const kuruSkillManifest: PluginManifestInput = {
  ...common,
  id: 'kuru-skill',
  capabilities: ['READ_MARKET', 'QUOTE', 'SPOT_TRADE'],
  chains: [mainnet],
  sourceDocs: ['https://github.com/Kuru-Labs/kuru-trading-skills'],
  sourceIds: ['S025', 'SYNQ-091'],
  health: { maxStalenessSeconds: 60, checks: ['RPC', 'PROVIDER_API'] },
};
export const kuruClobManifest: PluginManifestInput = {
  ...common,
  id: 'kuru-clob',
  capabilities: ['READ_MARKET', 'QUOTE', 'SPOT_TRADE'],
  chains: [testnet, mainnet],
  sourceDocs: ['https://docs.kuru.io/contracts/Contract-addresses'],
  sourceIds: ['SYNQ-091'],
  health: { maxStalenessSeconds: 60, checks: ['RPC', 'QUOTE_SOURCE'] },
};

type Chain = Pick<
  PublicClient,
  | 'getChainId'
  | 'getCode'
  | 'readContract'
  | 'simulateCalls'
  | 'request'
  | 'getBlockNumber'
>;
export type KuruPluginDeps = {
  clientFor: (context: PluginContext) => Chain;
  flow: KuruFlowClient;
  clob: KuruClobAdapter;
  probeAddress: Address;
};

const ok = (context: PluginContext): PluginHealth => ({
  available: true,
  checkedAt: context.now,
});
const down = (context: PluginContext, reason: string): PluginHealth => ({
  available: false,
  checkedAt: context.now,
  reason: reason.slice(0, 200),
});

async function codeMatches(
  client: Chain,
  chainId: number,
  kind: 'KURU_FLOW_ENTRYPOINT',
): Promise<boolean> {
  const entry = contractEntries(chainId, kind)[0];
  if (!entry?.codeHash) return false;
  const code = await client.getCode({ address: entry.address });
  return code !== undefined && keccak256(code) === entry.codeHash;
}

/**
 * Grant-bound swap store: `prepare` only returns calldata that was quoted, verified and stored earlier, and
 * re-verifies it against the grant (target, selector, calldata hash, token, amount, minimum output, account, expiry).
 */
export class PreparedSwapStore {
  private readonly swaps = new Map<Hex, PreparedSwap>();
  put(swap: PreparedSwap): void {
    this.swaps.set(swap.calldataHash, swap);
  }
  forGrant(context: PluginContext, grant: ExecutionGrant): PreparedAction[] {
    const swap = this.swaps.get(grant.calldataHash);
    requireKuru(
      swap !== undefined,
      'CALLDATA_MISMATCH',
      'no prepared swap for this grant',
    );
    requireKuru(
      grant.chainId === swap.chainId &&
        context.network.chainId === swap.chainId,
      'WRONG_CHAIN',
    );
    requireKuru(grant.target === swap.swap.target, 'WRONG_TARGET');
    requireKuru(
      grant.selector === swap.swap.calldata.slice(0, 10).toLowerCase(),
      'CALLDATA_MISMATCH',
      'selector',
    );
    requireKuru(
      grant.inputAsset?.address === swap.tokenIn &&
        grant.outputToken === swap.tokenOut,
      'WRONG_TOKEN',
    );
    verifyPreparedSwap(swap, {
      profile: context.network.profile,
      account: grant.account,
      tokenIn: swap.tokenIn,
      tokenOut: swap.tokenOut,
      amountIn: BigInt(grant.maxInputAmount),
      maxInputAmount: BigInt(grant.maxInputAmount),
      minOutputFloor: BigInt(grant.minOutputAmount),
      quotedOutput: swap.quotedOutput,
      now: context.now * 1000,
    });
    requireKuru(
      swap.expiresAt <= grant.validUntil * 1000 + 60_000,
      'QUOTE_EXPIRED',
      'quote outlives grant',
    );
    return [
      {
        chainId: swap.chainId,
        account: swap.account,
        target: swap.swap.target,
        calldata: swap.swap.calldata,
        value: swap.swap.value.toString(),
        intentHash: grant.intentHash,
      },
    ];
  }
  get(calldataHash: Hex): PreparedSwap | undefined {
    return this.swaps.get(calldataHash);
  }
}

function unavailableExecution(): never {
  throw new KuruError('EXECUTION_PATH_UNAVAILABLE', EXECUTION_PATH_REASON);
}

function swapPlugin(
  manifest: PluginManifestInput,
  deps: KuruPluginDeps,
  store: PreparedSwapStore,
): SynqPlugin {
  return {
    manifest,
    async health(context) {
      try {
        if (context.network.profile !== 'proof/monad-mainnet')
          return down(context, 'UNAVAILABLE_IN_NETWORK_PROFILE');
        const client = deps.clientFor(context);
        if ((await client.getChainId()) !== context.network.chainId)
          return down(context, 'rpc chain mismatch');
        if (
          !(await codeMatches(
            client,
            context.network.chainId,
            'KURU_FLOW_ENTRYPOINT',
          ))
        )
          return down(
            context,
            'Flow entrypoint codehash differs from the registry',
          );
        await deps.flow.token(deps.probeAddress);
        return ok(context);
      } catch (error) {
        return down(
          context,
          error instanceof KuruError ? error.code : 'health probe failed',
        );
      }
    },
    async prepare(context, grant) {
      return store.forGrant(context, grant);
    },
    async simulate(context, actions): Promise<Simulation> {
      const action = actions[0];
      requireKuru(
        actions.length === 1 && action !== undefined,
        'SIMULATION_FAILED',
        'one swap action',
      );
      const swap = store.get(keccak256(action.calldata));
      requireKuru(swap !== undefined, 'CALLDATA_MISMATCH');
      const result = await simulateSwap(deps.clientFor(context), {
        account: swap.account,
        tokenIn: swap.tokenIn,
        tokenOut: swap.tokenOut,
        amountIn: swap.amountIn,
        approval: swap.approval,
        swap: swap.swap,
      });
      return {
        intentHash: action.intentHash,
        calldataHash: swap.calldataHash,
        chainId: context.network.chainId,
        account: swap.account,
        target: swap.swap.target,
        succeeded:
          result.succeeded &&
          BigInt(result.outputAmount) >= swap.minOutput &&
          BigInt(result.inputBalanceBefore) -
            BigInt(result.inputBalanceAfter) ===
            swap.amountIn &&
          result.residualAllowance === '0',
        simulatedAt: context.now,
        blockNumber: result.blockNumber,
        artifactHash: keccak256(
          new TextEncoder().encode(JSON.stringify(result)),
        ),
      } as Simulation;
    },
    async execute() {
      return unavailableExecution();
    },
    async reconcile() {
      return unavailableExecution();
    },
  };
}

export function kuruFlowPlugin(
  deps: KuruPluginDeps,
  store = new PreparedSwapStore(),
): SynqPlugin {
  return swapPlugin(kuruFlowManifest, deps, store);
}
export function kuruSkillPlugin(
  deps: KuruPluginDeps,
  store = new PreparedSwapStore(),
): SynqPlugin {
  return swapPlugin(kuruSkillManifest, deps, store);
}

export function kuruClobPlugin(deps: KuruPluginDeps): SynqPlugin {
  return {
    manifest: kuruClobManifest,
    async health(context) {
      try {
        const markets = kuruDeployment(context.network.profile).markets;
        if (markets.length === 0)
          return down(context, 'UNAVAILABLE_IN_NETWORK_PROFILE');
        for (const market of markets)
          await deps.clob.marketParams(context.network.profile, market.pair);
        return ok(context);
      } catch (error) {
        return down(
          context,
          error instanceof KuruError ? error.code : 'health probe failed',
        );
      }
    },
    async prepare() {
      return unavailableExecution();
    },
    async simulate() {
      return unavailableExecution();
    },
    async execute() {
      return unavailableExecution();
    },
    async reconcile() {
      return unavailableExecution();
    },
  };
}
