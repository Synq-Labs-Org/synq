import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { createTestClient, createWalletClient, http, type Hex } from 'viem';
import {
  generatePrivateKey,
  privateKeyToAccount,
  type PrivateKeyAccount,
} from 'viem/accounts';
import { anvil } from 'viem/chains';
import {
  AssetSchema,
  LOCAL_CHAIN_ID,
  MandateSchema,
  type Asset,
  type Mandate,
} from '@synq/schemas';
import { localProfile } from '@synq/chain-registry';
import { onchainMandateId, toMandateConfig } from '@synq/kernel';
import { PostgresIdentityStore } from '@synq/identity';
import { tokenAbi } from '@synq/execution-worker/abi';
import { startAnvil } from '@synq/demo/src/anvil.js';
import { deployLocalSynq, type LocalSynq } from '@synq/demo/src/safe.js';
import { enrolLocalGroup, ensureDatabase, localGateway } from './identity.js';
import {
  canonicalAssetKey,
  encodeAttestationReport,
} from '@synq/plugin-chainlink-cre';
import { riskAttestationRegistryAbi } from '@synq/plugin-chainlink-cre';
import type { LocalWorkflowManifest } from './manifest.js';

export const LOCAL_GROUP_ID = 'wf_local_group';
export const LOCAL_MANDATE_ID = 'wf_local_mandate';
export const LOCAL_FUNDING = 1_000_000_000n;

function localMandate(
  chain: LocalSynq,
  executor: `0x${string}`,
  asset: Asset,
  now: number,
  ttlSeconds: number,
): Mandate {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: LOCAL_MANDATE_ID,
    groupId: LOCAL_GROUP_ID,
    version: 1,
    status: 'ACTIVE',
    network: localProfile.network,
    account: chain.account,
    chainGroupId: chain.chainGroupId,
    operators: [executor],
    bindings: [
      {
        pluginId: 'local-transfer',
        action: 'TRANSFER',
        target: chain.token,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [{ address: chain.recipient, purpose: 'COUNTERPARTY' }],
    inputAsset: asset,
    outputAssets: [],
    perActionCap: '100000000',
    cumulativeBudget: LOCAL_FUNDING.toString(),
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
    validAfter: now - 600,
    validUntil: now + ttlSeconds,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 50,
  });
}

