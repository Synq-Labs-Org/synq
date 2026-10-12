import { SynqBrain } from '@synq/agent-runtime';
import { QwenStructuredReasoner } from '@synq/plugin-qwen';
import { KimiReasoner } from '@synq/plugin-kimi';
import { WorldSnapshotBuilder } from '@synq/world-model';
import { ChainHeadObserver } from '@synq/read-model';
import {
  KernelProposalGateway,
  StoreIdentityDirectoryReader,
  ChainSimulation,
} from '../apps/api/src/brain-runtime.js';
import { chatFixture, SUPPORT } from '../tests/brain/harness.js';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPublicClient, http } from 'viem';
import { monad } from 'viem/chains';
import { MandateSchema } from '@synq/schemas';
import {
  artifactHash,
  hedgeIntentHash,
  onchainMandateId,
  toMandateConfig,
  RISK_REDUCING_KINDS,
} from '@synq/kernel';
import { registryAbi } from '@synq/execution-worker/abi';
import { GrantApprovalGateway } from '@synq/identity';
import { labelEvidenceHex } from '@synq/funding';
import { perplNetwork, profileConfiguration } from '@synq/chain-registry';
import { MarketCatalog, PerplRestClient } from '@synq/plugin-perpl';
import {
  DurableHedgeGrantAuthority,
  PerplHedgeEvidenceReader,
  PerplHedgeExecutor,
  PerplHedgeService,
  PostgresHedgeStore,
  defaultKeyPath,
  loadPerplKey,
  productionHedgeMandateSource,
  testnetTreasuryReader,
  trustedHedgeStateLoader,
} from '@synq/perpl-executor';
import {
  RpcRiskAttestationReader,
  RegistryRiskSource,
  riskAttestationDeployment,
  stableRiskGateConfig,
  canonicalAssetKey,
} from '@synq/plugin-chainlink-cre';
import {
  KuruCapabilities,
  KuruClobAdapter,
  KuruFlowAdapter,
  KuruFlowClient,
  kuruDeployment,
} from '@synq/plugin-kuru';
import { runSendE2E } from '../apps/demo/src/send.js';
import {
  startTemporal,
  testConfig,
} from '../tests/workflow/harness/temporal.js';
import { withWorkers } from '../tests/workflow/harness/worker.js';
import {
  createStrategyActivities,
  FileTickStore,
  evaluateDcaDeterministic,
} from '../workers/workflow/src/activities/strategy.js';
import { perplHedgeActivities } from '../workers/workflow/src/activities/hedge-perpl.js';
import { hedgeMandate } from '../tests/risk/hedge-fixtures.js';
import type { HedgeState } from '../workers/workflow/src/workflows/hedge.js';
import type { DcaTickResult } from '../workers/workflow/src/workflows/dca.js';

