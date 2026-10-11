import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';
import { perplNetwork, profileConfiguration } from '@synq/chain-registry';
import { RISK_REDUCING_KINDS, hedgeIntentHash } from '@synq/kernel';
import {
  MarketCatalog,
  PerplRestClient,
  PerplTradingStream,
  type PerplFill,
  type PerplOrder,
} from '@synq/plugin-perpl';
import {
  DurableHedgeGrantAuthority,
  PerplHedgeEvidenceReader,
  PerplHedgeExecutor,
  PerplHedgeService,
  defaultKeyPath,
  keyFileExists,
  loadPerplKey,
  testnetTreasuryReader,
  trustedHedgeStateLoader,
  type HedgeMandates,
} from '@synq/perpl-executor';
import { referenceDeviationBps, toKernelRiskPacket } from '@synq/risk-engine';
import { perplHedgeActivities } from '../../../workers/workflow/src/activities/hedge-perpl.js';
import type { HedgeState } from '../../../workers/workflow/src/workflows/hedge.js';
import { startTemporal, testConfig } from '../../workflow/harness/temporal.js';
import { withWorkers } from '../../workflow/harness/worker.js';
import { fixtureControls } from '../../workflow/harness/controls.js';
import { hedgeMandate, parentMandate } from '../../risk/hedge-fixtures.js';
import { liveHedgeAuthority } from './hedge-authority.js';
import { LIVE, readEvidence, recordEvidence } from './evidence.js';

const network = perplNetwork('sandbox/monad-testnet');
const HAVE_KEYS =
  keyFileExists(defaultKeyPath('read')) &&
  keyFileExists(defaultKeyPath('trade'));
const wait = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end)
    await new Promise((r) => setTimeout(r, 250));
  return cond();
};

