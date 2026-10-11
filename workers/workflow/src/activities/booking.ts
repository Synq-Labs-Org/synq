import { ApplicationFailure } from '@temporalio/activity';
import {
  artifactHash,
  type EconomicExecution,
  type EconomicGrantAuthority,
} from '@synq/kernel';
import {
  EconomicOfferSchema,
  FulfillmentReceiptSchema,
  assertExecutable,
  convert,
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
import {
  ReservationError,
  planSettlement,
  type RailDescriptor,
  type ReferencePrice,
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
  /** Identity layer: returns member ids whose approvals verify for this request. */
  approvals: {
    verify(input: {
      bookingId: string;
      groupId: string;
      tokens: readonly string[];
    }): Promise<string[]>;
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
};

const subjectHash = (offer: EconomicOffer) =>
  artifactHash({ subject: offer.subject, providerRef: offer.providerRef });

function domainOf(offer: EconomicOffer): EconomicExecution['domain'] {
  if (offer.domain === 'STAY' || offer.domain === 'FLIGHT') return offer.domain;
  if (offer.domain === 'COMMERCE' || offer.domain === 'DATA')
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
  reservationId: string,
  planHash: string,
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
    reservationId,
    settlementPlanHash: planHash,
    recipientRef: null,
  };
}

export function createBookingActivities(
  deps: BookingActivityDeps,
): BookingActivities {
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
        : { status: 'BLOCKED', reason: `${r.status}: ${r.reason}` };
    },

    async reserveBookingFunds({
      bookingId,
      intent,
      offer,
      landed,
      approvedMax,
    }) {
      const now = deps.now();
      const plan = planSettlement({
        intentId: intent.id,
        payable: landed,
        approvedMax,
        requirement: offer.settlement,
        treasury: await deps.settlement.treasury(intent.groupId),
        rails: deps.settlement.rails,
        policy: deps.settlement.policy,
        reference: await deps.settlement.reference(),
        now,
      });
      if (plan.status === 'REFUSED')
        return { status: 'REFUSED', reason: `${plan.code}: ${plan.reason}` };
      const treasury = await deps.settlement.treasury(intent.groupId);
      const expiresAt = Math.min(
        now + deps.settlement.reservationTtlSeconds,
        intent.validUntil,
      );
      try {
        const r = await deps.reservations.reserve(
          {
            reservationId: `bk-${bookingId}`,
            groupId: intent.groupId,
            assetId: treasury.core.asset.canonicalAssetId,
            amount: plan.coreReservation,
            intentId: intent.id,
            purpose:
              intent.domain === 'FLIGHT'
                ? 'FLIGHT'
                : intent.domain === 'STAY'
                  ? 'STAY'
                  : 'COMMERCE',
            settlementPlanHash: plan.planHash,
            expiresAt,
          },
          now,
        );
        return {
          status: 'RESERVED',
          reservationId: r.reservationId,
          planHash: plan.planHash,
          coreAmount: r.amount,
          expiresAt: r.expiresAt,
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
      const held = await deps.reservations.get(input.reservationId);
      const approvers = await deps.approvals.verify({
        bookingId: input.bookingId,
        groupId: input.intent.groupId,
        tokens: input.approvals.map((a) => a.token),
      });
      const d = deps.authority.authorize(
        {
          intentId: input.intent.id,
          groupId: input.intent.groupId,
          mandateId: input.mandateId,
          execution: execution(
            deps,
            offer,
            input.landed,
            input.reservationId,
            input.planHash,
          ),
          quoteExpiresAt: offer.price.expiresAt,
          revalidatedAt: offer.price.revalidatedAt,
          reservationHeld: held?.state === 'ACTIVE' && held.expiresAt > now,
        },
        approvers,
        now,
      );
      if (d.status === 'AUTHORIZED')
        return { status: 'AUTHORIZED', grant: d.grant };
      if (d.status === 'PENDING_APPROVAL')
        return {
          status: 'PENDING_APPROVAL',
          requiredApprovals: d.requiredApprovals,
          approvals: d.approvals.length,
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
        deps.authority.consume(
          input.grant,
          execution(
            deps,
            offer,
            input.grant.execution.maxAmount,
            input.reservationId,
            input.planHash,
          ),
          now,
        );
      } catch (e) {
        return {
          status: 'FAILED',
          reason: `KERNEL_REFUSED: ${(e as Error).message}`,
        };
      }
      const travelers = await deps.travelers.resolve({
        groupId: input.grant.groupId,
        refs: input.travelerRefs,
        purpose: `booking:${input.bookingId}`,
      });
      return port.book({
        offer,
        travelers,
        idempotencyKey: input.idempotencyKey,
      });
    },

    async reconcileBooking({ offer, idempotencyKey }) {
      const port = deps.ports[offer.fulfillmentProviderId];
      if (!port) return { status: 'UNKNOWN', reason: 'no booking port' };
      try {
        const found = await port.find({ offer, idempotencyKey });
        if (!found) return { status: 'ABSENT' };
        if (found.status === 'FAILED' || found.status === 'UNKNOWN')
          return { status: 'UNKNOWN', reason: found.reason };
        return found;
      } catch (e) {
        return {
          status: 'UNKNOWN',
          reason: (e as Error).message.slice(0, 200),
        };
      }
    },

    async settleBooking(input) {
      const now = deps.now();
      const reserved = BigInt(input.coreAmount);
      let capture = reserved;
      if (input.charged) {
        const budget = input.intent.budget.max;
        const inBudget = convert(input.charged, budget, input.offer.price.fx);
        const treasury = await deps.settlement.treasury(input.intent.groupId);
        const core = rescale(
          BigInt(inBudget.amount),
          inBudget.decimals,
          treasury.core.asset.decimals,
          'up',
        );
        capture = core < reserved ? core : reserved;
      }
      const existing = await deps.reservations.get(input.reservationId);
      if (existing?.state === 'ACTIVE')
        await deps.reservations.capture(input.reservationId, capture, now);
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
      return receipt;
    },

    async releaseBookingFunds({ reservationId, reason }) {
      const r = await deps.reservations.get(reservationId);
      if (r?.state === 'ACTIVE')
        await deps.reservations.release(reservationId, reason, deps.now());
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
      return c;
    },
  };
}
