import { describe, expect, it } from 'vitest';
import { officialAssets } from '@synq/chain-registry';
import {
  ConversionError,
  MainnetReadOnlyRoute,
  TestnetSettlementFixture,
  planSettlement,
  quoteConversion,
  verifyRefundDestination,
  type RailDescriptor,
  type SettlementPlan,
  type SettlementPolicy,
} from '@synq/settlement';
import type { Asset } from '@synq/schemas';

const T = 1_780_000_000;
const AUSD = officialAssets.testnetAUSD as Asset;
const USDC = officialAssets.testnetUSDC as Asset;
const ACCOUNT = '0x00000000000000000000000000000000000a11ce' as const;
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});

const rail = (
  r: Partial<RailDescriptor> & Pick<RailDescriptor, 'rail'>,
): RailDescriptor => ({
  railId: r.rail.toLowerCase(),
  chainId: 10143,
  assetId: null,
  currency: 'USD',
  auth: 'KERNEL_GRANT',
  kycRequired: false,
  kycSatisfied: false,
  environment: 'TESTNET',
  status: 'READY',
  ...r,
});
const policy: SettlementPolicy = {
  allowedRails: [
    'AUSD_ONCHAIN',
    'USDC_ONCHAIN',
    'X402_USDC',
    'PROVIDER_BALANCE',
    'SCOPED_CARD',
    'HUMAN_HANDOFF',
  ],
  allowedSourceAssets: [AUSD.canonicalAssetId],
  fxBufferBps: 100,
  conversion: {
    maxSlippageBps: 50,
    maxDepegBps: 100,
    maxReferenceAgeSeconds: 300,
    perConversionCap: 500_000_000n,
    autoApproveMax: 20_000_000n,
    verifiedVenues: ['testnet-deterministic-settlement-fixture'],
  },
  quoteTtlSeconds: 120,
};
const treasury = (core: bigint, edge: bigint) => ({
  account: ACCOUNT,
  core: { asset: AUSD, free: core },
  edge: { asset: USDC, free: edge },
});
const ref = {
  source: 'chainlink-fixture',
  priceE8: 100_010_000n,
  observedAt: T - 10,
};
const usdcOnly = {
  accepts: [{ rail: 'USDC_ONCHAIN' as const, currency: 'USDC' }],
  payee: null,
};
const plan = (over: Partial<Parameters<typeof planSettlement>[0]> = {}) =>
  planSettlement({
    intentId: 'intent-1',
    payable: usd(10_000),
    approvedMax: usd(10_500),
    requirement: usdcOnly,
    treasury: treasury(1_000_000_000n, 0n),
    rails: [
      rail({ rail: 'USDC_ONCHAIN' }),
      rail({ rail: 'AUSD_ONCHAIN' }),
      rail({ rail: 'PROVIDER_BALANCE', environment: 'SANDBOX' }),
    ],
    policy,
    reference: ref,
    now: T,
    ...over,
  });

