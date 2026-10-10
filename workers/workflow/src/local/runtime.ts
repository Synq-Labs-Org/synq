import { readFileSync } from 'node:fs';
import pg from 'pg';
import {
  createPublicClient,
  http,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { anvil } from 'viem/chains';
import { Context } from '@temporalio/activity';
import { localProfile } from '@synq/chain-registry';
import { artifactHash, intentHash, onchainMandateId } from '@synq/kernel';
import { PostgresIdentityStore } from '@synq/identity';
import { PluginRegistry } from '@synq/plugin-sdk';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  projectionConfig,
} from '@synq/read-model';
import {
  identityPorts,
  openDurableKernel,
  type DurableKernel,
} from '@synq/api/kernel-runtime';
import { PostgresKernelStateStore } from '@synq/api/kernel-store';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  readIntegrityKey,
} from '@synq/execution-worker';
import { moduleAbi, registryAbi, tokenAbi } from '@synq/execution-worker/abi';
import { indexedEvents } from '@synq/demo/src/events.js';
import { localTransferPlugin } from '@synq/demo/src/local-transfer-plugin.js';
import type { LocalSynq } from '@synq/demo/src/safe.js';
import { SimulationSchema, StartActionExecutionSchema } from '@synq/schemas';
import {
  createEconomicActivities,
  type EconomicChainPort,
} from '../activities/economic.js';
import { createOperationsActivities } from '../activities/operations.js';
import {
  createApprovalActivities,
  outboxNotifier,
} from '../activities/approval.js';
import {
  FileTickStore,
  createStrategyActivities,
} from '../activities/strategy.js';
import { FileAutonomyFreeze } from '../activities/freeze.js';
import { NO_FAULTS, type FaultHooks } from '../activities/faults.js';
import type { SynqActivities } from '../activities/types.js';
import { unconfiguredPorts } from '../activities/unconfigured.js';
import { actionWorkflowIdFor } from '../client.js';
import { localGateway } from './identity.js';
import type { LocalWorkflowManifest } from './manifest.js';
import { localNow, localTransferStart } from './proposal.js';

/** Keeps long Activities alive while they work; a killed process stops heartbeating at once. */
function withHeartbeats<T extends object>(activities: T, everyMs = 1000): T {
  const wrapped: Record<string, unknown> = {};
  for (const [name, fn] of Object.entries(activities)) {
    if (typeof fn !== 'function') continue;
    wrapped[name] = async (...args: unknown[]) => {
      let ctx: Context | null = null;
      try {
        ctx = Context.current();
      } catch {
        ctx = null;
      }
      const timer = ctx
        ? setInterval(() => ctx!.heartbeat(name), everyMs)
        : null;
      try {
        return await (fn as (...a: unknown[]) => Promise<unknown>)(...args);
      } finally {
        if (timer) clearInterval(timer);
      }
    };
  }
  return wrapped as T;
}

export type LocalRuntime = {
  activities: SynqActivities;
  kernel: DurableKernel;
  journal: ExecutionJournal;
  client: PublicClient;
  close(): Promise<void>;
};