function secretFile(path: string, value: string): string {
  writeFileSync(path, `${value}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

export type LocalEnvironment = {
  manifest: LocalWorkflowManifest;
  manifestPath: string;
  chain: LocalSynq;
  owners: PrivateKeyAccount[];
  principalIds: string[];
  gateway: ReturnType<typeof localGateway>;
  pool: pg.Pool;
  close(): Promise<void>;
};

/**
 * Local-anvil environment for workflow development and the crash harness: real Safe, MandateRegistry
 * and ExecutionModule, a funded group, LOCAL_FIXTURE identities in Postgres and on-disk keys.
 * The owner keys stay with the caller (they approve); the worker only gets the executor key.
 */
export async function bootstrapLocalEnvironment(input: {
  dataDir: string;
  databaseUrl: string;
  mandateTtlSeconds?: number;
  funding?: bigint;
}): Promise<LocalEnvironment> {
  const dataDir = resolve(input.dataDir);
  const keys = join(dataDir, 'keys');
  mkdirSync(keys, { recursive: true, mode: 0o700 });
  await ensureDatabase(input.databaseUrl);
  const node = await startAnvil();
  const pool = new pg.Pool({ connectionString: input.databaseUrl, max: 4 });
  const close = async () => {
    await pool.end().catch(() => undefined);
    await node.close();
  };
  try {
    const chain = await deployLocalSynq(node.url);
    const decimals = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'decimals',
    });
    const asset = AssetSchema.parse({
      canonicalAssetId: `eip155:${LOCAL_CHAIN_ID}/erc20:${chain.token.toLowerCase()}`,
      chainId: LOCAL_CHAIN_ID,
      address: chain.token,
      symbol: 'OTHER',
      decimals,
    });
    const executorPrivateKey = generatePrivateKey();
    const executor = privateKeyToAccount(executorPrivateKey);
    await createTestClient({
      chain: anvil,
      mode: 'anvil',
      transport: http(node.url),
    }).setBalance({
      address: executor.address,
      value: 10n ** 20n,
    });
    const now = Number((await chain.client.getBlock()).timestamp);
    const mandate = localMandate(
      chain,
      executor.address,
      asset,
      now,
      input.mandateTtlSeconds ?? 6 * 3600,
    );
    await chain.governance.setExecutor(executor.address, true);
    await chain.governance.configureMandate(
      onchainMandateId(mandate),
      toMandateConfig(mandate),
    );
    await chain.fund(input.funding ?? LOCAL_FUNDING);
    const principalIds = await enrolLocalGroup(pool, {
      groupId: LOCAL_GROUP_ID,
      chainGroupId: chain.chainGroupId,
      account: chain.account,
      owners: chain.owners,
      executor: executor.address,
      threshold: 2,
    });
    const forwarder = chain.executor.address.toLowerCase() as Hex;
    const wallet = createWalletClient({
      chain: anvil,
      account: chain.executor,
      transport: http(node.url),
    });
    const artifact = JSON.parse(
      readFileSync(
        'contracts/out/RiskAttestationRegistry.sol/RiskAttestationRegistry.json',
        'utf8',
      ),
    ) as { abi: readonly unknown[]; bytecode: { object: Hex } };
    const deployment = await wallet.deployContract({
      abi: artifact.abi,
      bytecode: artifact.bytecode.object,
      args: [forwarder],
    });
    const registry = (
      await chain.client.waitForTransactionReceipt({ hash: deployment })
    ).contractAddress!;
    const workflowId = `0x${'11'.repeat(32)}` as Hex;
    const sourceConfigHash = `0x${'22'.repeat(32)}` as Hex;
    const assetId = canonicalAssetKey(LOCAL_CHAIN_ID, chain.token);
    const timestamp = (await chain.client.getBlock()).timestamp;
    const reportTx = await wallet.writeContract({
      address: registry,
      abi: riskAttestationRegistryAbi,
      functionName: 'onReport',
      args: [
        (workflowId + '00'.repeat(30)) as Hex,
        encodeAttestationReport({
          assetId,
          timestamp,
          referencePrice: 100_000_000n,
          deviationBps: 0,
          stalenessSec: 0n,
          status: 'HEALTHY',
          sourceConfigHash,
          reasons: ['LOCAL_SIMULATION'],
        }),
      ],
    });
    await chain.client.waitForTransactionReceipt({ hash: reportTx });
    const runId = `${Date.now()}-${process.pid}`;
    const manifest: LocalWorkflowManifest = {
      schemaVersion: 1,
      executionMode: 'SIMULATION',
      rpcUrl: node.url,
      riskAttestation: {
        registry: registry.toLowerCase() as Hex,
        forwarder,
        workflowId,
        sourceConfigHash,
        assetId,
      },
      factory: chain.factory.toLowerCase() as `0x${string}`,
      registry: chain.registry.toLowerCase() as `0x${string}`,
      module: chain.module.toLowerCase() as `0x${string}`,
      token: chain.token.toLowerCase() as `0x${string}`,
      account: chain.account.toLowerCase() as `0x${string}`,
      recipient: chain.recipient.toLowerCase() as `0x${string}`,
      executor: executor.address.toLowerCase() as `0x${string}`,
      chainGroupId: chain.chainGroupId,
      deploymentBlock: String(chain.deploymentBlock),
      groupId: LOCAL_GROUP_ID,
      mandate,
      asset,
      owners: chain.owners.map((o) => o.address.toLowerCase() as `0x${string}`),
      databaseUrl: input.databaseUrl,
      kernelInstance: `workflow-local:${runId}`,
      executorKeyFile: secretFile(
        join(keys, 'executor.key'),
        executorPrivateKey,
      ),
      auditKeyFile: secretFile(
        join(keys, 'kernel-audit.key'),
        randomBytes(32).toString('hex'),
      ),
      journalKeyFile: secretFile(
        join(keys, 'journal.key'),
        randomBytes(32).toString('hex'),
      ),
      journalDirectory: join(dataDir, 'journal'),
      freezeFile: join(dataDir, 'autonomy-freeze.json'),
      ticksFile: join(dataDir, 'dca-ticks.json'),
      outboxFile: join(dataDir, 'outbox.jsonl'),
    };
    const manifestPath = join(dataDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
      mode: 0o600,
    });
    const gateway = localGateway(
      new PostgresIdentityStore(pool),
      manifest.module,
      asset,
    );
    return {
      manifest,
      manifestPath,
      chain,
      owners: chain.owners,
      principalIds,
      gateway,
      pool,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
