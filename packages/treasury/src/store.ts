import {
  GroupFund,
  TreasuryError,
  type FundCharter,
  type FundEvent,
} from './fund.js';

/**
 * Append-only fund event store. Every transfer key (deposit, spend, refund)
 * and every provider booking is claimed globally, so one on-chain transfer can
 * credit exactly one fund and one provider booking can belong to one trip.
 */
export interface FundStore {
  load(fundId: string): Promise<FundEvent[]>;
  /** Appends at `expectedSeq` (the current length); throws CONFLICT on a race and DUPLICATE_CLAIM on a reused key. */
  append(
    fundId: string,
    expectedSeq: number,
    events: readonly FundEvent[],
    claims: readonly string[],
  ): Promise<void>;
  claimOwner(key: string): Promise<string | null>;
}

/** Global claim keys carried by a batch of events. */
export function claimsOf(events: readonly FundEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    // One custody account per fund: a pool shared by two funds would double count.
    if (e.type === 'OPENED')
      out.push(
        `pool:${e.charter.asset.chainId}:${e.charter.pool.toLowerCase()}`,
      );
    if (
      e.type === 'DEPOSIT_SEEN' ||
      e.type === 'SPEND_EXECUTED' ||
      e.type === 'REFUND_EXECUTED'
    )
      out.push(e.key);
    if (e.type === 'TRIP_BOOKED')
      out.push(`booking:${e.providerId}:${e.providerRef}`);
  }
  return out;
}

export const encodeEvent = (e: FundEvent) =>
  JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
export const decodeEvent = (raw: unknown): FundEvent =>
  JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw), (_k, v) =>
    typeof v === 'string' && /^-?\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v,
  ) as FundEvent;

export class MemoryFundStore implements FundStore {
  private readonly logs = new Map<string, string[]>();
  private readonly claims = new Map<string, string>();
  async load(fundId: string) {
    return (this.logs.get(fundId) ?? []).map(decodeEvent);
  }
  async append(
    fundId: string,
    expectedSeq: number,
    events: readonly FundEvent[],
    claims: readonly string[],
  ) {
    const log = this.logs.get(fundId) ?? [];
    if (log.length !== expectedSeq)
      throw new TreasuryError(
        'CONFLICT',
        `${fundId} at ${log.length}, expected ${expectedSeq}`,
      );
    if (new Set(claims).size !== claims.length)
      throw new TreasuryError('DUPLICATE_CLAIM', 'batch repeats a key');
    for (const k of claims) {
      const owner = this.claims.get(k);
      if (owner !== undefined)
        throw new TreasuryError('DUPLICATE_CLAIM', `${k} belongs to ${owner}`);
    }
    for (const k of claims) this.claims.set(k, fundId);
    this.logs.set(fundId, [...log, ...events.map(encodeEvent)]);
  }
  async claimOwner(key: string) {
    return this.claims.get(key) ?? null;
  }
}

export type TreasurySqlClient = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};
export type TreasurySqlPool = TreasurySqlClient & {
  connect(): Promise<TreasurySqlClient & { release(): void }>;
};