export async function openLocalRuntime(
  manifest: LocalWorkflowManifest,
  options: {
    workerId?: string;
    faults?: FaultHooks;
    allowMainnetBroadcast?: boolean;
  } = {},
): Promise<LocalRuntime> {
  const faults = options.faults ?? NO_FAULTS;
  const chainId = manifest.asset.chainId;
  const client = createPublicClient({
    chain: anvil,
    transport: http(manifest.rpcUrl, { retryCount: 0 }),
  }) as unknown as PublicClient;
  const executor = privateKeyToAccount(
    readFileSync(manifest.executorKeyFile, 'utf8').trim() as Hex,
  );
  if (executor.address.toLowerCase() !== manifest.executor)
    throw new Error('EXECUTOR_KEY_MISMATCH');
  const pool = new pg.Pool({ connectionString: manifest.databaseUrl, max: 4 });
  const identityStore = new PostgresIdentityStore(pool);
  const gateway = localGateway(identityStore, manifest.module, manifest.asset);
  const plugins = new PluginRegistry();
  const plugin = localTransferPlugin(
    client as unknown as LocalSynq['client'],
    () => undefined,
  );
  plugins.register(plugin);
  const rmConfig = projectionConfig({
    chainId,
    profile: localProfile.network.profile,
    startBlock: Number(manifest.deploymentBlock),
    factory: manifest.factory,
    registry: manifest.registry,
    module: manifest.module,
    treasuryAssets: [manifest.token],
    reorgWindowBlocks: 64,
    confirmationDepth: localProfile.confirmationDepth,
  });
  const chainView = {
    client,
    deploymentBlock: BigInt(manifest.deploymentBlock),
    factory: manifest.factory,
    registry: manifest.registry,
    module: manifest.module,
    token: manifest.token,
    account: manifest.account,
  } as unknown as LocalSynq;
  const project = async () => {
    const indexed = await indexedEvents(chainView);
    const store = new MemoryProjectionStore(chainId);
    await new Projector(store, rmConfig).applyWindow({
      fromBlockExclusive: rmConfig.startBlock - 1,
      toBlockInclusive: indexed.checkpoint,
      events: indexed.events,
    });
    return new ProjectionReader(store, rmConfig);
  };
  let last = 0;
  const clock = {
    now: () => (last = Math.max(last, Math.floor(Date.now() / 1000))),
  };
  const kernelStore = new PostgresKernelStateStore(
    pool,
    manifest.kernelInstance,
  );
  await kernelStore.migrate();
  const balance = await client.readContract({
    address: manifest.token,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [manifest.account],
  });
  const kernel = await openDurableKernel(
    {
      network: localProfile.network,
      executionModule: manifest.module,
      clock,
      identity: identityPorts(identityStore),
      client,
      projection: rmConfig,
      snapshots: project,
      head: new ChainHeadObserver(client, chainId, { ttlMs: 0 }),
      maxLagBlocks: Number(localProfile.maxIndexLagBlocks),
      auditKey: Uint8Array.from(
        Buffer.from(readFileSync(manifest.auditKeyFile, 'utf8').trim(), 'hex'),
      ),
      plugins: [plugin.manifest],
      state: {
        mandates: [manifest.mandate],
        balances: [
          {
            account: manifest.account,
            asset: manifest.asset,
            balance: String(balance),
          },
        ],
        balanceBlock: String(await client.getBlockNumber()),
      },
    },
    kernelStore,
  );
  const journal = new ExecutionJournal(
    manifest.journalDirectory,
    undefined,
    undefined,
    {
      bytes: readIntegrityKey(manifest.journalKeyFile, [
        manifest.journalDirectory,
      ]),
      path: manifest.journalKeyFile,
      source: 'FILE',
    },
  );
  const broadcaster = new JournaledBroadcaster(
    journal,
    {
      async sendRawTransaction(raw) {
        await faults.reach('during-activity', keccak256(raw));
        const hash = await client.sendRawTransaction({
          serializedTransaction: raw,
        });
        await faults.reach('after-submit-before-response', hash);
        return hash;
      },
      async receipt(hash) {
        try {
          const r = await client.getTransactionReceipt({ hash });
          return { status: r.status, blockNumber: r.blockNumber };
        } catch {
          return null;
        }
      },
      blockNumber: () => client.getBlockNumber({ cacheTime: 0 }),
    },
    localProfile.confirmationDepth,
  );
  const chain: EconomicChainPort = {
    chainId,
    now: () => localNow(client),
    async buildTransaction(call, from) {
      await client.call({
        account: from,
        to: call.to,
        data: call.data,
        blockTag: 'pending',
      });
      const [fees, gas, nonce] = await Promise.all([
        client.estimateFeesPerGas(),
        client.estimateGas({
          account: from,
          to: call.to,
          data: call.data,
          blockTag: 'pending',
        }),
        client.getTransactionCount({ address: from, blockTag: 'pending' }),
      ]);
      return {
        type: 'eip1559',
        chainId,
        to: call.to,
        data: call.data,
        value: 0n,
        nonce,
        gas: gas * 2n,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      };
    },
    async receipt(hash) {
      try {
        const r = await client.getTransactionReceipt({ hash });
        return {
          status: r.status,
          transactionHash: r.transactionHash,
          blockNumber: r.blockNumber,
          logs: r.logs,
        };
      } catch {
        return null;
      }
    },
    async transactionKnown(hash) {
      try {
        await client.getTransaction({ hash });
        return true;
      } catch {
        return false;
      }
    },
    sendRawTransaction: (raw) =>
      client.sendRawTransaction({ serializedTransaction: raw }),
  };
  const freeze = new FileAutonomyFreeze(manifest.freezeFile);
  const economic = createEconomicActivities({
    chainId,
    allowMainnetBroadcast: options.allowMainnetBroadcast ?? false,
    kernel,
    approvals: gateway,
    simulator: {
      async simulate(intent, calldata) {
        const now = clock.now();
        const context = { network: localProfile.network, now };
        if (!(await plugins.refreshHealth(intent.pluginId, context)))
          throw new Error('PLUGIN_UNHEALTHY');
        return SimulationSchema.parse(
          await plugins
            .getMutator(intent.pluginId, localProfile.network, now)
            .simulate(context, [
              {
                chainId,
                account: intent.account,
                target: intent.target,
                calldata,
                value: intent.nativeValue,
                intentHash: intentHash(intent),
              },
            ]),
        );
      },
    },
    index: {
      async grantIndexed(_grantId, transactionHash) {
        const snapshot = await (
          await project()
        ).groupSnapshot(manifest.chainGroupId);
        return (
          snapshot?.group.grantsExecuted.some(
            (g) => g.transactionHash === transactionHash,
          ) ?? false
        );
      },
    },
    chain,
    broadcaster,
    executor,
    module: manifest.module,
    localAssets: [manifest.asset],
    workerId: options.workerId ?? 'local-workflow-worker',
    freeze,
    faults,
  });
  const operations = createOperationsActivities({
    broadcaster,
    kernel,
    freeze,
    module: manifest.module,
    accountOf: async (groupId) => {
      if (groupId !== manifest.groupId) throw new Error('UNKNOWN_GROUP');
      return manifest.account;
    },
    async modulePaused(account) {
      const block = await client.getBlockNumber({ cacheTime: 0 });
      const paused = await client.readContract({
        address: manifest.module,
        abi: moduleAbi,
        functionName: 'paused',
        args: [account],
        blockNumber: block,
      });
      return { paused, block };
    },
  });
  const approval = createApprovalActivities({
    members: async () =>
      manifest.mandate.members.map((m) => ({
        memberId: m.memberId,
        signer: m.signer as Hex,
      })),
    async observeMandate({ mandateId, groupId, version, kind }) {
      const current = kernel.kernel.mandate(groupId, mandateId);
      const state = await client.readContract({
        address: manifest.registry,
        abi: registryAbi,
        functionName: 'mandateState',
        args: [
          manifest.account,
          onchainMandateId({ ...current, groupId, mandateId }),
        ],
      });
      const observed =
        kind === 'REVOKE'
          ? state.status !== 1
          : Number(state.currentVersion) >= version;
      return {
        observed,
        block: observed ? String(await client.getBlockNumber()) : null,
      };
    },
    async applyMandate({ groupId, mandateId, version }) {
      const current = kernel.kernel.mandate(groupId, mandateId);
      return { applied: current.version >= version, version: current.version };
    },
    notify: outboxNotifier(manifest.outboxFile),
  });
  const ticks = new FileTickStore(manifest.ticksFile);
  const strategy = createStrategyActivities({
    async freshState(strategy) {
      const mandate = kernel.kernel.mandate(
        strategy.groupId,
        strategy.mandateId,
      );
      const budget = kernel.kernel.accounting(
        strategy.groupId,
        strategy.mandateId,
      );
      return {
        mandateVersion: mandate.version,
        mandateActive: mandate.status === 'ACTIVE',
        ticksExecuted: ticks
          .all()
          .filter(
            (t) =>
              t.strategyId === strategy.strategyId && t.decision === 'EXECUTE',
          ).length,
        remainingBudget: String(
          BigInt(mandate.cumulativeBudget) -
            BigInt(budget.spentToken) -
            BigInt(budget.reservedToken),
        ),
        observedAt: await localNow(client),
      };
    },
    async marketEvidence(strategy) {
      const now = await localNow(client);
      const block = await client.getBlock();
      return {
        evidenceHash: artifactHash({
          blockHash: block.hash,
          strategy: strategy.strategyId,
        }),
        referencePrice: '1',
        quotedOutputAmount: strategy.inputAmountPerTick,
        quoteExpiresAt: now + 300,
        riskStatus: 'HEALTHY',
        observedAt: now,
      };
    },
    async buildAction({ strategy, tickKey, amount }) {
      const nonce =
        BigInt(keccak256(new TextEncoder().encode(tickKey))) % 10n ** 18n;
      const start = StartActionExecutionSchema.parse(
        await localTransferStart(manifest, client, {
          nonce: nonce.toString(),
          amount: BigInt(amount),
          proposedIntentId: `dca_${strategy.strategyId}`.slice(0, 120),
          correlationId: `dca.${strategy.strategyId}`.slice(0, 120),
        }),
      );
      return { start, workflowId: actionWorkflowIdFor(start.intent) };
    },
    ticks,
  });
  const activities = withHeartbeats({
    ...unconfiguredPorts(),
    ...economic,
    ...operations,
    ...approval,
    ...strategy,
  }) as SynqActivities;
  return {
    activities,
    kernel,
    journal,
    client,
    close: async () => {
      await pool.end().catch(() => undefined);
    },
  };
}
