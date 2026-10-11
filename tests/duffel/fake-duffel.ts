import type { HttpFetch } from '@synq/plugin-duffel';

type Json = Record<string, unknown>;
export type Fault =
  | { kind: 'TIMEOUT_AFTER_COMMIT' }
  | { kind: 'HTTP_500_AFTER_COMMIT' }
  | { kind: 'HTTP_500_BEFORE_COMMIT' }
  | { kind: 'RATE_UNAVAILABLE' }
  | { kind: 'PRICE_UP'; amount: string };

/**
 * In-memory Duffel test-mode double shaped from the public v2 API reference
 * (stays search/rates/quotes/bookings, air offer_requests/offers/orders/
 * order_cancellations). MOCKED evidence only; not a recording.
 */
export class FakeDuffel {
  readonly calls: { method: string; path: string; body: Json | null }[] = [];
  readonly bookings = new Map<string, Json>();
  readonly orders = new Map<string, Json>();
  readonly faults = new Map<string, Fault>();
  private seq = 0;
  quotePrice = '240.00';
  offerPrice = '312.40';
  constructor(readonly now: () => number = () => 1_780_000_000) {}

  private id(prefix: string) {
    return `${prefix}_${String(++this.seq).padStart(4, '0')}`;
  }

  accommodation(total = '240.00'): Json {
    return {
      id: 'acc_0000AWr2VsUNIF1Vl91xg0',
      name: 'Duffel Test Hotel',
      location: {
        geographic_coordinates: { latitude: -24.38, longitude: -128.32 },
      },
      rooms: [
        {
          name: 'Successful Booking with Balance',
          beds: [{ type: 'double', count: 1 }],
          rates: [
            {
              id: 'rat_0000AWr2VsUNIF1Vl91xg1',
              total_amount: total,
              total_currency: 'GBP',
              tax_amount: '40.00',
              fee_amount: '0.00',
              board_type: 'breakfast',
              payment_type: 'pay_now',
              available_payment_methods: ['balance'],
              cancellation_timeline: [
                {
                  refund_amount: total,
                  currency: 'GBP',
                  before: new Date(
                    (this.now() + 7 * 86_400) * 1000,
                  ).toISOString(),
                },
              ],
            },
            {
              id: 'rat_0000AWr2VsUNIF1Vl91xg2',
              total_amount: '180.00',
              total_currency: 'GBP',
              tax_amount: '30.00',
              fee_amount: '0.00',
              board_type: 'room_only',
              available_payment_methods: ['balance'],
              cancellation_timeline: [],
            },
          ],
        },
        {
          name: 'Rate Unavailable at Booking',
          beds: [{ type: 'double', count: 1 }],
          rates: [
            {
              id: 'rat_0000UNAVAILABLE',
              total_amount: '150.00',
              total_currency: 'GBP',
              tax_amount: '20.00',
              board_type: 'breakfast',
              available_payment_methods: ['balance'],
              cancellation_timeline: [
                {
                  refund_amount: '150.00',
                  currency: 'GBP',
                  before: new Date(
                    (this.now() + 7 * 86_400) * 1000,
                  ).toISOString(),
                },
              ],
            },
          ],
        },
      ],
    };
  }

