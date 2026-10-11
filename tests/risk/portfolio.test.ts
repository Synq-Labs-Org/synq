import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { RiskPacketSchema } from '@synq/schemas';
import { officialAsset } from '@synq/chain-registry';
import {
  ceilDiv,
  evaluatePortfolio,
  floorDiv,
  liquidationPrice,
  portfolioRiskHash,
  referenceDeviationBps,
  toKernelRiskPacket,
  valueOf,
  type PerpPositionInput,
  type RiskInputs,
} from '@synq/risk-engine';

const NOW = 1_791_644_300_000;
// MON testnet market: price 5 decimals, size 0 decimals, maintenance 20%.
const mon = (price: bigint, at = NOW) => ({
  asset: 'MON',
  price,
  decimals: 5,
  at,
  source: 'perpl-testnet:mark:64',
});
const base = (over: Partial<RiskInputs> = {}): RiskInputs => ({
  asOf: NOW,
  valueDecimals: 6,
  spot: [
    {
      asset: 'MON',
      canonicalAssetId: 'eip155:10143/native',
      amount: 100n * 10n ** 18n,
      decimals: 18,
      bucket: 'GAS_BUFFER',
    },
    {
      asset: 'AUSD',
      canonicalAssetId: officialAsset('testnetAUSD').canonicalAssetId,
      amount: 50_000_000n,
      decimals: 6,
      bucket: 'CORE_TREASURY',
      stable: true,
    },
  ],
  perpAccount: { balance: 10_000_000n, lockedBalance: 1_000_000n },
  perpPositions: [],
  prices: [mon(2_500n)],
  maxPriceAgeMs: 60_000,
  scenarios: [
    { id: 'mon-down-30', shocksBps: { MON: -3_000 } },
    { id: 'mon-up-30', shocksBps: { MON: 3_000 } },
  ],
  ...over,
});
const short = (
  size: bigint,
  collateral: bigint,
  entry = 2_500n,
): PerpPositionInput => ({
  marketId: 64,
  asset: 'MON',
  side: 'SHORT',
  size,
  sizeDecimals: 0,
  entryPrice: entry,
  priceDecimals: 5,
  collateral,
  maintenanceMarginBps: 2_000,
});

describe('deterministic portfolio risk', () => {
  it('values exposures exactly in collateral units', () => {
    // 100 MON at $0.025 = 2.5 AUSD (6 decimals).
    expect(valueOf(100n * 10n ** 18n, 18, 2_500n, 5, 6)).toBe(2_500_000n);
    const r = evaluatePortfolio(base());
    expect(r.treasuryValue).toBe('52500000');
    expect(r.assets).toEqual([
      expect.objectContaining({
        asset: 'MON',
        spotValue: '2500000',
        perpNotional: '0',
        hedgeRatioBps: 0,
      }),
    ]);
    expect(r.equity).toBe('62500000');
    expect(r.perpFreeCollateral).toBe('9000000');
    expect(r.scenarios[0]).toEqual(
      expect.objectContaining({
        id: 'mon-down-30',
        pnl: '-750000',
        loss: '750000',
      }),
    );
    expect(r.blocked).toBe(false);
  });

  it('computes hedge ratio, leverage, margin utilization, liquidation distance and PnL for a short', () => {
    const r = evaluatePortfolio(
      base({ prices: [mon(2_400n)], perpPositions: [short(50n, 1_250_000n)] }),
    );
    const p = r.positions[0]!;
    expect(p.notional).toBe('1200000');
    expect(p.unrealizedPnl).toBe('50000');
    expect(p.maintenanceRequirement).toBe('240000');
    // Short liquidation: (s*V*ep + c*D) * 1e4 / (s*V*(1e4+m)) = (50*1e6*2500 + 1.25e6*1e5)*1e4/(50*1e6*12000) = 4166
    expect(p.liquidationPrice).toBe('4166');
    expect(p.liquidationDistanceBps).toBe(7_358);
    expect(r.assets[0]!.hedgeRatioBps).toBe(5_000);
    expect(r.perpEquity).toBe('11300000');
    expect(r.leverageBps).toBe(1_061);
    expect(r.marginUtilizationBps).toBe(212);
    expect(r.netExposure).toBe('1200000');
    expect(r.grossExposure).toBe('3600000');
    // A hedged book loses less in the down scenario.
    expect(r.scenarios[0]!.pnl).toBe('-360000');
  });

  it('blocks on stale, missing or duplicate prices and non-positive equity', () => {
    expect(
      evaluatePortfolio(base({ prices: [mon(2_500n, NOW - 61_000)] }))
        .blockReasons[0],
    ).toMatch(/stale price MON/);
    expect(evaluatePortfolio(base({ prices: [] })).blocked).toBe(true);
    expect(
      evaluatePortfolio(base({ prices: [mon(2_500n), mon(2_501n)] }))
        .blockReasons,
    ).toContain('duplicate price MON');
    expect(
      evaluatePortfolio(base({ spot: [], perpAccount: null })).blockReasons,
    ).toContain('non-positive equity');
  });

  it('is deterministic and hash-stable', () => {
    const a = evaluatePortfolio(
      base({ perpPositions: [short(50n, 1_250_000n)] }),
    );
    const b = evaluatePortfolio(
      base({ perpPositions: [short(50n, 1_250_000n)] }),
    );
    expect(portfolioRiskHash(a)).toBe(portfolioRiskHash(b));
    expect(a.inputsHash).toBe(b.inputsHash);
    expect(
      portfolioRiskHash(evaluatePortfolio(base({ prices: [mon(2_501n)] }))),
    ).not.toBe(portfolioRiskHash(a));
  });

  it('projects onto the Kernel RiskPacket wire schema', () => {
    const r = evaluatePortfolio(base());
    const packet = toKernelRiskPacket({
      risk: r,
      intentHash: `0x${'11'.repeat(32)}`,
      chainId: 10143,
      quoteTtlSeconds: 30,
      slippageBps: 300,
      referenceDeviationBps: referenceDeviationBps(2_500n, 2_490n),
      maxReferenceDeviationBps: 300,
    });
    expect(RiskPacketSchema.parse(packet)).toEqual(packet);
    expect(packet.evidence[0]!.artifactHash).toBe(portfolioRiskHash(r));
    expect(packet.referenceDeviationBps).toBe(40);
    expect(packet.blocked).toBe(false);
  });
});