describe.skipIf(!LIVE || !HAVE_KEYS)(
  'REAL_TESTNET HedgeWorkflow over the durable Perpl hedge path',
  () => {
    it('risk packet -> HedgeIntent -> Kernel policy -> verified Mera quorum -> trade-scoped order -> fill -> reconcile -> close -> final risk packet', async () => {
      const read = loadPerplKey(defaultKeyPath('read'), {
          scope: 'read',
          chainId: network.chainId,
        }),
        trade = loadPerplKey(defaultKeyPath('trade'), {
          scope: 'trade',
          chainId: network.chainId,
        });
      const restRead = new PerplRestClient({
          transport: 'live',
          network,
          signer: read.signer,
        }),
        restTrade = new PerplRestClient({
          transport: 'live',
          network,
          signer: trade.signer,
        });
      expect(restTrade.executionMode).toBe('REAL_TESTNET');
      const context = await restRead.context(),
        market = new MarketCatalog(network, context, Date.now()).byBase('MON');
      const config = profileConfiguration(network.profile),
        chain = createPublicClient({
          chain: monadTestnet,
          transport: http(
            process.env[config.rpcEnvironment] ?? config.defaultRpcUrl,
          ),
        }) as PublicClient;
      const accountId = Number(readEvidence('testnet-account')?.perplAccountId);
      expect(accountId).toBeGreaterThan(0);
      const owner = read.address,
        stamp = Date.now(),
        groupId = `perpl_operator_harness_${stamp}`,
        now = Math.floor(stamp / 1000);
      const harness = await liveHedgeAuthority({
        mandate: parentMandate({
          groupId,
          account: `0x${stamp.toString(16).padStart(40, '0')}`,
          chainGroupId: `0x${stamp.toString(16).padStart(64, '0')}`,
          validAfter: now - 60,
          validUntil: now + 86400,
        }),
      });
      const hm = (version: number, targetHedgeRatioBps: number) =>
        hedgeMandate({
          groupId,
          version,
          perplAccountId: String(accountId),
          allowedMarkets: [{ marketId: market.id, base: 'MON' }],
          maxLeverageHundredths: 100,
          targetHedgeRatioBps,
          validAfter: now - 60,
          validUntil: now + 86400,
        });
      const mandates: HedgeMandates = {
        mandate: harness.mandate,
        hedgeMandate: hm(1, 5000),
      };
      const authority = new DurableHedgeGrantAuthority({
        store: harness.store,
        key: randomBytes(32),
        mode: 'REAL_TESTNET',
        approvals: harness.approvals,
        executionModule: harness.mandate.account,
        loadTrusted: trustedHedgeStateLoader({
          store: harness.store,
          mandates: { current: async () => mandates },
          network,
        }),
      });
      const reader = new PerplHedgeEvidenceReader({
        rest: restRead,
        treasury: testnetTreasuryReader({ chain, owner, network }),
        accountId,
        base: 'MON',
      });
      const service = new PerplHedgeService({
        store: harness.store,
        reader,
        mandates: { current: async () => mandates },
        authority,
        executor: () =>
          new PerplHedgeExecutor({
            rest: restTrade,
            grants: authority,
            catalog: new MarketCatalog(network, context, Date.now()),
            mode: 'REAL_TESTNET',
          }),
        positions: restRead,
        accountId,
      });
      const ws = new PerplTradingStream({ network, signer: read.signer }),
        wsOrders: PerplOrder[] = [],
        wsFills: PerplFill[] = [],
        wsEvents: string[] = [];
      ws.on('orders', (o) => wsOrders.push(...o));
      ws.on('fills', (f) => wsFills.push(...f));
      ws.on('ready', (r) =>
        wsEvents.push(r.reconnect ? 'ready:reconnect' : 'ready'),
      );
      ws.on('positions', (p) =>
        wsEvents.push(
          `positions:${p.snapshot ? 'snapshot' : 'update'}:${p.positions.length}`,
        ),
      );
      const env = await startTemporal();
      const dir = mkdtempSync(join(tmpdir(), 'synq-perpl-live-'));
      const steps: Record<string, unknown>[] = [];
      let seq = 0;
      const run = async (hedgeId: string): Promise<HedgeState> => {
        const tq = testConfig('perpl-live'),
          controls = fixtureControls(join(dir, `c${++seq}`), [groupId]);
        const state = await withWorkers(
          env,
          tq,
          { ...perplHedgeActivities({ service }), ...controls.activities },
          async () => {
            const handle = await env.client.workflow.start('HedgeWorkflow', {
              workflowId: `perpl-live.${groupId}.${hedgeId}`,
              taskQueue: tq.taskQueues.strategy,
              args: [
                {
                  groupId,
                  hedgeId,
                  pollSeconds: 2,
                  maxPolls: 30,
                  maxApprovalPolls: 60,
                  activityTimeoutSeconds: 120,
                },
              ],
            });
            const approver = (async () => {
              for (let i = 0; i < 150; i++) {
                const p = await harness.store.proposal(groupId, hedgeId);
                if (p) {
                  if (!p.intent || RISK_REDUCING_KINDS.has(p.intent.kind))
                    return null;
                  return harness.approvePending(p.intent);
                }
                await new Promise((r) => setTimeout(r, 200));
              }
              return null;
            })();
            const [result, draftDigest] = await Promise.all([
              handle.result() as Promise<HedgeState>,
              approver,
            ]);
            return { ...result, approvedDraft: draftDigest };
          },
        );
        const proposal = await harness.store.proposal(groupId, hedgeId);
        const record = proposal
          ? await harness.store.intent(proposal.intentId)
          : null;
        steps.push({
          hedgeId,
          workflow: state,
          intent: proposal?.intent ?? null,
          riskPacketHash: proposal?.evidence.riskPacketHash,
          evidenceMode: proposal?.evidence.executionMode,
          market: proposal?.evidence.quote,
          decision: record?.authorization.decision ?? null,
          grant: record
            ? {
                grantId: record.grant.grantId,
                executionMode: record.grant.executionMode,
                approvals: record.grant.approvals,
                maxSize: record.grant.maxSize,
                limitPrice: record.grant.limitPrice,
                expiresAt: record.grant.expiresAt,
              }
            : null,
          receipt: record?.receipt ?? null,
        });
        return state;
      };
      let opened = false;
      ws.connect();
      try {
        expect(await wait(() => ws.accounts.has(accountId), 20000)).toBe(true);
        expect(ws.accounts.get(accountId)?.fw).toBe(true);
        const initial = await reader.read();
        expect(initial.risk.blocked, initial.risk.blockReasons.join(',')).toBe(
          false,
        );
        expect(initial.risk.positions).toHaveLength(0);
        const open = await run('open');
        opened = open.outcome === 'FILLED';
        expect(open, JSON.stringify(steps.at(-1))).toMatchObject({
          outcome: 'FILLED',
          reconciled: true,
          approvals: { required: 2, satisfied: true },
          plan: { action: 'OPEN', side: 'SHORT' },
        });
        const openStep = steps.at(-1)!;
        expect(
          (openStep.grant as { approvals: string[] }).approvals,
        ).toHaveLength(2);
        expect(BigInt(open.order!.filledSize)).toBeGreaterThan(0n);
        expect(
          BigInt((openStep.intent as { size: string }).size),
        ).toBeLessThanOrEqual(3n * 10n ** BigInt(market.sizeDecimals));
        const openReceipt = openStep.receipt as { orderId: number };
        await wait(
          () => wsFills.some((f) => f.oid === openReceipt.orderId),
          20000,
        );
        const hedged = await reader.read();
        expect(hedged.risk.positions.length).toBeGreaterThan(0);
        mandates.hedgeMandate = hm(2, 0);
        const close = await run('close');
        expect(close).toMatchObject({
          outcome: 'FILLED',
          reconciled: true,
          approvals: { required: 0, satisfied: true },
          position: '0',
        });
        opened = false;
        const final = await reader.read();
        expect(final.risk.positions).toHaveLength(0);
        const openIntent = steps[0]!.intent as Parameters<
          typeof hedgeIntentHash
        >[0];
        const finalKernelRiskPacket = toKernelRiskPacket({
          risk: final.risk,
          intentHash: hedgeIntentHash(openIntent),
          chainId: network.chainId as 10143,
          quoteTtlSeconds: 60,
          slippageBps: 300,
          referenceDeviationBps: referenceDeviationBps(
            BigInt(final.quote.mark),
            BigInt(final.quote.oracle),
          ),
          maxReferenceDeviationBps: 300,
        });
        const fills = await restRead.fills(20);
        recordEvidence('testnet-hedge-workflow', 'REAL_TESTNET', {
          path: 'HedgeWorkflow (Temporal) -> PerplHedgeService -> HedgePolicy -> DurableHedgeGrantAuthority (P05 verified approvals) -> PerplHedgeExecutor (trade-scoped key)',
          operatorAccount: {
            label: 'TEST_HARNESS_OPERATOR_ACCOUNT',
            owner,
            perplAccountId: accountId,
          },
          proofMode: harness.proofMode,
          realHumanPasskeyEvidence: 'REAL_PASSKEY_EVIDENCE_PENDING',
          safeOwnershipEvidence: 'UNPROVEN',
          softwarePrincipals: harness.registeredPrincipals,
          market: {
            id: market.id,
            base: market.base,
            sizeDecimals: market.sizeDecimals,
            priceDecimals: market.priceDecimals,
          },
          initialRisk: initial.risk,
          hedgedRisk: hedged.risk,
          finalRisk: final.risk,
          finalKernelRiskPacket,
          steps,
          venueFills: fills.d.filter((f) =>
            steps.some(
              (s) =>
                (s.receipt as { orderId?: number } | null)?.orderId === f.oid,
            ),
          ),
          testMonSpentWei: '0',
          newFundingDeposited: '0',
          ws: { events: wsEvents, orders: wsOrders, fills: wsFills },
        });
      } catch (error) {
        recordEvidence('testnet-hedge-workflow-failure', 'REAL_TESTNET', {
          status: 'INVESTIGATE',
          error: error instanceof Error ? error.message : String(error),
          steps,
        });
        throw error;
      } finally {
        if (opened) {
          try {
            mandates.hedgeMandate = hm(3, 0);
            await run('cleanup');
          } catch (error) {
            recordEvidence('testnet-hedge-cleanup', 'REAL_TESTNET', {
              status: 'INVESTIGATE',
              error: error instanceof Error ? error.message : String(error),
              steps,
            });
          }
        }
        ws.close();
        await env.teardown();
        rmSync(dir, { recursive: true, force: true });
        await harness.close();
      }
    });
  },
);
