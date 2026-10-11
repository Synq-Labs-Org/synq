import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineSignal,
  proxyActivities,
  setHandler,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import {
  BOOKING_TRANSITIONS,
  type BookingEvent,
  type BookingState,
} from '@synq/domain';
import type {
  ApprovalToken,
  BookingActivities,
  BookingCandidate,
  StepUpChallenge,
  StepUpCompletion,
} from '../activities/booking-types.js';
import type {
  EconomicIntent,
  EconomicOffer,
  FulfillmentReceipt,
  Money,
} from '@synq/offer-exchange';
import { NON_RETRYABLE, seconds } from './common.js';

export type BookingInput = {
  bookingId: string;
  groupId: string;
  mandateId: string;
  intent: EconomicIntent;
  candidates: BookingCandidate[];
  approvedMax: Money;
  travelerRefs: string[];
  approvalTimeoutSeconds?: number;
  stepUpTimeoutSeconds?: number;
  reconcileAttempts?: number;
  reconcileIntervalSeconds?: number;
  activityTimeoutSeconds?: number;
  cancelWindowSeconds?: number;
};

export type BookingWorkflowState = {
  bookingId: string;
  state: BookingState;
  history: BookingEvent[];
  offer: EconomicOffer | null;
  reservationId: string | null;
  grantId: string | null;
  providerRef: string | null;
  reference: string | null;
  idempotencyKey: string;
  stepUp: StepUpChallenge | null;
  requestHash: string | null;
  receipt: FulfillmentReceipt | null;
  refund: Money | null;
  notes: string[];
};

export const bookingStateQuery =
  defineQuery<BookingWorkflowState>('bookingState');
export const bookingApprovalSignal =
  defineSignal<[ApprovalToken]>('bookingApproval');
export const bookingStepUpSignal =
  defineSignal<[StepUpCompletion]>('bookingStepUp');
export const bookingCancelSignal = defineSignal<[]>('bookingCancel');

/**
 * Durable booking: revalidate → reserve → approve (Kernel grant) → optional
 * human step-up → book exactly once → reconcile → settle. Ambiguous provider
 * outcomes are reconciled, never re-submitted.
 */
