import { randomBytes } from 'node:crypto';
import type { SendRecord } from '@synq/funding';
import { FundError, type FundView } from './fund-service.js';
import type { Cabin } from './fund-intents.js';
import { flightTripCard } from './trip-cards.js';

/**
 * Group picks for a fund: flights (Duffel test mode) and gifts (live product
 * search; bought with a Lithic sandbox virtual card against a simulated
 * merchant). Someone searches, the chat
 * votes on up to three options (a non-binding preference), and the group then
 * pays the chosen total from its Safe to the Synq Travel settlement account
 * with the usual passkey approvals. Once that payment is on chain the operator
 * books the order in Duffel test mode. Nothing books without a paid,
 * group-approved transfer, and no real ticket or charge is ever made.
 */

export type TripOption = {
  optionId: string;
  /** e.g. "Duffel Airways ZZ 123" */
  title: string;
  /** e.g. "LHR → JFK · 1 stop · economy" */
  detail: string;
  /** Decimal total in the offer currency, e.g. "227.65". */
  total: string;
  currency: string;
  refundable: boolean;
  /** Provider offer kept server-side for the quote and booking. */
  offer: unknown;
};

export type TripState =
  | 'VOTING'
  | 'AWAITING_PAYMENT'
  | 'BOOKING'
  | 'BOOKED'
  | 'FAILED';

export type Trip = {
  schemaVersion: 1;
  tripId: string;
  fundId: string;
  kind: 'FLIGHT' | 'GIFT';
  /** e.g. "DEL → GOI · 2026-12-05" (one way), "DEL → GOI · 2026-12-01, back 2026-12-05" or "Gift: car gifts" */
  title: string;
  // FLIGHT
  origin?: string;
  destination?: string;
  departureDate?: string;
  /** Return leg date for a round trip; absent/null for one way. */
  returnDate?: string | null;
  travelers?: number;
  cabin?: Cabin;
  // GIFT
  query?: string;
  maxPrice?: string;
  createdAt: number;
  updatedAt: number;
  options: TripOption[];
  /** voterId (one per device) -> optionId */
  votes: Record<string, string>;
  state: TripState;
  chosen: string | null;
  payment: {
    amount: string;
    requestedAt: number;
    intentHash: string | null;
  } | null;
  booking: { reference: string | null; bookingId: string | null } | null;
  error: string | null;
};

export type TripView = Omit<Trip, 'options' | 'votes'> & {
  options: (Omit<TripOption, 'offer'> & { votes: number })[];
  voteCount: number;
  leading: string | null;
  myVote: string | null;
  label: string;
  payTo: { recipientId: string; label: string } | null;
};

export interface TripStore {
  migrate(): Promise<void>;
  create(trip: Trip): Promise<void>;
  get(tripId: string): Promise<Trip | null>;
  mutate(
    tripId: string,
    change: (trip: Trip) => Trip | Promise<Trip>,
  ): Promise<Trip>;
  forFund(fundId: string, limit: number): Promise<Trip[]>;
  awaiting(): Promise<Trip[]>;
  createdSince(fundId: string, at: number): Promise<number>;
}

export type FulfilResult =
  | { status: 'BOOKED'; reference: string | null; bookingId: string | null }
  | { status: 'FAILED'; reason: string };

export type TripPorts = {
  now(): number;
  /** Authorizes the fund key and returns the fund's current view. */
  fund(fundId: string, key: string): Promise<FundView>;
  /** One-way, or a return trip (two slices) when `returnDate` is set. */
  search(input: {
    origin: string;
    destination: string;
    departureDate: string;
    returnDate: string | null;
    travelers: number;
    cabin: Cabin;
  }): Promise<TripOption[]>;
  /** Re-quotes the option and books it; never charges more than `maxTotal`. */
  book(input: {
    option: TripOption;
    trip: Trip;
    maxTotal: string;
    idempotencyKey: string;
  }): Promise<FulfilResult>;
  /** Gift search and purchase; absent when not configured. */
  gifts?: {
    search(input: { query: string; maxPrice: string }): Promise<TripOption[]>;
    buy(input: {
      option: TripOption;
      trip: Trip;
      maxTotal: string;
      idempotencyKey: string;
    }): Promise<FulfilResult>;
  };
  settlement: { address: string; recipientId: string; label: string };
  /** The fund's Sends, newest first. */
  sends(groupId: string): Promise<SendRecord[]>;
  log(message: string): void;
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const IATA = /^[A-Z]{3}$/;
const CABINS: readonly Cabin[] = [
  'economy',
  'premium_economy',
  'business',
  'first',
];
const MAX_TRAVELERS = 4;
const realDay = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === day;
};
const lower = (s: string) => s.toLowerCase();

