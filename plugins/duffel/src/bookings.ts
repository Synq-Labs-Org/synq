import { providerMoney, type Money } from '@synq/offer-exchange';
import { DuffelClient, DuffelError } from './client.js';

type Json = Record<string, unknown>;
const obj = (v: unknown): Json =>
  v && typeof v === 'object' ? (v as Json) : {};
const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
const str = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : undefined;

export const IDEMPOTENCY_METADATA_KEY = 'synq_idempotency_key';

/** Minimum traveler fields, resolved by the execution worker from ProfileVault. */
export type TravelerPii = {
  givenName: string;
  familyName: string;
  bornOn: string;
  email: string;
  phone: string;
  title?: 'mr' | 'ms' | 'mrs' | 'miss' | 'dr';
  gender?: 'm' | 'f';
};

export type BookingOutcome =
  | {
      status: 'CONFIRMED';
      providerRef: string;
      reference: string | null;
      charged: Money | null;
      providerStatus: string;
    }
  | {
      status: 'CANCELED';
      providerRef: string;
      reference: string | null;
      charged: Money | null;
      providerStatus: string;
    }
  | { status: 'FAILED'; code: string; requestId: string | null }
  | { status: 'UNKNOWN'; detail: string; requestId: string | null };

export type CancellationOutcome = {
  cancellationId: string | null;
  confirmed: boolean;
  refund: Money | null;
  refundTo: string | null;
};

function failure(error: unknown): BookingOutcome {
  if (error instanceof DuffelError) {
    if (error.kind === 'AMBIGUOUS')
      return {
        status: 'UNKNOWN',
        detail: error.message,
        requestId: error.requestId,
      };
    return {
      status: 'FAILED',
      code: `${error.status ?? 0}:${error.code}`,
      requestId: error.requestId,
    };
  }
  return {
    status: 'UNKNOWN',
    detail: error instanceof Error ? error.message : String(error),
    requestId: null,
  };
}

function stayCharged(booking: Json): Money | null {
  const rate = arr(obj(arr(obj(booking.accommodation).rooms)[0]).rates)[0];
  if (!rate || rate.total_amount == null) return null;
  return providerMoney(
    String(rate.total_amount),
    str(rate.total_currency) ?? 'USD',
  );
}

function stayOutcome(b: Json): BookingOutcome {
  const status = str(b.status) ?? 'unknown';
  const common = {
    providerRef: String(b.id),
    reference: str(b.reference) ?? null,
    charged: stayCharged(b),
    providerStatus: status,
  };
  return status === 'cancelled'
    ? { status: 'CANCELED', ...common }
    : { status: 'CONFIRMED', ...common };
}

function orderOutcome(o: Json): BookingOutcome {
  const common = {
    providerRef: String(o.id),
    reference: str(o.booking_reference) ?? null,
    charged:
      o.total_amount != null
        ? providerMoney(String(o.total_amount), str(o.total_currency) ?? 'USD')
        : null,
    providerStatus: o.cancelled_at ? 'cancelled' : 'confirmed',
  };
  return o.cancelled_at
    ? { status: 'CANCELED', ...common }
    : { status: 'CONFIRMED', ...common };
}

/**
 * Reconcile-first Duffel executor. A create that times out or fails with 5xx
 * returns UNKNOWN; the caller must reconcile by idempotency key and never
 * re-submit blindly (Duffel: do not retry a booking whose status is unknown).
 */
export class DuffelBookingExecutor {
  constructor(
    private readonly client: DuffelClient,
    private readonly maxPages = 5,
  ) {}

  private async findByKey(path: string, key: string): Promise<Json | null> {
    let after: string | undefined;
    for (let page = 0; page < this.maxPages; page++) {
      const r = await this.client.request<Json[]>(
        'GET',
        `${path}?limit=200${after ? `&after=${encodeURIComponent(after)}` : ''}`,
      );
      const hit = (r.data ?? []).find(
        (x) => obj(x.metadata)[IDEMPOTENCY_METADATA_KEY] === key,
      );
      if (hit) return hit;
      after = str(obj(r.meta).after);
      if (!after) return null;
    }
    throw new DuffelError(
      'AMBIGUOUS',
      null,
      'RECONCILE_PAGE_LIMIT',
      null,
      'reconciliation window exhausted',
    );
  }

  async findStayBooking(key: string): Promise<BookingOutcome | null> {
    const b = await this.findByKey('/stays/bookings', key);
    return b ? stayOutcome(b) : null;
  }

