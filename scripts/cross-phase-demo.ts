import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, http, type Hex } from 'viem';
import { anvil } from 'viem/chains';
import { FixtureFileSchema, SynqBrain } from '@synq/agent-runtime';
import { QwenStructuredReasoner } from '@synq/plugin-qwen';
import { KimiReasoner } from '@synq/plugin-kimi';
import { WorldSnapshotBuilder } from '@synq/world-model';
import { PluginRegistry } from '@synq/plugin-sdk';
import {
  MemoryProjectionStore,
  Projector,
  ProjectionReader,
  ChainHeadObserver,
  projectionConfig,
} from '@synq/read-model';
import { artifactHash, onchainMandateId, toMandateConfig } from '@synq/kernel';
import {
  RegistryRiskSource,
  RpcRiskAttestationReader,
  encodeAttestationReport,
  riskAttestationRegistryAbi,
} from '@synq/plugin-chainlink-cre';
import { evaluatePortfolio, proposeHedge } from '@synq/risk-engine';
import { tokenAbi } from '@synq/execution-worker/abi';
import {
  KernelProposalGateway,
  DeclaredSimulation,
  StoreIdentityDirectoryReader,
} from '../apps/api/src/brain-runtime.js';
import { TemporalWorkflowStatusSource } from '../apps/api/src/world-sources.js';
import { bootstrapLocalEnvironment } from '../workers/workflow/src/local/bootstrap.js';
import { openLocalRuntime } from '../workers/workflow/src/local/runtime.js';
import { approveAsMember } from '../workers/workflow/src/local/identity.js';
import { localTransferPlugin } from '../apps/demo/src/local-transfer-plugin.js';
import { indexedEvents } from '../apps/demo/src/events.js';
import {
  startTemporal,
  testConfig,
  eventually,
} from '../tests/workflow/harness/temporal.js';
import { withWorkers } from '../tests/workflow/harness/worker.js';
import {
  KuruFlowAdapter,
  KuruFlowClient,
  type FlowQuote,
} from '@synq/plugin-kuru';
import { hedgeMandate } from '../tests/risk/hedge-fixtures.js';
import { approvalRecordedSignal } from '../workers/workflow/src/workflows/messages.js';
import type { DcaTickResult } from '../workers/workflow/src/workflows/dca.js';

export const CROSS_PHASE_GROUP_TEXT =
  'We have 300 AUSD. Keep 150 liquid. Use up to 100 AUSD to accumulate MON gradually. Never buy more than 25 AUSD per week. Pause if AUSD becomes unhealthy. If MON risk gets too high, propose a hedge covering at most 20%.';