export class TripService {
  constructor(
    readonly store: TripStore,
    readonly ports: TripPorts,
  ) {}

  private view(trip: Trip, voterId: string | null): TripView {
    const counts = new Map<string, number>();
    for (const o of Object.values(trip.votes))
      counts.set(o, (counts.get(o) ?? 0) + 1);
    const options = trip.options.map(({ offer: _offer, ...o }) => ({
      ...o,
      votes: counts.get(o.optionId) ?? 0,
    }));
    const leading = [...options].sort((a, b) => b.votes - a.votes)[0]?.votes
      ? [...options].sort((a, b) => b.votes - a.votes)[0]!.optionId
      : null;
    const { options: _o, votes: _v, ...rest } = trip;
    return {
      ...rest,
      options,
      voteCount: Object.keys(trip.votes).length,
      leading,
      myVote: voterId ? (trip.votes[voterId] ?? null) : null,
      label:
        trip.kind === 'GIFT'
          ? 'Live product prices; bought with a Lithic sandbox virtual card at a simulated merchant, no real order'
          : 'Duffel test mode: Duffel Airways test flights, no real ticket or charge',
      payTo:
        trip.state === 'AWAITING_PAYMENT'
          ? {
              recipientId: this.ports.settlement.recipientId,
              label: this.ports.settlement.label,
            }
          : null,
    };
  }

  private async own(fundId: string, key: string, tripId: string) {
    await this.ports.fund(fundId, key);
    const trip = await this.store.get(tripId);
    if (!trip || trip.fundId !== fundId)
      throw new FundError('FUND_NOT_FOUND', 404, 'trip');
    return trip;
  }

  async start(
    fundId: string,
    input: {
      key: string;
      origin: string;
      destination: string;
      departureDate: string;
      returnDate?: string | null;
      travelers: number;
      cabin?: Cabin | null;
    },
  ): Promise<TripView> {
    const fund = await this.ports.fund(fundId, input.key);
    if (fund.state !== 'ACTIVE') throw new FundError('WRONG_STATE', 409);
    const origin = input.origin.trim().toUpperCase();
    const destination = input.destination.trim().toUpperCase();
    const returnDate = input.returnDate ?? null;
    const cabin = input.cabin ?? 'economy';
    const now = this.ports.now();
    const today = new Date(now * 1000).toISOString().slice(0, 10);
    const horizon = new Date((now + 366 * 86_400) * 1000)
      .toISOString()
      .slice(0, 10);
    if (
      !IATA.test(origin) ||
      !IATA.test(destination) ||
      origin === destination ||
      !DAY.test(input.departureDate) ||
      !realDay(input.departureDate) ||
      input.departureDate <= today ||
      input.departureDate > horizon ||
      // A return leg must come after the departure.
      (returnDate !== null &&
        (!DAY.test(returnDate) ||
          !realDay(returnDate) ||
          returnDate <= input.departureDate ||
          returnDate > horizon)) ||
      !CABINS.includes(cabin) ||
      !Number.isInteger(input.travelers) ||
      input.travelers < 1 ||
      input.travelers > MAX_TRAVELERS
    )
      throw new FundError('INVALID_REQUEST', 400, 'trip');
    if ((await this.store.createdSince(fundId, now - 86_400)) >= 10)
      throw new FundError('RATE_LIMITED', 429);
    const options = await this.ports.search({
      origin,
      destination,
      departureDate: input.departureDate,
      returnDate,
      travelers: input.travelers,
      cabin,
    });
    const trip: Trip = {
      schemaVersion: 1,
      tripId: `trp_${randomBytes(8).toString('hex')}`,
      fundId,
      kind: 'FLIGHT',
      title: `${origin} → ${destination} · ${input.departureDate}${returnDate ? `, back ${returnDate}` : ''}`,
      origin,
      destination,
      departureDate: input.departureDate,
      returnDate,
      travelers: input.travelers,
      cabin,
      createdAt: now,
      updatedAt: now,
      options,
      votes: {},
      state: options.length ? 'VOTING' : 'FAILED',
      chosen: null,
      payment: null,
      booking: null,
      error: options.length
        ? null
        : `No bookable test flights on that route and ${returnDate ? 'those dates' : 'date'}.`,
    };
    await this.store.create(trip);
    this.ports.log(
      `fund ${fundId}: trip ${trip.tripId} (${options.length} options)`,
    );
    return this.view(trip, null);
  }

