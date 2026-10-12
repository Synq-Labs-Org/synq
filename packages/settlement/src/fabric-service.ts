import type { Money } from '@synq/offer-exchange';
import {
  SettlementFabricError,
  evidenceLabelFor,
  obligationLedger,
  receiptStatement,
  transitionOrder,
  treasuryEffectFor,
  type EconomicEffect,
  type ExecutionCategory,
  type FinancialExecutionMode,
  type PaymentAuthorization,
  type ProviderOrder,
  type SettlementReceipt,
  type SettlementRefundRecord,
} from './fabric.js';
import type { SettlementFabricStore } from './fabric-store.js';
import type { TreasuryReservationStore } from './reservations.js';

export type SubmitGate =
  | { action: 'SUBMIT'; order: ProviderOrder }
  /** A prior submit may have reached the provider: look it up, never resubmit blindly. */
  | { action: 'RECONCILE_FIRST'; order: ProviderOrder }
  | { action: 'DONE'; order: ProviderOrder };

/**
 * Settlement Fabric service: provider orders, authorizations, the four
 * offchain ledgers and receipts, on top of the treasury reservation store
 * (verified on-chain funds and reservations). Sandbox outcomes never move
 * treasury value; refunds only credit the treasury from on-chain evidence.
 */
export class SettlementFabric {
  constructor(
    readonly store: SettlementFabricStore,
    private readonly reservations: TreasuryReservationStore,
    private readonly now: () => number,
  ) {}

  async openOrder(input: {
    intentId: string;
    groupId: string;
    providerId: string;
    mode: FinancialExecutionMode;
    economicEffect: EconomicEffect;
    idempotencyKey: string;
    amount: Money;
  }): Promise<ProviderOrder> {
    const t = this.now();
    const { order } = await this.store.createOrder({
      providerOrderId: `po-${input.providerId}-${input.idempotencyKey}`.slice(
        0,
        160,
      ),
      intentId: input.intentId,
      groupId: input.groupId,
      providerId: input.providerId,
      mode: input.mode,
      idempotencyKey: input.idempotencyKey,
      providerRef: null,
      state: 'PENDING_SUBMIT',
      amount: input.amount,
      economicEffect: input.economicEffect,
      reason: null,
      createdAt: t,
      updatedAt: t,
    });
    return order;
  }

  /**
   * Called right before a provider submit. Only a PENDING_SUBMIT order is
   * submitted (and atomically marked SUBMITTED); a SUBMITTED or
   * UNKNOWN_OUTCOME order must be reconciled at the provider first.
   */
  async submitGate(providerOrderId: string): Promise<SubmitGate> {
    let action: SubmitGate['action'] = 'DONE';
    const order = await this.store.updateOrder(providerOrderId, (o) => {
      if (o.state === 'PENDING_SUBMIT') {
        action = 'SUBMIT';
        return transitionOrder(o, 'SUBMITTED', {}, this.now());
      }
      action =
        o.state === 'SUBMITTED' || o.state === 'UNKNOWN_OUTCOME'
          ? 'RECONCILE_FIRST'
          : 'DONE';
      return o;
    });
    return { action, order };
  }

  transition(
    providerOrderId: string,
    next: ProviderOrder['state'],
    patch: { providerRef?: string | null; reason?: string | null } = {},
  ) {
    return this.store.updateOrder(providerOrderId, (o) =>
      transitionOrder(o, next, patch, this.now()),
    );
  }

  recordAuthorization(a: PaymentAuthorization) {
    return this.store.upsertAuthorization(a);
  }

