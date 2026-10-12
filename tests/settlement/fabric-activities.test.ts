import { describe, expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
  type ProviderBookingPort,
} from '@synq/offer-exchange';
import {
  LITHIC,
  LITHIC_SANDBOX_HOST,
  SimulatedCardMerchant,
  lithicProviderCapability,
} from '@synq/plugin-commerce';
import {
  fabricBookingWorld,
  usd,
} from '../../scripts/lib/fabric-booking-world.js';

const now = () => 1_780_000_000;

describe('booking activities move fabric orders out of UNKNOWN_OUTCOME', () => {
  it('SEC-L2 a reconcile that finds a definitive provider failure marks the fabric order FAILED', async () => {
    const port: ProviderBookingPort = {
      providerId: LITHIC,
      host: LITHIC_SANDBOX_HOST,
      settlement: {
        category: 'CARD_NETWORK_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
        economicEffect: 'NONE_SANDBOX',
        providerName: 'Lithic',
      },
      book: async () => ({ status: 'UNKNOWN', reason: 'timeout' }),
      find: async () => ({
        status: 'FAILED',
        reason: 'authorization declined',
      }),
      cancel: async () => ({ confirmed: false, refund: null, reason: null }),
    };
    const merchant = new SimulatedCardMerchant(
      { descriptor: 'SYNQ TEST CAFE', title: 'Team lunch', priceCents: 900 },
      now,
    );
    const world = await fabricBookingWorld({
      groupId: 'g1',
      mandateId: 'm1',
      providerId: LITHIC,
      host: LITHIC_SANDBOX_HOST,
      capability: lithicProviderCapability({ LITHIC_API_KEY: 'x' }),
      provider: merchant,
      port,
      rail: {
        railId: 'card',
        rail: 'SCOPED_CARD',
        chainId: null,
        assetId: null,
        currency: 'USD',
        auth: 'PROVIDER_API_KEY',
        kycRequired: false,
        kycSatisfied: false,
        environment: 'SANDBOX',
        status: 'READY',
      },
      perActionCapCents: 2_500,
      now,
    });
    const intent = EconomicIntentSchema.parse({
      id: 'i1',
      groupId: 'g1',
      domain: 'COMMERCE',
      objective: 'lunch',
      subject: { kind: 'PRODUCT', title: 'Team lunch', quantity: 1 },
      hardConstraints: [],
      preferences: [],
      budget: { max: usd(2_500) },
      autonomy: { execution: 'QUORUM', substitution: 'NONE' },
      validUntil: now() + 3_600,
    });
    const offer = EconomicOfferSchema.parse(merchant.offer(intent));
    const order = await world.fabric.openOrder({
      intentId: 'i1',
      groupId: 'g1',
      providerId: LITHIC,
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'synq:g1:b1:wf',
      amount: usd(900),
    });
    await world.fabric.submitGate(order.providerOrderId);
    await world.fabric.transition(order.providerOrderId, 'UNKNOWN_OUTCOME');
    const r = await world.activities.reconcileBooking({
      offer,
      idempotencyKey: 'synq:g1:b1:wf',
    });
    expect(r.status).toBe('UNKNOWN');
    expect(
      (await world.fabric.store.getOrder(order.providerOrderId))!.state,
    ).toBe('FAILED');
  });
});
