import { ApplicationFailure } from '@temporalio/activity';
import {
  artifactHash,
  economicRequestHash,
  type EconomicAuthorizationRequest,
  type EconomicExecution,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import {
  EconomicOfferSchema,
  FulfillmentReceiptSchema,
  assertExecutable,
  convert,
  landedTotal,
  rescale,
  revalidateOffer,
  type EconomicOffer,
  type FulfillmentReceipt,
  type Money,
  type OfferProvider,
  type ProviderBookingPort,
  type ProviderCapabilityGraph,
  type TravelerPii,
} from '@synq/offer-exchange';
import { redact } from '@synq/profile-vault';
import {
  ReservationError,
  planSettlement,
  type ExecutionCategory,
  type FinancialExecutionMode,
  type SettlementFabric,
  type RailDescriptor,
  type ReferencePrice,
  type ReservationRequest,
  type SettlementPolicy,
  type TreasuryReservationStore,
  type TreasuryView,
} from '@synq/settlement';
import type {
  BookingActivities,
  StepUpChallenge,
  StepUpCompletion,
} from './booking-types.js';

export type BookingActivityDeps = {
  now: () => number;
  graph: ProviderCapabilityGraph;
  providers: Readonly<Record<string, OfferProvider>>;
  ports: Readonly<Record<string, ProviderBookingPort>>;
  reservations: TreasuryReservationStore;
  settlement: {
    treasury(groupId: string): Promise<TreasuryView>;
    rails: readonly RailDescriptor[];
    policy: SettlementPolicy;
    reference(): Promise<ReferencePrice | null>;
    reservationTtlSeconds: number;
  };
  authority: EconomicGrantAuthority;
  /** Identity layer: verified approval records bound to the Kernel request hash. */
  approvals: {
    verify(input: {
      bookingId: string;
      groupId: string;
      requestHash: string;
      tokens: readonly string[];
    }): Promise<readonly unknown[]>;
  };
  /** ProfileVault port: the only place traveler PII is decrypted. */
  travelers: {
    resolve(input: {
      groupId: string;
      refs: readonly string[];
      purpose: string;
    }): Promise<TravelerPii[]>;
  };
  stepUp?: {
    requirement(input: {
      bookingId: string;
      offer: EconomicOffer;
    }): Promise<StepUpChallenge | null>;
    verify(input: {
      challenge: StepUpChallenge;
      completion: StepUpCompletion;
    }): Promise<boolean>;
  };
  receipts: { write(receipt: FulfillmentReceipt): Promise<void> };
  /**
   * Settlement Fabric v1.3. When present, ports that declare a settlement
   * profile get a ProviderOrder that gates resubmission (reconcile first) and
   * a ledgered settlement receipt.
   */
  fabric?: SettlementFabric;
  incidents?: {
    open(input: {
      bookingId: string;
      code: string;
      detail: string;
    }): Promise<void>;
  };
};

const clean = (text: string) => redact(text).slice(0, 200);
const subjectHash = (offer: EconomicOffer) =>
  artifactHash({ subject: offer.subject, providerRef: offer.providerRef });
export const legsOf = (reservationId: string) => [
  reservationId,
  `${reservationId}-edge`,
];

function domainOf(offer: EconomicOffer): EconomicExecution['domain'] {
  if (
    offer.domain === 'STAY' ||
    offer.domain === 'FLIGHT' ||
    offer.domain === 'COMMERCE'
  )
    return offer.domain;
  throw ApplicationFailure.nonRetryable(
    `unsupported booking domain ${offer.domain}`,
    'INVALID_INPUT',
  );
}

function execution(
  deps: BookingActivityDeps,
  offer: EconomicOffer,
  landed: Money,
  reservation: {
    reservationId: string;
    planHash: string;
    reservedAssetId: string;
    reservedAmount: string;
  },
): EconomicExecution {
  const port = deps.ports[offer.fulfillmentProviderId];
  if (!port)
    throw ApplicationFailure.nonRetryable(
      `no booking port for ${offer.fulfillmentProviderId}`,
      'NOT_CONFIGURED',
    );
  return {
    domain: domainOf(offer),
    providerId: offer.fulfillmentProviderId,
    host: port.host,
    offerId: offer.offerId,
    subjectHash: subjectHash(offer),
    quantity: offer.subject.kind === 'PRODUCT' ? offer.subject.quantity : 1,
    maxAmount: landed,
    reservationId: reservation.reservationId,
    reservedAssetId: reservation.reservedAssetId,
    reservedAmount: reservation.reservedAmount,
    settlementPlanHash: reservation.planHash,
    recipientRef: null,
    payAsset: null,
  };
}

export function createBookingActivities(
  deps: BookingActivityDeps,
): BookingActivities {
  const eachLeg = async (
    reservationId: string,
    fn: (id: string, state: string) => Promise<void>,
  ) => {
    for (const id of legsOf(reservationId)) {
      const r = await deps.reservations.get(id);
      if (r) await fn(id, r.state);
    }
  };
  return {
    async revalidateBookingCandidate({ intent, candidate, approvedMax }) {
      const offer = EconomicOfferSchema.parse(candidate.offer);
      const provider = deps.providers[offer.fulfillmentProviderId];
      if (!provider)
        return { status: 'BLOCKED', reason: 'provider not installed' };
      const r = await revalidateOffer({
        intent,
        candidate: {
          offer,
          landed: candidate.landed,
          match: { level: 'EXACT_MATCH', basis: 'SELECTED', reasons: [] },
        },
        provider,
        graph: deps.graph,
        approvedMax,
        now: deps.now,
      });
      return r.status === 'EXECUTABLE'
        ? { status: 'EXECUTABLE', offer: r.offer, landed: r.landed }
        : { status: 'BLOCKED', reason: clean(`${r.status}: ${r.reason}`) };
    },

    async reserveBookingFunds({
      bookingId,
      intent,
      offer,
      landed,
      approvedMax,
    }) {
      const now = deps.now();
      const treasury = await deps.settlement.treasury(intent.groupId);
      const plan = planSettlement({
        intentId: intent.id,
        payable: landed,
        approvedMax,
        requirement: offer.settlement,
        treasury,
        rails: deps.settlement.rails,
        policy: deps.settlement.policy,
        reference: await deps.settlement.reference(),
        now,
      });
      if (plan.status === 'REFUSED')
        return { status: 'REFUSED', reason: `${plan.code}: ${plan.reason}` };
      const expiresAt = Math.min(
        now + deps.settlement.reservationTtlSeconds,
        intent.validUntil,
      );
      const purpose =
        intent.domain === 'FLIGHT'
          ? 'FLIGHT'
          : intent.domain === 'STAY'
            ? 'STAY'
            : 'COMMERCE';
      const legs = [
        {
          assetId: treasury.core.asset.canonicalAssetId,
          amount: plan.coreReservation,
        },
        {
          assetId: treasury.edge.asset.canonicalAssetId,
          amount: plan.edgeReservation,
        },
      ].filter((l) => BigInt(l.amount) > 0n);
      if (!legs.length)
        return { status: 'REFUSED', reason: 'NOTHING_TO_RESERVE' };
      const requests: ReservationRequest[] = legs.map((l, i) => ({
        reservationId: i === 0 ? `bk-${bookingId}` : `bk-${bookingId}-edge`,
        groupId: intent.groupId,
        assetId: l.assetId,
        amount: l.amount,
        intentId: intent.id,
        purpose,
        settlementPlanHash: plan.planHash,
        expiresAt,
      }));
      try {
        const [primary] = await deps.reservations.reservePlan(requests, now);
        return {
          status: 'RESERVED',
          reservationId: primary!.reservationId,
          planHash: plan.planHash,
          coreAmount: plan.coreReservation,
          reservedAssetId: primary!.assetId,
          reservedAmount: primary!.amount,
          expiresAt: primary!.expiresAt,
        };
      } catch (e) {
        if (e instanceof ReservationError)
          return { status: 'REFUSED', reason: e.message };
        throw e;
      }
    },

    async authorizeBooking(input) {
      const now = deps.now();
      const offer = EconomicOfferSchema.parse(input.offer);
      try {
        assertExecutable(offer, now);
      } catch (e) {
        return { status: 'REJECTED', reason: (e as Error).message };
      }
      const request: EconomicAuthorizationRequest = {
        intentId: input.intent.id,
        groupId: input.intent.groupId,
        mandateId: input.mandateId,
        execution: execution(deps, offer, input.landed, input),
        quoteExpiresAt: offer.price.expiresAt,
        revalidatedAt: offer.price.revalidatedAt,
      };
      const requestHash = economicRequestHash(request);
      const approvals = await deps.approvals.verify({
        bookingId: input.bookingId,
        groupId: input.intent.groupId,
        requestHash,
        tokens: input.approvals.map((a) => a.token),
      });
      const d = await deps.authority.authorize(request, approvals, now);
      if (d.status === 'AUTHORIZED')
        return { status: 'AUTHORIZED', grant: d.grant };
      if (d.status === 'PENDING_APPROVAL')
        return {
          status: 'PENDING_APPROVAL',
          requiredApprovals: d.requiredApprovals,
          approvals: d.approvals.length,
          requestHash: d.requestHash,
        };
      return {
        status: 'REJECTED',
        reason: `${d.code}${d.detail ? `: ${d.detail}` : ''}`,
      };
    },

    async bookingStepUpRequirement({ bookingId, offer }) {
      if (!offer.execution.requiresStepUp && !deps.stepUp) return null;
      if (!deps.stepUp)
        throw ApplicationFailure.nonRetryable(
          'step-up broker not configured',
          'NOT_CONFIGURED',
        );
      return deps.stepUp.requirement({ bookingId, offer });
    },

    async verifyBookingStepUp({ challenge, completion }) {
      if (!deps.stepUp) return false;
      return deps.stepUp.verify({ challenge, completion });
    },

    async executeBooking(input) {
      const now = deps.now();
      const offer = EconomicOfferSchema.parse(input.offer);
      const port = deps.ports[offer.fulfillmentProviderId];
      if (!port) return { status: 'FAILED', reason: 'no booking port' };
      const prior = await port.find({
        offer,
        idempotencyKey: input.idempotencyKey,
      });
      if (prior && prior.status !== 'FAILED' && prior.status !== 'UNKNOWN')
        return prior;
      try {
        assertExecutable(offer, now, 900);
        const landed = landedTotal(offer, input.grant.execution.maxAmount);
        for (const id of legsOf(input.reservationId)) {
          if (id !== input.reservationId && !(await deps.reservations.get(id)))
            continue;
          await deps.reservations.beginExecution(
            id,
            {
              groupId: input.grant.groupId,
              settlementPlanHash: input.planHash,
            },
            now,
          );
        }
        await deps.authority.consume(
          input.grant,
          execution(deps, offer, landed, input),
          now,
        );
      } catch (e) {
        return {
          status: 'FAILED',
          reason: clean(`KERNEL_REFUSED: ${(e as Error).message}`),
        };
      }
      let orderId: string | null = null;
      if (deps.fabric && port.settlement) {
        const order = await deps.fabric.openOrder({
          intentId: input.grant.intentId,
          groupId: input.grant.groupId,
          providerId: port.providerId,
          mode: port.settlement.mode as FinancialExecutionMode,
          economicEffect: port.settlement.economicEffect,
          idempotencyKey: input.idempotencyKey,
          amount: input.grant.execution.maxAmount,
        });
        const gate = await deps.fabric.submitGate(order.providerOrderId);
        if (gate.action !== 'SUBMIT')
          return {
            status: 'UNKNOWN',
            reason: `prior submit ${gate.order.state}: reconcile at the provider before any retry`,
          };
        orderId = order.providerOrderId;
      }
      const travelers = await deps.travelers.resolve({
        groupId: input.grant.groupId,
        refs: input.travelerRefs,
        purpose: `booking:${input.bookingId}`,
      });
      const out = await port.book({
        offer,
        travelers,
        idempotencyKey: input.idempotencyKey,
      });
      if (orderId && deps.fabric) {
        if (out.status === 'FAILED')
          await deps.fabric.transition(orderId, 'FAILED', {
            reason: clean(out.reason),
          });
        else if (out.status === 'UNKNOWN')
          await deps.fabric.transition(orderId, 'UNKNOWN_OUTCOME', {
            reason: clean(out.reason),
          });
      }
      return out.status === 'FAILED' || out.status === 'UNKNOWN'
        ? { ...out, reason: clean(out.reason) }
        : out;
    },

    async holdBookingFunds({ reservationId, reason }) {
      await eachLeg(reservationId, async (id, state) => {
        if (state === 'ACTIVE' || state === 'EXECUTING')
          await deps.reservations.hold(id, clean(reason), deps.now());
      });
    },

    async reconcileBooking({ offer, idempotencyKey }) {
      const port = deps.ports[offer.fulfillmentProviderId];
      if (!port) return { status: 'UNKNOWN', reason: 'no booking port' };
      try {
        const found = await port.find({ offer, idempotencyKey });
        if (!found) return { status: 'ABSENT' };
        if (found.status === 'FAILED' && deps.fabric && port.settlement) {
          const o = await deps.fabric.store.findOrder(
            port.providerId,
            idempotencyKey,
          );
          if (o)
            await deps.fabric.markFailed(
              o.providerOrderId,
              clean(found.reason),
            );
        }
        if (found.status === 'FAILED' || found.status === 'UNKNOWN')
          return { status: 'UNKNOWN', reason: clean(found.reason) };
        return found;
      } catch (e) {
        return { status: 'UNKNOWN', reason: clean((e as Error).message) };
      }
    },

    async settleBooking(input) {
      const now = deps.now();
      const sandboxPort = deps.ports[input.offer.fulfillmentProviderId];
      if (sandboxPort?.settlement?.economicEffect === 'NONE_SANDBOX') {
        // A provider sandbox spent no treasury value: never capture; release.
        const profile = sandboxPort.settlement;
        const order = deps.fabric
          ? await deps.fabric.store.findOrder(
              sandboxPort.providerId,
              input.idempotencyKey,
            )
          : null;
        if (deps.fabric && order)
          await deps.fabric.settleSandboxOrder({
            providerOrderId: order.providerOrderId,
            providerRefs: { providerRef: input.providerRef },
            category: profile.category as ExecutionCategory,
            providerName: profile.providerName,
            reservationIds: legsOf(input.reservationId),
            charged: input.charged,
          });
        else
          await eachLeg(input.reservationId, async (id, state) => {
            if (state === 'ACTIVE' || state === 'EXECUTING')
              await deps.reservations.release(
                id,
                'SANDBOX_NO_ECONOMIC_EFFECT',
                now,
              );
            else if (state === 'HELD')
              await deps.reservations.releaseHeld(
                id,
                'SANDBOX_NO_ECONOMIC_EFFECT',
                now,
              );
          });
        const receipt = FulfillmentReceiptSchema.parse({
          receiptId: `rcpt-${input.bookingId}`,
          intentId: input.intent.id,
          offerId: input.offer.offerId,
          providerId: input.offer.fulfillmentProviderId,
          providerRef: input.providerRef,
          providerReference: input.reference,
          state: 'CONFIRMED',
          charged: input.charged,
          idempotencyKey: input.idempotencyKey,
          reservationId: input.reservationId,
          grantId: input.grantId,
          environment: 'SANDBOX',
          evidence: 'PROVIDER_SANDBOX',
          createdAt: now,
        });
        await deps.receipts.write(receipt);
        return { status: 'SETTLED', receipt };
      }
      const existing = await deps.reservations.get(input.reservationId);
      const capturable =
        existing &&
        ['ACTIVE', 'EXECUTING', 'HELD', 'CAPTURED'].includes(existing.state);
      if (!existing || !capturable) {
        const detail = `reservation ${existing?.state ?? 'missing'} at settlement of ${input.providerRef}`;
        await deps.incidents?.open({
          bookingId: input.bookingId,
          code: 'SETTLE_WITHOUT_RESERVATION',
          detail,
        });
        return { status: 'INCIDENT', reason: detail };
      }
      const reserved = BigInt(existing.amount);
      let capture = reserved;
      if (input.charged) {
        const inBudget = convert(
          input.charged,
          input.intent.budget.max,
          input.offer.price.fx,
        );
        const treasury = await deps.settlement.treasury(input.intent.groupId);
        const core = rescale(
          BigInt(inBudget.amount),
          inBudget.decimals,
          treasury.core.asset.decimals,
          'up',
        );
        if (core > reserved) {
          const detail = `charged ${core} exceeds reserved ${reserved}`;
          await deps.incidents?.open({
            bookingId: input.bookingId,
            code: 'CHARGE_EXCEEDS_RESERVATION',
            detail,
          });
          capture = reserved;
        } else capture = core;
      }
      if (existing.state !== 'CAPTURED')
        await deps.reservations.capture(input.reservationId, capture, now);
      await eachLeg(input.reservationId, async (id, state) => {
        if (
          id !== input.reservationId &&
          state !== 'CAPTURED' &&
          state !== 'RELEASED'
        )
          await deps.reservations.capture(
            id,
            BigInt((await deps.reservations.get(id))!.amount),
            now,
          );
      });
      const receipt = FulfillmentReceiptSchema.parse({
        receiptId: `rcpt-${input.bookingId}`,
        intentId: input.intent.id,
        offerId: input.offer.offerId,
        providerId: input.offer.fulfillmentProviderId,
        providerRef: input.providerRef,
        providerReference: input.reference,
        state: 'CONFIRMED',
        charged: input.charged,
        idempotencyKey: input.idempotencyKey,
        reservationId: input.reservationId,
        grantId: input.grantId,
        environment: input.offer.environment,
        evidence: input.offer.evidence,
        createdAt: now,
      });
      await deps.receipts.write(receipt);
      return { status: 'SETTLED', receipt };
    },

    async releaseBookingFunds({ reservationId, reason }) {
      await eachLeg(reservationId, async (id, state) => {
        if (state === 'ACTIVE' || state === 'EXECUTING')
          await deps.reservations.release(id, clean(reason), deps.now());
      });
    },

    async cancelProviderBooking({ offer, providerRef, reservationId }) {
      const port = deps.ports[offer.fulfillmentProviderId];
      if (!port)
        return { confirmed: false, refund: null, reason: 'no booking port' };
      const c = await port.cancel({ offer, providerRef });
      if (c.confirmed && c.refund) {
        const reservation = await deps.reservations.get(reservationId);
        if (reservation && BigInt(reservation.captured) > 0n) {
          const treasury = await deps.settlement.treasury(reservation.groupId);
          const usd = convert(
            c.refund,
            { currency: 'USD', decimals: 2 },
            offer.price.fx,
          );
          const core = rescale(
            BigInt(usd.amount),
            usd.decimals,
            treasury.core.asset.decimals,
            'down',
          );
          const amount =
            core < BigInt(reservation.captured)
              ? core
              : BigInt(reservation.captured);
          if (amount > 0n)
            await deps.reservations.recordRefund({
              refundId: `refund-${providerRef}`,
              reservationId,
              amount,
              now: deps.now(),
            });
        }
      }
      return { ...c, reason: c.reason ? clean(c.reason) : null };
    },
  };
}