  /**
   * A TESTNET order paid with testnet tokens: TESTNET_SETTLED, a simulated
   * provider obligation (the merchant side is a sandbox) and a receipt whose
   * treasury effect is the testnet debit. Reservation capture stays with the
   * caller, which observes the on-chain payment.
   */
  async settleTestnetOrder(input: {
    providerOrderId: string;
    providerRefs: Record<string, string>;
    category: ExecutionCategory;
    providerName: string;
    charged: Money | null;
  }): Promise<SettlementReceipt> {
    const prior = await this.store.getOrder(input.providerOrderId);
    if (!prior) throw new SettlementFabricError('NOT_FOUND');
    if (prior.mode !== 'TESTNET' || prior.economicEffect !== 'TESTNET_TOKENS')
      throw new SettlementFabricError(
        'ORDER_TRANSITION_FORBIDDEN',
        'not a testnet-token order',
      );
    if (prior.state === 'PENDING_SUBMIT')
      await this.transition(input.providerOrderId, 'SUBMITTED');
    const order = await this.transition(
      input.providerOrderId,
      'TESTNET_SETTLED',
      { providerRef: Object.values(input.providerRefs)[0] ?? null },
    );
    const amount = input.charged ?? order.amount;
    await this.store.appendLedger({
      entryId: `obl-${order.providerOrderId}`.slice(0, 160),
      ledger: obligationLedger(order.mode),
      groupId: order.groupId,
      intentId: order.intentId,
      providerOrderId: order.providerOrderId,
      mode: order.mode,
      amount,
      at: this.now(),
    });
    return this.store.putReceipt({
      receiptId: `sr-${order.providerOrderId}`.slice(0, 160),
      intentId: order.intentId,
      groupId: order.groupId,
      providerId: order.providerId,
      providerOrderId: order.providerOrderId,
      providerRefs: input.providerRefs,
      category: input.category,
      mode: order.mode,
      label: evidenceLabelFor(order.mode),
      amount,
      treasuryEffect: treasuryEffectFor(order.mode, order.economicEffect),
      statement: receiptStatement({
        category: input.category,
        mode: order.mode,
        providerName: input.providerName,
      }),
      createdAt: this.now(),
    });
  }

  /** Reconcile found the provider definitively did nothing: the order is FAILED. */
  async markFailed(providerOrderId: string, reason: string) {
    const o = await this.store.getOrder(providerOrderId);
    if (!o || o.state === 'FAILED') return o;
    if (
      o.state === 'PENDING_SUBMIT' ||
      o.state === 'SUBMITTED' ||
      o.state === 'UNKNOWN_OUTCOME'
    )
      return this.transition(providerOrderId, 'FAILED', { reason });
    return o;
  }

  private async releaseLegs(reservationIds: readonly string[], reason: string) {
    for (const id of reservationIds) {
      const r = await this.reservations.get(id);
      if (!r) continue;
      if (r.state === 'ACTIVE' || r.state === 'EXECUTING')
        await this.reservations.release(id, reason, this.now());
      else if (r.state === 'HELD')
        await this.reservations.releaseHeld(id, reason, this.now());
    }
  }

  /**
   * A no-effect sandbox fulfilment: the order is SANDBOX_FULFILLED (never a
   * settled merchant order), the obligation goes to the simulated ledger and
   * the reservation is released because no treasury value was spent.
   */
  async settleSandboxOrder(input: {
    providerOrderId: string;
    providerRefs: Record<string, string>;
    category: ExecutionCategory;
    providerName: string;
    reservationIds: readonly string[];
    charged: Money | null;
  }): Promise<SettlementReceipt> {
    const prior = await this.store.getOrder(input.providerOrderId);
    if (!prior) throw new SettlementFabricError('NOT_FOUND');
    if (prior.economicEffect !== 'NONE_SANDBOX')
      throw new SettlementFabricError(
        'ORDER_TRANSITION_FORBIDDEN',
        'not a no-effect sandbox order',
      );
    const ref = Object.values(input.providerRefs)[0] ?? null;
    if (prior.state === 'PENDING_SUBMIT')
      await this.transition(input.providerOrderId, 'SUBMITTED');
    const order = await this.transition(
      input.providerOrderId,
      'SANDBOX_FULFILLED',
      { providerRef: ref },
    );
    const amount = input.charged ?? order.amount;
    await this.store.appendLedger({
      entryId: `obl-${order.providerOrderId}`.slice(0, 160),
      ledger: obligationLedger(order.mode),
      groupId: order.groupId,
      intentId: order.intentId,
      providerOrderId: order.providerOrderId,
      mode: order.mode,
      amount,
      at: this.now(),
    });
    await this.releaseLegs(
      input.reservationIds,
      'SANDBOX_NO_ECONOMIC_EFFECT: provider sandbox spent no treasury value',
    );
    return this.store.putReceipt({
      receiptId: `sr-${order.providerOrderId}`.slice(0, 160),
      intentId: order.intentId,
      groupId: order.groupId,
      providerId: order.providerId,
      providerOrderId: order.providerOrderId,
      providerRefs: input.providerRefs,
      category: input.category,
      mode: order.mode,
      label: evidenceLabelFor(order.mode),
      amount,
      treasuryEffect: treasuryEffectFor(order.mode, order.economicEffect),
      statement: receiptStatement({
        category: input.category,
        mode: order.mode,
        providerName: input.providerName,
      }),
      createdAt: this.now(),
    });
  }

