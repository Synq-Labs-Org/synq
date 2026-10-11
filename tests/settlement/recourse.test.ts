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
