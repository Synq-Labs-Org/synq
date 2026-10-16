import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FundAssistant } from '../../apps/demo/src/fund-assistant.js';
import { registerFundRoutes } from '../../apps/demo/src/fund-routes.js';
import {
  MemoryTripStore,
  TripService,
  type TripPorts,
} from '../../apps/demo/src/fund-trips.js';
import { duffelTripPorts } from '../../apps/demo/src/duffel-trips.js';
import { InteractiveCardSchema } from '@synq/schemas';
import { duffelOffer } from '../duffel/offer-fixture.js';
import type {
  FundService,
  FundView,
} from '../../apps/demo/src/fund-service.js';

const FUND_ID = 'fnd_00000000000000000001';
const KEY = 'k'.repeat(32);
/** 2026-10-16T00:00:00Z */
const NOW = 1_792_137_600;

const fundView = {
  fundId: FUND_ID,
  name: 'Goa',
  state: 'ACTIVE',
  members: [{ name: 'Ana' }, { name: 'Ben' }],
  threshold: 2,
  treasury: { balance: '250', symbol: 'AUSD' },
  maxPayment: '500',
  recipients: [],
  proposals: [],
  canRequestTestFunds: true,
} as unknown as FundView;

function server() {
  const searches: Parameters<TripPorts['search']>[0][] = [];
  const ports: TripPorts = {
    now: () => NOW,
    fund: async (_id, key) => {
      if (key !== KEY) throw new Error('forbidden');
      return fundView;
    },
    search: async (input) => {
      searches.push(input);
      return [
        {
          optionId: 'aaaaaaaaaaaa',
          title: 'Duffel Airways ZZ 1 / ZZ 2',
          detail:
            'DEL → GOI 2026-12-01 · GOI → DEL 2026-12-05 · nonstop · economy',
          total: '300',
          currency: 'USD',
          refundable: true,
          offer: {},
        },
      ];
    },
    book: async () => ({ status: 'FAILED', reason: 'not in this test' }),
    settlement: { address: '0x0', recipientId: 'contact:0x0', label: 'S' },
    sends: async () => [],
    log: () => undefined,
  };
  const app = Fastify();
  const funds = {
    view: async () => fundView,
    ports: { now: () => NOW },
  } as unknown as FundService;
  registerFundRoutes(app, funds, {
    legacyWrites: true,
    assistant: new FundAssistant({
      complete: null,
      today: () => '2026-10-16',
      timeZone: 'Asia/Kolkata',
      maxPaymentAmount: 500,
    }),
    trips: new TripService(new MemoryTripStore(), ports),
  });
  return { app, searches };
}

