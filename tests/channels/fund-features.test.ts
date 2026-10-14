import { describe, expect, it } from 'vitest';
import type { SendRecord } from '@synq/funding';
import { FundAssistant } from '../../apps/demo/src/fund-assistant.js';
import {
  MemoryTripStore,
  TripService,
  type TripOption,
  type TripPorts,
} from '../../apps/demo/src/fund-trips.js';
import type { FundView } from '../../apps/demo/src/fund-service.js';

const fund = (state = 'ACTIVE'): FundView =>
  ({
    fundId: 'fnd_00000000000000000001',
    name: 'Goa',
    state,
    members: [{ name: 'Ana' }, { name: 'Ben' }],
    threshold: 2,
    treasury: { balance: '250', symbol: 'AUSD' },
    maxPayment: '500',
    recipients: [
      { name: 'Ana', recipientId: 'member:member_0' },
      { name: 'Ben', recipientId: 'member:member_1' },
    ],
    proposals: [],
    canRequestTestFunds: true,
  }) as unknown as FundView;

const assistant = (output: unknown) =>
  new FundAssistant({
    complete: async () =>
      typeof output === 'string' ? output : JSON.stringify(output),
    today: () => '2026-10-14',
    maxPaymentAmount: 500,
  });

describe('Ask Synq', () => {
  it('turns a valid suggestion into a pre-filled send for a known member', async () => {
    const r = await assistant({
      reply: 'Sure, send Ben his share.',
      action: { kind: 'SEND', recipient: 'ben', amount: '12.5' },
    }).ask(fund(), 'pay ben 12.5 for dinner', 1);
    expect(r).toEqual({
      reply: 'Sure, send Ben his share.',
      action: {
        kind: 'SEND',
        recipientId: 'member:member_1',
        recipient: 'Ben',
        amount: '12.5',
      },
    });
  });

  it('drops suggestions that do not fit the fund but keeps the reply', async () => {
    const cases = [
      { kind: 'SEND', recipient: 'Mallory', amount: '1' },
      { kind: 'SEND', recipient: 'Ben', amount: '501' },
      { kind: 'SEND', recipient: 'Ben', amount: '1e3' },
      {
        kind: 'FLIGHT_SEARCH',
        origin: 'GOI',
        destination: 'GOI',
        departureDate: '2026-12-01',
        travelers: 2,
      },
      {
        kind: 'FLIGHT_SEARCH',
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-01-01',
        travelers: 2,
      },
      {
        kind: 'FLIGHT_SEARCH',
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-12-01',
        travelers: 9,
      },
    ];
    for (const action of cases) {
      const r = await assistant({ reply: 'ok', action }).ask(fund(), 'x', 1);
      expect(r).toEqual({ reply: 'ok', action: null });
    }
    // Sends are only suggested once the fund is live.
    const forming = await assistant({
      reply: 'ok',
      action: { kind: 'SEND', recipient: 'Ben', amount: '1' },
    }).ask(fund('FORMING'), 'x', 1);
    expect(forming.action).toBeNull();
  });

  it('normalises a flight search and survives malformed model output', async () => {
    const r = await assistant({
      reply: 'Here are flights.',
      action: {
        kind: 'FLIGHT_SEARCH',
        origin: 'del',
        destination: 'goi',
        departureDate: '2026-12-01',
        travelers: 3,
      },
    }).ask(fund(), 'flights to goa for 3 on dec 1', 1);
    expect(r.action).toEqual({
      kind: 'FLIGHT_SEARCH',
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      travelers: 3,
    });
    const bad = await assistant('not json').ask(fund(), 'hi', 1);
    expect(bad.action).toBeNull();
  });

  it('suggests a gift search within the fund limit and only when live', async () => {
    const ok = await assistant({
      reply: 'Let me look.',
      action: { kind: 'GIFT_SEARCH', query: ' car  gifts ', maxPrice: '50' },
    }).ask(fund(), 'find a gift related to cars', 1);
    expect(ok.action).toEqual({
      kind: 'GIFT_SEARCH',
      query: 'car gifts',
      maxPrice: '50',
    });
    for (const [state, maxPrice] of [
      ['ACTIVE', '900'],
      ['ACTIVE', 'fifty'],
      ['SETUP', '50'],
    ] as const) {
      const r = await assistant({
        reply: 'ok',
        action: { kind: 'GIFT_SEARCH', query: 'car gifts', maxPrice },
      }).ask(fund(state), 'x', 1);
      expect(r.action).toBeNull();
    }
  });

  it('rate-limits each fund', async () => {
    const a = assistant({ reply: 'ok', action: null });
    for (let i = 0; i < 20; i++) await a.ask(fund(), 'hi', 100);
    await expect(a.ask(fund(), 'hi', 100)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });
});

describe('group trips', () => {
  const SETTLEMENT = `0x${'0e'.repeat(20)}`;
  const option = (id: string, total: string): TripOption => ({
    optionId: id,
    title: `Duffel Airways ZZ ${id}`,
    detail: 'DEL → GOI · nonstop · economy',
    total,
    currency: 'USD',
    refundable: true,
    offer: { id },
  });
  function harness() {
    // 2026-09-22, before the December departures used below.
    let now = 1_790_000_000;
    const sends: SendRecord[] = [];
    const booked: string[] = [];
    let bookResult: Awaited<ReturnType<TripPorts['book']>> = {
      status: 'BOOKED',
      reference: 'ZZ1234',
      bookingId: 'ord_1',
    };
    const ports: TripPorts = {
      now: () => now,
      fund: async (_id, key) => {
        if (key !== 'k'.repeat(32)) throw new Error('forbidden');
        return fund();
      },
      search: async () => [
        option('aaaaaaaaaaaa', '138.84'),
        option('bbbbbbbbbbbb', '150'),
      ],
      book: async ({ option: o, maxTotal }) => {
        booked.push(`${o.optionId}<=${maxTotal}`);
        return bookResult;
      },
      settlement: {
        address: SETTLEMENT,
        recipientId: `contact:${SETTLEMENT}`,
        label: 'Synq Travel (test settlement)',
      },
      sends: async () => sends,
      log: () => undefined,
    };
    const service = new TripService(new MemoryTripStore(), ports);
    const pay = (state: SendRecord['state'], amount: string, at = now) =>
      sends.unshift({
        state,
        intentHash: `0x${'4'.repeat(64)}`,
        preview: {
          amountDecimal: amount,
          recipient: { address: SETTLEMENT },
        },
        history: [{ state: 'PREVIEWED', at }],
      } as unknown as SendRecord);
    return {
      service,
      pay,
      booked,
      advance: (s: number) => (now += s),
      failNextBooking: (reason: string) => {
        bookResult = { status: 'FAILED', reason };
      },
    };
  }
  const key = 'k'.repeat(32);
  const groupOf = async () => `0x${'9a'.repeat(32)}`;

  it('searches, votes, takes payment from the group and books once paid', async () => {
    const h = harness();
    const trip = await h.service.start('fnd_1', {
      key,
      origin: 'del',
      destination: 'goi',
      departureDate: '2026-12-01',
      travelers: 2,
    });
    expect(trip).toMatchObject({
      state: 'VOTING',
      origin: 'DEL',
      destination: 'GOI',
    });
    expect(JSON.stringify(trip)).not.toContain('"offer"');

    await h.service.vote('fnd_1', {
      key,
      tripId: trip.tripId,
      voterId: 'device-aaaa',
      optionId: 'bbbbbbbbbbbb',
    });
    let v = await h.service.vote('fnd_1', {
      key,
      tripId: trip.tripId,
      voterId: 'device-bbbb',
      optionId: 'bbbbbbbbbbbb',
    });
    expect(v).toMatchObject({
      voteCount: 2,
      leading: 'bbbbbbbbbbbb',
      myVote: 'bbbbbbbbbbbb',
    });

    v = await h.service.choose('fnd_1', {
      key,
      tripId: trip.tripId,
      optionId: 'bbbbbbbbbbbb',
    });
    expect(v).toMatchObject({
      state: 'AWAITING_PAYMENT',
      payment: { amount: '150' },
      payTo: { recipientId: `contact:${SETTLEMENT}` },
    });

    // A pending payment does not book; a different amount is not this trip.
    h.pay('PENDING_APPROVAL', '150');
    h.pay('INDEXED', '149.99');
    await h.service.tick(groupOf);
    expect(h.booked).toEqual([]);
    expect((await h.service.get('fnd_1', key, trip.tripId, null)).state).toBe(
      'AWAITING_PAYMENT',
    );

    h.pay('INDEXED', '150');
    await h.service.tick(groupOf);
    await h.service.tick(groupOf);
    expect(h.booked).toEqual(['bbbbbbbbbbbb<=150']);
    expect(await h.service.get('fnd_1', key, trip.tripId, null)).toMatchObject({
      state: 'BOOKED',
      booking: { reference: 'ZZ1234' },
    });
  });

  it('reopens voting when the group rejects the payment, and reports failed bookings', async () => {
    const h = harness();
    const trip = await h.service.start('fnd_1', {
      key,
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      travelers: 1,
    });
    await h.service.choose('fnd_1', {
      key,
      tripId: trip.tripId,
      optionId: 'aaaaaaaaaaaa',
    });
    h.pay('REJECTED', '138.84');
    await h.service.tick(groupOf);
    expect(await h.service.get('fnd_1', key, trip.tripId, null)).toMatchObject({
      state: 'VOTING',
      payment: null,
    });

    h.advance(120);
    await h.service.choose('fnd_1', {
      key,
      tripId: trip.tripId,
      optionId: 'aaaaaaaaaaaa',
    });
    h.pay('CONFIRMED', '138.84');
    h.failNextBooking(
      'The fare changed beyond what the group paid (MISMATCH).',
    );
    await h.service.tick(groupOf);
    await h.service.tick(groupOf);
    expect(await h.service.get('fnd_1', key, trip.tripId, null)).toMatchObject({
      state: 'FAILED',
      error: 'The fare changed beyond what the group paid (MISMATCH).',
    });
  });

  it('runs a gift pick: live options, vote, group payment, sandbox purchase', async () => {
    const h = harness();
    const bought: string[] = [];
    const gifts = {
      search: async () => [option('cccccccccccc', '26.99')],
      buy: async ({
        option: o,
        maxTotal,
      }: {
        option: TripOption;
        maxTotal: string;
      }) => {
        bought.push(`${o.optionId}<=${maxTotal}`);
        return {
          status: 'BOOKED' as const,
          reference: 'card ••1318',
          bookingId: 'tx_1',
        };
      },
    };
    const service = new TripService(h.service.store, {
      ...h.service.ports,
      gifts,
    });
    const gift = await service.startGift('fnd_1', {
      key,
      query: 'gifts for car lovers',
      maxPrice: '50',
    });
    expect(gift).toMatchObject({
      kind: 'GIFT',
      title: 'Gift: gifts for car lovers',
      state: 'VOTING',
    });
    expect(gift.label).toContain('sandbox virtual card');
    await service.choose('fnd_1', {
      key,
      tripId: gift.tripId,
      optionId: 'cccccccccccc',
    });
    h.pay('INDEXED', '26.99');
    await service.tick(groupOf);
    await service.tick(groupOf);
    expect(bought).toEqual(['cccccccccccc<=26.99']);
    expect(h.booked).toEqual([]);
    expect(await service.get('fnd_1', key, gift.tripId, null)).toMatchObject({
      state: 'BOOKED',
      booking: { reference: 'card ••1318' },
    });
    await expect(
      service.startGift('fnd_1', { key, query: 'x', maxPrice: '5000' }),
    ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      h.service.startGift('fnd_1', { key, query: 'x', maxPrice: '10' }),
    ).rejects.toMatchObject({ code: 'WRONG_STATE' });
  });

  it('validates trip requests and fund keys', async () => {
    const h = harness();
    const base = {
      key,
      origin: 'DEL',
      destination: 'GOI',
      departureDate: '2026-12-01',
      travelers: 2,
    };
    for (const bad of [
      { origin: 'DELHI' },
      { destination: 'DEL' },
      { departureDate: '2020-01-01' },
      { travelers: 5 },
    ])
      await expect(
        h.service.start('fnd_1', { ...base, ...bad }),
      ).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(
      h.service.start('fnd_1', { ...base, key: 'x'.repeat(32) }),
    ).rejects.toThrow('forbidden');
  });
});