export async function BookingWorkflow(
  input: BookingInput,
): Promise<BookingWorkflowState> {
  const timeout = seconds(input.activityTimeoutSeconds ?? 60);
  const reads = proxyActivities<BookingActivities>({
    startToCloseTimeout: timeout,
    retry: {
      initialInterval: '1s',
      backoffCoefficient: 2,
      maximumInterval: '20s',
      maximumAttempts: 5,
      nonRetryableErrorTypes: [...NON_RETRYABLE],
    },
  });
  const once = proxyActivities<BookingActivities>({
    startToCloseTimeout: timeout,
    retry: { maximumAttempts: 1 },
  });
  const s: BookingWorkflowState = {
    bookingId: input.bookingId,
    state: 'DISCOVERED',
    history: [],
    offer: null,
    reservationId: null,
    grantId: null,
    providerRef: null,
    reference: null,
    idempotencyKey: `synq:${input.groupId}:${input.bookingId}:${workflowInfo().workflowId}`,
    stepUp: null,
    requestHash: null,
    receipt: null,
    refund: null,
    notes: [],
  };
  const approvals: ApprovalToken[] = [];
  const stepUps: StepUpCompletion[] = [];
  let cancelRequested = false;
  setHandler(bookingStateQuery, () => s);
  setHandler(bookingApprovalSignal, (t) => {
    if (approvals.length < 32 && !approvals.some((a) => a.token === t.token))
      approvals.push(t);
  });
  setHandler(bookingStepUpSignal, (c) => {
    if (stepUps.length < 8) stepUps.push(c);
  });
  setHandler(bookingCancelSignal, () => {
    cancelRequested = true;
  });
  const to = (next: BookingState, note = '') => {
    if (!BOOKING_TRANSITIONS[s.state].includes(next))
      throw new Error(`BOOKING_TRANSITION_FORBIDDEN: ${s.state} -> ${next}`);
    s.history.push({
      from: s.state,
      to: next,
      at: Math.floor(Date.now() / 1000),
      note: note.slice(0, 200),
    });
    s.state = next;
  };
  const finish = async () => {
    await condition(allHandlersFinished);
    return s;
  };
  const fail = async (note: string) => {
    s.notes.push(note);
    if (s.reservationId)
      await reads.releaseBookingFunds({
        reservationId: s.reservationId,
        reason: note.slice(0, 120),
      });
    to('FAILED', note);
    return finish();
  };

  to('QUOTED', `${input.candidates.length} ranked candidates`);
  let landed: Money | null = null;
  for (const candidate of input.candidates.slice(0, 5)) {
    const r = await reads.revalidateBookingCandidate({
      intent: input.intent,
      candidate,
      approvedMax: input.approvedMax,
    });
    if (r.status === 'EXECUTABLE') {
      s.offer = r.offer;
      landed = r.landed;
      break;
    }
    s.notes.push(`${candidate.offer.offerId}: ${r.reason}`);
  }
  if (!s.offer || !landed) return fail('no candidate revalidated');
  to('REVALIDATED', s.offer.offerId);

  const reserved = await reads.reserveBookingFunds({
    bookingId: input.bookingId,
    intent: input.intent,
    offer: s.offer,
    landed,
    approvedMax: input.approvedMax,
  });
  if (reserved.status !== 'RESERVED') return fail(reserved.reason);
  s.reservationId = reserved.reservationId;
  to('RESERVED', reserved.reservationId);

  const deadline = Date.now() + (input.approvalTimeoutSeconds ?? 3_600) * 1000;
  let grant = null;
  for (;;) {
    if (cancelRequested) return fail('cancelled before approval');
    const seen = approvals.length;
    const a = await reads.authorizeBooking({
      bookingId: input.bookingId,
      intent: input.intent,
      mandateId: input.mandateId,
      offer: s.offer,
      landed,
      reservationId: reserved.reservationId,
      planHash: reserved.planHash,
      reservedAssetId: reserved.reservedAssetId,
      reservedAmount: reserved.reservedAmount,
      approvals: [...approvals],
    });
    if (a.status === 'AUTHORIZED') {
      grant = a.grant;
      break;
    }
    if (a.status === 'REJECTED') return fail(`kernel: ${a.reason}`);
    s.requestHash = a.requestHash;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return fail('approval timed out');
    await condition(
      () => approvals.length > seen || cancelRequested,
      remaining,
    );
  }
  s.grantId = grant.grantId;
  to('APPROVED', grant.grantId);

  const challenge = await reads.bookingStepUpRequirement({
    bookingId: input.bookingId,
    offer: s.offer,
  });
  if (challenge) {
    s.stepUp = challenge;
    const until = Date.now() + (input.stepUpTimeoutSeconds ?? 900) * 1000;
    let verified = false;
    while (!verified) {
      const left = until - Date.now();
      if (left <= 0 || cancelRequested) break;
      const got = await condition(
        () => stepUps.length > 0 || cancelRequested,
        left,
      );
      if (!got || cancelRequested) break;
      const completion = stepUps.shift()!;
      verified = await reads.verifyBookingStepUp({
        bookingId: input.bookingId,
        challenge,
        completion,
      });
    }
    if (!verified) return fail('step-up not completed by the authorized human');
  }

  to('BOOKING_PENDING', s.idempotencyKey);
  let executed: Awaited<ReturnType<BookingActivities['executeBooking']>>;
  try {
    executed = await once.executeBooking({
      bookingId: input.bookingId,
      offer: s.offer,
      grant,
      reservationId: reserved.reservationId,
      planHash: reserved.planHash,
      reservedAssetId: reserved.reservedAssetId,
      reservedAmount: reserved.reservedAmount,
      travelerRefs: input.travelerRefs,
      idempotencyKey: s.idempotencyKey,
    });
  } catch {
    executed = {
      status: 'UNKNOWN',
      reason: 'booking activity failed or timed out',
    };
  }
  let outcome: {
    status: 'CONFIRMED' | 'CANCELED';
    providerRef: string;
    reference: string | null;
    charged: Money | null;
  } | null = null;
  let held = false;
  if (executed.status === 'FAILED') return fail(executed.reason);
  if (executed.status === 'UNKNOWN') {
    to('UNKNOWN_PROVIDER_OUTCOME', executed.reason);
    await reads.holdBookingFunds({
      reservationId: reserved.reservationId,
      reason: 'provider outcome unknown',
    });
    held = true;
    const attempts = input.reconcileAttempts ?? 6;
    for (let i = 0; i < attempts && !outcome; i++) {
      await sleep(
        seconds((input.reconcileIntervalSeconds ?? 10) * 2 ** Math.min(i, 4)),
      );
      const r = await reads.reconcileBooking({
        offer: s.offer,
        idempotencyKey: s.idempotencyKey,
      });
      if (r.status === 'CONFIRMED' || r.status === 'CANCELED') outcome = r;
      else s.notes.push(`reconcile ${i + 1}: ${r.status}`);
    }
    if (!outcome) {
      s.notes.push(
        'provider outcome unresolved; reservation held for human recourse',
      );
      return finish();
    }
  } else outcome = executed;

  if (outcome.status === 'CANCELED') {
    s.providerRef = outcome.providerRef;
    s.reference = outcome.reference;
    if (outcome.charged === null && !held)
      return fail('provider canceled the booking before any charge');
    to('CANCELED', 'provider reports the booking canceled');
    if (!held)
      await reads.holdBookingFunds({
        reservationId: reserved.reservationId,
        reason: 'provider canceled; refund via recourse',
      });
    s.notes.push('canceled by provider; reservation held for recourse');
    to('REFUND_PENDING', 'recourse');
    return finish();
  }

  s.providerRef = outcome.providerRef;
  s.reference = outcome.reference;
  to('CONFIRMED', outcome.reference ?? outcome.providerRef);
  const settled = await reads.settleBooking({
    bookingId: input.bookingId,
    intent: input.intent,
    offer: s.offer,
    reservationId: reserved.reservationId,
    coreAmount: reserved.coreAmount,
    providerRef: outcome.providerRef,
    reference: outcome.reference,
    charged: outcome.charged,
    grantId: grant.grantId,
    idempotencyKey: s.idempotencyKey,
  });
  if (settled.status === 'INCIDENT') {
    s.notes.push(`settlement incident: ${settled.reason}`);
    return finish();
  }
  s.receipt = settled.receipt;
  to('RECONCILED', s.receipt.receiptId);

  if (!cancelRequested && (input.cancelWindowSeconds ?? 0) > 0)
    await condition(
      () => cancelRequested,
      (input.cancelWindowSeconds ?? 0) * 1000,
    );
  if (cancelRequested) {
    to('CANCEL_REQUESTED');
    const c = await once.cancelProviderBooking({
      bookingId: input.bookingId,
      offer: s.offer,
      providerRef: outcome.providerRef,
      reservationId: reserved.reservationId,
    });
    if (!c.confirmed) {
      s.notes.push(`cancel not confirmed: ${c.reason ?? 'unknown'}`);
      to('CONFIRMED', 'cancellation refused by provider');
      return finish();
    }
    s.refund = c.refund;
    to('CANCELED');
    to(
      'REFUND_PENDING',
      c.refund
        ? `${c.refund.amount} ${c.refund.currency}`
        : 'refund amount unknown',
    );
  }
  return finish();
}
