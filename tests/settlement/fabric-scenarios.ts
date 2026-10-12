import { describe, expect, it } from 'vitest';
import {
  SettlementFabric,
  SettlementFabricError,
  type SettlementFabricStore,
  type TreasuryReservationStore,
} from '@synq/settlement';

export const AUSD = 'eip155:10143/erc20:ausd';
export const T0 = 1_780_000_000;
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return e instanceof SettlementFabricError
      ? e.code
      : ((e as { code?: string }).code ?? String(e));
  }
};

let seq = 0;
export function fabricScenarios(
  label: string,
  fresh: () => Promise<{
    store: SettlementFabricStore;
    reservations: TreasuryReservationStore;
  }>,
) {
  describe(`settlement fabric ledgers (${label})`, () => {
    async function world() {
      const { store, reservations } = await fresh();
      const fabric = new SettlementFabric(store, reservations, () => T0 + 10);
      await reservations.setConfirmedBalance({
        groupId: 'g1',
        assetId: AUSD,
        confirmed: 100_000_000n,
        asOf: T0,
      });
      const id = `${label}-${process.pid}-${++seq}`;
      await reservations.reserve(
        {
          reservationId: `res-${id}`,
          groupId: 'g1',
          assetId: AUSD,
          amount: '10000000',
          intentId: `int-${id}`,
          purpose: 'GIFT_CARD',
          settlementPlanHash: 'plan',
          expiresAt: T0 + 600,
        },
        T0,
      );
      return { fabric, store, reservations, id };
    }

    it('FAB-001 a sandbox order settles as SANDBOX_FULFILLED, releases the reservation and books a simulated obligation', async () => {
      const { fabric, store, reservations, id } = await world();
      const order = await fabric.openOrder({
        intentId: `int-${id}`,
        groupId: 'g1',
        providerId: 'reloadly-sandbox',
        mode: 'PROVIDER_SANDBOX',
        economicEffect: 'NONE_SANDBOX',
        idempotencyKey: `synq-key-${id}`,
        amount: usd(1000),
      });
      expect((await fabric.submitGate(order.providerOrderId)).action).toBe(
        'SUBMIT',
      );
      const receipt = await fabric.settleSandboxOrder({
        providerOrderId: order.providerOrderId,
        providerRefs: { transactionId: '42' },
        category: 'DIGITAL_GOODS_SANDBOX',
        providerName: 'Reloadly',
        reservationIds: [`res-${id}`],
        charged: usd(1000),
      });
      expect(receipt.treasuryEffect).toBe('NONE');
      expect(receipt.label).toBe('PROVIDER_SANDBOX');
      expect(receipt.statement).not.toMatch(/AUSD|paid/i);
      expect((await reservations.get(`res-${id}`))!.state).toBe('RELEASED');
      const totals = await store.ledgerTotals('g1');
      expect(totals.SIMULATED_PROVIDER_OBLIGATION['USD/2']).toBeDefined();
      expect(totals.REAL_OFFCHAIN_OBLIGATION).toEqual({});
      expect(
        await code(
          fabric.transition(order.providerOrderId, 'MERCHANT_SETTLED'),
        ),
      ).toBe('ORDER_TRANSITION_FORBIDDEN');
    });

    it('FAB-002 a sandbox order is never a settled merchant order', async () => {
      const { fabric, id } = await world();
      const order = await fabric.openOrder({
        intentId: `int-${id}`,
        groupId: 'g1',
        providerId: 'lithic-sandbox',
        mode: 'PROVIDER_SANDBOX',
        economicEffect: 'NONE_SANDBOX',
        idempotencyKey: `synq-key-${id}`,
        amount: usd(2000),
      });
      await fabric.submitGate(order.providerOrderId);
      expect(
        await code(
          fabric.transition(order.providerOrderId, 'MERCHANT_SETTLED'),
        ),
      ).toBe('SANDBOX_IS_NOT_MERCHANT_SETTLEMENT');
    });

    it('FAB-003 a sandbox refund is a provider claim only and never credits the treasury', async () => {
      const { fabric, store, reservations, id } = await world();
      const order = await fabric.openOrder({
        intentId: `int-${id}`,
        groupId: 'g1',
        providerId: 'lithic-sandbox',
        mode: 'PROVIDER_SANDBOX',
        economicEffect: 'NONE_SANDBOX',
        idempotencyKey: `synq-key-${id}`,
        amount: usd(2000),
      });
      const before = await reservations.free('g1', AUSD);
      const rec = await fabric.recordProviderRefund({
        providerOrderId: order.providerOrderId,
        refundId: `rf-${id}`,
        amount: usd(500),
        providerRef: 'return-token',
      });
      expect(rec.treasuryCredit).toBe(false);
      expect(rec.ledger).toBe('PROVIDER_REPORTED_REFUND');
      expect(
        await code(
          fabric.confirmRefund({
            providerOrderId: order.providerOrderId,
            refundId: `rf2-${id}`,
            amount: usd(500),
            onchain: { chainId: 10143, txHash: `0x${'a'.repeat(64)}` },
            reservationId: `res-${id}`,
            coreAmount: 5_000_000n,
            observedCoreAmount: 5_000_000n,
          }),
        ),
      ).toBe('SANDBOX_REFUND_NOT_TREASURY_CREDIT');
      const after = await reservations.free('g1', AUSD);
      expect(after.free).toBe(before.free);
      expect(after.pendingRefunds).toBe(before.pendingRefunds);
      const totals = await store.ledgerTotals('g1');
      expect(totals.CONFIRMED_REFUND).toEqual({});
      expect(totals.PROVIDER_REPORTED_REFUND['USD/2']).toBe('500');
      expect(
        await code(
          fabric.recordProviderRefund({
            providerOrderId: order.providerOrderId,
            refundId: `rf3-${id}`,
            amount: usd(1600),
            providerRef: null,
          }),
        ),
      ).toBe('REFUND_EXCEEDS_ORDER');
    });

    it('FAB-004 a submitted order must be reconciled before any retry', async () => {
      const { fabric, id } = await world();
      const input = {
        intentId: `int-${id}`,
        groupId: 'g1',
        providerId: 'reloadly-sandbox',
        mode: 'PROVIDER_SANDBOX' as const,
        economicEffect: 'NONE_SANDBOX' as const,
        idempotencyKey: `synq-key-${id}`,
        amount: usd(1000),
      };
      const order = await fabric.openOrder(input);
      expect((await fabric.submitGate(order.providerOrderId)).action).toBe(
        'SUBMIT',
      );
      const again = await fabric.openOrder(input);
      expect(again.providerOrderId).toBe(order.providerOrderId);
      expect((await fabric.submitGate(order.providerOrderId)).action).toBe(
        'RECONCILE_FIRST',
      );
      await fabric.transition(order.providerOrderId, 'UNKNOWN_OUTCOME');
      expect((await fabric.submitGate(order.providerOrderId)).action).toBe(
        'RECONCILE_FIRST',
      );
      await fabric.transition(order.providerOrderId, 'FAILED');
      expect((await fabric.submitGate(order.providerOrderId)).action).toBe(
        'DONE',
      );
      expect(
        await code(fabric.openOrder({ ...input, intentId: 'other-intent' })),
      ).toBe('ORDER_CONFLICT');
    });

    it('FAB-005 a testnet refund confirms into the treasury only with on-chain evidence', async () => {
      const { fabric, reservations, id } = await world();
      await reservations.capture(`res-${id}`, 10_000_000n, T0 + 1);
      const order = await fabric.openOrder({
        intentId: `int-${id}`,
        groupId: 'g1',
        providerId: 'monad-ausd',
        mode: 'TESTNET',
        economicEffect: 'TESTNET_TOKENS',
        idempotencyKey: `synq-key-${id}`,
        amount: usd(1000),
      });
      const base = {
        providerOrderId: order.providerOrderId,
        refundId: `rf-${id}`,
        amount: usd(1000),
        reservationId: `res-${id}`,
        coreAmount: 10_000_000n,
        observedCoreAmount: 10_000_000n,
      };
      expect(await code(fabric.confirmRefund({ ...base, onchain: null }))).toBe(
        'REFUND_EVIDENCE_REQUIRED',
      );
      const rec = await fabric.confirmRefund({
        ...base,
        onchain: { chainId: 10143, txHash: `0x${'b'.repeat(64)}` },
      });
      expect(rec.ledger).toBe('CONFIRMED_REFUND');
      expect(rec.treasuryCredit).toBe(true);
    });
  });
}
