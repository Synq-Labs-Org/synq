import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Hex, PublicClient } from 'viem';
import {
  AssetSchema,
  LOCAL_CHAIN_ID,
  MandateSchema,
  type ExecutionGrant,
} from '@synq/schemas';
import { onchainMandateId, toMandateConfig } from '@synq/kernel';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  assessFreshness,
  projectionConfig,
  type ProjectionConfig,
} from '@synq/read-model';
import { createIntentKernel } from '@synq/api/kernel-runtime';
import { localProfile, DeploymentManifestSchema } from '@synq/chain-registry';
import { writeDurableJson } from '@synq/execution-worker/persistence';
import { synqDeployment } from '@synq/execution-worker';
import { tokenAbi } from '@synq/execution-worker/abi';
import { formatDecimal, parseDecimal } from '@synq/domain';
import { PluginRegistry } from '@synq/plugin-sdk';
import { localTransferPlugin } from './local-transfer-plugin.js';
import { startLocalIdentity } from './identity.js';
import { startAnvil } from './anvil.js';
import { deployLocalSynq, type LocalSynq } from './safe.js';
import { indexedEvents } from './events.js';
import { transferVertical } from './vertical.js';

const DEFAULT_TRANSFER_BASE_UNITS = 60_000_000n;
const FUNDING = 200_000_000n;
const GROUP_ID = 'local_group';
const MANDATE_ID = 'local_mandate';
const WORKER_ID = 'local-execution-worker';

function localMandate(chain: LocalSynq, decimals: number, now: number) {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: MANDATE_ID,
    groupId: GROUP_ID,
    version: 1,
    status: 'ACTIVE',
    network: localProfile.network,
    account: chain.account,
    chainGroupId: chain.chainGroupId,
    operators: [chain.executor.address],
    bindings: [
      {
        pluginId: 'local-transfer',
        action: 'TRANSFER',
        target: chain.token,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [{ address: chain.recipient, purpose: 'COUNTERPARTY' }],
    inputAsset: localAsset(chain, decimals),
    outputAssets: [],
    perActionCap: '100000000',
    cumulativeBudget: FUNDING.toString(),
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 0,
    maxReferenceDeviationBps: 0,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '0', reviewMax: '0' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'UNANIMOUS',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['LOCAL_FIXTURE'],
    },
    delegationScope: null,
    members: chain.owners.map((o, i) => ({
      memberId: `member_${i}`,
      signer: o.address,
      active: true,
    })),
    validAfter: now - 10,
    validUntil: now + 3600,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 10,
  });
}
function localAsset(chain: LocalSynq, decimals: number) {
  return AssetSchema.parse({
    canonicalAssetId: `eip155:${LOCAL_CHAIN_ID}/erc20:${chain.token.toLowerCase()}`,
    chainId: LOCAL_CHAIN_ID,
    address: chain.token,
    symbol: 'OTHER',
    decimals,
  });
}
function readModelConfig(chain: LocalSynq): ProjectionConfig {
  if (chain.deploymentBlock === null) throw new Error('DEPLOYMENT_BLOCK');
  return projectionConfig({
    chainId: LOCAL_CHAIN_ID,
    profile: localProfile.network.profile,
    startBlock: Number(chain.deploymentBlock),
    factory: chain.factory,
    registry: chain.registry,
    module: chain.module,
    treasuryAssets: [chain.token],
    reorgWindowBlocks: 64,
    confirmationDepth: localProfile.confirmationDepth,
  });
}

