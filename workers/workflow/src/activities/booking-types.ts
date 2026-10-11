import type {
  EconomicIntent,
  EconomicOffer,
  FulfillmentReceipt,
  Money,
} from '@synq/offer-exchange';
import type { EconomicGrant } from '@synq/kernel';

export type BookingCandidate = { offer: EconomicOffer; landed: Money };

export type RevalidateBookingResult =
  | { status: 'EXECUTABLE'; offer: EconomicOffer; landed: Money }
  | { status: 'BLOCKED'; reason: string };

export type ReserveBookingResult =
  | {
      status: 'RESERVED';
      reservationId: string;
      planHash: string;
      coreAmount: string;
      reservedAssetId: string;
      reservedAmount: string;
      expiresAt: number;
    }
  | { status: 'REFUSED'; reason: string };

export type AuthorizeBookingResult =
  | { status: 'AUTHORIZED'; grant: EconomicGrant }
  | {
      status: 'PENDING_APPROVAL';
      requiredApprovals: number;
      approvals: number;
      requestHash: string;
    }
  | { status: 'REJECTED'; reason: string };

export type StepUpChallenge = {
  challengeId: string;
  kind: 'OTP' | 'THREE_DS' | 'PASSKEY';
  principalId: string;
  expiresAt: number;
};

export type ExecuteBookingResult =
  | {
      status: 'CONFIRMED' | 'CANCELED';
      providerRef: string;
      reference: string | null;
      charged: Money | null;
    }
  | { status: 'FAILED'; reason: string }
  | { status: 'UNKNOWN'; reason: string };

export type ReconcileBookingResult =
  | {
      status: 'CONFIRMED' | 'CANCELED';
      providerRef: string;
      reference: string | null;
      charged: Money | null;
    }
  | { status: 'ABSENT' }
  | { status: 'UNKNOWN'; reason: string };

export type SettleBookingResult =
  | { status: 'SETTLED'; receipt: FulfillmentReceipt }
  | { status: 'INCIDENT'; reason: string };

export type CancelBookingResult = {
  confirmed: boolean;
  refund: Money | null;
  reason: string | null;
};

export type ApprovalToken = { token: string };
export type StepUpCompletion = {
  challengeId: string;
  principalId: string;
  proof: string;
};

export interface BookingActivities {
  revalidateBookingCandidate(input: {
    intent: EconomicIntent;
    candidate: BookingCandidate;
    approvedMax: Money;
  }): Promise<RevalidateBookingResult>;
  reserveBookingFunds(input: {
    bookingId: string;
    intent: EconomicIntent;
    offer: EconomicOffer;
    landed: Money;
    approvedMax: Money;
  }): Promise<ReserveBookingResult>;
  authorizeBooking(input: {
    bookingId: string;
    intent: EconomicIntent;
    mandateId: string;
    offer: EconomicOffer;
    landed: Money;
    reservationId: string;
    planHash: string;
    reservedAssetId: string;
    reservedAmount: string;
    approvals: ApprovalToken[];
  }): Promise<AuthorizeBookingResult>;
  bookingStepUpRequirement(input: {
    bookingId: string;
    offer: EconomicOffer;
  }): Promise<StepUpChallenge | null>;
  verifyBookingStepUp(input: {
    bookingId: string;
    challenge: StepUpChallenge;
    completion: StepUpCompletion;
  }): Promise<boolean>;
  executeBooking(input: {
    bookingId: string;
    offer: EconomicOffer;
    grant: EconomicGrant;
    reservationId: string;
    planHash: string;
    reservedAssetId: string;
    reservedAmount: string;
    travelerRefs: string[];
    idempotencyKey: string;
  }): Promise<ExecuteBookingResult>;
  holdBookingFunds(input: {
    reservationId: string;
    reason: string;
  }): Promise<void>;
  reconcileBooking(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ReconcileBookingResult>;
  settleBooking(input: {
    bookingId: string;
    intent: EconomicIntent;
    offer: EconomicOffer;
    reservationId: string;
    coreAmount: string;
    providerRef: string;
    reference: string | null;
    charged: Money | null;
    grantId: string;
    idempotencyKey: string;
  }): Promise<SettleBookingResult>;
  releaseBookingFunds(input: {
    reservationId: string;
    reason: string;
  }): Promise<void>;
  cancelProviderBooking(input: {
    bookingId: string;
    offer: EconomicOffer;
    providerRef: string;
    reservationId: string;
  }): Promise<CancelBookingResult>;
}