/** Versioned, reversible migrations in this package's own migrations table. */
export const TREASURY_MIGRATIONS: readonly {
  version: number;
  up: string;
  down: string;
}[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_treasury_fund_events (
      fund_id text NOT NULL,
      seq integer NOT NULL CHECK (seq >= 0),
      type text NOT NULL,
      data jsonb NOT NULL,
      recorded_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (fund_id, seq));
    CREATE TABLE IF NOT EXISTS synq_treasury_claims (
      claim_key text PRIMARY KEY,
      fund_id text NOT NULL,
      claimed_at timestamptz NOT NULL DEFAULT now());`,
    down: `DROP TABLE IF EXISTS synq_treasury_claims; DROP TABLE IF EXISTS synq_treasury_fund_events;`,
  },
];

export async function migrateTreasury(
  sql: TreasurySqlClient,
  target = TREASURY_MIGRATIONS.at(-1)!.version,
): Promise<number> {
  await sql.query(
    'CREATE TABLE IF NOT EXISTS synq_treasury_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const r = await sql.query(
    'SELECT coalesce(max(version), 0) AS v FROM synq_treasury_migrations',
  );
  let current = Number(r.rows[0]?.v ?? 0);
  for (const m of TREASURY_MIGRATIONS)
    if (m.version > current && m.version <= target) {
      await sql.query(m.up);
      await sql.query(
        'INSERT INTO synq_treasury_migrations (version) VALUES ($1)',
        [m.version],
      );
      current = m.version;
    }
  for (const m of [...TREASURY_MIGRATIONS].reverse())
    if (m.version <= current && m.version > target) {
      await sql.query(m.down);
      await sql.query('DELETE FROM synq_treasury_migrations WHERE version=$1', [
        m.version,
      ]);
      current = m.version - 1;
    }
  return current;
}

export class PostgresFundStore implements FundStore {
  constructor(private readonly pool: TreasurySqlPool) {}
  migrate() {
    return migrateTreasury(this.pool);
  }
  async load(fundId: string) {
    const r = await this.pool.query(
      'SELECT data FROM synq_treasury_fund_events WHERE fund_id=$1 ORDER BY seq',
      [fundId],
    );
    return r.rows.map((row) => decodeEvent(row.data));
  }
  async append(
    fundId: string,
    expectedSeq: number,
    events: readonly FundEvent[],
    claims: readonly string[],
  ) {
    if (!events.length) return;
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      // The (fund_id, seq) primary key fences concurrent writers; claim_key is globally unique.
      for (const [i, e] of events.entries())
        await c.query(
          'INSERT INTO synq_treasury_fund_events (fund_id, seq, type, data) VALUES ($1,$2,$3,$4::jsonb)',
          [fundId, expectedSeq + i, e.type, encodeEvent(e)],
        );
      const at = await c.query(
        'SELECT count(*)::int AS n FROM synq_treasury_fund_events WHERE fund_id=$1',
        [fundId],
      );
      if (Number(at.rows[0]?.n) !== expectedSeq + events.length)
        throw new TreasuryError(
          'CONFLICT',
          `${fundId} moved past ${expectedSeq}`,
        );
      for (const k of claims)
        await c.query(
          'INSERT INTO synq_treasury_claims (claim_key, fund_id) VALUES ($1,$2)',
          [k, fundId],
        );
      await c.query('COMMIT');
    } catch (e) {
      await c.query('ROLLBACK');
      const code = (e as { code?: string; constraint?: string }).code;
      const constraint = (e as { constraint?: string }).constraint ?? '';
      if (code === '23505' && constraint.includes('claims'))
        throw new TreasuryError(
          'DUPLICATE_CLAIM',
          'transfer or booking already belongs to a fund',
        );
      if (code === '23505')
        throw new TreasuryError('CONFLICT', `${fundId} concurrent append`);
      throw e;
    } finally {
      c.release();
    }
  }
  async claimOwner(key: string) {
    const r = await this.pool.query(
      'SELECT fund_id FROM synq_treasury_claims WHERE claim_key=$1',
      [key],
    );
    return (r.rows[0]?.fund_id as string | undefined) ?? null;
  }
}

/** Loads, decides and appends; a racing writer gets CONFLICT and must reload. */
export class GroupFundService {
  constructor(private readonly store: FundStore) {}

  async open(charter: FundCharter, at: number): Promise<GroupFund> {
    const events = GroupFund.open(charter, at);
    await this.store.append(charter.fundId, 0, events, claimsOf(events));
    return GroupFund.fold(events);
  }

  async load(fundId: string): Promise<GroupFund> {
    const events = await this.store.load(fundId);
    if (!events.length)
      throw new TreasuryError('BAD_CHARTER', `unknown fund ${fundId}`);
    return GroupFund.fold(events);
  }

  async run(
    fundId: string,
    decide: (fund: GroupFund) => FundEvent[] | Promise<FundEvent[]>,
  ): Promise<GroupFund> {
    const fund = await this.load(fundId);
    const events = await decide(fund);
    if (events.length) {
      await this.store.append(fundId, fund.seq, events, claimsOf(events));
      for (const e of events) fund.apply(e);
    }
    return fund;
  }
}