  async findFlightOrder(key: string): Promise<BookingOutcome | null> {
    const o = await this.findByKey('/air/orders', key);
    return o ? orderOutcome(o) : null;
  }

  async bookStay(input: {
    quoteId: string;
    guests: TravelerPii[];
    idempotencyKey: string;
  }): Promise<BookingOutcome> {
    const lead = input.guests[0];
    if (!lead) return { status: 'FAILED', code: 'NO_GUESTS', requestId: null };
    const existing = await this.findStayBooking(input.idempotencyKey);
    if (existing) return existing;
    try {
      const r = await this.client.request<Json>('POST', '/stays/bookings', {
        quote_id: input.quoteId,
        email: lead.email,
        phone_number: lead.phone,
        guests: input.guests.map((g) => ({
          given_name: g.givenName,
          family_name: g.familyName,
          born_on: g.bornOn,
        })),
        metadata: { [IDEMPOTENCY_METADATA_KEY]: input.idempotencyKey },
      });
      return stayOutcome(r.data);
    } catch (error) {
      return failure(error);
    }
  }

  async bookFlight(input: {
    offerId: string;
    passengerIds: string[];
    passengers: TravelerPii[];
    amount: Money;
    amountDecimal: string;
    idempotencyKey: string;
  }): Promise<BookingOutcome> {
    if (
      input.passengers.length !== input.passengerIds.length ||
      !input.passengers.length
    )
      return { status: 'FAILED', code: 'PASSENGER_MISMATCH', requestId: null };
    const existing = await this.findFlightOrder(input.idempotencyKey);
    if (existing) return existing;
    try {
      const r = await this.client.request<Json>('POST', '/air/orders', {
        type: 'instant',
        selected_offers: [input.offerId],
        passengers: input.passengers.map((p, i) => ({
          id: input.passengerIds[i],
          given_name: p.givenName,
          family_name: p.familyName,
          born_on: p.bornOn,
          email: p.email,
          phone_number: p.phone,
          title: p.title ?? 'mr',
          gender: p.gender ?? 'm',
        })),
        payments: [
          {
            type: 'balance',
            currency: input.amount.currency,
            amount: input.amountDecimal,
          },
        ],
        metadata: { [IDEMPOTENCY_METADATA_KEY]: input.idempotencyKey },
      });
      return orderOutcome(r.data);
    } catch (error) {
      return failure(error);
    }
  }

  async getStayBooking(id: string): Promise<BookingOutcome> {
    const r = await this.client.request<Json>(
      'GET',
      `/stays/bookings/${encodeURIComponent(id)}`,
    );
    return stayOutcome(r.data);
  }

  async getOrder(id: string): Promise<BookingOutcome> {
    const r = await this.client.request<Json>(
      'GET',
      `/air/orders/${encodeURIComponent(id)}`,
    );
    return orderOutcome(r.data);
  }

  async cancelStay(id: string): Promise<CancellationOutcome> {
    const r = await this.client.request<Json>(
      'POST',
      `/stays/bookings/${encodeURIComponent(id)}/actions/cancel`,
    );
    return {
      cancellationId: null,
      confirmed: str(r.data.status) === 'cancelled',
      refund: null,
      refundTo: null,
    };
  }

  /** Quotes the cancellation first so the penalty/refund can be shown before confirming. */
  async quoteFlightCancellation(orderId: string): Promise<CancellationOutcome> {
    const r = await this.client.request<Json>(
      'POST',
      '/air/order_cancellations',
      { order_id: orderId },
    );
    return {
      cancellationId: String(r.data.id),
      confirmed: r.data.confirmed_at != null,
      refund:
        r.data.refund_amount != null
          ? providerMoney(
              String(r.data.refund_amount),
              str(r.data.refund_currency) ?? 'USD',
            )
          : null,
      refundTo: str(r.data.refund_to) ?? null,
    };
  }

  async confirmFlightCancellation(
    cancellationId: string,
  ): Promise<CancellationOutcome> {
    const r = await this.client.request<Json>(
      'POST',
      `/air/order_cancellations/${encodeURIComponent(cancellationId)}/actions/confirm`,
    );
    return {
      cancellationId: String(r.data.id),
      confirmed: r.data.confirmed_at != null,
      refund:
        r.data.refund_amount != null
          ? providerMoney(
              String(r.data.refund_amount),
              str(r.data.refund_currency) ?? 'USD',
            )
          : null,
      refundTo: str(r.data.refund_to) ?? null,
    };
  }
}
