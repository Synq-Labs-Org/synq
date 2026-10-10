/**
 * Typed contracts for workflows that later phases implement. Nothing here is registered with a
 * worker: these are interfaces only, so no commerce, travel or x402 side effect exists yet.
 */
import type { ActionState, BoundActionIntent } from '@synq/schemas';
import type { Actor, ScheduledEvent } from './messages.js';

export type ProviderPaymentState =
  | 'QUOTED'
  | 'AUTHORIZED'
  | 'CAPTURED'
  | 'REFUNDED'
  | 'VOIDED'
  | 'FAILED';

export type CommercePurchaseInput = {
  intent: BoundActionIntent;
  merchantRef: string;
  amount: string;
  currency: string;
  idempotencyKey: string;
  requestedBy: Actor;
  correlationId: string;
};
export type CommercePurchaseState = {
  actionState: ActionState;
  paymentState: ProviderPaymentState | null;
  providerPaymentId: string | null;
  nextEvent: ScheduledEvent;
};
export type CommercePurchaseResult = CommercePurchaseState & {
  outcome: 'CAPTURED' | 'REFUNDED' | 'CANCELLED' | 'REJECTED';
};
export type CommercePurchaseWorkflowContract = (
  input: CommercePurchaseInput,
) => Promise<CommercePurchaseResult>;

export type TravelSegment = {
  kind: 'FLIGHT' | 'LODGING' | 'GROUND';
  providerOfferId: string;
  amount: string;
  currency: string;
  holdExpiresAt: number;
};
export type TravelBookingInput = {
  intent: BoundActionIntent;
  segments: TravelSegment[];
  travelers: string[];
  idempotencyKey: string;
  requestedBy: Actor;
  correlationId: string;
};
export type TravelBookingState = {
  actionState: ActionState;
  held: string[];
  booked: string[];
  compensated: string[];
  nextEvent: ScheduledEvent;
};
export type TravelBookingResult = TravelBookingState & {
  outcome: 'BOOKED' | 'PARTIALLY_COMPENSATED' | 'CANCELLED' | 'REJECTED';
};
export type TravelBookingWorkflowContract = (
  input: TravelBookingInput,
) => Promise<TravelBookingResult>;

export type X402PaymentInput = {
  intent: BoundActionIntent;
  resourceUrl: string;
  maxAmount: string;
  asset: string;
  paymentRequirementsHash: `0x${string}`;
  idempotencyKey: string;
  requestedBy: Actor;
  correlationId: string;
};
export type X402PaymentState = {
  actionState: ActionState;
  paymentState: ProviderPaymentState | null;
  settlementTx: `0x${string}` | null;
  nextEvent: ScheduledEvent;
};
export type X402PaymentResult = X402PaymentState & {
  outcome: 'PAID' | 'REFUSED' | 'CANCELLED';
  receiptHash: `0x${string}` | null;
};
export type X402WorkflowContract = (
  input: X402PaymentInput,
) => Promise<X402PaymentResult>;

export const INTERFACE_ONLY_WORKFLOWS = [
  'CommerceWorkflow',
  'TravelBookingWorkflow',
  'X402Workflow',
] as const;
