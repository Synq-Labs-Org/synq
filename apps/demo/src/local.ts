import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BaseError,
  ContractFunctionRevertedError,
  encodeFunctionData,
  keccak256,
  type Hex,
} from 'viem';
import {
  AssetSchema,
  BoundActionIntentSchema,
  MandateSchema,
  executionGrantTypedData,
  type BoundActionIntent,
  type ExecutionGrant,
  type RiskPacket,
} from '@synq/schemas';
import {
  Kernel,
  artifactHash,
  economicIntentHash,
  intentHash,
  onchainMandateId,
  toMandateConfig,
  type DirectVerifier,
  type FreshnessProbe,
} from '@synq/kernel';
import { PrincipalRegistry } from '@synq/identity';
import {
  ChainHeadObserver,
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  assessFreshness,
  projectionConfig,
  type ProjectionConfig,
} from '@synq/read-model';
import {
  ReadModelFreshnessProbe,
  RpcKernelDirectVerifier,
} from '@synq/read-model/kernel';
import { localProfile, DeploymentManifestSchema } from '@synq/chain-registry';
import { writeDurableJson } from '@synq/execution-worker/persistence';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  chainGrant,
  observeGrantExecution,
  onchainGrantArgs,
  packSafeSignatures,
  prepareModuleCall,
  signGrantBoundTransaction,
  synqDeployment,
} from '@synq/execution-worker';
import { moduleAbi, registryAbi, tokenAbi } from '@synq/execution-worker/abi';
import { formatDecimal, parseDecimal } from '@synq/domain';
import { PluginRegistry } from '@synq/plugin-sdk';
import { localTransferPlugin } from './local-transfer-plugin.js';
import { LocalApprovalDesk } from './approval-desk.js';
import { startAnvil } from './anvil.js';
import { deployLocalSynq, type LocalSynq } from './safe.js';
import { indexedEvents } from './events.js';

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
    canonicalAssetId: `eip155:31337/erc20:${chain.token.toLowerCase()}`,
    chainId: 31337,
    address: chain.token,
    symbol: 'OTHER',
    decimals,
  });
}
function readModelConfig(chain: LocalSynq): ProjectionConfig {
  if (chain.deploymentBlock === null) throw new Error('DEPLOYMENT_BLOCK');
  return projectionConfig({
    chainId: 31337,
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
    const registry = new PrincipalRegistry('local/anvil', () =>
      chain.owners.map((o) => o.address),
    );
    chain.owners.forEach((owner, i) => {
      registry.register({
        principalId: `fixture_${i}`,
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owner.address,
      });
      registry.bindMembership(GROUP_ID, `member_${i}`, `fixture_${i}`);
    });
    const desk = new LocalApprovalDesk(registry);
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
      const store = new MemoryProjectionStore(31337);
      await new Projector(store, rmConfig).applyWindow({
        fromBlockExclusive: rmConfig.startBlock - 1,
        toBlockInclusive: indexed.checkpoint,
        events: indexed.events,
      });
      return { indexed, reader: new ProjectionReader(store, rmConfig) };
    };
    const head = new ChainHeadObserver(chain.client, 31337, { ttlMs: 0 });
    const probe: FreshnessProbe = {
      async observe(query) {
        const { reader } = await project();
        return new ReadModelFreshnessProbe(reader, head).observe(query);
      },
    };
    const verifier: DirectVerifier = new RpcKernelDirectVerifier(
      chain.client,
      rmConfig,
    );
    const kernel = new Kernel({
      network: localProfile.network,
      executionModule: deployment.module,
      clock,
      approvalLedger: desk,
      membershipDirectory: registry,
      freshness: {
        probe,
        verifier,
        maxLagBlocks: Number(localProfile.maxIndexLagBlocks),
      },
      plugins: [plugin.manifest],
      mandates: [mandate],
      balances: [
        {
          account: chain.account,
          asset,
          balance: String(await balanceOf(chain.account)),
        },
      ],
      balanceBlock: String(await chain.client.getBlockNumber()),
    });

    async function propose(amount: bigint, nonce: string, version = 1) {
      const now = await sync();
      const data = encodeFunctionData({
        abi: tokenAbi,
        functionName: 'transfer',
        args: [chain.recipient, amount],
      });
      calldatas.set(keccak256(data), data);
      const zero = `0x${'0'.repeat(64)}`;
      const input = BoundActionIntentSchema.parse({
        schemaVersion: 1,
        intentId: `local_intent_${nonce}`,
        groupId: GROUP_ID,
        mandateId: MANDATE_ID,
        mandateVersion: version,
        action: 'TRANSFER',
        chainId: 31337,
        account: chain.account,
        operator: chain.executor.address,
        recipient: chain.recipient,
        pluginId: 'local-transfer',
        target: chain.token,
        selector: '0xa9059cbb',
        calldataHash: keccak256(data),
        inputToken: chain.token,
        maxInputAmount: String(amount),
        minOutputAmount: '0',
        nativeValue: '0',
        validAfter: now - 10,
        validUntil: Math.min(now + 600, mandate.validUntil),
        nonce,
        evidenceHash: zero,
        riskPacketHash: zero,
      });
      const block = await chain.client.getBlock();
      const risk: RiskPacket = {
        schemaVersion: 1,
        intentHash: economicIntentHash(input),
        evaluatedAt: now,
        quoteAt: now,
        quoteExpiresAt: now + 300,
        slippageBps: 0,
        referenceDeviationBps: 0,
        maxReferenceDeviationBps: 0,
        blocked: false,
        evidence: [
          {
            source: 'local-chain-transfer',
            retrievedAt: now,
            chainId: 31337,
            artifactHash: artifactHash({
              blockHash: block.hash,
              token: chain.token,
            }),
            untrusted: false,
          },
        ],
      };
      const intent = BoundActionIntentSchema.parse({
        ...input,
        evidenceHash: artifactHash(risk.evidence),
        riskPacketHash: artifactHash(risk),
      });
      const context = { network: localProfile.network, now };
      if (!(await plugins.refreshHealth(intent.pluginId, context)))
        throw new Error('PLUGIN_UNHEALTHY');
      const simulation = await plugins
        .getMutator(intent.pluginId, localProfile.network, now)
        .simulate(context, [
          {
            chainId: 31337,
            account: intent.account,
            target: intent.target,
            calldata: data,
            value: intent.nativeValue,
            intentHash: intentHash(intent),
          },
        ]);
      kernel.attestEvidence({
        riskPacketHashes: [artifactHash(risk)],
        simulationHashes: [artifactHash(simulation)],
      });
      return { intent, risk, simulation, data };
    }

    async function authorize(amount: bigint, nonce: string, version = 1) {
      const proposal = await propose(amount, nonce, version);
      const request = {
        intent: proposal.intent,
        risk: proposal.risk,
        simulation: proposal.simulation,
      };
      const pending = await kernel.authorize({ ...request, approvals: [] });
      if (pending.status !== 'PENDING_APPROVAL' || !pending.draft)
        return { ...proposal, decision: pending, onchainDigest: null };
      const draft = pending.draft;
      const onchainDigest = await chain.client.readContract({
        address: chain.module,
        abi: moduleAbi,
        functionName: 'hashGrant',
        args: [onchainGrantArgs(draft.grant)],
      });
      if (onchainDigest !== draft.digest)
        throw new Error('EIP712_DIGEST_DIVERGES_FROM_MODULE');
      const approvals = [];
      for (const i of [0, 1]) {
        const challenge = await desk.issue(draft, `member_${i}`, clock.t);
        const signature = await chain.owners[i]!.signTypedData(
          executionGrantTypedData(draft.domain, draft.grant),
        );
        approvals.push(
          await desk.submit(challenge.challengeId, signature, clock.t),
        );
      }
      const decision = await kernel.authorize({ ...request, approvals });
      return { ...proposal, decision, onchainDigest };
    }

    async function execute(
      grant: ExecutionGrant,
      intent: BoundActionIntent,
      data: Hex,
      journalDirectory: string,
    ) {
      await sync();
      const claim = kernel.claimForExecution(grant, intent, WORKER_ID);
      const call = prepareModuleCall(kernel, claim, data, [asset]);
      await chain.client.call({
        account: chain.executor.address,
        to: call.to,
        data: call.data,
      });
      const fees = await chain.client.estimateFeesPerGas();
      const gas = await chain.client.estimateGas({
        account: chain.executor.address,
        to: call.to,
        data: call.data,
      });
      const raw = await signGrantBoundTransaction(
        grant,
        {
          type: 'eip1559',
          chainId: 31337,
          to: call.to,
          data: call.data,
          value: 0n,
          nonce: await chain.client.getTransactionCount({
            address: chain.executor.address,
          }),
          gas: gas * 2n,
          maxFeePerGas: fees.maxFeePerGas,
          maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
        },
        chain.executor,
        clock.t,
        [asset],
      );
      const transactionHash = keccak256(raw);
      const broadcaster = new JournaledBroadcaster(
        new ExecutionJournal(journalDirectory),
        {
          sendRawTransaction: (serialized) =>
            chain.client.sendRawTransaction({
              serializedTransaction: serialized,
            }),
          receipt: async (hash) => {
            try {
              const r = await chain.client.getTransactionReceipt({ hash });
              return { status: r.status, blockNumber: r.blockNumber };
            } catch {
              return null;
            }
          },
        },
      );
      const submitted = await broadcaster.submit({
        schemaVersion: 1,
        grantId: grant.grantId,
        transactionHash,
        rawTransaction: raw,
        state: 'SIGNED',
        chainId: 31337,
        blockNumber: null,
      });
      if (submitted.state === 'RECONCILIATION_REQUIRED')
        throw new Error('SUBMISSION_AMBIGUOUS: reconcile journal before retry');
      const receipt = await chain.client.waitForTransactionReceipt({
        hash: transactionHash,
      });
      await broadcaster.reconcile(grant.grantId);
      const observation = observeGrantExecution(receipt, chain.module, 31337);
      kernel.reconcile(grant.grantId, observation);
      return { transactionHash, receipt, observation };
    }

    async function onchainRevert(grant: ExecutionGrant, data: Hex) {
      try {
        await chain.client.simulateContract({
          account: chain.executor.address,
          address: chain.module,
          abi: [...moduleAbi, ...registryAbi],
          functionName: 'execute',
          args: [
            chainGrant(grant, [asset]),
            data,
            packSafeSignatures(grant.approvals, grant.draft),
          ],
        });
        return null;
      } catch (error) {
        if (!(error instanceof BaseError)) throw error;
        const reverted = error.walk(
          (e) => e instanceof ContractFunctionRevertedError,
        );
        return reverted instanceof ContractFunctionRevertedError
          ? (reverted.data?.errorName ?? 'UNKNOWN_REVERT')
          : 'UNKNOWN_REVERT';
      }
    }

    return {
      node,
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
    await node.close();
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
      sourceChainId: 31337,
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
    if (!keepAlive || !completed) await local.node.close();
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
    await local.node.close();
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