export async function startLocalVertical() {
  const node = await startAnvil();
  const closers: (() => Promise<unknown>)[] = [];
  const close = async () => {
    for (const c of closers.splice(0)) await c().catch(() => undefined);
    await node.close();
  };
  try {
    const chain = await deployLocalSynq(node.url);
    const deployment = synqDeployment('local/anvil', {
      factory: chain.factory,
      registry: chain.registry,
      module: chain.module,
    });
    const clock = {
      t: Number((await chain.client.getBlock()).timestamp),
      now() {
        return this.t;
      },
    };
    const sync = async () => {
      const block = await chain.client.getBlock({ blockTag: 'latest' });
      clock.t = Math.max(clock.t, Number(block.timestamp));
      return clock.t;
    };
    const decimals = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'decimals',
    });
    const asset = localAsset(chain, decimals);
    const mandate = localMandate(chain, decimals, clock.t);
    await chain.governance.setExecutor(chain.executor.address, true);
    await chain.governance.configureMandate(
      onchainMandateId(mandate),
      toMandateConfig(mandate),
    );
    await chain.fund(FUNDING);
    const identity = await startLocalIdentity({
      groupId: GROUP_ID,
      chainGroupId: chain.chainGroupId,
      account: chain.account,
      owners: chain.owners,
      executor: chain.executor.address,
      executionModule: deployment.module,
      asset,
      threshold: 2,
      now: () => clock.t,
    });
    closers.push(identity.close);
    const calldatas = new Map<Hex, Hex>();
    const plugins = new PluginRegistry();
    const plugin = localTransferPlugin(chain.client, (h) => calldatas.get(h));
    plugins.register(plugin);
    const balanceOf = (who: `0x${string}`) =>
      chain.client.readContract({
        address: chain.token,
        abi: tokenAbi,
        functionName: 'balanceOf',
        args: [who],
      });
    const rmConfig = readModelConfig(chain);
    const project = async () => {
      const indexed = await indexedEvents(chain);
      const store = new MemoryProjectionStore(LOCAL_CHAIN_ID);
      await new Projector(store, rmConfig).applyWindow({
        fromBlockExclusive: rmConfig.startBlock - 1,
        toBlockInclusive: indexed.checkpoint,
        events: indexed.events,
      });
      return { indexed, reader: new ProjectionReader(store, rmConfig) };
    };
    const head = new ChainHeadObserver(chain.client, LOCAL_CHAIN_ID, {
      ttlMs: 0,
    });
    const kernel = createIntentKernel({
      network: localProfile.network,
      executionModule: deployment.module,
      clock,
      identity,
      client: chain.client,
      projection: rmConfig,
      snapshots: async () => (await project()).reader,
      head,
      maxLagBlocks: Number(localProfile.maxIndexLagBlocks),
      plugins: [plugin.manifest],
      state: {
        mandates: [mandate],
        balances: [
          {
            account: chain.account,
            asset,
            balance: String(await balanceOf(chain.account)),
          },
        ],
        balanceBlock: String(await chain.client.getBlockNumber()),
      },
    });

    const vertical = transferVertical({
      client: chain.client as unknown as PublicClient,
      network: localProfile.network,
      kernel,
      plugins,
      pluginId: plugin.manifest.id,
      calldatas,
      mandate: () => mandate,
      module: chain.module,
      token: chain.token,
      account: chain.account,
      recipient: chain.recipient,
      executor: chain.executor,
      workerId: WORKER_ID,
      localAssets: [asset],
      sync,
      now: () => clock.t,
      intentPrefix: 'local_intent',
      evidenceSource: 'local-chain-transfer',
      gasLimitPercent: 200n,
      approve: identity.approve,
    });
    const { authorize, execute, onchainRevert } = vertical;

    return {
      node,
      close,
      identity,
      plugins,
      releaseIdentity: async () => {
        for (const c of closers.splice(0)) await c().catch(() => undefined);
      },
      chain,
      kernel,
      mandate,
      asset,
      decimals,
      deployment,
      clock,
      sync,
      project,
      authorize,
      execute,
      onchainRevert,
      balanceOf,
      readModelConfig: rmConfig,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function runLocalDemo(
  outputDirectory: string,
  keepAlive = false,
  requestedAmount?: string,
) {
  const local = await startLocalVertical();
  let completed = false;
  try {
    const { chain, kernel } = local;
    const amount =
      requestedAmount === undefined
        ? DEFAULT_TRANSFER_BASE_UNITS
        : parseDecimal(requestedAmount, local.decimals);
    const authorized = await local.authorize(amount, '1');
    const decision = authorized.decision;
    if (decision.status !== 'AUTHORIZED')
      throw new Error(`KERNEL_REJECTED:${decision.code}`);
    mkdirSync(outputDirectory, { recursive: true });
    writeDurableJson(join(outputDirectory, 'kernel.json'), kernel.snapshot());
    const executed = await local.execute(
      decision.grant,
      authorized.intent,
      authorized.data,
      join(outputDirectory, 'journal'),
    );
    const { indexed, reader } = await local.project();
    const snapshot = await reader.groupSnapshot(chain.chainGroupId);
    if (!snapshot) throw new Error('GROUP_NOT_INDEXED');
    const freshness = assessFreshness({
      sourceChainId: LOCAL_CHAIN_ID,
      indexedThroughBlock: snapshot.indexedThroughBlock,
      head: { block: indexed.checkpoint, observedAt: local.clock.t },
      maxLagBlocks: Number(localProfile.maxIndexLagBlocks),
      frozen: snapshot.group.accountingStatus === 'FROZEN',
    });
    if (freshness.status !== 'FRESH') throw new Error('STALE_READ_MODEL');
    const recipientBalance = await local.balanceOf(chain.recipient);
    const accountBalance = await local.balanceOf(chain.account);
    if (BigInt(snapshot.group.treasury[0]?.balance ?? -1) !== accountBalance)
      throw new Error('INDEX_BALANCE_MISMATCH');
    if (
      executed.observation.event?.tokenAmount !== String(amount) ||
      recipientBalance !== amount
    )
      throw new Error('RECONCILIATION_MISMATCH');
    const manifest = DeploymentManifestSchema.parse({
      schemaVersion: 1,
      network: localProfile.network,
      account: chain.account,
      mandateRegistry: chain.registry,
      executionModule: chain.module,
      deploymentTransactions: chain.deploymentTransactions,
      deploymentBlock: String(chain.deploymentBlock),
      sandboxOnly: true,
    });
    const result = {
      rpcUrl: local.node.url,
      manifest,
      factory: chain.factory,
      safeAccount: chain.account,
      chainGroupId: chain.chainGroupId,
      localTestToken: chain.token,
      localTokenSymbol: 'LOCAL_TEST',
      transferAmount: formatDecimal(amount, local.decimals),
      transactionHash: executed.transactionHash,
      grantId: decision.grant.grantId,
      draftDigest: decision.draft.digest,
      onchainDigest: authorized.onchainDigest,
      intentId: decision.intentId,
      intentHash: decision.grant.intentHash,
      approvals: decision.grant.approvals,
      recipient: chain.recipient,
      recipientBalance: String(recipientBalance),
      accountBalance: String(accountBalance),
      observation: executed.observation,
      accounting: kernel.accounting(GROUP_ID, MANDATE_ID),
      lifecycle: kernel.lifecycle(decision.grant.intentId),
      audit: kernel.auditLog(),
      snapshot,
      events: indexed.events,
      checkpoint: indexed.checkpoint,
      readModelConfig: local.readModelConfig,
      proofSource: 'actual-anvil-receipts',
      identityAssurance: 'local-cryptographic-fixtures',
      kernel: kernel.snapshot(),
    };
    writeFileSync(
      join(outputDirectory, 'demonstration.json'),
      JSON.stringify(result, null, 2) + '\n',
    );
    writeFileSync(
      join(outputDirectory, 'deployment.json'),
      JSON.stringify(manifest, null, 2) + '\n',
    );
    writeDurableJson(join(outputDirectory, 'kernel.json'), kernel.snapshot());
    completed = true;
    return result;
  } finally {
    if (!keepAlive || !completed) await local.close();
    else await local.releaseIdentity();
  }
}

export async function runNegativeScenarios() {
  const local = await startLocalVertical();
  try {
    const { chain, kernel, mandate } = local;
    const grantOf = (d: { status: string; grant?: ExecutionGrant }) => {
      if (d.status !== 'AUTHORIZED' || !d.grant)
        throw new Error(`EXPECTED_GRANT:${d.status}`);
      return d.grant;
    };
    const paused = await local.authorize(1_000_000n, '2');
    const pausedGrant = grantOf(paused.decision);
    await chain.governance.pause();
    const whilePaused = await local.authorize(1_000_000n, '3');
    const pauseRevert = await local.onchainRevert(pausedGrant, paused.data);
    await chain.governance.unpause();

    const superseded = await local.authorize(1_000_000n, '4');
    const supersededGrant = grantOf(superseded.decision);
    const v2 = MandateSchema.parse({
      ...mandate,
      version: 2,
      perActionCap: '50000000',
    });
    await chain.governance.supersedeMandate(
      onchainMandateId(v2),
      2n,
      toMandateConfig(v2),
      true,
    );
    kernel.supersedeMandate(v2, { securitySensitive: true });
    await local.sync();
    let supersededKernel = 'ACCEPTED';
    try {
      kernel.verify(supersededGrant, superseded.intent);
    } catch (error) {
      supersededKernel = (error as { code?: string }).code ?? 'ERROR';
    }
    const supersedeRevert = await local.onchainRevert(
      supersededGrant,
      superseded.data,
    );

    const revoked = await local.authorize(1_000_000n, '5', 2);
    const revokedGrant = grantOf(revoked.decision);
    await chain.governance.revokeMandate(onchainMandateId(v2));
    kernel.revokeMandate(v2.groupId, v2.mandateId);
    await local.sync();
    let revokedKernel = 'ACCEPTED';
    try {
      kernel.verify(revokedGrant, revoked.intent);
    } catch (error) {
      revokedKernel = (error as { code?: string }).code ?? 'ERROR';
    }
    const revokeRevert = await local.onchainRevert(revokedGrant, revoked.data);
    const afterRevoke = await local.authorize(1_000_000n, '6', 2);
    return {
      pause: {
        kernel:
          whilePaused.decision.status === 'AUTHORIZED'
            ? 'AUTHORIZED'
            : whilePaused.decision.code,
        onchain: pauseRevert,
      },
      supersede: { kernel: supersededKernel, onchain: supersedeRevert },
      revoke: {
        kernel: revokedKernel,
        onchain: revokeRevert,
        newIntent:
          afterRevoke.decision.status === 'AUTHORIZED'
            ? 'AUTHORIZED'
            : afterRevoke.decision.code,
      },
      recipientBalance: String(await local.balanceOf(chain.recipient)),
    };
  } finally {
    await local.close();
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await runLocalDemo(
    resolve('artifacts/local'),
    process.env.SYNQ_KEEP_LOCAL_CHAIN === '1',
    process.env.SYNQ_DEMO_AMOUNT,
  );
  console.log(
    JSON.stringify(
      {
        transactionHash: result.transactionHash,
        transferAmount: result.transferAmount,
        accountBalance: result.accountBalance,
        recipientBalance: result.recipientBalance,
        readState: result.snapshot,
      },
      null,
      2,
    ),
  );
}
