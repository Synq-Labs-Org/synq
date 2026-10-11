import { describe, expect, it } from 'vitest';
import { createPublicClient, http, type PublicClient } from 'viem';
import { monadTestnet } from 'viem/chains';
import { perplNetwork, profileConfiguration } from '@synq/chain-registry';
import { HedgePolicy, hedgeIntentHash, type HedgeIntent } from '@synq/kernel';
import {
  MarketCatalog,
  PerplCollateralAdapter,
  PerplRestClient,
  PerplTradingStream,
  accountInput,
  erc20Abi,
  hedgeMarket,
  markObservation,
  positionInputs,
  quoteFrom,
  type PerplFill,
  type PerplOrder,
} from '@synq/plugin-perpl';
import {
  PerplHedgeExecutor,
  defaultKeyPath,
  keyFileExists,
  loadPerplKey,
  type TrustedHedgeState,
} from '@synq/perpl-executor';
import {
  evaluatePortfolio,
  portfolioRiskHash,
  proposeHedge,
  referenceDeviationBps,
  toKernelRiskPacket,
} from '@synq/risk-engine';
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
  'REAL_TESTNET durable bounded Perpl hedge',
  () => {
    it('risk packet -> P05 signed software-Mera quorum -> persisted grant/rq -> fill -> positions -> close -> final risk packet', async () => {
      const read = loadPerplKey(defaultKeyPath('read'), {
          scope: 'read',
          chainId: network.chainId,
        }),
        trade = loadPerplKey(defaultKeyPath('trade'), {
          scope: 'trade',
          chainId: network.chainId,
        });
      const restRead = new PerplRestClient({ network, signer: read.signer }),
        restTrade = new PerplRestClient({ network, signer: trade.signer });
      const context = await restRead.context(),
        collateral = new PerplCollateralAdapter(network).resolve(context),
        catalog = new MarketCatalog(network, context, Date.now()),
        market = catalog.byBase('MON');
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
        groupId = `perpl_operator_harness_${Date.now()}`,
        now = Math.floor(Date.now() / 1000);
      const harness = await liveHedgeAuthority({
        mandate: parentMandate({
          groupId,
          validAfter: now - 60,
          validUntil: now + 86400,
        }),
      });
      const mandate = harness.mandate;
      const hm = (zero = false) =>
        hedgeMandate({
          groupId,
          perplAccountId: String(accountId),
          allowedMarkets: [{ marketId: market.id, base: 'MON' }],
          maxLeverageHundredths: 100,
          validAfter: now - 60,
          ...(zero ? { targetHedgeRatioBps: 0 } : {}),
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
      const steps: Record<string, unknown>[] = [];
      const snapshot = async (label: string) => {
        const [wallet, positions, ticker, monWei, ausd] = await Promise.all([
          restRead.wallet(),
          restRead.positions(),
          restRead.ticker(market.id),
          chain.getBalance({ address: owner }),
          chain.readContract({
            address: collateral.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [owner],
          }),
        ]);
        const quote = quoteFrom(
          market.id,
          ticker.d[String(market.id)]!,
          60000,
          Date.now(),
        );
        const risk = evaluatePortfolio({
          asOf: Date.now(),
          valueDecimals: collateral.decimals,
          spot: [
            {
              asset: 'MON',
              canonicalAssetId: `eip155:${network.chainId}/native`,
              amount: monWei,
              decimals: 18,
              bucket: 'GAS_BUFFER',
            },
            {
              asset: 'AUSD',
              canonicalAssetId: collateral.canonicalAssetId,
              amount: ausd,
              decimals: collateral.decimals,
              bucket: 'CORE_TREASURY',
              stable: true,
            },
          ],
          perpAccount: accountInput(
            wallet.as?.find((a) => a.id === accountId) ?? null,
          ),
          perpPositions: positionInputs(catalog, positions.d, accountId),
          prices: [markObservation(market, quote, network.label)],
          maxPriceAgeMs: 60000,
          scenarios: [
            { id: 'mon-down-30', shocksBps: { MON: -3000 } },
            { id: 'mon-up-30', shocksBps: { MON: 3000 } },
          ],
        });
        expect(risk.blocked, `${label}: ${risk.blockReasons.join(',')}`).toBe(
          false,
        );
        return { risk, quote, freeAusd: ausd };
      };
      const run = async (
        label: string,
        intent: HedgeIntent,
        s: Awaited<ReturnType<typeof snapshot>>,
        zero = false,
      ) => {
        const asset = s.risk.assets.find((a) => a.asset === 'MON'),
          marketView = hedgeMarket(market, s.quote),
          state: TrustedHedgeState = {
            intent,
            mandate,
            hedgeMandate: hm(zero),
            facts: {
              now: Math.floor(Date.now() / 1000),
              nowMs: Date.now(),
              marketOpen: market.open,
              expectedCollateral: collateral,
              freeCoreTreasury: s.freeAusd.toString(),
              perpFreeCollateral: s.risk.perpFreeCollateral,
              currentHedgeNotional: (asset && BigInt(asset.perpNotional) < 0n
                ? -BigInt(asset.perpNotional)
                : 0n
              ).toString(),
              spotExposure: asset?.spotValue ?? '0',
              riskPacketHash: portfolioRiskHash(s.risk),
              risk: s.risk,
              market: {
                ...marketView,
                chainId: network.chainId,
                exchange: network.exchange,
                mark: marketView.mark.toString(),
                bid: marketView.bid.toString(),
                ask: marketView.ask.toString(),
              },
            },
          };
        const decision = new HedgePolicy().evaluate(state);
        expect(
          decision.status,
          `${label}: ${JSON.stringify(decision.rejection)}`,
        ).not.toBe('REJECTED');
        await harness.register(state, decision.requiredApprovals > 0);
        const grant = await harness.authority.issue(intent.intentId);
        const receipt = await new PerplHedgeExecutor({
          rest: restTrade,
          grants: harness.authority,
          catalog,
          mode: 'REAL_TESTNET',
        }).execute(grant);
        steps.push({
          label,
          intent,
          decision,
          grant: {
            grantId: grant.grantId,
            approvals: grant.approvals,
            maxSize: grant.maxSize,
            expiresAt: grant.expiresAt,
          },
          receipt,
        });
        recordEvidence('testnet-hedge-admission', 'REAL_TESTNET', {
          proofMode: harness.proofMode,
          operatorAccountLabel: 'TEST_HARNESS_OPERATOR_ACCOUNT',
          steps,
        });
        return receipt;
      };
      const proposal = (
        s: Awaited<ReturnType<typeof snapshot>>,
        zero: boolean,
        label: string,
      ) => {
        const p = proposeHedge(s.risk, hm(zero), hedgeMarket(market, s.quote), {
          intentId: `${groupId}_${label}_${Date.now()}`,
          now: Date.now(),
          ttlSeconds: 120,
          trigger: 'OPERATOR_TEST',
          leverageHundredths: 100,
        });
        if (p.action !== 'PROPOSE')
          throw new Error(`${label}: ${JSON.stringify(p)}`);
        return p.intent;
      };
      let opened = false;
      ws.connect();
      try {
        expect(await wait(() => ws.accounts.has(accountId), 20000)).toBe(true);
        expect(ws.accounts.get(accountId)?.fw).toBe(true);
        let initial = await snapshot('initial');
        if (initial.risk.positions.length) {
          const flattened = await run(
            'pre-flatten',
            proposal(initial, true, 'flatten'),
            initial,
            true,
          );
          expect(flattened.reconciliation).toBe('SETTLED');
          initial = await snapshot('flat');
        }
        expect(initial.risk.positions).toHaveLength(0);
        const intent = proposal(initial, false, 'open');
        expect(BigInt(intent.size)).toBeLessThanOrEqual(
          3n * 10n ** BigInt(market.sizeDecimals),
        );
        const open = await run('open-hedge', intent, initial);
        opened = open.submitted;
        expect(open.admission?.code, JSON.stringify(open.admission)).toBe(0);
        expect(open.reconciliation).toBe('SETTLED');
        expect(BigInt(open.filledSize)).toBeGreaterThan(0n);
        await wait(() => wsFills.some((f) => f.oid === open.orderId), 20000);
        const hedged = await snapshot('hedged');
        expect(hedged.risk.positions.length).toBeGreaterThan(0);
        const close = await run(
          'close-hedge',
          proposal(hedged, true, 'close'),
          hedged,
          true,
        );
        expect(close.reconciliation).toBe('SETTLED');
        const final = await snapshot('final');
        expect(final.risk.positions).toHaveLength(0);
        opened = false;
        const finalKernelRiskPacket = toKernelRiskPacket({
          risk: final.risk,
          intentHash: hedgeIntentHash(intent),
          chainId: network.chainId as 10143,
          quoteTtlSeconds: 60,
          slippageBps: 300,
          referenceDeviationBps: referenceDeviationBps(
            final.quote.mark,
            final.quote.oracle,
          ),
          maxReferenceDeviationBps: 300,
        });
        recordEvidence('testnet-hedge-durable', 'REAL_TESTNET', {
          operatorAccount: {
            label: 'TEST_HARNESS_OPERATOR_ACCOUNT',
            owner,
            perplAccountId: accountId,
          },
          proofMode: harness.proofMode,
          realHumanPasskeyEvidence: 'REAL_PASSKEY_EVIDENCE_PENDING',
          safeOwnershipEvidence: 'UNPROVEN',
          softwarePrincipals: harness.registeredPrincipals,
          collateral,
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
          testMonSpentWei: '0',
          newFundingDeposited: '0',
          ws: { events: wsEvents, orders: wsOrders, fills: wsFills },
        });
      } finally {
        if (opened) {
          try {
            const s = await snapshot('cleanup');
            if (s.risk.positions.length)
              await run('cleanup-close', proposal(s, true, 'cleanup'), s, true);
          } catch (error) {
            recordEvidence('testnet-hedge-cleanup', 'REAL_TESTNET', {
              status: 'INVESTIGATE',
              error: error instanceof Error ? error.message : String(error),
              steps,
            });
          }
        }
        ws.close();
        await harness.close();
      }
    });
  },
);