  offer(id = 'off_0000ZZtest', total = this.offerPrice): Json {
    return {
      id,
      total_amount: total,
      total_currency: 'GBP',
      tax_amount: '52.40',
      tax_currency: 'GBP',
      expires_at: new Date((this.now() + 1_200) * 1000).toISOString(),
      owner: { iata_code: 'ZZ', name: 'Duffel Airways' },
      passengers: [{ id: 'pas_0000test1', type: 'adult' }],
      conditions: {
        refund_before_departure: {
          allowed: true,
          penalty_amount: '25.00',
          penalty_currency: 'GBP',
        },
        change_before_departure: {
          allowed: true,
          penalty_amount: '0.00',
          penalty_currency: 'GBP',
        },
      },
      slices: [
        {
          origin: { iata_code: 'LHR' },
          destination: { iata_code: 'JFK' },
          fare_brand_name: 'Basic',
          segments: [
            {
              departing_at: '2026-12-01T09:00:00',
              marketing_carrier: { iata_code: 'ZZ' },
              marketing_carrier_flight_number: '0101',
              origin: { iata_code: 'LHR' },
              destination: { iata_code: 'JFK' },
              passengers: [
                {
                  cabin_class: 'economy',
                  baggages: [{ type: 'checked', quantity: 1 }],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private fault(op: string) {
    const f = this.faults.get(op);
    if (f) this.faults.delete(op);
    return f;
  }

  readonly fetch: HttpFetch = async (url, init) => {
    const path = url.replace('https://api.duffel.com', '');
    const body = init.body
      ? ((JSON.parse(init.body) as Json).data as Json)
      : null;
    this.calls.push({ method: init.method, path, body });
    if (init.headers['Duffel-Version'] !== 'v2')
      return this.reply(400, { errors: [{ code: 'unsupported_version' }] });
    const [p, query = ''] = path.split('?');
    const ok = (data: unknown, meta?: Json) =>
      this.reply(200, { data, ...(meta ? { meta } : {}) });
    if (init.method === 'POST' && p === '/stays/search')
      return ok({
        results: [
          {
            id: 'srr_0000test',
            accommodation: {
              id: 'acc_0000AWr2VsUNIF1Vl91xg0',
              name: 'Duffel Test Hotel',
            },
          },
        ],
      });
    if (init.method === 'POST' && p!.startsWith('/stays/search_results/'))
      return ok({ id: 'srr_0000test', accommodation: this.accommodation() });
    if (init.method === 'POST' && p === '/stays/quotes') {
      const rateId = String(body?.rate_id);
      if (rateId === 'rat_0000UNAVAILABLE')
        return this.reply(422, {
          errors: [{ code: 'rate_unavailable', type: 'validation_error' }],
        });
      const f = this.fault('quote');
      const total = f?.kind === 'PRICE_UP' ? f.amount : this.quotePrice;
      const acc = this.accommodation(total);
      const rooms = (acc.rooms as Json[])
        .map((r) => ({
          ...r,
          rates: (r.rates as Json[]).filter((x) => x.id === rateId),
        }))
        .filter((r) => (r.rates as Json[]).length);
      return ok({
        id: this.id('quo'),
        total_amount: total,
        total_currency: 'GBP',
        tax_amount: '40.00',
        fee_amount: '0.00',
        accommodation: { ...acc, rooms },
      });
    }
    if (init.method === 'POST' && p === '/stays/bookings') {
      const f = this.fault('book');
      if (f?.kind === 'HTTP_500_BEFORE_COMMIT')
        return this.reply(500, { errors: [{ code: 'internal_server_error' }] });
      if (f?.kind === 'RATE_UNAVAILABLE')
        return this.reply(422, { errors: [{ code: 'rate_unavailable' }] });
      const booking: Json = {
        id: this.id('bok'),
        reference: `SYNQ${this.seq}`,
        status: 'confirmed',
        metadata: body?.metadata ?? null,
        accommodation: {
          ...this.accommodation(this.quotePrice),
          rooms: [
            {
              rates: [{ total_amount: this.quotePrice, total_currency: 'GBP' }],
            },
          ],
        },
        guests: body?.guests,
      };
      this.bookings.set(String(booking.id), booking);
      if (f?.kind === 'TIMEOUT_AFTER_COMMIT') throw new Error('socket hang up');
      if (f?.kind === 'HTTP_500_AFTER_COMMIT')
        return this.reply(500, { errors: [{ code: 'internal_server_error' }] });
      return ok(booking);
    }
    if (init.method === 'GET' && p === '/stays/bookings')
      return ok([...this.bookings.values()], {});
    if (p!.startsWith('/stays/bookings/')) {
      const id = p!.split('/')[3]!;
      const b = this.bookings.get(id);
      if (!b) return this.reply(404, { errors: [{ code: 'not_found' }] });
      if (init.method === 'POST' && p!.endsWith('/actions/cancel')) {
        b.status = 'cancelled';
        return ok(b);
      }
      return ok(b);
    }
    if (
      init.method === 'POST' &&
      p === '/air/offer_requests' &&
      query.includes('return_offers=true')
    )
      return ok({
        id: 'orq_0000test',
        offers: [this.offer(), this.offer('off_0000ZZnobag', '250.00')].map(
          (o, i) =>
            i === 1
              ? {
                  ...o,
                  slices: [
                    {
                      ...(o.slices as Json[])[0],
                      segments: [
                        {
                          ...((o.slices as Json[])[0]!.segments as Json[])[0],
                          passengers: [
                            { cabin_class: 'economy', baggages: [] },
                          ],
                        },
                      ],
                    },
                  ],
                }
              : o,
        ),
      });
    if (init.method === 'GET' && p!.startsWith('/air/offers/')) {
      const f = this.fault('offer');
      return ok(
        this.offer(
          p!.split('/')[3],
          f?.kind === 'PRICE_UP' ? f.amount : this.offerPrice,
        ),
      );
    }
    if (init.method === 'POST' && p === '/air/orders') {
      const f = this.fault('order');
      if (f?.kind === 'HTTP_500_BEFORE_COMMIT')
        return this.reply(500, { errors: [{ code: 'internal_server_error' }] });
      const order: Json = {
        id: this.id('ord'),
        booking_reference: `ZZ${this.seq}`,
        total_amount: (body?.payments as Json[])[0]!.amount,
        total_currency: 'GBP',
        cancelled_at: null,
        metadata: body?.metadata ?? null,
      };
      this.orders.set(String(order.id), order);
      if (f?.kind === 'TIMEOUT_AFTER_COMMIT') throw new Error('ETIMEDOUT');
      return ok(order);
    }
    if (init.method === 'GET' && p === '/air/orders')
      return ok([...this.orders.values()], {});
    if (init.method === 'GET' && p!.startsWith('/air/orders/')) {
      const o = this.orders.get(p!.split('/')[3]!);
      return o ? ok(o) : this.reply(404, { errors: [{ code: 'not_found' }] });
    }
    if (init.method === 'POST' && p === '/air/order_cancellations')
      return ok({
        id: 'ore_0000test',
        order_id: body?.order_id,
        refund_amount: '287.40',
        refund_currency: 'GBP',
        refund_to: 'balance',
        confirmed_at: null,
      });
    if (init.method === 'POST' && p!.startsWith('/air/order_cancellations/')) {
      for (const o of this.orders.values())
        o.cancelled_at = new Date(this.now() * 1000).toISOString();
      return ok({
        id: 'ore_0000test',
        refund_amount: '287.40',
        refund_currency: 'GBP',
        refund_to: 'balance',
        confirmed_at: new Date(this.now() * 1000).toISOString(),
      });
    }
    return this.reply(404, {
      errors: [{ code: 'not_found', message: `${init.method} ${p}` }],
    });
  };

  private reply(status: number, body: Json) {
    return {
      status,
      headers: {
        get: (n: string) => (n === 'x-request-id' ? `req_${this.seq}` : null),
      },
      text: async () => JSON.stringify(body),
    };
  }
}