  /** A provider says it refunded. Recorded as a claim only; never treasury value. */
  async recordProviderRefund(input: {
    providerOrderId: string;
    refundId: string;
    amount: Money;
    providerRef: string | null;
  }): Promise<SettlementRefundRecord> {
    const order = await this.store.getOrder(input.providerOrderId);
    if (!order) throw new SettlementFabricError('NOT_FOUND');
    if (
      input.amount.currency !== order.amount.currency ||
      input.amount.decimals !== order.amount.decimals
    )
      throw new SettlementFabricError('REFUND_EXCEEDS_ORDER', 'unit differs');
    const rec = await this.store.putRefundCapped(
      {
        refundId: input.refundId,
        providerOrderId: order.providerOrderId,
        intentId: order.intentId,
        ledger: 'PROVIDER_REPORTED_REFUND',
        mode: order.mode,
        amount: input.amount,
        providerRef: input.providerRef,
        onchain: null,
        treasuryCredit: false,
        at: this.now(),
      },
      BigInt(order.amount.amount),
    );
    await this.store.appendLedger({
      entryId: `prr-${input.refundId}`.slice(0, 160),
      ledger: 'PROVIDER_REPORTED_REFUND',
      groupId: order.groupId,
      intentId: order.intentId,
      providerOrderId: order.providerOrderId,
      mode: order.mode,
      amount: input.amount,
      at: this.now(),
    });
    return rec;
  }

  /**
   * Confirms a refund into the treasury. Only TESTNET or approved real-money
   * orders qualify, only with on-chain evidence, and the treasury credit goes
   * through the reservation store's observed-balance check.
   */
  async confirmRefund(input: {
    providerOrderId: string;
    refundId: string;
    amount: Money;
    onchain: { chainId: number; txHash: string } | null;
    reservationId: string;
    coreAmount: bigint;
    observedCoreAmount: bigint;
  }): Promise<SettlementRefundRecord> {
    const order = await this.store.getOrder(input.providerOrderId);
    if (!order) throw new SettlementFabricError('NOT_FOUND');
    if (
      order.mode !== 'TESTNET' &&
      order.mode !== 'REAL_MONEY_APPROVAL_REQUIRED'
    )
      throw new SettlementFabricError(
        'SANDBOX_REFUND_NOT_TREASURY_CREDIT',
        `${order.mode} refunds never credit the treasury`,
      );
    if (!input.onchain)
      throw new SettlementFabricError('REFUND_EVIDENCE_REQUIRED');
    if (
      input.amount.currency !== order.amount.currency ||
      input.amount.decimals !== order.amount.decimals
    )
      throw new SettlementFabricError('REFUND_EXCEEDS_ORDER', 'unit differs');
    // 1. Cap and record atomically; a reused refund id from another ledger
    //    conflicts here, before any treasury state is touched.
    await this.store.putRefundCapped(
      {
        refundId: input.refundId,
        providerOrderId: order.providerOrderId,
        intentId: order.intentId,
        ledger: 'CONFIRMED_REFUND',
        mode: order.mode,
        amount: input.amount,
        providerRef: null,
        onchain: {
          chainId: input.onchain.chainId,
          txHash: input.onchain.txHash,
        },
        treasuryCredit: false,
        at: this.now(),
      },
      BigInt(order.amount.amount),
    );
    // 2. Treasury credit through the observed-balance check (own id namespace).
    const reservationRefundId = `fabric-cfr-${input.refundId}`.slice(0, 160);
    await this.reservations.recordRefund({
      refundId: reservationRefundId,
      reservationId: input.reservationId,
      amount: input.coreAmount,
      now: this.now(),
    });
    const settled = await this.reservations.settleRefund(
      reservationRefundId,
      input.observedCoreAmount,
      this.now(),
    );
    // 3. Record whether the treasury actually reflects it.
    const rec = await this.store.markRefundCredited(
      input.refundId,
      settled.state === 'SETTLED',
    );
    await this.store.appendLedger({
      entryId: `cfr-${input.refundId}`.slice(0, 160),
      ledger: 'CONFIRMED_REFUND',
      groupId: order.groupId,
      intentId: order.intentId,
      providerOrderId: order.providerOrderId,
      mode: order.mode,
      amount: input.amount,
      at: this.now(),
    });
    return rec;
  }
}
