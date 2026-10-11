import type { Money } from './money.js';
import type { EconomicOffer } from './schemas.js';

/** Minimum traveler/recipient fields, resolved only inside the execution worker. */
export type TravelerPii = {
  givenName: string;
  familyName: string;
  bornOn: string;
  email: string;
  phone: string;
  title?: 'mr' | 'ms' | 'mrs' | 'miss' | 'dr';
  gender?: 'm' | 'f';
};

export type ProviderBookingOutcome =
  | {
      status: 'CONFIRMED' | 'CANCELED';
      providerRef: string;
      reference: string | null;
      charged: Money | null;
    }
  | { status: 'FAILED'; reason: string }
  | { status: 'UNKNOWN'; reason: string };

export interface ProviderBookingPort {
  readonly providerId: string;
  readonly host: string;
  book(input: {
    offer: EconomicOffer;
    travelers: TravelerPii[];
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome>;
  find(input: {
    offer: EconomicOffer;
    idempotencyKey: string;
  }): Promise<ProviderBookingOutcome | null>;
  cancel(input: { offer: EconomicOffer; providerRef: string }): Promise<{
    confirmed: boolean;
    refund: Money | null;
    reason: string | null;
  }>;
}