  async startGift(
    fundId: string,
    input: { key: string; query: string; maxPrice: string },
  ): Promise<TripView> {
    const gifts = this.ports.gifts;
    if (!gifts) throw new FundError('WRONG_STATE', 409, 'gifts are off');
    const fund = await this.ports.fund(fundId, input.key);
    if (fund.state !== 'ACTIVE') throw new FundError('WRONG_STATE', 409);
    const query = input.query.replace(/\s+/g, ' ').trim();
    const max = Number(input.maxPrice);
    if (
      !query ||
      query.length > 80 ||
      !/^\d{1,4}(\.\d{1,2})?$/.test(input.maxPrice) ||
      !(max >= 1 && max <= Number(fund.maxPayment ?? '500'))
    )
      throw new FundError('INVALID_REQUEST', 400, 'gift');
    const now = this.ports.now();
    if ((await this.store.createdSince(fundId, now - 86_400)) >= 10)
      throw new FundError('RATE_LIMITED', 429);
    const options = await gifts.search({ query, maxPrice: input.maxPrice });
    const trip: Trip = {
      schemaVersion: 1,
      tripId: `trp_${randomBytes(8).toString('hex')}`,
      fundId,
      kind: 'GIFT',
      title: `Gift: ${query}`,
      query,
      maxPrice: input.maxPrice,
      createdAt: now,
      updatedAt: now,
      options,
      votes: {},
      state: options.length ? 'VOTING' : 'FAILED',
      chosen: null,
      payment: null,
      booking: null,
      error: options.length ? null : 'No products found under that price.',
    };
    await this.store.create(trip);
    this.ports.log(
      `fund ${fundId}: gift ${trip.tripId} (${options.length} options)`,
    );
    return this.view(trip, null);
  }

  async get(
    fundId: string,
    key: string,
    tripId: string,
    voterId: string | null,
  ): Promise<TripView> {
    return this.view(await this.own(fundId, key, tripId), voterId);
  }

  /** The flight trip as a FLIGHT_COMPARISON card (null for gifts). */
  async card(fundId: string, key: string, tripId: string, webBaseUrl: string) {
    const fund = await this.ports.fund(fundId, key);
    const trip = await this.own(fundId, key, tripId);
    return flightTripCard(trip, {
      groupLabel: fund.name,
      webBaseUrl,
      now: this.ports.now(),
    });
  }

  async list(fundId: string, key: string, voterId: string | null) {
    await this.ports.fund(fundId, key);
    return (await this.store.forFund(fundId, 10)).map((t) =>
      this.view(t, voterId),
    );
  }

