import { privateKeyToAccount } from 'viem/accounts';
import { perplNetwork } from '@synq/chain-registry';
import { MandateSchema, type Mandate } from '@synq/schemas';
import {
  HedgeMandateSchema,
  artifactHash,
  type HedgeFacts,
  type HedgeMandate,
} from '@synq/kernel';

export const testnetPerpl = perplNetwork('sandbox/monad-testnet');
export const mainnetPerpl = perplNetwork('proof/monad-mainnet');
export const members = [11, 12, 13].map((n) =>
  privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`),
);
const addr = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}`;
export const GROUP_ACCOUNT = addr(0x5afe);
export const OPERATOR = addr(0x0b0b);
export const GRANT_KEY = new Uint8Array(32).fill(9);
export const T0 = 1_791_644_300; // seconds, 2026-10-10

// Test-harness parent mandate on the testnet profile with a Perpl hedge binding.
export function parentMandate(
  overrides: Record<string, unknown> = {},
): Mandate {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: 'mandate_hedge',
    groupId: 'group_hedge',
    version: 1,
    status: 'ACTIVE',
    network: {
      profile: 'sandbox/monad-testnet',
      chainId: testnetPerpl.chainId,
      providerEnvironment: 'sandbox',
    },
    account: GROUP_ACCOUNT,
    chainGroupId: `0x${'77'.repeat(32)}`,
    operators: [OPERATOR],
    bindings: [
      {
        pluginId: 'perpl',
        action: 'PERP_HEDGE',
        target: testnetPerpl.exchange,
        selector: '0x2ab0f8f6',
      },
    ],
    recipients: [{ address: addr(0xcafe), purpose: 'COUNTERPARTY' }],
    inputAsset: testnetPerpl.collateral,
    outputAssets: [],
    perActionCap: '5000000',
    cumulativeBudget: '50000000',
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 300,
    maxReferenceDeviationBps: 300,
    maxLeverageBps: 20_000,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '1000000', reviewMax: '3000000' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'CONSENSUS',
      withdrawal: 'BLOCKED',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['LOCAL_FIXTURE', 'MERA_HUMAN'],
    },
    delegationScope: null,
    members: members.map((m, i) => ({
      memberId: `member_${i}`,
      signer: m.address,
      active: true,
    })),
    validAfter: T0 - 3_600,
    validUntil: T0 + 30 * 86_400,
    quoteTtlSeconds: 60,
    evidenceTtlSeconds: 120,
    simulationTtlSeconds: 60,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 100,
    ...overrides,
  });
}

export function hedgeMandate(
  overrides: Record<string, unknown> = {},
): HedgeMandate {
  return HedgeMandateSchema.parse({
    schemaVersion: 1,
    hedgeMandateId: 'hedge_mon_downside',
    version: 1,
    status: 'ACTIVE',
    groupId: 'group_hedge',
    parentMandateId: 'mandate_hedge',
    parentMandateVersion: 1,
    chainId: testnetPerpl.chainId,
    venue: 'perpl',
    exchange: testnetPerpl.exchange,
    perplAccountId: '1058',
    collateralAsset: testnetPerpl.collateral,
    hedgedAsset: 'MON',
    allowedMarkets: [{ marketId: 64, base: 'MON' }],
    targetHedgeRatioBps: 5_000,
    maxHedgeRatioBps: 8_000,
    maxLeverageHundredths: 200,
    maxNotional: '5000000',
    maxCollateral: '5000000',
    minLiquidationBufferBps: 2_000,
    minAdjustNotional: '1000',
    maxSlippageBps: 300,
    maxMarketDataAgeMs: 120_000,
    grantTtlSeconds: 300,
    approval: { autoMaxNotional: '1000000', reviewMaxNotional: '3000000' },
    validAfter: T0 - 3_600,
    validUntil: T0 + 30 * 86_400,
    ...overrides,
  });
}