describe('POST /v1/funds/:id/ask', () => {
  it('returns an auto-run flight search for a plain instruction', async () => {
    const { app } = server();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND_ID}/ask`,
      payload: {
        key: KEY,
        text: 'book a flight from Delhi to Goa on Dec 1 to Dec 5 for 3 people',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      reply: 'Searching Delhi (DEL) → Goa (GOI), Dec 1–5, 3 travellers…',
      action: {
        kind: 'FLIGHT_SEARCH',
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-12-01',
        returnDate: '2026-12-05',
        travelers: 3,
        originLabel: 'Delhi',
        destinationLabel: 'Goa',
        cabin: null,
        autoRun: true,
      },
    });
  });

  it('returns a clarifying question with no action when details are missing', async () => {
    const { app } = server();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND_ID}/ask`,
      payload: { key: KEY, text: 'flights from delhi to goa' },
    });
    expect(res.json()).toEqual({
      reply: 'What date do you want to fly DEL → GOI?',
      action: null,
    });
  });

  it('returns an auto-run gift search', async () => {
    const { app } = server();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND_ID}/ask`,
      payload: { key: KEY, text: 'find a gift for a coffee lover under $40' },
    });
    expect(res.json().action).toEqual({
      kind: 'GIFT_SEARCH',
      query: 'gift for coffee lover',
      maxPrice: '40',
      autoRun: true,
    });
  });
});

describe('POST /v1/funds/:id/trips', () => {
  const trip = (extra: Record<string, unknown>) => ({
    method: 'POST' as const,
    url: `/v1/funds/${FUND_ID}/trips`,
    payload: {
      key: KEY,
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      travelers: 3,
      ...extra,
    },
  });

  it('starts a return trip and passes both dates to the search', async () => {
    const { app, searches } = server();
    const res = await app.inject(
      trip({ returnDate: '2026-12-05', cabin: 'business' }),
    );
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      kind: 'FLIGHT',
      title: 'DEL → GOI · 2026-12-01, back 2026-12-05',
      departureDate: '2026-12-01',
      returnDate: '2026-12-05',
      cabin: 'business',
      state: 'VOTING',
    });
    expect(body.options[0].detail).toContain('GOI → DEL 2026-12-05');
    expect(searches).toEqual([
      {
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-12-01',
        returnDate: '2026-12-05',
        travelers: 3,
        cabin: 'business',
      },
    ]);
  });

  it('keeps one-way trips working without returnDate (and with null)', async () => {
    const { app, searches } = server();
    for (const extra of [{}, { returnDate: null }]) {
      const res = await app.inject(trip(extra));
      expect(res.statusCode).toBe(200);
      expect(res.json().returnDate).toBeNull();
      expect(res.json().title).toBe('DEL → GOI · 2026-12-01');
    }
    expect(searches.map((s) => [s.returnDate, s.cabin])).toEqual([
      [null, 'economy'],
      [null, 'economy'],
    ]);
  });

  it('rejects a return date that is not after the departure', async () => {
    const { app, searches } = server();
    for (const returnDate of [
      '2026-12-01',
      '2026-11-30',
      '2026-12-32',
      '05/12/2026',
      '2028-01-01',
    ]) {
      const res = await app.inject(trip({ returnDate }));
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('INVALID_REQUEST');
    }
    const cabin = await app.inject(trip({ cabin: 'luxury' }));
    expect(cabin.statusCode).toBe(400);
    expect(searches).toHaveLength(0);
  });
});

describe('Duffel return-trip search (mocked HTTP)', () => {
  afterEach(() => vi.unstubAllGlobals());

  const segment = (from: string, to: string, day: string, flight: string) => ({
    origin: { iata_code: from },
    destination: { iata_code: to },
    departing_at: `${day}T08:00:00`,
    arriving_at: `${day}T10:30:00`,
    marketing_carrier: { iata_code: 'ZZ' },
    marketing_carrier_flight_number: flight,
    passengers: [{ cabin_class: 'economy', baggages: [] }],
  });
  const slice = (from: string, to: string, day: string, flight: string) => ({
    origin: { iata_code: from },
    destination: { iata_code: to },
    segments: [segment(from, to, day, flight)],
  });

  it('sends one offer request with two slices and shows both legs', async () => {
    const requests: { url: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        requests.push({
          url,
          body: init.body ? JSON.parse(init.body) : null,
        });
        return new Response(
          JSON.stringify({
            data: {
              id: 'orq_test',
              offers: [
                {
                  id: 'off_return',
                  total_amount: '412.40',
                  total_currency: 'USD',
                  tax_amount: '40.00',
                  tax_currency: 'USD',
                  expires_at: '2026-10-17T00:00:00Z',
                  conditions: {
                    refund_before_departure: { allowed: false },
                    change_before_departure: { allowed: false },
                  },
                  slices: [
                    slice('DEL', 'GOI', '2026-12-01', '101'),
                    slice('GOI', 'DEL', '2026-12-05', '202'),
                  ],
                },
                {
                  // Not Duffel Airways: never shown in test mode.
                  id: 'off_other',
                  total_amount: '100.00',
                  total_currency: 'USD',
                  expires_at: '2026-10-17T00:00:00Z',
                  conditions: {},
                  slices: [
                    {
                      ...slice('DEL', 'GOI', '2026-12-01', '9'),
                      segments: [
                        {
                          ...segment('DEL', 'GOI', '2026-12-01', '9'),
                          marketing_carrier: { iata_code: 'AI' },
                        },
                      ],
                    },
                    slice('GOI', 'DEL', '2026-12-05', '8'),
                  ],
                },
              ],
            },
          }),
          { status: 201, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const ports = duffelTripPorts('duffel_test_fixture', () => NOW);
    const options = await ports.search({
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      returnDate: '2026-12-05',
      travelers: 2,
      cabin: 'economy',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(
      'https://api.duffel.com/air/offer_requests?return_offers=true',
    );
    expect(requests[0]!.body).toEqual({
      data: {
        slices: [
          { origin: 'DEL', destination: 'GOI', departure_date: '2026-12-01' },
          { origin: 'GOI', destination: 'DEL', departure_date: '2026-12-05' },
        ],
        passengers: [{ type: 'adult' }, { type: 'adult' }],
        cabin_class: 'economy',
        max_connections: 1,
      },
    });
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      title: 'Duffel Airways ZZ 101 / ZZ 202',
      detail: 'DEL → GOI 2026-12-01 · GOI → DEL 2026-12-05 · nonstop · economy',
      total: '412.40',
      currency: 'USD',
      refundable: false,
    });
  });
});

describe('GET /v1/funds/:id/trips/:tripId/card', () => {
  it('returns the flight trip as a FLIGHT_COMPARISON card in provider-sandbox mode', async () => {
    const ports: TripPorts = {
      now: () => NOW,
      fund: async (_id, key) => {
        if (key !== KEY) throw new Error('forbidden');
        return fundView;
      },
      search: async () => [
        {
          optionId: 'aaaaaaaaaaaa',
          title: 'Duffel Airways ZZ 123 / ZZ 456',
          detail:
            'DEL → GOI 2026-12-01 · GOI → DEL 2026-12-05 · nonstop · economy',
          total: '254.30',
          currency: 'USD',
          refundable: false,
          offer: { intent: {}, offer: duffelOffer('a', 24430, {}, NOW) },
        },
      ],
      book: async () => ({ status: 'FAILED', reason: 'not in this test' }),
      settlement: { address: '0x0', recipientId: 'contact:0x0', label: 'S' },
      sends: async () => [],
      log: () => undefined,
    };
    const app = Fastify();
    registerFundRoutes(
      app,
      {
        view: async () => fundView,
        ports: { now: () => NOW },
      } as unknown as FundService,
      {
        legacyWrites: true,
        trips: new TripService(new MemoryTripStore(), ports),
        webBaseUrl: 'https://synq.example',
      },
    );
    const start = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND_ID}/trips`,
      payload: {
        key: KEY,
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-12-01',
        returnDate: '2026-12-05',
        travelers: 3,
      },
    });
    const tripId = start.json().tripId as string;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/funds/${FUND_ID}/trips/${tripId}/card?k=${KEY}`,
    });
    expect(res.statusCode).toBe(200);
    const card = InteractiveCardSchema.parse(res.json().card);
    expect(card).toMatchObject({
      type: 'FLIGHT_COMPARISON',
      groupLabel: 'Goa',
      executionMode: 'PROVIDER_SANDBOX',
      chainId: null,
      origin: 'DEL',
      returnDate: '2026-12-05',
      options: [
        { price: { amount: '254.30', symbol: 'USD' }, refundable: false },
      ],
    });
    expect(card.actions[0]!.url).toBe(
      `https://synq.example/fund/${FUND_ID}/trips/${tripId}`,
    );
    const denied = await app.inject({
      method: 'GET',
      url: `/v1/funds/${FUND_ID}/trips/${tripId}/card?k=${'x'.repeat(32)}`,
    });
    expect(denied.statusCode).not.toBe(200);
  });
});

describe('G3 legacy Monad fund creation and writes', () => {
  it('refuses new legacy funds even when existing-fund writes are enabled', async () => {
    const app = Fastify();
    const create = vi.fn();
    registerFundRoutes(app, { create } as unknown as FundService, {
      legacyWrites: true,
    });
    const result = await app.inject({
      method: 'POST',
      url: '/v1/funds',
      payload: { name: 'New group' },
    });
    expect(result.statusCode).toBe(410);
    expect(result.json().error).toBe('ARC_WORKSPACE_REQUIRED');
    expect(create).not.toHaveBeenCalled();
    await app.close();
  });
  it('defaults legacy mutations to read-only before any service call', async () => {
    const join = vi.fn(),
      view = vi.fn(async () => fundView);
    const app = Fastify();
    registerFundRoutes(app, { join, view } as unknown as FundService);
    const result = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND_ID}/members`,
      payload: {},
    });
    expect(result.statusCode).toBe(410);
    expect(join).not.toHaveBeenCalled();
    expect((await app.inject(`/v1/funds/${FUND_ID}?k=${KEY}`)).statusCode).toBe(
      200,
    );
    await app.close();
  });
});