/** Runs the connected local authority path. Provider recordings and token analogues are explicitly SIMULATION. */
export async function runCrossPhaseDemo() {
  if (
    process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true' ||
    BigInt(process.env.SYNQ_MAINNET_CANARY_MAX_USD ?? '0') !== 0n
  )
    throw new Error('MAINNET_BROADCAST_REFUSED');
  process.env.SYNQ_ALLOW_MAINNET_BROADCAST = 'false';
  process.env.SYNQ_MAINNET_CANARY_MAX_USD = '0';
  const dir = mkdtempSync(join(tmpdir(), 'synq-cross-phase-'));
  const local = await bootstrapLocalEnvironment({
    dataDir: dir,
    databaseUrl:
      process.env.SYNQ_CROSS_PHASE_DATABASE_URL ??
      'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p07_cross_phase_demo',
    funding: 300n * 10n ** 18n,
  });
  const temporal = await startTemporal();
  const config = testConfig('crossphase');
  let runtime = await openLocalRuntime(local.manifest);
  const stages: {
    stage: string;
    executionMode: 'SIMULATION';
    evidence: unknown;
  }[] = [];
  const record = (stage: string, evidence: unknown) => {
    stages.push({ stage, executionMode: 'SIMULATION', evidence });
    console.log(JSON.stringify({ stage, executionMode: 'SIMULATION' }));
  };
  try {
    const unit = 10n ** BigInt(local.manifest.asset.decimals);
    const units = (n: number) => (BigInt(n) * unit).toString();
    const now = () => Math.floor(Date.now() / 1000);
    const binding = local.manifest.riskAttestation!;
    const registryRisk = new RegistryRiskSource(
      {
        reader: new RpcRiskAttestationReader(local.chain.client, {
          confirmationDepth: 1,
          trustedForwarder: binding.forwarder,
          forwarderKind: 'CRE_MOCK_FORWARDER',
          trustedWorkflowId: binding.workflowId,
        }),
        chainId: local.manifest.asset.chainId,
        registry: binding.registry,
        assets: [{ address: local.manifest.token, assetId: binding.assetId }],
        maxAttestationAgeSeconds: 1200,
        maxReferenceStalenessSeconds: 1200,
        maxHealthyDeviationBps: 50,
        trustedSourceConfigHash: binding.sourceConfigHash,
        trustedForwarder: binding.forwarder,
        forwarderKind: 'CRE_MOCK_FORWARDER',
        trustedWorkflowId: binding.workflowId,
      },
      now,
      local.manifest.token,
    );
    const plugins = new PluginRegistry();
    plugins.register(localTransferPlugin(local.chain.client, () => undefined));
    await plugins.refreshHealth('local-transfer', {
      network: local.manifest.mandate.network,
      now: now(),
    });
    const rm = projectionConfig({
      chainId: local.manifest.asset.chainId,
      profile: local.manifest.mandate.network.profile,
      startBlock: Number(local.manifest.deploymentBlock),
      factory: local.manifest.factory,
      registry: local.manifest.registry,
      module: local.manifest.module,
      treasuryAssets: [local.manifest.token],
      reorgWindowBlocks: 64,
      confirmationDepth: 1,
    });
    const projection = new MemoryProjectionStore(local.manifest.asset.chainId);
    const reader = new ProjectionReader(projection, rm);
    let checkpoint = rm.startBlock - 1;
    const sync = async () => {
      const data = await indexedEvents(local.chain);
      await new Projector(projection, rm).applyWindow({
        fromBlockExclusive: checkpoint,
        toBlockInclusive: data.checkpoint,
        events: data.events.filter((e) => e.blockNumber > checkpoint),
      });
      checkpoint = data.checkpoint;
    };
    const workflows = new TemporalWorkflowStatusSource(
      {
        list: () => temporal.client.workflow.list(),
        nextEvent: (id) =>
          temporal.client.workflow
            .getHandle(id)
            .query<{ at: number | null }>('nextScheduledEvent'),
      },
      now,
    );
    const builder = () =>
      new WorldSnapshotBuilder({
        network: local.manifest.mandate.network,
        now,
        kernel: runtime.kernel.kernel,
        identity: new StoreIdentityDirectoryReader(
          local.gateway.store,
          local.pool,
        ),
        plugins,
        readModel: {
          snapshots: reader,
          head: new ChainHeadObserver(
            local.chain.client,
            local.manifest.asset.chainId,
            { ttlMs: 0 },
          ),
          maxLagBlocks: 5,
        },
        workflows,
        risk: registryRisk,
        market: {
          quotes: async () => [
            {
              pair: 'OTHER/USD',
              price: units(100),
              priceDecimals: 8,
              chainId: local.manifest.mandate.network.chainId,
              source: 'LOCAL_TOKEN_ANALOGUE',
              observedAt: now(),
              maxAgeSeconds: 60,
            },
          ],
        },
        localAssets: [local.manifest.asset],
        mainnetBroadcastAllowed: false,
      });
    await sync();
    const before = await builder().build({ groupId: local.manifest.groupId });
    record('WorldSnapshot', {
      snapshotId: before.snapshotId,
      treasury: before.treasury,
      sourceFreshness: before.sourceFreshness,
    });
    let raw = readFileSync('tests/brain/fixtures/demo.qwen.json', 'utf8')
      .replaceAll('{{TOKEN}}', local.manifest.token)
      .replaceAll('{{ACCOUNT}}', local.manifest.recipient)
      .replaceAll('{{DECIMALS}}', String(local.manifest.asset.decimals))
      .replaceAll('{{UNITS_150}}', units(150))
      .replaceAll('{{UNITS_100}}', units(100))
      .replaceAll('{{UNITS_25}}', units(25))
      .replaceAll('local_mandate', local.manifest.mandate.mandateId);
    const fixture = JSON.parse(raw);
    const output = JSON.parse(
      fixture.interactions[0].response.body.choices[0].message.content,
    );
    const draft = {
      ...output.items[0],
      newMandateId: 'demo_mon_dca',
      goal: CROSS_PHASE_GROUP_TEXT,
      perActionCap: {
        display: '25',
        baseUnits: units(25),
        decimals: local.manifest.asset.decimals,
      },
      cumulativeBudget: {
        display: '100',
        baseUnits: units(100),
        decimals: local.manifest.asset.decimals,
      },
      cadenceSeconds: 604800,
    };
    fixture.interactions[0].response.body.choices[0].message.content =
      JSON.stringify({ items: [draft] });
    raw = JSON.stringify(fixture);
    const gateway = new KernelProposalGateway({
      kernel: runtime.kernel.kernel,
      network: local.manifest.mandate.network,
      simulations: new DeclaredSimulation({ now }, 'LOCAL_SIMULATION'),
      clock: { now },
      market: { quotes: async () => [] },
      executionMode: 'SIMULATION',
    });
    const brain = new SynqBrain({
      structured: new QwenStructuredReasoner({
        mode: 'REPLAY',
        fixtures: FixtureFileSchema.parse(JSON.parse(raw)),
      }),
      research: new KimiReasoner({
        mode: 'REPLAY',
        fixtures: FixtureFileSchema.parse(
          JSON.parse(
            readFileSync('tests/brain/fixtures/demo.kimi.json', 'utf8'),
          ),
        ),
        now,
      }),
      critic: new KimiReasoner({
        mode: 'REPLAY',
        fixtures: FixtureFileSchema.parse(
          JSON.parse(
            readFileSync('tests/brain/fixtures/demo.kimi.json', 'utf8'),
          ),
        ),
        now,
      }),
      proposals: gateway,
      authenticateMessage: async ({ groupId, memberId }) =>
        groupId === local.manifest.groupId && memberId === 'member_0'
          ? { memberId, principalId: local.principalIds[0]! }
          : null,
      executionMode: 'SIMULATION',
      nowSeconds: now,
    });
    const result = await brain.run({
      runId: `demo_${Date.now()}`,
      groupId: local.manifest.groupId,
      world: before,
      messages: [{ memberId: 'member_0', text: CROSS_PHASE_GROUP_TEXT }],
      fixtureKey: 'brain-demo',
    });
    const item = result.items.find((i) => i.normalized?.kind === 'MANDATE');
    if (
      !item ||
      item.normalized?.kind !== 'MANDATE' ||
      item.decision?.status !== 'REQUIRES_HUMAN_APPROVAL'
    )
      throw new Error(
        `BRAIN_PROPOSAL_FAILED:${JSON.stringify(result.items.map((i) => ({ status: i.status, issues: i.issues, decision: i.decision })))}`,
      );
    record('Brain → typed Mandate → EvidenceArtifact', {
      fixtureLabel: 'HAND_AUTHORED_FIXTURE',
      mandate: item.normalized.mandate,
      evidenceArtifact: item.evidenceArtifact,
      evidenceArtifactHash: item.evidenceArtifactHash,
      decision: item.decision,
      grantsBeforeApproval: runtime.kernel.kernel.stateView().grants.length,
    });
    const mandate = item.normalized.mandate;
    const governanceTx = await local.chain.governance.configureMandate(
      onchainMandateId(mandate),
      toMandateConfig(mandate),
    );
    await runtime.kernel.mutate((k) => k.configureMandate(mandate));
    record('Safe owner approval → registry governance', {
      mandateHash: artifactHash(mandate),
      governanceTx,
      identityTier: 'LOCAL_FIXTURE',
    });
    local.manifest.mandate = mandate;
    await runtime.close();
    const startAt = now() - 10;
    const policy = {
      strategyId: 'demo_dca',
      startAt,
      expiresAt: startAt + 60 * 86400,
      frequencySeconds: 604800,
      budgetAsset: {
        symbol: 'OTHER',
        address: local.manifest.token,
        decimals: local.manifest.asset.decimals,
        chainId: local.manifest.asset.chainId,
      },
      targetAsset: {
        symbol: 'MON',
        address: 'native',
        decimals: 18,
        chainId: local.manifest.asset.chainId,
      },
      allowedAssets: [local.manifest.token, 'native'],
      venue: 'local-anvil',
      allowedVenues: ['local-anvil'],
      baseTranche: units(25),
      maxTranche: units(25),
      minTranche: units(1),
      budget: units(100),
      maxDeployment: units(100),
      maxAllocationBps: 10000,
      maxSlippageBps: 0,
      spike: { skipIf24hChangeAboveBps: 800 },
      dip: { multiplierBps: 10000, triggerBelowTrailingBps: 1000 },
      maxMarketDataAgeSeconds: 300,
      pause: { paused: false },
    };
    runtime = await openLocalRuntime(local.manifest, {
      dcaPolicies: { demo_dca: policy },
    });
    const strategy = {
      strategyId: 'demo_dca',
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      mandateVersion: mandate.version,
      inputAmountPerTick: units(25),
      maxSlippageBps: 0,
      maxTicks: 4,
    };
    await withWorkers(temporal, config, runtime.activities, async () => {
      const tick = (await temporal.client.workflow.execute('DCAWorkflow', {
        workflowId: `demo.dca.${Date.now()}`,
        taskQueue: config.taskQueues.strategy,
        args: [{ strategy, executionTaskQueue: config.taskQueues.economic }],
        memo: { synqGroupId: mandate.groupId },
      })) as DcaTickResult;
      if (tick.decision !== 'EXECUTE' || !tick.childWorkflowId)
        throw new Error(`DCA_NOT_EXECUTED:${JSON.stringify(tick)}`);
      const child = temporal.client.workflow.getHandle(tick.childWorkflowId);
      const pending = await eventually(
        () =>
          child.query<{
            approval: { draftDigest: string } | null;
            waitingFor: string;
          }>('state'),
        (s) => s.waitingFor === 'APPROVAL' && !!s.approval,
      );
      const draftView = await local.gateway.store.transaction((tx) =>
        tx.getDraft(pending.approval!.draftDigest),
      );
      if (!draftView) throw new Error('DRAFT_MISSING');
      for (let index = 0; index < 2; index++)
        await approveAsMember(local.gateway, draftView.draft, {
          index,
          owner: local.owners[index]!,
          principalId: local.principalIds[index]!,
        });
      await child.signal(approvalRecordedSignal, {
        memberId: 'member_1',
        draftDigest: draftView.draft.digest,
      });
      const settled = await child.result();
      record(
        'Temporal → DCA → registry risk → Kernel → approval → local accounting analogue → reconciliation',
        { tick, settled },
      );
      const duplicateWeek = (await temporal.client.workflow.execute(
        'DCAWorkflow',
        {
          workflowId: `demo.dca.repeat.${Date.now()}`,
          taskQueue: config.taskQueues.strategy,
          args: [{ strategy }],
          memo: { synqGroupId: mandate.groupId },
        },
      )) as DcaTickResult;
      if (duplicateWeek.decision === 'EXECUTE')
        throw new Error('WEEKLY_CAP_BREACH');
      record('weekly cap', duplicateWeek);
    });
    const flow = new KuruFlowAdapter(
      new KuruFlowClient({
        fetch: async () => {
          throw new Error('REPLAY_ONLY');
        },
        clock: { now: Date.now },
      }),
    );
    const rawQuote = JSON.parse(
      readFileSync(
        'bounty-evidence/integration/fresh-read-only-evidence.json',
        'utf8',
      ),
    ).kuru.quote as Omit<
      FlowQuote,
      'amountIn' | 'quotedOutput' | 'providerMinOut' | 'transaction'
    > & {
      amountIn: string;
      quotedOutput: string;
      providerMinOut: string | null;
      transaction: { to: Hex; data: Hex; value: string };
    };
    const quote: FlowQuote = {
      ...rawQuote,
      amountIn: BigInt(rawQuote.amountIn),
      quotedOutput: BigInt(rawQuote.quotedOutput),
      providerMinOut:
        rawQuote.providerMinOut === null
          ? null
          : BigInt(rawQuote.providerMinOut),
      transaction: {
        ...rawQuote.transaction,
        value: BigInt(rawQuote.transaction.value),
      },
    };
    const selectedOfficialInput =
      (BigInt(strategy.inputAmountPerTick) *
        10n ** BigInt(quote.tokenIn.decimals)) /
      unit;
    if (quote.amountIn !== selectedOfficialInput)
      throw new Error('DCA_KURU_AMOUNT_MISMATCH');
    const prepared = flow.prepare(quote, {
      maxSlippageBps: 75,
      maxInputAmount: selectedOfficialInput,
      now: quote.receivedAt,
    });
    record('Kuru quote → bounded prepare', {
      fixtureLabel: 'PUBLIC_PROVIDER_RECORDING_REPLAY',
      sourceArtifact:
        'bounty-evidence/integration/fresh-read-only-evidence.json',
      replayAt: quote.receivedAt,
      selectedInput: selectedOfficialInput.toString(),
      prepared,
      broadcast: false,
      limitation:
        'Provider recording replay; local transfer is an accounting analogue, no MON acquisition or mainnet swap is claimed.',
    });
    const risk = evaluatePortfolio({
      asOf: Date.now(),
      valueDecimals: local.manifest.asset.decimals,
      spot: [
        {
          asset: 'AUSD',
          canonicalAssetId: local.manifest.asset.canonicalAssetId,
          amount: 275n * unit,
          decimals: local.manifest.asset.decimals,
          bucket: 'CORE_AUSD',
          stable: true,
        },
      ],
      perpAccount: null,
      perpPositions: [],
      prices: [],
      maxPriceAgeMs: 60000,
      scenarios: [],
    });
    const hedge = proposeHedge(
      risk,
      hedgeMandate({ targetHedgeRatioBps: 2000, maxHedgeRatioBps: 2000 }),
      {
        marketId: 1,
        base: 'MON',
        priceDecimals: 5,
        sizeDecimals: 3,
        maxLeverageHundredths: 100,
        maintenanceMarginBps: 100,
        mark: 2500n,
        bid: 2499n,
        ask: 2501n,
        at: risk.asOf,
      },
      {
        intentId: 'demo_hedge',
        now: risk.asOf,
        ttlSeconds: 60,
        trigger: 'BRAIN_FLAG_EXCESSIVE_DOWNSIDE',
        leverageHundredths: 100,
      },
    );
    record('Perpl risk → bounded conditional hedge', {
      risk,
      hedge,
      reason:
        'No acquired MON exposure in local accounting analogue; no hedge execution triggered. Historical real testnet hedge evidence is separate.',
    });
    const wallet = createWalletClient({
      chain: anvil,
      account: local.chain.executor,
      transport: http(local.chain.url),
    });
    const latest = (await local.chain.client.getBlock()).timestamp;
    const tx = await wallet.writeContract({
      address: binding.registry,
      abi: riskAttestationRegistryAbi,
      functionName: 'onReport',
      args: [
        (binding.workflowId + '00'.repeat(30)) as Hex,
        encodeAttestationReport({
          assetId: binding.assetId,
          timestamp: latest,
          referencePrice: 0n,
          deviationBps: 0,
          stalenessSec: 0n,
          status: 'UNKNOWN',
          sourceConfigHash: binding.sourceConfigHash,
          reasons: ['REFERENCE_UNAVAILABLE'],
        }),
      ],
    });
    await local.chain.client.waitForTransactionReceipt({ hash: tx });
    const unhealthy = await runtime.activities.dcaMarketEvidence({ strategy });
    const paused = await runtime.activities.evaluateDca({
      strategy,
      state: await runtime.activities.dcaFreshState({ strategy }),
      evidence: unhealthy,
    });
    if (paused.decision === 'EXECUTE') throw new Error('UNHEALTHY_EXECUTION');
    record('CRE unhealthy → pause', { unhealthy, paused, registryTx: tx });
    await sync();
    const after = await builder().build({ groupId: mandate.groupId });
    const balance = await local.chain.client.readContract({
      address: local.manifest.token,
      abi: tokenAbi,
      functionName: 'balanceOf',
      args: [local.manifest.account],
    });
    if (balance !== 275n * unit || balance < 150n * unit)
      throw new Error('LIQUIDITY_BREACH');
    record('WorldSnapshot update', {
      snapshotId: after.snapshotId,
      treasury: after.treasury,
      risk: after.riskState,
      balance: balance.toString(),
      minimumLiquid: units(150),
    });
    const mutations = await local.chain.client.getContractEvents({
      address: local.manifest.token,
      abi: tokenAbi,
      eventName: 'Transfer',
      fromBlock: BigInt(local.manifest.deploymentBlock),
      args: { from: local.manifest.account },
    });
    const unauthorized = mutations.filter(
      (e) =>
        e.args.to?.toLowerCase() !== local.manifest.recipient ||
        e.args.value !== 25n * unit,
    ).length;
    if (
      mutations.length !== 1 ||
      unauthorized !== 0 ||
      runtime.kernel.kernel.accounting(mandate.groupId, mandate.mandateId)
        .spentToken !== units(25)
    )
      throw new Error('MUTATION_RECONCILIATION_FAILED');
    return {
      executionMode: 'SIMULATION',
      groupText: CROSS_PHASE_GROUP_TEXT,
      stages,
      unauthorizedMutations: unauthorized,
      authorizedLocalTokenTransfers: mutations.length,
      finalBalance: balance.toString(),
      mainnetBroadcasts: 0,
      sponsorInference: 'HAND_AUTHORED_FIXTURE',
      realPasskeys: 'REAL_PASSKEY_EVIDENCE_PENDING',
    };
  } finally {
    await runtime.close();
    await temporal.teardown();
    await local.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  if (process.argv.includes('--testnet')) {
    const { runCrossPhaseTestnet } = await import('./cross-phase-testnet.js');
    await runCrossPhaseTestnet();
  } else {
    const result = await runCrossPhaseDemo();
    const path = resolve('bounty-evidence/integration/cross-phase-demo.json');
    mkdirSync(resolve('bounty-evidence/integration'), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify(
        result,
        (_, value: unknown) =>
          typeof value === 'bigint' ? value.toString() : value,
        2,
      ) + '\n',
    );
    console.log(
      JSON.stringify({
        executionMode: result.executionMode,
        stages: result.stages.map((s) => s.stage),
        finalBalance: result.finalBalance,
        evidence: path,
      }),
    );
  }
}