export const marketEvidence = {
  marketId: 64,
  base: 'MON',
  chainId: testnetPerpl.chainId,
  exchange: testnetPerpl.exchange,
  priceDecimals: 5,
  sizeDecimals: 0,
  maintenanceMarginBps: 2000,
  maxLeverageHundredths: 300,
  executionMode: 'SIMULATION' as const,
  source: 'fixture:perpl:ticker:64',
  mark: '2469',
  bid: '2469',
  ask: '2470',
  at: T0 * 1000 - 5000,
};
export function fixtureRisk(
  overrides: {
    perpFreeCollateral?: string;
    currentHedgeNotional?: string;
    spotExposure?: string;
    position?: boolean;
  } = {},
) {
  return {
    asOf: T0 * 1000,
    valueDecimals: 6,
    blocked: false,
    perpFreeCollateral: overrides.perpFreeCollateral ?? '0',
    assets: [
      {
        asset: 'MON',
        spotValue: overrides.spotExposure ?? '2000000',
        perpNotional: `-${overrides.currentHedgeNotional ?? '0'}`,
        price: '2469',
        priceDecimals: 5,
        priceAt: T0 * 1000 - 5000,
      },
    ],
    positions: overrides.position
      ? [
          {
            marketId: 64,
            side: 'SHORT',
            size: '40',
            collateral: '987600',
            liquidationDistanceBps: 6666,
          },
        ]
      : [],
  };
}
export function facts(overrides: Partial<HedgeFacts> = {}): HedgeFacts {
  const risk = overrides.risk ?? fixtureRisk(overrides);
  return {
    now: T0,
    nowMs: T0 * 1000,
    marketOpen: true,
    expectedCollateral: testnetPerpl.collateral,
    freeCoreTreasury: '100000000',
    perpFreeCollateral: '0',
    currentHedgeNotional: '0',
    spotExposure: '2000000',
    risk,
    market: marketEvidence,
    riskPacketHash: artifactHash(risk),
    ...overrides,
  };
}
export function hedgeIntent(overrides: Record<string, unknown> = {}) {
  const reducing = ['CLOSE', 'REDUCE', 'CANCEL'].includes(
    String(overrides.kind),
  );
  const risk = fixtureRisk({ position: reducing });
  const size = BigInt(String(overrides.size ?? '40'));
  const notional = size * 2469n * 10n;
  const leverage = BigInt(String(overrides.leverageHundredths ?? 100));
  const collateral = reducing
    ? 0n
    : leverage > 0n
      ? (notional * 100n + leverage - 1n) / leverage
      : 0n;
  const effectiveCollateral = BigInt(
    String(overrides.collateral ?? collateral),
  );
  const liq =
    size > 0n
      ? ((size * 1000000n * 2469n + effectiveCollateral * 100000n) * 10000n) /
        (size * 1000000n * 12000n)
      : 0n;
  const buffer = liq > 2469n ? Number(((liq - 2469n) * 10000n) / 2469n) : 0;
  return {
    schemaVersion: 1,
    intentId: 'hedge_intent_1',
    groupId: 'group_hedge',
    hedgeMandateId: 'hedge_mon_downside',
    hedgeMandateVersion: 1,
    chainId: testnetPerpl.chainId,
    venue: 'perpl',
    perplAccountId: '1058',
    kind: 'OPEN',
    side: 'SHORT',
    marketId: 64,
    base: 'MON',
    size: size.toString(),
    limitPrice: '2400',
    leverageHundredths: Number(leverage),
    notional: notional.toString(),
    collateral: collateral.toString(),
    postTradeHedgeRatioBps: Number((notional * 10000n) / 2000000n),
    postTradeLiquidationBufferBps: reducing ? null : buffer,
    riskPacketHash: artifactHash(risk),
    marketDataAt: T0 * 1000 - 5000,
    createdAt: T0,
    expiresAt: T0 + 120,
    trigger: 'SCHEDULED_REVIEW',
    ...overrides,
  };
}
export function factsFor(
  intent: { kind: string },
  overrides: Partial<HedgeFacts> = {},
): HedgeFacts {
  return facts({
    risk: fixtureRisk({
      ...overrides,
      position: ['CLOSE', 'REDUCE', 'CANCEL'].includes(intent.kind),
    }),
    ...overrides,
  });
}