describe('risk engine properties', () => {
  const big = (lo: bigint, hi: bigint) => fc.bigInt({ min: lo, max: hi });

  it('floor/ceil division bracket the rational quotient', () => {
    fc.assert(
      fc.property(
        big(-(10n ** 30n), 10n ** 30n),
        big(1n, 10n ** 20n),
        fc.boolean(),
        (n, d, neg) => {
          const den = neg ? -d : d;
          const f = floorDiv(n, den);
          const c = ceilDiv(n, den);
          expect(f * den <= n === den > 0n || f * den === n).toBe(true);
          expect(c - f === 0n || c - f === 1n).toBe(true);
          expect(n % den === 0n ? c === f : c === f + 1n).toBe(true);
        },
      ),
    );
  });

  it('gross >= |net|, equity identity, monotone hedge ratio and non-negative scenario loss', () => {
    fc.assert(
      fc.property(
        big(0n, 10n ** 24n),
        big(1n, 10n ** 7n),
        big(0n, 10n ** 5n),
        big(0n, 10n ** 9n),
        fc.integer({ min: -9_000, max: 9_000 }),
        (monWei, price, size, collateral, shock) => {
          const inputs = base({
            spot: [
              {
                asset: 'MON',
                canonicalAssetId: 'x',
                amount: monWei,
                decimals: 18,
                bucket: 'B',
              },
            ],
            prices: [mon(price)],
            perpAccount: { balance: 10n ** 7n, lockedBalance: 0n },
            perpPositions: size > 0n ? [short(size, collateral, price)] : [],
            scenarios: [{ id: 's', shocksBps: { MON: shock } }],
          });
          const r = evaluatePortfolio(inputs);
          const net = BigInt(r.netExposure);
          expect(BigInt(r.grossExposure) >= (net < 0n ? -net : net)).toBe(true);
          expect(BigInt(r.equity)).toBe(
            BigInt(r.treasuryValue) + BigInt(r.perpEquity),
          );
          expect(BigInt(r.scenarios[0]!.loss) >= 0n).toBe(true);
          const more = evaluatePortfolio({
            ...inputs,
            perpPositions: [short(size + 1n, collateral, price)],
          });
          const h0 = r.assets[0]?.hedgeRatioBps ?? null;
          const h1 = more.assets[0]?.hedgeRatioBps ?? null;
          if (h0 !== null && h1 !== null) expect(h1 >= h0).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('liquidation price leaves equity at (or conservatively below) maintenance', () => {
    fc.assert(
      fc.property(
        big(1n, 10n ** 5n),
        big(100n, 10n ** 7n),
        big(1n, 10n ** 9n),
        fc.integer({ min: 100, max: 5_000 }),
        fc.boolean(),
        (size, entry, collateral, mm, isLong) => {
          const p: PerpPositionInput = {
            ...short(size, collateral, entry),
            side: isLong ? 'LONG' : 'SHORT',
            maintenanceMarginBps: mm,
          };
          const liq = liquidationPrice(p, 6);
          if (liq === 0n) return;
          const value = (px: bigint) => valueOf(size, 0, px, 5, 6);
          const equityAt = (px: bigint) =>
            collateral +
            (isLong ? value(px) - value(entry) : value(entry) - value(px));
          const maint = (px: bigint) =>
            ceilDiv(value(px) * BigInt(mm), 10_000n);
          // One tick further into the loss is at or below maintenance (conservative estimate).
          const beyond = isLong ? liq - 1n : liq + 1n;
          if (beyond > 0n)
            expect(equityAt(beyond) <= maint(beyond) + 2n).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
  }, 60_000);
});
