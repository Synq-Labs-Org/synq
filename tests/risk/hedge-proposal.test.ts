import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HedgePolicy } from '@synq/kernel';
import {
  evaluatePortfolio,
  proposeHedge,
  type HedgeMarket,
  type RiskInputs,
} from '@synq/risk-engine';
import { T0, facts, hedgeMandate, parentMandate } from './hedge-fixtures.js';

const NOW = T0 * 1000;
const market: HedgeMarket = {
  marketId: 64,
  base: 'MON',
  priceDecimals: 5,
  sizeDecimals: 0,
  maxLeverageHundredths: 300,
  maintenanceMarginBps: 2_000,
  mark: 2_500n,
  bid: 2_498n,
  ask: 2_502n,
  at: NOW - 2_000,
};
const inputs = (monWhole: bigint, shortSize = 0n): RiskInputs => ({
  asOf: NOW,
  valueDecimals: 6,
  spot: [
    {
      asset: 'MON',
      canonicalAssetId: 'eip155:10143/native',
      amount: monWhole * 10n ** 18n,
      decimals: 18,
      bucket: 'GAS_BUFFER',
    },
  ],
  perpAccount: { balance: 2_000_000n, lockedBalance: 0n },
  perpPositions:
    shortSize > 0n
      ? [
          {
            marketId: 64,
            asset: 'MON',
            side: 'SHORT',
            size: shortSize,
            sizeDecimals: 0,
            entryPrice: 2_500n,
            priceDecimals: 5,
            collateral: shortSize * 25_000n,
            maintenanceMarginBps: 2_000,
          },
        ]
      : [],
  prices: [
    {
      asset: 'MON',
      price: 2_500n,
      decimals: 5,
      at: NOW - 2_000,
      source: 'perpl-testnet:mark:64',
    },
  ],
  maxPriceAgeMs: 60_000,
  scenarios: [{ id: 'mon-down-30', shocksBps: { MON: -3_000 } }],
});
const ctx = (
  trigger:
    | 'SCHEDULED_REVIEW'
    | 'BRAIN_FLAG_EXCESSIVE_DOWNSIDE' = 'SCHEDULED_REVIEW',
) => ({
  intentId: 'hedge_1',
  now: NOW,
  ttlSeconds: 120,
  trigger,
  leverageHundredths: 100,
});

describe('HedgeIntent from exposure', () => {
  it('sizes a short to the target hedge ratio from treasury MON exposure', () => {
    const risk = evaluatePortfolio(inputs(80n)); // 80 MON = 2.0 AUSD
    const p = proposeHedge(risk, hedgeMandate(), market, ctx());
    expect(p.action).toBe('PROPOSE');
    if (p.action !== 'PROPOSE') return;
    expect(p.intent).toMatchObject({
      kind: 'OPEN',
      side: 'SHORT',
      marketId: 64,
      size: '40',
      notional: '1000000',
      collateral: '1000000',
      leverageHundredths: 100,
      postTradeHedgeRatioBps: 5_000,
    });
    // Sell limit = bid * (1 - 3%).
    expect(p.intent.limitPrice).toBe('2423');
    expect(p.intent.postTradeLiquidationBufferBps).toBeGreaterThan(2_000);
    const decision = new HedgePolicy().evaluate({
      intent: p.intent,
      hedgeMandate: hedgeMandate(),
      mandate: parentMandate(),
      facts: facts({
        risk,
        market: {
          ...market,
          mark: market.mark.toString(),
          bid: market.bid.toString(),
          ask: market.ask.toString(),
          chainId: parentMandate().network.chainId,
          exchange: hedgeMandate().exchange,
          executionMode: 'SIMULATION',
          source: 'fixture:perpl:ticker:64',
        },
        nowMs: NOW,
        spotExposure: '2000000',
        riskPacketHash: p.riskPacketHash,
        perpFreeCollateral: '2000000',
      }),
    });
    expect(decision.rejection).toBeNull();
    expect(decision.status).toBe('PENDING_APPROVAL');
    expect(decision.treasuryReservation).toBe('0');
  });

  it('the Brain flag changes only the recorded trigger, never the size', () => {
    const risk = evaluatePortfolio(inputs(80n));
    const a = proposeHedge(risk, hedgeMandate(), market, ctx());
    const b = proposeHedge(
      risk,
      hedgeMandate(),
      market,
      ctx('BRAIN_FLAG_EXCESSIVE_DOWNSIDE'),
    );
    if (a.action !== 'PROPOSE' || b.action !== 'PROPOSE')
      throw new Error('expected proposals');
    expect({ ...b.intent, trigger: a.intent.trigger }).toEqual(a.intent);
  });

  it('reduces or closes when over-hedged and does nothing inside tolerance', () => {
    const over = proposeHedge(
      evaluatePortfolio(inputs(80n, 60n)),
      hedgeMandate(),
      market,
      ctx(),
    );
    expect(over.action === 'PROPOSE' && over.intent.kind).toBe('REDUCE');
    if (over.action === 'PROPOSE') {
      expect(over.intent.size).toBe('20');
      expect(over.intent.limitPrice).toBe('2578');
    }
    const flat = proposeHedge(
      evaluatePortfolio(inputs(80n, 40n)),
      hedgeMandate(),
      market,
      ctx(),
    );
    expect(flat.action).toBe('NONE');
    const unwind = proposeHedge(
      evaluatePortfolio(inputs(80n, 40n)),
      hedgeMandate({ targetHedgeRatioBps: 0 }),
      market,
      ctx(),
    );
    expect(unwind.action === 'PROPOSE' && unwind.intent.kind).toBe('CLOSE');
  });

  it('refuses to propose from a blocked risk packet or the wrong market', () => {
    const stale = evaluatePortfolio({
      ...inputs(80n),
      prices: [
        {
          asset: 'MON',
          price: 2_500n,
          decimals: 5,
          at: NOW - 600_000,
          source: 's',
        },
      ],
    });
    expect(proposeHedge(stale, hedgeMandate(), market, ctx()).action).toBe(
      'BLOCKED',
    );
    expect(
      proposeHedge(
        evaluatePortfolio(inputs(80n)),
        hedgeMandate(),
        { ...market, base: 'BTC' },
        ctx(),
      ).action,
    ).toBe('BLOCKED');
  });

  it('never proposes beyond notional, collateral or hedge-ratio caps', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000n }),
        fc.integer({ min: 0, max: 8_000 }),
        fc.bigInt({ min: 1n, max: 10_000_000n }),
        (mon, target, maxNotional) => {
          const hm = hedgeMandate({
            targetHedgeRatioBps: target,
            maxNotional: maxNotional.toString(),
            maxCollateral: maxNotional.toString(),
          });
          const p = proposeHedge(
            evaluatePortfolio(inputs(mon)),
            hm,
            market,
            ctx(),
          );
          if (p.action !== 'PROPOSE') return;
          expect(BigInt(p.intent.notional) <= maxNotional).toBe(true);
          expect(BigInt(p.intent.collateral) <= maxNotional).toBe(true);
          expect(p.intent.postTradeHedgeRatioBps <= 8_000).toBe(true);
          expect(p.intent.side).toBe('SHORT');
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
