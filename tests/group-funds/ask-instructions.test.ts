import { describe, expect, it } from 'vitest';
import { FundAssistant } from '../../apps/demo/src/fund-assistant.js';
import {
  describeDates,
  parseInstruction,
  todayIn,
  type FlightRequest,
} from '../../apps/demo/src/fund-intents.js';
import type { FundView } from '../../apps/demo/src/fund-service.js';

/** Friday 16 Oct 2026: "next Friday" is the 23rd, "this weekend" the 17th–18th. */
const TODAY = '2026-10-16';
const parse = (text: string) =>
  parseInstruction(text, { today: TODAY, maxGiftPrice: 500 });

const flight = (
  origin: string,
  destination: string,
  departureDate: string,
  extra: Partial<FlightRequest> = {},
) => ({
  kind: 'FLIGHT',
  request: {
    origin,
    destination,
    departureDate,
    returnDate: null,
    travelers: 1,
    originLabel: LABEL[origin] ?? null,
    destinationLabel: LABEL[destination] ?? null,
    cabin: null,
    ...extra,
  },
});
const LABEL: Record<string, string> = {
  DEL: 'Delhi',
  GOI: 'Goa',
  BOM: 'Mumbai',
  LHR: 'London',
  BLR: 'Bengaluru',
  MAA: 'Chennai',
  HYD: 'Hyderabad',
  CCU: 'Kolkata',
  PNQ: 'Pune',
  JAI: 'Jaipur',
  COK: 'Kochi',
  DXB: 'Dubai',
  SIN: 'Singapore',
  CDG: 'Paris',
  JFK: 'New York',
  SFO: 'San Francisco',
  BKK: 'Bangkok',
  DPS: 'Bali',
  HND: 'Tokyo',
  LIS: 'Lisbon',
};
const clarify = (topic: 'FLIGHT' | 'GIFT', match: RegExp) => ({
  kind: 'CLARIFY',
  topic,
  question: expect.stringMatching(match),
});
const gift = (query: string, maxPrice: string, budgetDefaulted = false) => ({
  kind: 'GIFT',
  request: { query, maxPrice },
  budgetDefaulted,
});
const NONE = { kind: 'NONE' };