describe('SettlementRouter', () => {
  it('SET-001 USDC already in the edge buffer means no swap', () => {
    const p = plan({
      treasury: treasury(1_000_000_000n, 200_000_000n),
    }) as SettlementPlan;
    expect(p.status).toBe('PLANNED');
    expect(p.conversion).toBeNull();
    expect(p.edgeReservation).toBe('101000000');
    expect(p.coreReservation).toBe('0');
  });
  it('converts only the bounded shortfall, never the treasury', () => {
    const p = plan({
      treasury: treasury(1_000_000_000n, 30_000_000n),
    }) as SettlementPlan;
    expect(p.conversion?.shortfall).toBe('71000000');
    const amountIn = BigInt(p.conversion!.intent.amountIn);
    expect(amountIn).toBeLessThan(72_000_000n);
    expect(BigInt(p.conversion!.intent.minAmountOut)).toBeGreaterThanOrEqual(
      71_000_000n,
    );
    expect(p.coreReservation).toBe(String(amountIn));
    expect(p.conversion?.approval).toBe('GROUP_APPROVAL');
  });
  it('AUSD-accepting rails are preferred and need no conversion', () => {
    const p = plan({
      requirement: {
        accepts: [
          { rail: 'USDC_ONCHAIN', currency: 'USDC' },
          { rail: 'AUSD_ONCHAIN', currency: 'AUSD' },
        ],
        payee: null,
      },
    }) as SettlementPlan;
    expect(p.rail.rail).toBe('AUSD_ONCHAIN');
    expect(p.conversion).toBeNull();
    expect(p.coreReservation).toBe('101000000');
  });
  it('SET-009 the FX buffer never exceeds the approved cap', () => {
    const p = plan({ approvedMax: usd(10_050) }) as SettlementPlan;
    expect(p.maxPayable).toBe('100500000');
    expect(plan({ approvedMax: usd(9_999) })).toMatchObject({
      status: 'REFUSED',
      code: 'OVER_APPROVED_CAP',
    });
  });
  it('SET-002 depeg or stale reference blocks the conversion', () => {
    expect(plan({ reference: { ...ref, priceE8: 98_000_000n } })).toMatchObject(
      { code: 'DEPEG_GUARD' },
    );
    expect(plan({ reference: { ...ref, observedAt: T - 301 } })).toMatchObject({
      code: 'REFERENCE_STALE',
    });
    expect(plan({ reference: null })).toMatchObject({
      code: 'REFERENCE_STALE',
    });
  });
  it('SET-004 an unsupported source asset is never auto-swapped', () => {
    expect(
      plan({ policy: { ...policy, allowedSourceAssets: [] } }),
    ).toMatchObject({ code: 'UNSUPPORTED_SOURCE_ASSET' });
  });
  it('SET-008 unavailable rails fall back only within the mandate', () => {
    const requirement = {
      accepts: [
        { rail: 'USDC_ONCHAIN' as const, currency: 'USDC' },
        { rail: 'SCOPED_CARD' as const, currency: 'USD' },
      ],
      payee: null,
    };
    const down = [
      rail({ rail: 'USDC_ONCHAIN', status: 'DOWN' }),
      rail({ rail: 'SCOPED_CARD', kycRequired: true }),
    ];
    const r = plan({ requirement, rails: down });
    expect(r).toMatchObject({ status: 'REFUSED', code: 'NO_RAIL' });
    expect((r as { skipped: unknown[] }).skipped).toEqual([
      { rail: 'USDC_ONCHAIN', reason: 'DOWN' },
      { rail: 'SCOPED_CARD', reason: 'KYC not satisfied' },
    ]);
    const restricted = plan({
      requirement,
      rails: down,
      policy: { ...policy, allowedRails: ['AUSD_ONCHAIN'] },
    });
    expect(
      (restricted as { skipped: { reason: string }[] }).skipped.every(
        (s) => s.reason === 'not allowed by mandate',
      ),
    ).toBe(true);
    expect(
      plan({ rails: [rail({ rail: 'USDC_ONCHAIN', environment: 'MAINNET' })] }),
    ).toMatchObject({ code: 'NO_RAIL' });
  });
  it('caps a single conversion and requires free core balance', () => {
    expect(
      plan({
        policy: {
          ...policy,
          conversion: { ...policy.conversion, perConversionCap: 1_000n },
        },
      }),
    ).toMatchObject({
      code: 'CONVERSION_CAP_EXCEEDED',
    });
    expect(plan({ treasury: treasury(1_000n, 0n) })).toMatchObject({
      code: 'INSUFFICIENT_FREE_BALANCE',
    });
  });
  it('provider-balance sandbox reserves the AUSD fiat equivalent', () => {
    const p = plan({
      requirement: {
        accepts: [{ rail: 'PROVIDER_BALANCE', currency: 'USD' }],
        payee: null,
      },
    }) as SettlementPlan;
    expect(p.rail.environment).toBe('SANDBOX');
    expect(p.coreReservation).toBe('101000000');
  });
  it('plan hash is deterministic', () => {
    expect((plan() as SettlementPlan).planHash).toBe(
      (plan() as SettlementPlan).planHash,
    );
  });
  it('SET-010 refund destination is bound to the verified treasury', () => {
    const p = plan() as SettlementPlan;
    expect(() => verifyRefundDestination(p, ACCOUNT)).not.toThrow();
    expect(() =>
      verifyRefundDestination(p, '0x000000000000000000000000000000000000beef'),
    ).toThrow(/REFUND_DESTINATION_MISMATCH/);
  });
});

describe('conversion routes', () => {
  const conv = () => (plan() as SettlementPlan).conversion!;
  it('the testnet fixture is labelled SIMULATED and never claims a swap', async () => {
    const route = new TestnetSettlementFixture();
    const q = await quoteConversion({ plan: conv(), route, policy, now: T });
    expect(q.label).toBe('SIMULATED');
    const receipt = await route.execute(q.intent, T);
    expect(receipt.transactionHash).toBeNull();
    expect(receipt.note).toMatch(/no swap was broadcast/);
  });
  it('SET-002 a route quote under minimum output is blocked', async () => {
    const route = new TestnetSettlementFixture(80);
    await expect(
      quoteConversion({ plan: conv(), route, policy, now: T }),
    ).rejects.toMatchObject({ code: 'SLIPPAGE_EXCEEDED' });
  });
  it('SET-003 an expired quote is blocked', async () => {
    const route = new TestnetSettlementFixture();
    const stale = {
      ...route,
      venue: route.venue,
      label: route.label,
      executable: true,
      quote: async (i: Parameters<typeof route.quote>[0]) => ({
        ...(await route.quote(i)),
        expiresAt: T - 1,
      }),
    };
    await expect(
      quoteConversion({ plan: conv(), route: stale, policy, now: T }),
    ).rejects.toBeInstanceOf(ConversionError);
  });
  it('unverified venues and mainnet execution are refused', async () => {
    const mainnet = new MainnetReadOnlyRoute(new TestnetSettlementFixture());
    await expect(
      quoteConversion({
        plan: conv(),
        route: mainnet,
        policy: {
          ...policy,
          conversion: { ...policy.conversion, verifiedVenues: [] },
        },
        now: T,
      }),
    ).rejects.toMatchObject({
      code: 'ROUTE_UNVERIFIED',
    });
    const q = await quoteConversion({
      plan: conv(),
      route: mainnet,
      policy,
      now: T,
    });
    expect(q.label).toBe('MAINNET_READ_ONLY');
    await expect(mainnet.execute()).rejects.toThrow(
      /MAINNET_BROADCAST_DISABLED/,
    );
  });
});
