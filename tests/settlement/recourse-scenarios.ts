import { describe, expect, it } from 'vitest';
import {
  MemoryRecourseStore,
  RecourseReconciler,
  type RecourseStore,
  type TreasuryReservationStore,
} from '@synq/settlement';
import { AUSD, T0, req } from './reservation-scenarios.js';

const TREASURY = '0x00000000000000000000000000000000000a11ce';

export function recourseScenarios(
  label: string,
  fresh: () => Promise<{
    store: RecourseStore;
    reservations: TreasuryReservationStore;
  }>,
) {
  describe(`recourse (${label})`, () => {
    async function setup(captured = 800n) {
      const { store, reservations } = await fresh();
      await reservations.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 10_000n,
        asOf: T0,
      });
      const r = await reservations.reserve(req({ amount: '1000' }), T0);
      if (captured > 0n)
        await reservations.capture(r.reservationId, captured, T0);
      const rec = new RecourseReconciler(
        store,
        reservations,
        async () => TREASURY,
        () => T0 + 10,
      );
      return { store, reservations, rec, id: r.reservationId };
    }
    const ev = (
      id: string,
      reservationId: string,
      at: number,
      body: Record<string, unknown>,
    ) =>
      ({
        eventId: `${label}-${id}-${reservationId}`,
        providerId: 'duffel-stays',
        providerRef: `bok-${reservationId}`,
        reservationId,
        providerUpdatedAt: at,
        ...body,
      }) as never;

    it('duplicate webhooks apply once', async () => {
      const { rec, reservations, id } = await setup();
      const e = ev('refund1', id, T0 + 1, {
        kind: 'REFUND_ISSUED',
        refundId: `rf-${id}`,
        refundCore: '300',
        refundDestination: TREASURY,
      });
      expect(await rec.apply(e)).toBe('REFUND_PENDING');
      expect(await rec.apply(e)).toBe('DUPLICATE');
      expect((await reservations.free('group-1', AUSD)).pendingRefunds).toBe(
        '300',
      );
    });
    it('stale provider state is ignored', async () => {
      const { rec, id } = await setup();
      expect(
        await rec.apply(ev('new', id, T0 + 5, { kind: 'CONFIRMED' })),
      ).toBe('APPLIED');
      expect(
        await rec.apply(
          ev('old', id, T0 + 1, {
            kind: 'PAYMENT_FAILED',
            reason: 'late webhook',
          }),
        ),
      ).toBe('STALE');
    });
    it('failed auth releases an uncaptured reservation; after capture it is an incident', async () => {
      const open = await setup(0n);
      expect(
        await open.rec.apply(
          ev('pf', open.id, T0 + 1, {
            kind: 'PAYMENT_FAILED',
            reason: 'declined',
          }),
        ),
      ).toBe('RELEASED');
      expect((await open.reservations.get(open.id))?.state).toBe('RELEASED');
      const taken = await setup();
      expect(
        await taken.rec.apply(
          ev('pf2', taken.id, T0 + 1, {
            kind: 'PAYMENT_FAILED',
            reason: 'declined',
          }),
        ),
      ).toBe('INCIDENT');
      expect((await taken.store.incidents())[0]?.code).toBe(
        'PAYMENT_FAILED_AFTER_CAPTURE',
      );
    });
    it('SET-010 a refund to any other destination opens an incident', async () => {
      const { rec, store, reservations, id } = await setup();
      expect(
        await rec.apply(
          ev('rf', id, T0 + 1, {
            kind: 'REFUND_ISSUED',
            refundId: `rf2-${id}`,
            refundCore: '100',
            refundDestination: '0x000000000000000000000000000000000000beef',
          }),
        ),
      ).toBe('INCIDENT');
      expect((await store.incidents()).map((i) => i.code)).toEqual([
        'REFUND_DESTINATION_MISMATCH',
      ]);
      expect((await reservations.free('group-1', AUSD)).pendingRefunds).toBe(
        '0',
      );
    });
    it('RECOURSE-002/RECOURSE-004 partial refunds accumulate; over-refund and observed mismatch are incidents', async () => {
      const { rec, store, id } = await setup();
      expect(
        await rec.apply(
          ev('p1', id, T0 + 1, {
            kind: 'REFUND_ISSUED',
            refundId: `a-${id}`,
            refundCore: '500',
            refundDestination: TREASURY,
          }),
        ),
      ).toBe('REFUND_PENDING');
      expect(
        await rec.apply(
          ev('p2', id, T0 + 2, {
            kind: 'REFUND_ISSUED',
            refundId: `b-${id}`,
            refundCore: '301',
            refundDestination: TREASURY,
          }),
        ),
      ).toBe('INCIDENT');
      expect(await rec.observeRefund(`a-${id}`, `bok-${id}`, 500n)).toBe(
        'SETTLED',
      );
      expect(
        await rec.apply(
          ev('p3', id, T0 + 3, {
            kind: 'REFUND_ISSUED',
            refundId: `c-${id}`,
            refundCore: '300',
            refundDestination: TREASURY,
          }),
        ),
      ).toBe('REFUND_PENDING');
      expect(await rec.observeRefund(`c-${id}`, `bok-${id}`, 250n)).toBe(
        'INCIDENT',
      );
      expect((await store.incidents()).map((i) => i.code)).toEqual([
        'REFUND_EXCEEDS_CAPTURE',
        'REFUND_MISMATCH',
      ]);
    });
    it('cancellation before capture releases; after capture the refund stays pending', async () => {
      const open = await setup(0n);
      expect(
        await open.rec.apply(
          ev('c', open.id, T0 + 1, {
            kind: 'CANCELED',
            refundCore: null,
            refundDestination: null,
          }),
        ),
      ).toBe('RELEASED');
      const taken = await setup();
      expect(
        await taken.rec.apply(
          ev('c2', taken.id, T0 + 1, {
            kind: 'CANCELED',
            refundCore: '800',
            refundDestination: TREASURY,
          }),
        ),
      ).toBe('REFUND_PENDING');
    });
    it('sweep releases expired holds', async () => {
      const { reservations } = await fresh();
      await reservations.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 100n,
        asOf: T0,
      });
      const r = await reservations.reserve(
        req({ amount: '50', expiresAt: T0 + 5 }),
        T0,
      );
      const rec = new RecourseReconciler(
        new MemoryRecourseStore(),
        reservations,
        async () => null,
        () => T0 + 6,
      );
      expect(await rec.sweep()).toContain(r.reservationId);
    });
  });
}