const TABLE: [string, unknown][] = [
  // Complete flight instructions
  [
    'Book a flight from Delhi to Goa on Dec 1 to Dec 5 for 3 people',
    flight('DEL', 'GOI', '2026-12-01', {
      returnDate: '2026-12-05',
      travelers: 3,
    }),
  ],
  [
    'find flights DEL to GOI 1-5 Dec',
    flight('DEL', 'GOI', '2026-12-01', { returnDate: '2026-12-05' }),
  ],
  [
    'find flights DEL to GOI 1–5 Dec',
    flight('DEL', 'GOI', '2026-12-01', { returnDate: '2026-12-05' }),
  ],
  [
    'search flights from Mumbai to London on 1st December returning the 5th',
    flight('BOM', 'LHR', '2026-12-01', { returnDate: '2026-12-05' }),
  ],
  [
    'get me tickets from Bangalore to Goa tomorrow',
    flight('BLR', 'GOI', '2026-10-17'),
  ],
  [
    'fly from Bengaluru to Chennai next Friday',
    flight('BLR', 'MAA', '2026-10-23'),
  ],
  [
    'book a flight from Hyderabad to Kolkata this weekend, round trip',
    flight('HYD', 'CCU', '2026-10-17', { returnDate: '2026-10-18' }),
  ],
  [
    'flights from Pune to Jaipur 2026-11-20',
    flight('PNQ', 'JAI', '2026-11-20'),
  ],
  [
    'book a flight from Kochi to Dubai on 13/12',
    flight('COK', 'DXB', '2026-12-13'),
  ],
  [
    'I need flights from Delhi to Singapore for me and 2 friends on Nov 10, back Nov 17',
    flight('DEL', 'SIN', '2026-11-10', {
      returnDate: '2026-11-17',
      travelers: 3,
    }),
  ],
  [
    'book 2 tickets from London to Paris on 3 Jan in business class',
    flight('LHR', 'CDG', '2027-01-03', { travelers: 2, cabin: 'business' }),
  ],
  [
    'flight from New York to San Francisco on Dec 1, one way, first class',
    flight('JFK', 'SFO', '2026-12-01', { cabin: 'first' }),
  ],
  [
    'fly del-goi this weekend round trip',
    flight('DEL', 'GOI', '2026-10-17', { returnDate: '2026-10-18' }),
  ],
  [
    'Delhi to Goa next friday, me and 2 friends, business class',
    flight('DEL', 'GOI', '2026-10-23', { travelers: 3, cabin: 'business' }),
  ],
  [
    'BOM → DXB on Dec 28 to Jan 3 for two',
    flight('BOM', 'DXB', '2026-12-28', {
      returnDate: '2027-01-03',
      travelers: 2,
    }),
  ],
  [
    'flights from Chennai to Bangkok on 20 Nov for a week for the 3 of us',
    flight('MAA', 'BKK', '2026-11-20', {
      returnDate: '2026-11-27',
      travelers: 3,
    }),
  ],
  [
    'can you book a flight from Kolkata to Bali on December 20th and back on December 27th',
    flight('CCU', 'DPS', '2026-12-20', { returnDate: '2026-12-27' }),
  ],
  [
    'book a flight to Tokyo from Delhi on Jan 15 for 4 people premium economy',
    flight('DEL', 'HND', '2027-01-15', {
      travelers: 4,
      cabin: 'premium_economy',
    }),
  ],
  [
    'please find a cheap flight from Lisbon to Paris in 2 weeks',
    flight('LIS', 'CDG', '2026-10-30'),
  ],
  [
    'flights LHR to JFK 2026-12-10 returning 2026-12-20 for 2 adults',
    flight('LHR', 'JFK', '2026-12-10', {
      returnDate: '2026-12-20',
      travelers: 2,
    }),
  ],
  [
    'book me and my wife a flight from Mumbai to Goa on 5 Dec',
    flight('BOM', 'GOI', '2026-12-05', { travelers: 2 }),
  ],
  [
    'fly from delhi to goa on the 20th for 2 nights',
    flight('DEL', 'GOI', '2026-10-20', { returnDate: '2026-10-22' }),
  ],
  [
    'book flights from Delhi to Goa leaving Dec 1 until Dec 5',
    flight('DEL', 'GOI', '2026-12-01', { returnDate: '2026-12-05' }),
  ],
  // An unknown code typed in capitals is taken as an IATA code, without a label.
  [
    'find a flight from OPO to LIS on dec 3',
    flight('OPO', 'LIS', '2026-12-03'),
  ],
  // Past month/day rolls to next year.
  [
    'book a flight from Mumbai to Delhi on 1 Feb',
    flight('BOM', 'DEL', '2027-02-01'),
  ],
  [
    'book a flight from Delhi to Goa on Sept 3',
    flight('DEL', 'GOI', '2027-09-03'),
  ],
  // Clarifications instead of guesses
  ['flights to goa', clarify('FLIGHT', /flying to Goa from/)],
  [
    'i want to fly to paris on dec 1',
    clarify('FLIGHT', /flying to Paris from/),
  ],
  [
    'book a flight from Coorg to Goa tomorrow',
    clarify('FLIGHT', /don't know an airport for "coorg"/),
  ],
  ['flights from delhi to goa', clarify('FLIGHT', /What date/)],
  [
    'book a flight from Delhi to Goa on 12/01',
    clarify('FLIGHT', /12 Jan or the 1 Dec/),
  ],
  ['fly from delhi to goa today', clarify('FLIGHT', /after today/)],
  ['book a flight from Delhi to Delhi tomorrow', clarify('FLIGHT', /same/)],
  [
    'need 6 tickets from delhi to goa on dec 1',
    clarify('FLIGHT', /up to 4 travellers/),
  ],
  [
    'book a return flight from Delhi to Goa on Dec 1',
    clarify('FLIGHT', /coming back from Goa/),
  ],
  [
    'book a flight from Delhi to Goa on Dec 5 returning Dec 1',
    clarify('FLIGHT', /after the departure/),
  ],
  ['flight from Delhi to Goa Feb 30', clarify('FLIGHT', /doesn't exist/)],
  [
    'one way flight from delhi to goa dec 1 to dec 5',
    clarify('FLIGHT', /one way but also gave a return/),
  ],
  [
    'flights from Delhi to Mumbai to Goa on dec 1',
    clarify('FLIGHT', /one route at a time/),
  ],
  // Not instructions: left to the model
  ['how much did we spend on flights?', NONE],
  ['should we fly to goa in december?', NONE],
  ["what's our balance", NONE],
  ['send 10 to ben', NONE],
  ['book tickets to coldplay', NONE],
  ['what gift should we get Priya?', NONE],
  ['hi', NONE],
  // Gifts
  [
    'find a gift for a coffee lover under $40',
    gift('gift for coffee lover', '40'),
  ],
  [
    'buy a birthday present for Priya under 25 dollars',
    gift('birthday present for priya', '25'),
  ],
  ['gift ideas for a car lover', gift('gift ideas for car lover', '50', true)],
  ['find a gift for my dad budget $120.50', gift('gift for my dad', '120.5')],
  ['find a gift under $900', clarify('GIFT', /between \$1 and \$500/)],
  ['find a gift', clarify('GIFT', /Who's the gift for/)],
  ['find a gift for a gamer under ₹2000', clarify('GIFT', /US dollars/)],
];

describe('plain instructions → searches', () => {
  it('has a broad phrasing table', () => {
    expect(TABLE.length).toBeGreaterThanOrEqual(40);
  });
  it.each(TABLE)('%s', (text, expected) => {
    expect(parse(text)).toEqual(expected);
  });

  it('resolves today in the stated time zone', () => {
    // 2026-10-16 20:00 UTC is already the 17th in India.
    const now = Date.UTC(2026, 9, 16, 20) / 1000;
    expect(todayIn('UTC', now)).toBe('2026-10-16');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-10-17');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-10-16');
  });

  it('describes dates for the reply', () => {
    expect(describeDates('2026-12-01', '2026-12-05', TODAY)).toBe('Dec 1–5');
    expect(describeDates('2026-12-28', '2027-01-03', TODAY)).toBe(
      'Dec 28 – Jan 3, 2027',
    );
    expect(describeDates('2027-02-01', null, TODAY)).toBe(
      'Feb 1, 2027, one way',
    );
  });
});

const fund = (state = 'ACTIVE'): FundView =>
  ({
    fundId: 'fnd_00000000000000000001',
    name: 'Goa',
    state,
    members: [{ name: 'Ana' }, { name: 'Ben' }],
    threshold: 2,
    treasury: { balance: '250', symbol: 'AUSD' },
    maxPayment: '500',
    recipients: [{ name: 'Ben', recipientId: 'member:member_1' }],
    proposals: [],
    canRequestTestFunds: true,
  }) as unknown as FundView;

describe('Ask Synq with plain instructions', () => {
  const calls: string[] = [];
  const assistant = (output: unknown | null) =>
    new FundAssistant({
      complete:
        output === null
          ? null
          : async ({ user }) => {
              calls.push(user);
              return JSON.stringify(output);
            },
      today: () => TODAY,
      timeZone: 'Asia/Kolkata',
      maxPaymentAmount: 500,
    });

  it('auto-runs a complete flight instruction without asking the model', async () => {
    calls.length = 0;
    const r = await assistant({ reply: 'model', action: null }).ask(
      fund(),
      'book a flight from Delhi to Goa on Dec 1 to Dec 5 for 3 people',
      1,
    );
    expect(calls).toHaveLength(0);
    expect(r).toEqual({
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

  it('auto-runs a complete gift instruction', async () => {
    const r = await assistant(null).ask(
      fund(),
      'find a gift for a coffee lover under $40',
      1,
    );
    expect(r.action).toEqual({
      kind: 'GIFT_SEARCH',
      query: 'gift for coffee lover',
      maxPrice: '40',
      autoRun: true,
    });
    expect(r.reply).toMatch(/under \$40/);
  });

  it('asks instead of guessing, and never sends the question to the model', async () => {
    calls.length = 0;
    const r = await assistant({
      reply: 'Booked DEL → GOI',
      action: {
        kind: 'FLIGHT_SEARCH',
        origin: 'DEL',
        destination: 'GOI',
        departureDate: '2026-12-01',
        returnDate: null,
        travelers: 1,
        cabin: null,
      },
    }).ask(fund(), 'flights to goa on dec 1', 1);
    expect(calls).toHaveLength(0);
    expect(r).toEqual({
      reply: 'Where are you flying to Goa from?',
      action: null,
    });
  });

  it('works without a model: instructions run, open questions get help text', async () => {
    const a = assistant(null);
    expect(
      (await a.ask(fund(), 'fly BLR to SIN tomorrow one way', 1)).action,
    ).toMatchObject({ kind: 'FLIGHT_SEARCH', autoRun: true });
    const open = await a.ask(fund(), 'what is our balance?', 1);
    expect(open.action).toBeNull();
    expect(open.reply).toMatch(/book a flight from Delhi to Goa/);
  });

  it('does not run searches before the fund is live', async () => {
    const r = await assistant(null).ask(
      fund('FORMING'),
      'book a flight from Delhi to Goa on Dec 1',
      1,
    );
    expect(r.action).toBeNull();
    expect(r.reply).toMatch(/once the fund is live/);
  });

  it('never auto-runs model suggestions and validates their return legs', async () => {
    const base = {
      kind: 'FLIGHT_SEARCH',
      origin: 'bom',
      destination: 'lhr',
      departureDate: '2026-12-01',
      travelers: 2,
    };
    const ok = await assistant({
      reply: 'Here you go',
      action: { ...base, returnDate: '2026-12-09', cabin: 'business' },
    }).ask(fund(), 'somewhere cold for christmas?', 1);
    expect(ok.action).toEqual({
      kind: 'FLIGHT_SEARCH',
      origin: 'BOM',
      destination: 'LHR',
      departureDate: '2026-12-01',
      returnDate: '2026-12-09',
      travelers: 2,
      originLabel: 'Mumbai',
      destinationLabel: 'London',
      cabin: 'business',
      autoRun: false,
    });
    for (const bad of [
      { returnDate: '2026-11-30' },
      { returnDate: '2026-12-01' },
      { returnDate: '2026-02-30' },
      { returnDate: '2028-01-01' },
      { departureDate: '2028-01-01', returnDate: null },
      { cabin: 'luxury', returnDate: null },
      { travelers: 5, returnDate: null },
    ]) {
      const r = await assistant({
        reply: 'ok',
        action: { ...base, cabin: null, ...bad },
      }).ask(fund(), 'somewhere cold for christmas?', 1);
      expect(r.action).toBeNull();
    }
  });

  it('keeps SEND a suggestion only (no autoRun flag)', async () => {
    const r = await assistant({
      reply: 'Pay Ben?',
      action: { kind: 'SEND', recipient: 'Ben', amount: '5' },
    }).ask(fund(), 'pay ben 5 for lunch', 1);
    expect(r.action).toEqual({
      kind: 'SEND',
      recipientId: 'member:member_1',
      recipient: 'Ben',
      amount: '5',
    });
    expect(r.action).not.toHaveProperty('autoRun');
  });
});