  async vote(
    fundId: string,
    input: { key: string; tripId: string; voterId: string; optionId: string },
  ): Promise<TripView> {
    await this.own(fundId, input.key, input.tripId);
    const trip = await this.store.mutate(input.tripId, (t) => {
      if (t.state !== 'VOTING') throw new FundError('WRONG_STATE', 409);
      if (!t.options.some((o) => o.optionId === input.optionId))
        throw new FundError('INVALID_REQUEST', 400, 'option');
      if (!(input.voterId in t.votes) && Object.keys(t.votes).length >= 50)
        throw new FundError('RATE_LIMITED', 429);
      return {
        ...t,
        updatedAt: this.ports.now(),
        votes: { ...t.votes, [input.voterId]: input.optionId },
      };
    });
    return this.view(trip, input.voterId);
  }

  /** Chooses an option; the group then pays its total to the settlement account. */
  async choose(
    fundId: string,
    input: { key: string; tripId: string; optionId: string },
  ): Promise<TripView> {
    await this.own(fundId, input.key, input.tripId);
    const trip = await this.store.mutate(input.tripId, (t) => {
      if (t.state !== 'VOTING' && t.state !== 'AWAITING_PAYMENT')
        throw new FundError('WRONG_STATE', 409);
      const option = t.options.find((o) => o.optionId === input.optionId);
      if (!option) throw new FundError('INVALID_REQUEST', 400, 'option');
      return {
        ...t,
        state: 'AWAITING_PAYMENT',
        chosen: option.optionId,
        // Test mode settles 1 USD as 1 AUSD.
        payment: {
          amount: option.total,
          requestedAt: this.ports.now(),
          intentHash: null,
        },
        updatedAt: this.ports.now(),
        error: null,
      };
    });
    return this.view(trip, null);
  }

  /**
   * Matches group payments to trips awaiting them and books paid trips. Runs in
   * the operator loop.
   */
  async tick(groupOf: (fundId: string) => Promise<string | null>) {
    for (const t of await this.store.awaiting()) {
      try {
        if (t.state === 'AWAITING_PAYMENT') await this.matchPayment(t, groupOf);
        else if (t.state === 'BOOKING') await this.runBooking(t);
      } catch (error) {
        this.ports.log(
          `trip ${t.tripId}: ${String(error instanceof Error ? error.message : error).slice(0, 200)}`,
        );
      }
    }
  }

  private async matchPayment(
    t: Trip,
    groupOf: (fundId: string) => Promise<string | null>,
  ) {
    if (!t.payment) return;
    const groupId = await groupOf(t.fundId);
    if (!groupId) return;
    const target = lower(this.ports.settlement.address);
    const match = (await this.ports.sends(groupId)).find(
      (s) =>
        lower(s.preview.recipient.address) === target &&
        Number(s.preview.amountDecimal) === Number(t.payment!.amount) &&
        (s.history[0]?.at ?? 0) >= t.payment!.requestedAt - 60,
    );
    if (!match) return;
    if (match.state === 'REJECTED') {
      await this.store.mutate(t.tripId, (x) => ({
        ...x,
        state: 'VOTING',
        payment: null,
        chosen: null,
        error: 'The payment was rejected; choose again.',
        updatedAt: this.ports.now(),
      }));
      return;
    }
    const paid = match.state === 'CONFIRMED' || match.state === 'INDEXED';
    await this.store.mutate(t.tripId, (x) => ({
      ...x,
      state: paid ? 'BOOKING' : x.state,
      payment: { ...x.payment!, intentHash: match.intentHash },
      updatedAt: this.ports.now(),
    }));
    if (paid) this.ports.log(`trip ${t.tripId}: paid, booking`);
  }

  private async runBooking(t: Trip) {
    const option = t.options.find((o) => o.optionId === t.chosen);
    if (!option || !t.payment) return;
    const input = {
      option,
      trip: t,
      maxTotal: t.payment.amount,
      idempotencyKey: `synq-${t.tripId}`,
    };
    const result =
      t.kind === 'GIFT'
        ? ((await this.ports.gifts?.buy(input)) ?? {
            status: 'FAILED' as const,
            reason: 'Gift purchases are off.',
          })
        : await this.ports.book(input);
    await this.store.mutate(t.tripId, (x) => ({
      ...x,
      state: result.status === 'BOOKED' ? 'BOOKED' : 'FAILED',
      booking:
        result.status === 'BOOKED'
          ? { reference: result.reference, bookingId: result.bookingId }
          : null,
      error: result.status === 'FAILED' ? result.reason : null,
      updatedAt: this.ports.now(),
    }));
    this.ports.log(`trip ${t.tripId}: ${result.status}`);
  }
}

