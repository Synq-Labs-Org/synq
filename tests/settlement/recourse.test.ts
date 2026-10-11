import { describe, expect, it } from 'vitest';
import { cancellationPreview, returnSupported } from '@synq/settlement';
import { T0 } from './reservation-scenarios.js';
import { MemoryRecourseStore, MemoryReservationStore } from '@synq/settlement';
import { recourseScenarios } from './recourse-scenarios.js';

recourseScenarios('memory', async () => ({
  store: new MemoryRecourseStore(),
  reservations: new MemoryReservationStore(),
}));

describe('recourse policy helpers', () => {
  const usd = (c: number) => ({
    amount: String(c),
    currency: 'USD',
    decimals: 2,
  });
  it('RECOURSE-003 cancellation fees are shown and material ones need approval', () => {
    expect(
      cancellationPreview(
        {
          kind: 'FREE_UNTIL',
          refundable: true,
          freeUntil: T0 + 10,
          penalty: null,
          changeable: true,
        },
        T0,
        usd(1_000),
      ),
    ).toMatchObject({ expectedRefund: 'FULL', requiresApproval: false });
    expect(
      cancellationPreview(
        {
          kind: 'PARTIAL',
          refundable: true,
          freeUntil: null,
          penalty: usd(2_500),
          changeable: false,
        },
        T0,
        usd(1_000),
      ),
    ).toMatchObject({ penalty: usd(2_500), requiresApproval: true });
    expect(
      cancellationPreview(
        {
          kind: 'PARTIAL',
          refundable: true,
          freeUntil: null,
          penalty: usd(500),
          changeable: false,
        },
        T0,
        usd(1_000),
      ).requiresApproval,
    ).toBe(false);
    expect(
      cancellationPreview(
        {
          kind: 'NON_REFUNDABLE',
          refundable: false,
          freeUntil: null,
          penalty: null,
          changeable: false,
        },
        T0,
        usd(1),
      ).expectedRefund,
    ).toBe('NONE');
  });
  it('RECOURSE-005 returns are only promised when the provider exposes them', () => {
    const offer = { cancellation: { kind: 'UNKNOWN' } } as never;
    expect(returnSupported(null, offer)).toBe(false);
    expect(returnSupported({ verbs: ['PURCHASE'] } as never, offer)).toBe(
      false,
    );
    expect(
      returnSupported({ verbs: ['PURCHASE', 'RETURN'] } as never, offer),
    ).toBe(true);
  });
});

describe('recourse durability', () => {
  it('a processing failure does not drop the event; the retry applies it', async () => {
    const { MemoryRecourseStore, MemoryReservationStore, RecourseReconciler } =
      await import('@synq/settlement');
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: 'a',
      confirmed: 100n,
      asOf: T0,
    });
    await reservations.reserve(
      {
        reservationId: 'r1',
        groupId: 'group-1',
        assetId: 'a',
        amount: '50',
        intentId: 'i',
        purpose: 'STAY',
        settlementPlanHash: null,
        expiresAt: T0 + 60,
      },
      T0,
    );
    let fail = true;
    const flaky = Object.assign(
      Object.create(reservations) as typeof reservations,
      {
        get: async (id: string) => {
          if (fail) {
            fail = false;
            throw new Error('db down');
          }
          return reservations.get(id);
        },
      },
    );
    const rec = new RecourseReconciler(
      new MemoryRecourseStore(),
      flaky,
      async () => null,
      () => T0,
    );
    const ev = {
      eventId: 'e1',
      providerId: 'p',
      providerRef: 'ref',
      reservationId: 'r1',
      providerUpdatedAt: T0,
      kind: 'PAYMENT_FAILED' as const,
      reason: 'declined',
    };
    await expect(rec.apply(ev)).rejects.toThrow(/db down/);
    expect(await rec.apply(ev)).toBe('RELEASED');
    expect(await rec.apply(ev)).toBe('DUPLICATE');
  });
});
