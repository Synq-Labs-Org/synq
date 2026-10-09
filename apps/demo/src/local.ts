import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeFunctionData, keccak256, stringToHex } from 'viem';
import {
  BoundActionIntentSchema,
  MandateSchema,
  AssetSchema,
  type RiskPacket,
  type Simulation,
} from '@synq/schemas';
import {
  Kernel,
  artifactHash,
  economicIntentHash,
  intentHash,
  approvalTypedData,
} from '@synq/kernel';
import { ApprovalService, MemoryChallengeStore } from '@synq/identity';
import { DeterministicReadModel, verifyFresh } from '@synq/read-model';
import { localProfile, DeploymentManifestSchema } from '@synq/chain-registry';
import { writeDurableJson } from '@synq/execution-worker/persistence';
import {
  chainGrant,
  prepareModuleCall,
  ExecutionJournal,
  JournaledBroadcaster,
} from '@synq/execution-worker';
import { registryAbi, moduleAbi, tokenAbi } from '@synq/execution-worker/abi';
import { formatDecimal, parseDecimal } from '@synq/domain';
import { PluginRegistry } from '@synq/plugin-sdk';
import { localTransferPlugin } from './local-transfer-plugin.js';
import { startAnvil } from './anvil.js';
import { sandbox } from './sandbox.js';
import { indexedEvents } from './events.js';
const DEFAULT_TRANSFER_BASE_UNITS = 60_000_000n;
export async function runLocalDemo(
  outputDirectory: string,
  keepAlive = false,
  requestedAmount?: string,
) {
  const node = await startAnvil();
  let completed = false;
  try {
    const groupId = 'local_group';
    const mandateId = 'local_mandate';
    const groupHash = keccak256(stringToHex(groupId));
    const chain = await sandbox(node.url, groupHash);
    const block = await chain.client.getBlock();
    const now = Number(block.timestamp);
    const decimals = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'decimals',
    });
    const amount =
      requestedAmount === undefined
        ? DEFAULT_TRANSFER_BASE_UNITS
        : parseDecimal(requestedAmount, decimals);
    const asset = AssetSchema.parse({
      canonicalAssetId: `eip155:31337/erc20:${chain.token.toLowerCase()}`,
      chainId: 31337,
      address: chain.token,
      symbol: 'OTHER',
      decimals,
    });
    const mandate = MandateSchema.parse({
      schemaVersion: 1,
      mandateId,
      groupId,
      version: 1,
      status: 'ACTIVE',
      network: localProfile.network,
      account: chain.account,
      operators: [chain.operator.address],
      plugins: ['local-transfer'],
      actions: ['TRANSFER'],
      targets: [chain.token],
      selectors: ['0xa9059cbb'],
      inputAsset: asset,
      outputAssets: [],
      allowNewOutputAssets: false,
      perActionCap: '100000000',
      cumulativeBudget: '200000000',
      maxNativeValue: '0',
      maxSlippageBps: 0,
      maxReferenceDeviationBps: 0,
      maxLeverageBps: 0,
      autoCap: '0',
      reviewCap: '0',
      quorum: 2,
      members: chain.owners.map((o, i) => ({
        memberId: `member_${i}`,
        signer: o.address,
        active: true,
      })),
      validAfter: now - 10,
      validUntil: now + 3600,
      quoteTtlSeconds: 60,
      evidenceTtlSeconds: 60,
      simulationTtlSeconds: 60,
      maxGrantTtlSeconds: 120,
      minIntervalSeconds: 0,
      maxExecutions: 10,
    });
    await chain.governance(
      chain.registry,
      encodeFunctionData({
        abi: registryAbi,
        functionName: 'configure',
        args: [
          keccak256(stringToHex(mandateId)),
          1n,
          {
            target: chain.token,
            selector: '0xa9059cbb',
            inputToken: chain.token,
            maxPerCall: 100_000_000n,
            cumulativeCap: 200_000_000n,
            maxValue: 0n,
            validUntil: BigInt(mandate.validUntil),
          },
        ],
      }),
    );
    const data = encodeFunctionData({
      abi: tokenAbi,
      functionName: 'transfer',
      args: [chain.recipient, amount],
    });
    const zeroHash = `0x${'0'.repeat(64)}`;
    const input = BoundActionIntentSchema.parse({
      schemaVersion: 1,
      intentId: 'local_intent',
      groupId,
      mandateId,
      mandateVersion: 1,
      action: 'TRANSFER',
      chainId: 31337,
      account: chain.account,
      operator: chain.operator.address,
      pluginId: 'local-transfer',
      target: chain.token,
      selector: '0xa9059cbb',
      calldataHash: keccak256(data),
      inputToken: asset.address,
      maxInputAmount: String(amount),
      minOutputAmount: '0',
      nativeValue: '0',
      maxSlippageBps: 0,
      leverageBps: 0,
      validAfter: now - 10,
      validUntil: now + 300,
      nonce: '1',
      evidenceHash: zeroHash,
      riskPacketHash: zeroHash,
    });
    const reference = {
      source: 'local-chain-transfer',
      retrievedAt: now,
      chainId: 31337 as const,
      artifactHash: artifactHash({ blockHash: block.hash, token: chain.token }),
      untrusted: false,
    };
    const risk: RiskPacket = {
      schemaVersion: 1,
      intentHash: economicIntentHash(input),
      evaluatedAt: now,
      quoteAt: now,
      quoteExpiresAt: now + 60,
      slippageBps: 0,
      referenceDeviationBps: 0,
      maxReferenceDeviationBps: 0,
      blocked: false,
      evidence: [reference],
    };
    const intent = BoundActionIntentSchema.parse({
      ...input,
      evidenceHash: artifactHash(risk.evidence),
      riskPacketHash: artifactHash(risk),
    });
    const plugins = new PluginRegistry();
    plugins.register(localTransferPlugin(chain.client, data));
    const pluginContext = { network: localProfile.network, now };
    if (!(await plugins.refreshHealth(intent.pluginId, pluginContext)))
      throw new Error('PLUGIN_UNHEALTHY');
    const transfer = plugins.getMutator(
      intent.pluginId,
      localProfile.network,
      now,
    );
    const simulation: Simulation = await transfer.simulate(pluginContext, [
      {
        chainId: intent.chainId,
        account: intent.account,
        target: intent.target,
        calldata: data,
        value: intent.nativeValue,
        intentHash: intentHash(intent),
      },
    ]);
    const balance = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [chain.account],
    });
    const kernel = new Kernel({
      network: localProfile.network,
      mandates: [mandate],
      balances: [{ account: intent.account, asset, balance: String(balance) }],
      trustedEvidence: {
        riskPacketHashes: [artifactHash(risk)],
        simulationHashes: [artifactHash(simulation)],
      },
    });
    const approvalService = new ApprovalService(
      new MemoryChallengeStore(),
      'local/anvil',
    );
    chain.owners.forEach((owner, index) => {
      approvalService.register({
        principalId: `fixture_${index}`,
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owner.address,
      });
      approvalService.bindMembership(
        groupId,
        `member_${index}`,
        `fixture_${index}`,
      );
    });
    const approvals = await Promise.all(
      chain.owners.slice(0, 2).map(async (owner, index) => {
        const challenge = await approvalService.issue(
          intent,
          mandate,
          `member_${index}`,
          now,
        );
        const approval = {
          ...challenge.approval,
          signature: await owner.signTypedData(
            approvalTypedData(intent, challenge.approval),
          ),
        };
        return approvalService.submit(
          challenge.challengeId,
          approval,
          intent,
          mandate,
          now,
        );
      }),
    );
    const decision = await kernel.authorize({
      intent,
      risk,
      simulation,
      approvals,
      now,
    });
    if (decision.status !== 'AUTHORIZED')
      throw new Error(`KERNEL_REJECTED:${decision.code}`);
    const grant = decision.grant;
    const onchainGrant = chainGrant(grant, [asset]);
    const digest = await chain.client.readContract({
      address: chain.module,
      abi: moduleAbi,
      functionName: 'hashGrant',
      args: [onchainGrant],
    });
    const signatures = await chain.signDigest(digest);
    const prepared = prepareModuleCall(
      kernel,
      grant,
      intent,
      chain.module,
      data,
      signatures,
      now,
      [asset],
    );
    await chain.client.call({ account: chain.operator.address, ...prepared });
    mkdirSync(outputDirectory, { recursive: true });
    writeDurableJson(join(outputDirectory, 'kernel.json'), kernel.snapshot());
    const request = await chain.wallet.prepareTransactionRequest({
      account: chain.operator,
      ...prepared,
    });
    const rawTransaction = await chain.wallet.signTransaction(request);
    const transactionHash = keccak256(rawTransaction);
    const broadcaster = new JournaledBroadcaster(
      new ExecutionJournal(join(outputDirectory, 'journal')),
      {
        sendRawTransaction: (raw) =>
          chain.client.sendRawTransaction({ serializedTransaction: raw }),
        receipt: async (hash) => {
          try {
            const receipt = await chain.client.getTransactionReceipt({ hash });
            return { status: receipt.status, blockNumber: receipt.blockNumber };
          } catch {
            return null;
          }
        },
      },
    );
    kernel.consume(grant, intent, now);
    writeDurableJson(join(outputDirectory, 'kernel.json'), kernel.snapshot());
    const submitted = await broadcaster.submit({
      schemaVersion: 1,
      grantId: grant.grantId,
      transactionHash,
      rawTransaction,
      state: 'SIGNED',
      chainId: 31337,
      blockNumber: null,
    });
    if (submitted.state === 'RECONCILIATION_REQUIRED')
      throw new Error('SUBMISSION_AMBIGUOUS: reconcile journal before retry');
    const receipt = await chain.client.waitForTransactionReceipt({
      hash: transactionHash,
    });
    if (receipt.status !== 'success')
      throw new Error('ONCHAIN_EXECUTION_REVERTED');
    await broadcaster.reconcile(grant.grantId);
    const indexed = await indexedEvents(chain);
    const bindings = [
      {
        groupId: groupHash,
        account: chain.account,
        registry: chain.registry,
        module: chain.module,
        members: mandate.members.map((m) => ({
          memberId: m.memberId,
          signer: m.signer,
        })),
      },
    ];
    const projection = new DeterministicReadModel(31337, chain.token, bindings);
    projection.ingest(indexed.events, indexed.checkpoint);
    const snapshot = projection.snapshot(groupHash, indexed.checkpoint, now);
    await verifyFresh(snapshot, indexed.checkpoint, 0);
    const recipientBalance = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [chain.recipient],
    });
    const actualBalance = await chain.client.readContract({
      address: chain.token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [chain.account],
    });
    const execution = indexed.events.find(
      (event) =>
        event.eventName === 'GrantExecuted' &&
        event.transactionHash === transactionHash,
    );
    if (BigInt(snapshot.treasuryBalance) !== actualBalance)
      throw new Error('INDEX_BALANCE_MISMATCH');
    if (
      !execution ||
      execution.eventName !== 'GrantExecuted' ||
      BigInt(execution.payload.inputAmount) !== amount ||
      recipientBalance !== amount
    )
      throw new Error('RECONCILIATION_MISMATCH');
    kernel.reconcile(grant.grantId, String(amount));
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
      rpcUrl: node.url,
      manifest,
      localTestToken: chain.token,
      localTokenSymbol: 'LOCAL_TEST',
      transferAmount: formatDecimal(amount, decimals),
      transactionHash,
      grantId: grant.grantId,
      intentHash: intentHash(intent),
      recipient: chain.recipient,
      recipientBalance: String(recipientBalance),
      accountBalance: String(actualBalance),
      snapshot,
      events: indexed.events,
      checkpoint: indexed.checkpoint,
      bindings,
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
    if (!keepAlive || !completed) await node.close();
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