export class MemoryTripStore implements TripStore {
  private trips = new Map<string, Trip>();
  async migrate() {}
  async create(t: Trip) {
    this.trips.set(t.tripId, structuredClone(t));
  }
  async get(id: string) {
    const t = this.trips.get(id);
    return t ? structuredClone(t) : null;
  }
  async mutate(id: string, change: (t: Trip) => Trip | Promise<Trip>) {
    const t = this.trips.get(id);
    if (!t) throw new FundError('FUND_NOT_FOUND', 404, 'trip');
    const next = await change(structuredClone(t));
    this.trips.set(id, structuredClone(next));
    return structuredClone(next);
  }
  async forFund(fundId: string, limit: number) {
    return [...this.trips.values()]
      .filter((t) => t.fundId === fundId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((t) => structuredClone(t));
  }
  async awaiting() {
    return [...this.trips.values()]
      .filter((t) => t.state === 'AWAITING_PAYMENT' || t.state === 'BOOKING')
      .map((t) => structuredClone(t));
  }
  async createdSince(fundId: string, at: number) {
    return [...this.trips.values()].filter(
      (t) => t.fundId === fundId && t.createdAt >= at,
    ).length;
  }
}

type SqlClient = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
};
type Queryable = SqlClient & {
  connect(): Promise<SqlClient & { release(): void }>;
};

export class PostgresTripStore implements TripStore {
  constructor(readonly pool: Queryable) {}
  async migrate() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS synq_fund_trips (
      trip_id text PRIMARY KEY, fund_id text NOT NULL, state text NOT NULL,
      created_at bigint NOT NULL, data jsonb NOT NULL)`);
  }
  async create(t: Trip) {
    await this.pool.query(
      'INSERT INTO synq_fund_trips (trip_id,fund_id,state,created_at,data) VALUES ($1,$2,$3,$4,$5)',
      [t.tripId, t.fundId, t.state, t.createdAt, t],
    );
  }
  async get(id: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_fund_trips WHERE trip_id=$1',
      [id],
    );
    return (r.rows[0]?.data as Trip | undefined) ?? null;
  }
  async mutate(id: string, change: (t: Trip) => Trip | Promise<Trip>) {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const r = await c.query(
        'SELECT data FROM synq_fund_trips WHERE trip_id=$1 FOR UPDATE',
        [id],
      );
      const current = r.rows[0]?.data as Trip | undefined;
      if (!current) throw new FundError('FUND_NOT_FOUND', 404, 'trip');
      const next = await change(current);
      await c.query(
        'UPDATE synq_fund_trips SET state=$2, data=$3 WHERE trip_id=$1',
        [id, next.state, next],
      );
      await c.query('COMMIT');
      return next;
    } catch (error) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      c.release();
    }
  }
  async forFund(fundId: string, limit: number) {
    const r = await this.pool.query(
      'SELECT data FROM synq_fund_trips WHERE fund_id=$1 ORDER BY created_at DESC LIMIT $2',
      [fundId, limit],
    );
    return r.rows.map((x) => x.data as Trip);
  }
  async awaiting() {
    const r = await this.pool.query(
      "SELECT data FROM synq_fund_trips WHERE state IN ('AWAITING_PAYMENT','BOOKING') ORDER BY created_at",
    );
    return r.rows.map((x) => x.data as Trip);
  }
  async createdSince(fundId: string, at: number) {
    const r = await this.pool.query(
      'SELECT count(*)::int AS n FROM synq_fund_trips WHERE fund_id=$1 AND created_at >= $2',
      [fundId, at],
    );
    return Number(r.rows[0]?.n ?? 0);
  }
}
