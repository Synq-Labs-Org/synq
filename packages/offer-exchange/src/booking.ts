export const BOOKING_STATES = [
  'DISCOVERED',
  'QUOTED',
  'REVALIDATED',
  'RESERVED',
  'APPROVED',
  'BOOKING_PENDING',
  'CONFIRMED',
  'RECONCILED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELED',
  'REFUND_PENDING',
  'REFUNDED',
  'UNKNOWN_PROVIDER_OUTCOME',
] as const;
export type BookingState = (typeof BOOKING_STATES)[number];

export const BOOKING_TRANSITIONS: Readonly<
  Record<BookingState, readonly BookingState[]>
> = {
  DISCOVERED: ['QUOTED', 'FAILED'],
  QUOTED: ['REVALIDATED', 'FAILED'],
  REVALIDATED: ['RESERVED', 'QUOTED', 'FAILED'],
  RESERVED: ['APPROVED', 'FAILED'],
  APPROVED: ['BOOKING_PENDING', 'FAILED'],
  BOOKING_PENDING: ['CONFIRMED', 'FAILED', 'UNKNOWN_PROVIDER_OUTCOME'],
  UNKNOWN_PROVIDER_OUTCOME: ['CONFIRMED', 'FAILED', 'UNKNOWN_PROVIDER_OUTCOME'],
  CONFIRMED: ['RECONCILED', 'CANCEL_REQUESTED'],
  RECONCILED: ['CANCEL_REQUESTED'],
  CANCEL_REQUESTED: ['CANCELED', 'REFUND_PENDING', 'CONFIRMED'],
  CANCELED: ['REFUND_PENDING', 'REFUNDED'],
  REFUND_PENDING: ['REFUNDED', 'REFUND_PENDING'],
  REFUNDED: [],
  FAILED: [],
};

export const TERMINAL_BOOKING_STATES: readonly BookingState[] = [
  'REFUNDED',
  'FAILED',
];

export class BookingTransitionError extends Error {
  constructor(from: BookingState, to: BookingState) {
    super(`BOOKING_TRANSITION_FORBIDDEN: ${from} -> ${to}`);
    this.name = 'BookingTransitionError';
  }
}

export type BookingEvent = {
  from: BookingState;
  to: BookingState;
  at: number;
  note: string;
};

export function advanceBooking(
  history: readonly BookingEvent[],
  current: BookingState,
  to: BookingState,
  at: number,
  note = '',
): { state: BookingState; history: BookingEvent[] } {
  if (!BOOKING_TRANSITIONS[current].includes(to))
    throw new BookingTransitionError(current, to);
  return {
    state: to,
    history: [...history, { from: current, to, at, note: note.slice(0, 200) }],
  };
}

/** Releasing a reservation is only safe once the provider outcome is known not to have charged. */
export function reservationReleasable(state: BookingState): boolean {
  return state === 'FAILED' || state === 'REFUNDED';
}
