import { describe, expect, it } from 'vitest';
import {
  ReservationError,
  type ReservationRequest,
  type TreasuryReservationStore,
} from '@synq/settlement';

export const AUSD = 'eip155:10143/erc20:ausd';
export const T0 = 1_780_000_000;
let seq = 0;
export function req(
  over: Partial<ReservationRequest> & { amount: string },
): ReservationRequest {
  seq++;
  return {
    reservationId: `res-${process.pid}-${seq}`,
    groupId: 'group-1',
    assetId: AUSD,
    intentId: `intent-${seq}`,
    purpose: 'STAY',
    settlementPlanHash: null,
    expiresAt: T0 + 600,
    ...over,
  };
}
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof ReservationError ? e.code : String(e);
  }
};

export function reservationScenarios(
  label: string,
  fresh: () => Promise<TreasuryReservationStore>,
) {
  describe(`treasury reservations (${label})`, () => {
    it('SET-005 blocks spend beyond free balance after reservations and reserves', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        mandatoryReserve: 100n,
        asOf: T0,
      });
      await s.reserve(req({ amount: '600' }), T0);
      expect(await code(s.reserve(req({ amount: '301' }), T0))).toBe(
        'INSUFFICIENT_FREE_BALANCE',
      );
      await s.reserve(req({ amount: '300' }), T0);
      expect((await s.free('group-1', AUSD)).free).toBe('0');
    });
    it('is idempotent per reservation id and rejects a changed request', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        asOf: T0,
      });
      const r = req({ amount: '400' });
      const a = await s.reserve(r, T0);
      const b = await s.reserve(r, T0 + 1);
      expect(b).toEqual(a);
      expect((await s.free('group-1', AUSD)).held).toBe('400');
      expect(await code(s.reserve({ ...r, amount: '401' }, T0))).toBe(
        'RESERVATION_CONFLICT',
      );
    });
    it('requires a confirmed balance and an unexpired request', async () => {
      const s = await fresh();
      expect(await code(s.reserve(req({ amount: '1' }), T0))).toBe(
        'NO_CONFIRMED_BALANCE',
      );
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 10n,
        asOf: T0,
      });
      expect(
        await code(s.reserve(req({ amount: '1', expiresAt: T0 }), T0)),
      ).toBe('RESERVATION_EXPIRED');
    });
    it('SET-007 expiry and cancel release deterministically', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        asOf: T0,
      });
      const a = await s.reserve(req({ amount: '500', expiresAt: T0 + 10 }), T0);
      const b = await s.reserve(req({ amount: '500' }), T0);
      expect(await code(s.reserve(req({ amount: '1' }), T0 + 5))).toBe(
        'INSUFFICIENT_FREE_BALANCE',
      );
      const expired = await s.expireDue(T0 + 10);
      expect(expired.map((r) => r.reservationId)).toEqual([a.reservationId]);
      await s.release(b.reservationId, 'CANCELED', T0 + 11);
      expect((await s.free('group-1', AUSD)).free).toBe('1000');
      expect(await code(s.capture(b.reservationId, 1n, T0 + 12))).toBe(
        'INVALID_RESERVATION_TRANSITION',
      );
    });
    it('reservation expiry inside reserve frees space for a new intent', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 100n,
        asOf: T0,
      });
      await s.reserve(req({ amount: '100', expiresAt: T0 + 5 }), T0);
      await s.reserve(req({ amount: '100' }), T0 + 5);
    });
    it('RECOURSE-002 partial capture holds only the captured amount', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        asOf: T0,
      });
      const r = await s.reserve(req({ amount: '800' }), T0);
      expect(await code(s.capture(r.reservationId, 801n, T0))).toBe(
        'CAPTURE_EXCEEDS_RESERVATION',
      );
      await s.capture(r.reservationId, 650n, T0);
      expect(await s.free('group-1', AUSD)).toMatchObject({
        held: '650',
        free: '350',
      });
      expect(await code(s.release(r.reservationId, 'x', T0))).toBe(
        'INVALID_RESERVATION_TRANSITION',
      );
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 350n,
        asOf: T0 + 1,
      });
      await s.settle(r.reservationId, T0 + 1);
      expect(await s.free('group-1', AUSD)).toMatchObject({
        held: '0',
        free: '350',
      });
    });
    it('a promised refund is never counted as free until the balance reflects it', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        asOf: T0,
      });
      const r = await s.reserve(req({ amount: '500' }), T0);
      await s.capture(r.reservationId, 500n, T0);
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 500n,
        asOf: T0 + 1,
      });
      await s.settle(r.reservationId, T0 + 1);
      expect(
        await code(
          s.recordRefund({
            refundId: 'rf-x',
            reservationId: r.reservationId,
            amount: 501n,
            now: T0,
          }),
        ),
      ).toBe('REFUND_EXCEEDS_CAPTURE');
      const refundId = `rf-${r.reservationId}`;
      await s.recordRefund({
        refundId,
        reservationId: r.reservationId,
        amount: 200n,
        now: T0 + 2,
      });
      expect(await s.free('group-1', AUSD)).toMatchObject({
        free: '500',
        pendingRefunds: '200',
      });
      expect(await code(s.reserve(req({ amount: '600' }), T0 + 2))).toBe(
        'INSUFFICIENT_FREE_BALANCE',
      );
      expect((await s.settleRefund(refundId, 150n, T0 + 3)).state).toBe(
        'MISMATCH',
      );
    });
    it('stale balance observations never overwrite newer ones', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 500n,
        asOf: T0 + 10,
      });
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 9_999n,
        asOf: T0,
      });
      expect((await s.free('group-1', AUSD)).confirmed).toBe('500');
    });
    it('SET-006 concurrent hotel + shopping + DCA cannot oversubscribe', async () => {
      const s = await fresh();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 1_000n,
        asOf: T0,
      });
      for (let round = 0; round < 5; round++) {
        const asks = [
          req({ amount: '450', purpose: 'STAY' }),
          req({ amount: '400', purpose: 'COMMERCE' }),
          req({ amount: '350', purpose: 'DCA' }),
          req({ amount: '300', purpose: 'X402' }),
        ];
        const results = await Promise.allSettled(
          asks.map((a) => s.reserve(a, T0 + round)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled');
        const failed = results.filter((r) => r.status === 'rejected');
        const held = BigInt((await s.free('group-1', AUSD)).held);
        expect(held).toBeLessThanOrEqual(1_000n);
        expect(ok.length).toBeGreaterThanOrEqual(1);
        for (const f of failed)
          expect((f as PromiseRejectedResult).reason).toMatchObject({
            code: 'INSUFFICIENT_FREE_BALANCE',
          });
        for (const r of ok)
          await s.release(
            (r as PromiseFulfilledResult<{ reservationId: string }>).value
              .reservationId,
            'round',
            T0 + round,
          );
      }
    });
  });
}
