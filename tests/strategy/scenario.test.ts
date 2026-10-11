import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bibleSection23Example,
  evaluateDca,
  indicativeOutput,
  type DcaExecution,
} from '@synq/strategy-engine';
import { AUSD, UNIT, WMON } from './fixtures.js';

type Point = {
  roundId: string;
  answer: string;
  updatedAt: number;
  day: number;
};
const fixture = JSON.parse(
  readFileSync(
    new URL('./fixtures/mon-usd-chainlink-mainnet.json', import.meta.url),
    'utf8',
  ),
) as {
  provenance: { kind: string; registryKey: string; decimals: number };
  points: Point[];
};
const TRAILING_DAYS = 30;
const scale = 10n ** BigInt(18 - fixture.provenance.decimals);
const priceAt = (i: number) => BigInt(fixture.points[i]!.answer) * scale;

describe('Bible section 23 policy over real Chainlink MON/USD history', () => {
  it('fixture is a real read-only mainnet series with provenance', () => {
    expect(fixture.provenance).toMatchObject({
      kind: 'REAL_MAINNET_READ_ONLY',
      registryKey: 'mainnetChainlinkMonUsd',
      decimals: 8,
    });
    expect(fixture.points.length).toBeGreaterThanOrEqual(TRAILING_DAYS + 28);
    for (let i = 1; i < fixture.points.length; i++) {
      expect(fixture.points[i]!.day - fixture.points[i - 1]!.day).toBe(86_400);
      expect(fixture.points[i]!.updatedAt).toBeLessThanOrEqual(
        fixture.points[i]!.day,
      );
    }
  });

  it('runs weekly with AUSD treated at its 1 USD accounting target and keeps every invariant', () => {
    const first = fixture.points[TRAILING_DAYS]!.day;
    const policy = {
      ...bibleSection23Example({ ausd: AUSD, mon: WMON, startAt: first }),
      maxMarketDataAgeSeconds: 3_600,
    };
    const executions: DcaExecution[] = [];
    let free = 1_000n * UNIT;
    let monUnits = 0n;
    const lines: string[] = [];
    for (let i = TRAILING_DAYS; i < fixture.points.length; i += 7) {
      const point = fixture.points[i]!;
      const price = priceAt(i);
      let trailingSum = 0n;
      for (let j = i - TRAILING_DAYS; j < i; j++) trailingSum += priceAt(j);
      const trailing = trailingSum / BigInt(TRAILING_DAYS);
      const prev = priceAt(i - 1);
      const change24hBps = Number(((price - prev) * 10_000n) / prev);
      const positionValue = (monUnits * price * UNIT) / 10n ** 36n;
      const total = free + positionValue;
      const d = evaluateDca({
        policy,
        market: {
          asOf: point.updatedAt,
          venue: 'kuru-flow',
          assetIn: AUSD.address,
          assetOut: WMON.address,
          price,
          trailingReferencePrice: trailing,
          change24hBps,
          venueHealthy: true,
          liquidityMaxInput: 10_000n * UNIT,
          referenceStatus: 'HEALTHY',
          sourcesConflict: false,
        },
        treasury: {
          freeBudgetAsset: free,
          totalValueInBudgetAsset: total,
          targetPositionValueInBudgetAsset: positionValue,
        },
        history: { executions, exitedPrincipal: 0n },
        now: point.day,
      });
      if (d.kind === 'EXECUTE') {
        const t = d.tranche!;
        expect(t.amountIn).toBeLessThanOrEqual(policy.maxTranche);
        expect(t.amountIn).toBeLessThanOrEqual(free);
        expect((positionValue + t.amountIn) * 10_000n).toBeLessThanOrEqual(
          BigInt(policy.maxAllocationBps) * total,
        );
        expect(t.indicativeOutput).toBe(
          indicativeOutput(t.amountIn, price, 6, 18),
        );
        executions.push({
          slot: d.slot,
          intentId: d.decisionId,
          at: point.day,
          amountIn: t.amountIn,
          status: 'SETTLED',
        });
        free -= t.amountIn;
        monUnits += t.indicativeOutput;
      }
      lines.push(
        `${d.decisionId} px=${point.answer} chg=${change24hBps} ${d.kind} ${
          d.tranche?.amountIn ?? '-'
        } ${d.reasons.join('+')}`,
      );
    }
    const spent = executions.reduce((s, e) => s + e.amountIn, 0n);
    expect(spent).toBeLessThanOrEqual(policy.budget);
    expect(executions.length).toBeGreaterThan(0);
    expect(lines).toMatchSnapshot();
  });
});