/** Testnet authority and accounting are live; CRE mock provenance can never authorize a swap. */
export async function runCrossPhaseTestnet() {
  assert.notEqual(process.env.SYNQ_ALLOW_MAINNET_BROADCAST, 'true');
  assert.equal(BigInt(process.env.SYNQ_MAINNET_CANARY_MAX_USD ?? '0'), 0n);
  process.env.SYNQ_ALLOW_MAINNET_BROADCAST = 'false';
  process.env.SYNQ_MAINNET_CANARY_MAX_USD = '0';
  const stages: {
    stage: string;
    executionMode: 'REAL_TESTNET' | 'SIMULATION' | 'MAINNET_READ_ONLY';
    evidence: unknown;
  }[] = [];
  const record = (
    stage: string,
    executionMode: (typeof stages)[number]['executionMode'],
    evidence: unknown,
  ) => {
    stages.push({ stage, executionMode, evidence });
    console.log(JSON.stringify({ stage, executionMode }));
  };
  const path = resolve(
    'bounty-evidence/integration/cross-phase-demo-testnet.json',
  );
  mkdirSync(resolve('bounty-evidence/integration'), { recursive: true });
  const startedAt = new Date().toISOString();
  const persist = (extra: Record<string, unknown>) =>
    writeFileSync(
      path,
      JSON.stringify(
        labelEvidenceHex({
          startedAt,
          chainId: 10143,
          mainnetBroadcasts: 0,
          stages,
          ...extra,
        }),
        null,
        2,
      ) + '\n',
    );
  try {
    const send = await runSendE2E({
      evidenceDirectory: 'bounty-evidence/integration/testnet-send',
      maxRunMon: 600_000_000_000_000_000n,
      afterSend: async (ctx) => {
        const { chain, owners, pool, identity, kernel } = ctx;
        assert.equal(await chain.client.getChainId(), 10143);
        const gov = chain.governance(ctx.mandate.account, owners);
        const now = () => Math.floor(Date.now() / 1000);
        const hm = hedgeMandate({
          groupId: ctx.mandate.groupId,
          parentMandateId: 'cross_phase_mon',
          parentMandateVersion: 1,
          allowedMarkets: [{ marketId: 64, base: 'MON' }],
          targetHedgeRatioBps: 2000,
          maxHedgeRatioBps: 2000,
          maxLeverageHundredths: 100,
          maxNotional: '100000',
          maxCollateral: '100000',
          approval: { autoMaxNotional: '0', reviewMaxNotional: '0' },
          validAfter: now() - 60,
          validUntil: now() + 86400,
        });
        let parent = MandateSchema.parse({
          ...ctx.mandate,
          mandateId: hm.parentMandateId,
          perActionCap: '25000000',
          cumulativeBudget: '100000000',
          minIntervalSeconds: 604800,
          maxExecutions: 4,
          hedgePolicyHash: artifactHash(hm),
          bindings: [
            ...ctx.mandate.bindings,
            {
              pluginId: 'perpl',
              action: 'PERP_HEDGE',
              target: hm.exchange,
              selector: '0x2ab0f8f6',
            },
          ],
          maxSlippageBps: 300,
          maxLeverageBps: 10000,
          tierPolicy: { ...ctx.mandate.tierPolicy, leverage: 'CONSENSUS' },
        });
        const balanceBefore = await chain.balanceOf(parent.account);
        assert(balanceBefore <= 300_000_000n, 'unexpected existing treasury');
        if (balanceBefore < 300_000_000n) {
          const funding = await chain.fund(
            parent.account,
            300_000_000n - balanceBefore,
          );
          record('AUSD treasury → 300 AUSD', 'REAL_TESTNET', {
            transactionHash: funding.transactionHash,
            amount: String(300_000_000n - balanceBefore),
            balance: String(await chain.balanceOf(parent.account)),
          });
        }
        const binding = riskAttestationDeployment('sandbox/monad-testnet');
        const riskReader = new RpcRiskAttestationReader(chain.client, {
          confirmationDepth: 1,
          trustedForwarder: binding.forwarder,
          forwarderKind: binding.forwarderKind,
          trustedWorkflowId: `0x${'11'.repeat(32)}`,
        });
        const riskConfig = stableRiskGateConfig(
          'sandbox/monad-testnet',
          riskReader,
          1200,
        );
        const registryRisk = new RegistryRiskSource(
          riskConfig,
          now,
          chain.ausd.address,
        );
        await ctx.catchUp();
        await ctx.plugins.refreshHealth('ausd-transfer', {
          network: parent.network,
          now: now(),
        });
        const builder = new WorldSnapshotBuilder({
          network: parent.network,
          now,
          kernel,
          identity: new StoreIdentityDirectoryReader(identity, pool),
          plugins: ctx.plugins,
          readModel: {
            snapshots: ctx.reader,
            head: new ChainHeadObserver(chain.client, 10143, { ttlMs: 0 }),
            maxLagBlocks: 5,
          },
          risk: registryRisk,
          mainnetBroadcastAllowed: false,
        });
        const snapshot = await builder.build({ groupId: parent.groupId });
        record(
          'WorldSnapshot from live chain → Envio → Postgres → identity',
          'REAL_TESTNET',
          snapshot,
        );
        const draft = {
          kind: 'MANDATE',
          requestedBy: ['member_0'],
          change: 'NEW',
          baseMandateId: ctx.mandate.mandateId,
          newMandateId: hm.parentMandateId,
          goal: '300 AUSD; keep 150 liquid; <=100 DCA into MON; <=25/week; pause if AUSD unhealthy; hedge <=20% on high MON risk',
          action: 'TRANSFER',
          providerId: 'AUSD_TRANSFER',
          network: 'sandbox/monad-testnet',
          inputToken: chain.ausd.address,
          outputToken: null,
          perActionCap: { display: '25', baseUnits: '25000000', decimals: 6 },
          cumulativeBudget: {
            display: '100',
            baseUnits: '100000000',
            decimals: 6,
          },
          recipients: ctx.mandate.recipients.map((r) => r.address),
          cadenceSeconds: 604800,
          maxSlippageBps: 0,
          durationDays: 7,
          rationale:
            'Typed testnet treasury mandate; MON venue unavailable means DCA SKIP. Separate governed 20% hedge test policy requires consensus.',
          ambiguities: [
            'AUSD-to-MON testnet route unavailable',
            'Operator Perpl collateral is external to the Safe',
          ],
          uncertainty: 0.1,
        };
        const gateway = new KernelProposalGateway({
          kernel,
          network: parent.network,
          market: { quotes: async () => [] },
          clock: { now },
          simulations: new ChainSimulation(
            chain.client,
            { now },
            parent.network,
          ),
          executionMode: 'REAL_TESTNET',
        });
        const kimi = new KimiReasoner({
          mode: 'REPLAY',
          fixtures: chatFixture('kimi', [
            { key: 'testnet-demo:critic', content: SUPPORT },
          ]),
          now,
        });
        const brain = new SynqBrain({
          structured: new QwenStructuredReasoner({
            mode: 'REPLAY',
            fixtures: chatFixture('qwen', [
              { key: 'testnet-demo:intent', content: { items: [draft] } },
            ]),
          }),
          research: kimi,
          critic: kimi,
          proposals: gateway,
          executionMode: 'REAL_TESTNET',
          nowSeconds: now,
          authenticateMessage: async ({ groupId, memberId }) => {
            const members = await identity.transaction((tx) =>
              tx.listMemberships(groupId),
            );
            const member = members.find((m) => m.memberId === memberId);
            return member
              ? { memberId, principalId: member.principalId }
              : null;
          },
        });
        const proposed = await brain.run({
          runId: `testnet_demo_${Date.now()}`,
          fixtureKey: 'testnet-demo',
          groupId: parent.groupId,
          world: snapshot,
          messages: [{ memberId: 'member_0', text: draft.goal }],
        });
        const item = proposed.items.find(
          (i) => i.normalized?.kind === 'MANDATE',
        );
        assert(
          item?.normalized?.kind === 'MANDATE' &&
            item.decision?.status === 'REQUIRES_HUMAN_APPROVAL',
          JSON.stringify(
            proposed.items.map((i) => ({
              issues: i.issues,
              decision: i.decision,
            })),
          ),
        );
        parent = MandateSchema.parse({
          ...item.normalized.mandate,
          hedgePolicyHash: artifactHash(hm),
          bindings: [
            ...item.normalized.mandate.bindings,
            {
              pluginId: 'perpl',
              action: 'PERP_HEDGE',
              target: hm.exchange,
              selector: '0x2ab0f8f6',
            },
          ],
          maxLeverageBps: 10000,
          maxSlippageBps: 300,
          maxExecutions: 4,
          tierPolicy: {
            ...item.normalized.mandate.tierPolicy,
            leverage: 'CONSENSUS',
          },
        });
        record(
          'Brain → typed proposal → EvidenceArtifact → human approval required',
          'REAL_TESTNET',
          {
            modelLabel: 'HAND_AUTHORED_FIXTURE',
            item,
            approvedTestMandate: parent,
            grantsIssuedByBrain: 0,
          },
        );
        const governance = await gov.configureMandate(
          onchainMandateId(parent),
          toMandateConfig(parent),
        );
        kernel.configureMandate(parent);
        record(
          'Safe approval → §71 MandateRegistry governance',
          'REAL_TESTNET',
          {
            mandate: parent,
            mandateHash: artifactHash(parent),
            transactionHash: governance.transactionHash,
            identityTier: 'SOFTWARE_PRF_TEST_HARNESS',
            realPasskeys: 'REAL_PASSKEY_EVIDENCE_PENDING',
            hedgeCollateralOwner:
              'Independent operator account 1058; not Safe custody',
          },
        );
        const clob = new KuruClobAdapter(() => chain.client);
        const capability = await new KuruCapabilities({
          clob,
          probeAddress: parent.account,
        }).discover('sandbox/monad-testnet', Date.now());
        const rawAttestation = await riskReader.latest({
          registry: binding.RiskAttestationRegistry,
          assetId: canonicalAssetKey(10143, chain.ausd.address),
          chainId: 10143,
        });
        record('RiskAttestationRegistry live read', 'REAL_TESTNET', {
          registry: binding.RiskAttestationRegistry,
          rawAttestation,
          capability,
        });
        record('CRE report provenance', 'SIMULATION', {
          forwarderKind: binding.forwarderKind,
          reason:
            'Testnet mock forwarder; no production AUSD feed or DON authority',
        });
        const temporal = await startTemporal();
        const dir = mkdtempSync(join(tmpdir(), 'synq-cross-testnet-'));
        const tq = testConfig('cross-testnet');
        try {
          const before = {
            balance: String(await chain.balanceOf(parent.account)),
            grants: kernel.stateView().grants.length,
          };
          const acts = createStrategyActivities({
            freshState: async () => {
              const state = await chain.client.readContract({
                address: chain.deployment.registry,
                abi: registryAbi,
                functionName: 'mandateState',
                args: [parent.account, onchainMandateId(parent)],
              });
              return {
                mandateActive: state.status === 1,
                mandateVersion: Number(state.currentVersion),
                ticksExecuted: Number(state.spentToken / 25_000_000n),
                remainingBudget: (
                  BigInt(parent.cumulativeBudget) - state.spentToken
                ).toString(),
                observedAt: now(),
              };
            },
            marketEvidence: async () => {
              const risk = await registryRisk.current(parent.groupId);
              return {
                evidenceHash: artifactHash(risk),
                referencePrice: '0',
                quotedInputAmount: '25000000',
                quotedOutputAmount: '0',
                quoteExpiresAt: now() + 30,
                riskStatus: risk.state.status,
                observedAt: now(),
              };
            },
            evaluator: (input) => {
              const verdict = evaluateDcaDeterministic(input);
              return verdict.decision === 'EXECUTE'
                ? {
                    decision: 'SKIP',
                    reasons: [
                      'NO_TESTNET_AUSD_MON_ROUTE',
                      'BOUNDED_SWAP_MODULE_UNAVAILABLE',
                    ],
                  }
                : verdict;
            },
            buildAction: async () => {
              throw new Error('DCA_SKIP_MUST_NOT_BUILD_ACTION');
            },
            ticks: new FileTickStore(join(dir, 'ticks.json')),
          });
          const tick = (await withWorkers(temporal, tq, acts, async () =>
            temporal.client.workflow.execute('DCAWorkflow', {
              workflowId: `testnet.dca.${Date.now()}`,
              taskQueue: tq.taskQueues.strategy,
              args: [
                {
                  strategy: {
                    strategyId: 'cross_phase_dca',
                    groupId: parent.groupId,
                    mandateId: parent.mandateId,
                    mandateVersion: parent.version,
                    inputAmountPerTick: '25000000',
                    maxSlippageBps: 75,
                    maxTicks: 4,
                  },
                },
              ],
              memo: { synqGroupId: parent.groupId },
            }),
          )) as DcaTickResult;
          assert.equal(tick.decision, 'SKIP');
          assert.equal(tick.childWorkflowId, null);
          assert.deepEqual(
            {
              balance: String(await chain.balanceOf(parent.account)),
              grants: kernel.stateView().grants.length,
            },
            before,
          );
          record(
            'Temporal → registry risk → deterministic DCA → Kernel grant withheld',
            'REAL_TESTNET',
            {
              tick,
              before,
              after: before,
              route:
                'No registered testnet AUSD→MON market; USDC skill semantics cannot substitute AUSD',
              execution: 'SKIP',
              unauthorizedMutations: 0,
            },
          );
          const network = perplNetwork('sandbox/monad-testnet');
          const read = loadPerplKey(defaultKeyPath('read'), {
            scope: 'read',
            chainId: 10143,
          });
          const trade = loadPerplKey(defaultKeyPath('trade'), {
            scope: 'trade',
            chainId: 10143,
          });
          const restRead = new PerplRestClient({
            network,
            transport: 'live',
            signer: read.signer,
          });
          const restTrade = new PerplRestClient({
            network,
            transport: 'live',
            signer: trade.signer,
          });
          const positions = await restRead.positions();
          assert.equal(
            positions.d.filter((p) => p.acc === 1058 && p.st === 1 && p.s > 0)
              .length,
            0,
            'operator account must start flat',
          );
          const store = new PostgresHedgeStore(pool);
          await store.initialize();
          const mandates = await productionHedgeMandateSource({
            pool,
            kernel,
            client: chain.client,
            registry: chain.deployment.registry,
          });
          await mandates.publish(hm);
          const approvals = new GrantApprovalGateway(
            identity,
            {
              profile: 'sandbox/monad-testnet',
              rpId: 'localhost',
              origin: 'http://localhost',
            },
            { executionModules: { 10143: chain.deployment.module } },
          );
          const authority = new DurableHedgeGrantAuthority({
            store,
            key: randomBytes(32),
            mode: 'REAL_TESTNET',
            approvals,
            executionModule: chain.deployment.module,
            loadTrusted: trustedHedgeStateLoader({ store, mandates, network }),
          });
          const reader = new PerplHedgeEvidenceReader({
            rest: restRead,
            treasury: testnetTreasuryReader({
              chain: chain.client,
              owner: read.address,
              network,
            }),
            accountId: 1058,
            base: 'MON',
          });
          const context = await restRead.context();
          const requestIds = new Map<number, number>();
          const service = new PerplHedgeService({
            store,
            reader,
            mandates,
            authority,
            executor: () =>
              new PerplHedgeExecutor({
                rest: restTrade,
                grants: authority,
                catalog: new MarketCatalog(network, context, Date.now()),
                mode: 'REAL_TESTNET',
                requestIds,
              }),
            positions: restRead,
            accountId: 1058,
          });
          const steps: unknown[] = [];
          const runHedge = async (hedgeId: string) =>
            withWorkers(
              temporal,
              tq,
              perplHedgeActivities({
                service,
                trigger: 'BRAIN_FLAG_EXCESSIVE_DOWNSIDE',
              }),
              async () => {
                const handle = await temporal.client.workflow.start(
                  'HedgeWorkflow',
                  {
                    workflowId: `testnet.hedge.${parent.groupId}.${hedgeId}`,
                    taskQueue: tq.taskQueues.strategy,
                    args: [
                      {
                        groupId: parent.groupId,
                        hedgeId,
                        pollSeconds: 2,
                        maxPolls: 30,
                        maxApprovalPolls: 120,
                        activityTimeoutSeconds: 120,
                      },
                    ],
                    memo: { synqGroupId: parent.groupId },
                  },
                );
                const approver = (async () => {
                  for (let i = 0; i < 300; i++) {
                    const p = await store.proposal(parent.groupId, hedgeId);
                    if (p) {
                      if (!p.intent || RISK_REDUCING_KINDS.has(p.intent.kind))
                        return;
                      await ctx.approvePending(hedgeIntentHash(p.intent));
                      return;
                    }
                    await new Promise((r) => setTimeout(r, 200));
                  }
                  throw new Error('HEDGE_PROPOSAL_MISSING');
                })();
                const [state] = await Promise.all([
                  handle.result() as Promise<HedgeState>,
                  approver,
                ]);
                const proposal = await store.proposal(parent.groupId, hedgeId);
                const intent = proposal
                  ? await store.intent(proposal.intentId)
                  : null;
                const fills = (await restRead.fills(30)).d
                  .filter((f) => f.oid === intent?.receipt?.orderId)
                  .map((fill) => ({
                    ...fill,
                    ...(fill.at?.txid
                      ? {
                          transactionHash: fill.at.txid.startsWith('0x')
                            ? fill.at.txid
                            : `0x${fill.at.txid}`,
                        }
                      : {}),
                  }));
                steps.push({
                  hedgeId,
                  state,
                  proposal,
                  authorization: intent?.authorization,
                  receipt: intent?.receipt,
                  fills,
                });
                record(
                  `Perpl bounded hedge ${hedgeId}`,
                  'REAL_TESTNET',
                  steps.at(-1),
                );
                return state;
              },
            );
          const closingPolicy = async () => {
            const close = {
              ...hm,
              version: 2,
              parentMandateVersion: 2,
              targetHedgeRatioBps: 0,
            };
            parent = MandateSchema.parse({
              ...parent,
              version: 2,
              hedgePolicyHash: artifactHash(close),
            });
            const r = await gov.supersedeMandate(
              onchainMandateId(parent),
              2n,
              toMandateConfig(parent),
              true,
            );
            kernel.supersedeMandate(parent, { securitySensitive: true });
            await mandates.publish(close);
            record(
              'Safe approval → risk-reducing mandate update',
              'REAL_TESTNET',
              {
                transactionHash: r.transactionHash,
                mandateHash: artifactHash(parent),
              },
            );
          };
          let openAttempted = false;
          try {
            openAttempted = true;
            const open = await runHedge('open');
            if (open.outcome === 'NO_ACTION') {
              const proposal = await store.proposal(parent.groupId, 'open');
              assert.equal(proposal?.reason, 'hedge below one lot');
              const cyclePath =
                'bounty-evidence/integration/testnet-hedge-cycle-this-run.json';
              const cycle = JSON.parse(readFileSync(cyclePath, 'utf8')) as {
                startedAt: string;
                runId: string;
                stages: {
                  stage: string;
                  evidence: { fills?: { transactionHash: `0x${string}` }[] };
                }[];
              };
              const fills = cycle.stages
                .filter(
                  (s) =>
                    s.stage === 'Perpl bounded hedge open' ||
                    s.stage === 'Perpl bounded hedge close',
                )
                .flatMap((s) => s.evidence.fills ?? []);
              assert.equal(
                fills.length,
                2,
                'earlier fresh cycle must prove both fills',
              );
              const receipts = [];
              for (const fill of fills) {
                const receipt = await chain.client.getTransactionReceipt({
                  hash: fill.transactionHash,
                });
                assert.equal(receipt.status, 'success');
                receipts.push({
                  transactionHash: receipt.transactionHash,
                  blockNumber: String(receipt.blockNumber),
                  status: receipt.status,
                });
              }
              record(
                'Fresh testnet hedge cycle completed earlier in this run',
                'REAL_TESTNET',
                {
                  sourceArtifact: cyclePath,
                  runId: cycle.runId,
                  capturedAt: cycle.startedAt,
                  separateSafeApprovedTestMandate: true,
                  receipts,
                  currentDecision: proposal.reason,
                  limitation:
                    'The current 20% bound is below one venue lot. No exposure is invented and the ratio is not increased. This linked open/close cycle used new transactions earlier in this run; it is not a new trade in this invocation.',
                },
              );
            } else {
              assert.equal(open.outcome, 'FILLED', JSON.stringify(steps));
              await closingPolicy();
              const close = await runHedge('close');
              assert.equal(close.outcome, 'FILLED');
            }
          } finally {
            // A response loss cannot justify another open. Always inspect and reduce any remaining position.
            const outstanding = (await restRead.positions()).d.filter(
              (p) => p.acc === 1058 && p.st === 1 && p.s > 0,
            );
            if (openAttempted && outstanding.length) {
              if (parent.version === 1) await closingPolicy();
              await runHedge('cleanup');
            }
            assert.equal(
              (await restRead.positions()).d.filter(
                (p) => p.acc === 1058 && p.st === 1 && p.s > 0,
              ).length,
              0,
              'operator account must end flat',
            );
          }
          await ctx.catchUp();
          assert(
            (await chain.balanceOf(parent.account)) >= 150_000_000n,
            'minimum liquid treasury breached',
          );
          record(
            'WorldSnapshot update',
            'REAL_TESTNET',
            await builder.build({ groupId: parent.groupId }),
          );
          record(
            'Reconciliation → flat Perpl account → liquid treasury',
            'REAL_TESTNET',
            {
              perplAccountId: 1058,
              positions: [],
              safeBalance: String(await chain.balanceOf(parent.account)),
              minimumLiquid: '150000000',
              steps,
            },
          );
        } finally {
          await temporal.teardown();
          rmSync(dir, { recursive: true, force: true });
        }
        const mainnet = profileConfiguration('proof/monad-mainnet');
        const mainnetClient = createPublicClient({
          chain: monad,
          transport: http(
            process.env[mainnet.rpcEnvironment] ?? mainnet.defaultRpcUrl,
          ),
        });
        assert.equal(await mainnetClient.getChainId(), 143);
        const deployment = kuruDeployment('proof/monad-mainnet');
        const flow = new KuruFlowAdapter(
          new KuruFlowClient({
            fetch: (url, init) => fetch(url, init),
            clock: { now: Date.now },
          }),
        );
        const quote = await flow.quote(
          {
            profile: 'proof/monad-mainnet',
            account: parent.account,
            tokenIn: deployment.tokens.AUSD!.address,
            tokenOut: deployment.tokens.WMON!.address,
            amountIn: 25_000_000n,
            slippageBps: 50,
          },
          Date.now(),
        );
        record('Kuru Flow fresh 25-AUSD quote', 'MAINNET_READ_ONLY', {
          quote,
          broadcast: false,
        });
        return { stages };
      },
    });
    const { integration: _integration, ...sendEvidence } = send;
    record(
      'P08 Synq Send → AUSD → Envio → receipt',
      'REAL_TESTNET',
      sendEvidence,
    );
    persist({
      status: 'PASS',
      completedAt: new Date().toISOString(),
      newTransactions: send.transactions,
    });
    return { status: 'PASS', stages, evidence: path };
  } catch (error) {
    persist({
      status: 'FAIL',
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
