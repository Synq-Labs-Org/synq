import { describe, expect, it } from 'vitest';
import { officialAssets } from '@synq/chain-registry';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
} from '@synq/offer-exchange';
import {
  MemoryReservationStore,
  type SettlementPolicy,
} from '@synq/settlement';
import type { Asset } from '@synq/schemas';
import { createBookingActivities } from '../../workers/workflow/src/activities/booking.js';

const T = 1_780_000_000;
const AUSD = officialAssets.testnetAUSD as Asset;
const USDC = officialAssets.testnetUSDC as Asset;
const usd = (c: number) => ({
  amount: String(c),
  currency: 'USD',
  decimals: 2,
});
const policy: SettlementPolicy = {
  allowedRails: ['USDC_ONCHAIN'],
  allowedSourceAssets: [AUSD.canonicalAssetId],
  fxBufferBps: 0,
  conversion: {
    maxSlippageBps: 50,
    maxDepegBps: 100,
    maxReferenceAgeSeconds: 600,
    perConversionCap: 10n ** 12n,
    autoApproveMax: 0n,
    verifiedVenues: [],
  },
  quoteTtlSeconds: 600,
};
const intent = EconomicIntentSchema.parse({
  id: 'buy-1',
  groupId: 'g',
  domain: 'COMMERCE',
  objective: 'x',
  subject: { kind: 'PRODUCT', title: 'thing', gtin: '0012345678905' },
  hardConstraints: [],
  preferences: [],
  budget: { max: usd(10_000) },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  validUntil: T + 3_600,
});
const offer = EconomicOfferSchema.parse({
  offerId: 'o1',
  intentId: 'buy-1',
  domain: 'COMMERCE',
  discoveryProviderId: 'p',
  fulfillmentProviderId: 'p',
  providerRef: 'r',
  subject: { kind: 'PRODUCT', title: 'thing', gtin: '0012345678905' },
  price: {
    quoteId: 'q',
    base: usd(5_000),
    shipping: usd(0),
    tax: usd(0),
    fees: usd(0),
    fx: [],
    quotedAt: T,
    expiresAt: T + 600,
    revalidatedAt: T,
  },
  cancellation: {
    kind: 'UNKNOWN',
    refundable: false,
    freeUntil: null,
    penalty: null,
    changeable: false,
  },
  settlement: {
    accepts: [{ rail: 'USDC_ONCHAIN', currency: 'USDC' }],
    payee: null,
  },
  execution: {
    mode: 'NATIVE_API',
    requiresQuote: true,
    requiresKyc: false,
    requiresStepUp: false,
    piiFields: [],
  },
  environment: 'FIXTURE',
  evidence: 'MOCKED',
  retrievedAt: T,
  executable: true,
});

async function activities(edgeFree: bigint) {
  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: 'g',
    assetId: AUSD.canonicalAssetId,
    confirmed: 10n ** 12n,
    asOf: T,
  });
  await reservations.setConfirmedBalance({
    groupId: 'g',
    assetId: USDC.canonicalAssetId,
    confirmed: edgeFree,
    asOf: T,
  });
  const acts = createBookingActivities({
    now: () => T,
    reservations,
    settlement: {
      treasury: async () => ({
        account: '0x00000000000000000000000000000000000a11ce',
        core: { asset: AUSD, free: 10n ** 12n },
        edge: { asset: USDC, free: edgeFree },
      }),
      rails: [
        {
          railId: 'usdc',
          rail: 'USDC_ONCHAIN',
          chainId: 10143,
          assetId: USDC.canonicalAssetId,
          currency: 'USDC',
          auth: 'KERNEL_GRANT',
          kycRequired: false,
          kycSatisfied: false,
          environment: 'TESTNET',
          status: 'READY',
        },
      ],
      policy,
      reference: async () => ({
        source: 'fixture',
        priceE8: 100_000_000n,
        observedAt: T,
      }),
      reservationTtlSeconds: 600,
    },
  } as never);
  return { acts, reservations };
}

describe('booking reservations follow the settlement plan legs', () => {
  it('an edge-only plan reserves USDC and never trips on a zero core leg', async () => {
    const { acts, reservations } = await activities(100_000_000n);
    const r = await acts.reserveBookingFunds({
      bookingId: 'b1',
      intent,
      offer,
      landed: usd(5_000),
      approvedMax: usd(5_000),
    });
    expect(r).toMatchObject({
      status: 'RESERVED',
      reservationId: 'bk-b1',
      reservedAssetId: USDC.canonicalAssetId,
      reservedAmount: '50000000',
    });
    expect(await reservations.get('bk-b1-edge')).toBeNull();
  });
  it('a conversion plan reserves the AUSD leg and the existing USDC buffer together', async () => {
    const { acts, reservations } = await activities(20_000_000n);
    const r = await acts.reserveBookingFunds({
      bookingId: 'b2',
      intent,
      offer,
      landed: usd(5_000),
      approvedMax: usd(5_000),
    });
    expect(r).toMatchObject({
      status: 'RESERVED',
      reservedAssetId: AUSD.canonicalAssetId,
    });
    expect(await reservations.get('bk-b2-edge')).toMatchObject({
      assetId: USDC.canonicalAssetId,
      amount: '20000000',
      state: 'ACTIVE',
    });
  });
});
