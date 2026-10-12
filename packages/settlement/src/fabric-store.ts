import {
  LedgerEntrySchema,
  PaymentAuthorizationSchema,
  ProviderOrderSchema,
  SettlementFabricError,
  SettlementIntentSchema,
  SettlementReceiptSchema,
  SettlementRefundRecordSchema,
  addToTotals,
  emptyTotals,
  type LedgerEntry,
  type LedgerTotals,
  type PaymentAuthorization,
  type ProviderOrder,
  type SettlementIntent,
  type SettlementReceipt,
  type SettlementRefundRecord,
} from './fabric.js';
import type { SettlementSqlClient, SettlementSqlPool } from './postgres.js';

/**
 * Durable v1.3 settlement records. Writes are idempotent by record id; a
 * different record under an existing id is a conflict, never an overwrite.
 */
export interface SettlementFabricStore {
  putIntent(i: SettlementIntent): Promise<SettlementIntent>;
  getIntent(intentId: string): Promise<SettlementIntent | null>;
  /** Unique on (providerId, idempotencyKey); returns the existing order if present. */
  createOrder(
    o: ProviderOrder,
  ): Promise<{ order: ProviderOrder; created: boolean }>;
  getOrder(providerOrderId: string): Promise<ProviderOrder | null>;
  findOrder(
    providerId: string,
    idempotencyKey: string,
  ): Promise<ProviderOrder | null>;
  updateOrder(
    providerOrderId: string,
    fn: (o: ProviderOrder) => ProviderOrder,
  ): Promise<ProviderOrder>;
  upsertAuthorization(a: PaymentAuthorization): Promise<PaymentAuthorization>;
  listAuthorizations(providerOrderId: string): Promise<PaymentAuthorization[]>;
  appendLedger(e: LedgerEntry): Promise<LedgerEntry>;
  ledgerTotals(groupId: string): Promise<LedgerTotals>;
  putRefund(r: SettlementRefundRecord): Promise<SettlementRefundRecord>;
  /**
   * Atomically: an existing refund id must carry the same record (any ledger
   * difference is a conflict); otherwise the same-ledger total for the order
   * plus this amount must stay within `cap`, then the record is inserted.
   */
  putRefundCapped(
    r: SettlementRefundRecord,
    cap: bigint,
  ): Promise<SettlementRefundRecord>;
  markRefundCredited(
    refundId: string,
    credited: boolean,
  ): Promise<SettlementRefundRecord>;
  listRefunds(providerOrderId: string): Promise<SettlementRefundRecord[]>;
  putReceipt(r: SettlementReceipt): Promise<SettlementReceipt>;
  getReceipt(receiptId: string): Promise<SettlementReceipt | null>;
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const sameRefund = (a: SettlementRefundRecord, b: SettlementRefundRecord) =>
  same(
    { ...a, at: 0, treasuryCredit: false },
    { ...b, at: 0, treasuryCredit: false },
  );

function sameEntry(a: LedgerEntry, b: LedgerEntry) {
  const { at: _a, ...x } = a;
  const { at: _b, ...y } = b;
  return same(x, y);
}

export class MemorySettlementFabricStore implements SettlementFabricStore {
  private readonly intents = new Map<string, SettlementIntent>();
  private readonly orders = new Map<string, ProviderOrder>();
  private readonly auths = new Map<string, PaymentAuthorization>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly refunds = new Map<string, SettlementRefundRecord>();
  private readonly receipts = new Map<string, SettlementReceipt>();

  async putIntent(raw: SettlementIntent) {
    const i = SettlementIntentSchema.parse(raw);
    const prior = this.intents.get(i.intentId);
    if (prior) {
      if (!same({ ...prior, createdAt: 0 }, { ...i, createdAt: 0 }))
        throw new SettlementFabricError('RECORD_CONFLICT', i.intentId);
      return prior;
    }
    this.intents.set(i.intentId, i);
    return i;
  }
  async getIntent(id: string) {
    return this.intents.get(id) ?? null;
  }
  async createOrder(raw: ProviderOrder) {
    const o = ProviderOrderSchema.parse(raw);
    const existing = await this.findOrder(o.providerId, o.idempotencyKey);
    if (existing) {
      if (existing.intentId !== o.intentId)
        throw new SettlementFabricError('ORDER_CONFLICT', o.idempotencyKey);
      return { order: existing, created: false };
    }
    if (this.orders.has(o.providerOrderId))
      throw new SettlementFabricError('ORDER_CONFLICT', o.providerOrderId);
    this.orders.set(o.providerOrderId, o);
    return { order: o, created: true };
  }
  async getOrder(id: string) {
    return this.orders.get(id) ?? null;
  }
  async findOrder(providerId: string, key: string) {
    for (const o of this.orders.values())
      if (o.providerId === providerId && o.idempotencyKey === key) return o;
    return null;
  }
  async updateOrder(id: string, fn: (o: ProviderOrder) => ProviderOrder) {
    const o = this.orders.get(id);
    if (!o) throw new SettlementFabricError('NOT_FOUND', id);
    const next = ProviderOrderSchema.parse(fn(o));
    this.orders.set(id, next);
    return next;
  }
  async upsertAuthorization(raw: PaymentAuthorization) {
    const a = PaymentAuthorizationSchema.parse(raw);
    const prior = this.auths.get(a.authorizationId);
    if (prior && prior.providerOrderId !== a.providerOrderId)
      throw new SettlementFabricError('RECORD_CONFLICT', a.authorizationId);
    this.auths.set(a.authorizationId, a);
    return a;
  }
  async listAuthorizations(orderId: string) {
    return [...this.auths.values()].filter(
      (a) => a.providerOrderId === orderId,
    );
  }
  async appendLedger(raw: LedgerEntry) {
    const e = LedgerEntrySchema.parse(raw);
    const prior = this.ledger.get(e.entryId);
    if (prior) {
      if (!sameEntry(prior, e))
        throw new SettlementFabricError('RECORD_CONFLICT', e.entryId);
      return prior;
    }
    this.ledger.set(e.entryId, e);
    return e;
  }
  async ledgerTotals(groupId: string) {
    const t = emptyTotals();
    for (const e of this.ledger.values())
      if (e.groupId === groupId) addToTotals(t, e);
    return t;
  }
  async putRefund(raw: SettlementRefundRecord) {
    const r = SettlementRefundRecordSchema.parse(raw);
    const prior = this.refunds.get(r.refundId);
    if (prior) {
      if (!same({ ...prior, at: 0 }, { ...r, at: 0 }))
        throw new SettlementFabricError('RECORD_CONFLICT', r.refundId);
      return prior;
    }
    this.refunds.set(r.refundId, r);
    return r;
  }
  async listRefunds(orderId: string) {
    return [...this.refunds.values()].filter(
      (r) => r.providerOrderId === orderId,
    );
  }
  // No await between check and insert: atomic on the JS event loop.
  async putRefundCapped(raw: SettlementRefundRecord, cap: bigint) {
    const r = SettlementRefundRecordSchema.parse(raw);
    if (!this.orders.has(r.providerOrderId))
      throw new SettlementFabricError('NOT_FOUND', r.providerOrderId);
    const prior = this.refunds.get(r.refundId);
    if (prior) {
      if (!sameRefund(prior, r))
        throw new SettlementFabricError('RECORD_CONFLICT', r.refundId);
      return prior;
    }
    let sum = 0n;
    for (const f of this.refunds.values())
      if (f.providerOrderId === r.providerOrderId && f.ledger === r.ledger)
        sum += BigInt(f.amount.amount);
    if (sum + BigInt(r.amount.amount) > cap)
      throw new SettlementFabricError('REFUND_EXCEEDS_ORDER');
    this.refunds.set(r.refundId, r);
    return r;
  }
  async markRefundCredited(refundId: string, credited: boolean) {
    const r = this.refunds.get(refundId);
    if (!r) throw new SettlementFabricError('NOT_FOUND', refundId);
    if (credited && r.ledger !== 'CONFIRMED_REFUND')
      throw new SettlementFabricError(
        'RECORD_CONFLICT',
        'credit needs CONFIRMED',
      );
    const next = { ...r, treasuryCredit: credited };
    this.refunds.set(refundId, next);
    return next;
  }
  async putReceipt(raw: SettlementReceipt) {
    const r = SettlementReceiptSchema.parse(raw);
    const prior = this.receipts.get(r.receiptId);
    if (prior) return prior;
    this.receipts.set(r.receiptId, r);
    return r;
  }
  async getReceipt(id: string) {
    return this.receipts.get(id) ?? null;
  }
}

/**
 * Postgres store. Database CHECKs restate the money invariants: a sandbox or
 * simulated order can never be MERCHANT_SETTLED, and a CONFIRMED refund needs
 * on-chain evidence from a TESTNET or real-money order.
 */
export class PostgresSettlementFabricStore implements SettlementFabricStore {
  private readonly s: string;
  constructor(
    private readonly pool: SettlementSqlPool,
    schema = 'public',
  ) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))
      throw new Error('invalid schema name');
    this.s = `"${schema}"`;
  }

  async migrate() {
    const s = this.s;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${s}`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_intents (
      intent_id text PRIMARY KEY, data jsonb NOT NULL)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_orders (
      provider_order_id text PRIMARY KEY, provider_id text NOT NULL, idempotency_key text NOT NULL,
      intent_id text NOT NULL, mode text NOT NULL, state text NOT NULL, data jsonb NOT NULL,
      UNIQUE (provider_id, idempotency_key),
      CHECK (state <> 'MERCHANT_SETTLED' OR mode = 'REAL_MONEY_APPROVAL_REQUIRED'),
      CHECK (state <> 'SANDBOX_FULFILLED' OR mode IN ('PROVIDER_SANDBOX','MAINNET_SIMULATION')))`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_authorizations (
      authorization_id text PRIMARY KEY, provider_order_id text NOT NULL, data jsonb NOT NULL)`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_ledger (
      entry_id text PRIMARY KEY, ledger text NOT NULL CHECK (ledger IN
        ('SIMULATED_PROVIDER_OBLIGATION','REAL_OFFCHAIN_OBLIGATION','PROVIDER_REPORTED_REFUND','CONFIRMED_REFUND')),
      group_id text NOT NULL, mode text NOT NULL, amount numeric(78,0) NOT NULL CHECK (amount >= 0),
      currency text NOT NULL, decimals integer NOT NULL, data jsonb NOT NULL,
      CHECK (ledger <> 'REAL_OFFCHAIN_OBLIGATION' OR mode = 'REAL_MONEY_APPROVAL_REQUIRED'),
      CHECK (ledger <> 'SIMULATED_PROVIDER_OBLIGATION' OR mode <> 'REAL_MONEY_APPROVAL_REQUIRED'),
      CHECK (ledger <> 'CONFIRMED_REFUND' OR mode IN ('TESTNET','REAL_MONEY_APPROVAL_REQUIRED')))`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_refunds (
      refund_id text PRIMARY KEY, provider_order_id text NOT NULL, ledger text NOT NULL,
      mode text NOT NULL, onchain boolean NOT NULL, treasury_credit boolean NOT NULL, data jsonb NOT NULL,
      CHECK (ledger <> 'CONFIRMED_REFUND' OR (onchain AND mode IN ('TESTNET','REAL_MONEY_APPROVAL_REQUIRED'))),
      CHECK (NOT treasury_credit OR ledger = 'CONFIRMED_REFUND'))`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${s}.synq_settle_receipts (
      receipt_id text PRIMARY KEY, data jsonb NOT NULL)`);
  }

  private async tx<T>(run: (c: SettlementSqlClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await run(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  async putIntent(raw: SettlementIntent) {
    const i = SettlementIntentSchema.parse(raw);
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_intents (intent_id, data) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [i.intentId, JSON.stringify(i)],
    );
    const prior = (await this.getIntent(i.intentId))!;
    if (!same({ ...prior, createdAt: 0 }, { ...i, createdAt: 0 }))
      throw new SettlementFabricError('RECORD_CONFLICT', i.intentId);
    return prior;
  }
  async getIntent(id: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_intents WHERE intent_id=$1`,
      [id],
    );
    return r.rows[0] ? SettlementIntentSchema.parse(r.rows[0].data) : null;
  }

  async createOrder(raw: ProviderOrder) {
    const o = ProviderOrderSchema.parse(raw);
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_orders (provider_order_id, provider_id, idempotency_key, intent_id, mode, state, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        o.providerOrderId,
        o.providerId,
        o.idempotencyKey,
        o.intentId,
        o.mode,
        o.state,
        JSON.stringify(o),
      ],
    );
    if (r.rowCount === 1) return { order: o, created: true };
    const existing = await this.findOrder(o.providerId, o.idempotencyKey);
    if (!existing || existing.intentId !== o.intentId)
      throw new SettlementFabricError('ORDER_CONFLICT', o.idempotencyKey);
    return { order: existing, created: false };
  }
  async getOrder(id: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_orders WHERE provider_order_id=$1`,
      [id],
    );
    return r.rows[0] ? ProviderOrderSchema.parse(r.rows[0].data) : null;
  }
  async findOrder(providerId: string, key: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_orders WHERE provider_id=$1 AND idempotency_key=$2`,
      [providerId, key],
    );
    return r.rows[0] ? ProviderOrderSchema.parse(r.rows[0].data) : null;
  }
  async updateOrder(id: string, fn: (o: ProviderOrder) => ProviderOrder) {
    return this.tx(async (c) => {
      const r = await c.query(
        `SELECT data FROM ${this.s}.synq_settle_orders WHERE provider_order_id=$1 FOR UPDATE`,
        [id],
      );
      if (!r.rows[0]) throw new SettlementFabricError('NOT_FOUND', id);
      const next = ProviderOrderSchema.parse(
        fn(ProviderOrderSchema.parse(r.rows[0].data)),
      );
      await c.query(
        `UPDATE ${this.s}.synq_settle_orders SET state=$2, data=$3 WHERE provider_order_id=$1`,
        [id, next.state, JSON.stringify(next)],
      );
      return next;
    });
  }

  async upsertAuthorization(raw: PaymentAuthorization) {
    const a = PaymentAuthorizationSchema.parse(raw);
    const r = await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_authorizations (authorization_id, provider_order_id, data) VALUES ($1,$2,$3)
       ON CONFLICT (authorization_id) DO UPDATE SET data=EXCLUDED.data
       WHERE ${this.s}.synq_settle_authorizations.provider_order_id = EXCLUDED.provider_order_id`,
      [a.authorizationId, a.providerOrderId, JSON.stringify(a)],
    );
    if (r.rowCount !== 1)
      throw new SettlementFabricError('RECORD_CONFLICT', a.authorizationId);
    return a;
  }
  async listAuthorizations(orderId: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_authorizations WHERE provider_order_id=$1 ORDER BY authorization_id`,
      [orderId],
    );
    return r.rows.map((x) => PaymentAuthorizationSchema.parse(x.data));
  }

  async appendLedger(raw: LedgerEntry) {
    const e = LedgerEntrySchema.parse(raw);
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_ledger (entry_id, ledger, group_id, mode, amount, currency, decimals, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [
        e.entryId,
        e.ledger,
        e.groupId,
        e.mode,
        e.amount.amount,
        e.amount.currency,
        e.amount.decimals,
        JSON.stringify(e),
      ],
    );
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_ledger WHERE entry_id=$1`,
      [e.entryId],
    );
    const prior = LedgerEntrySchema.parse(r.rows[0]!.data);
    if (!sameEntry(prior, e))
      throw new SettlementFabricError('RECORD_CONFLICT', e.entryId);
    return prior;
  }
  async ledgerTotals(groupId: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_ledger WHERE group_id=$1`,
      [groupId],
    );
    const t = emptyTotals();
    for (const row of r.rows) addToTotals(t, LedgerEntrySchema.parse(row.data));
    return t;
  }

  async putRefund(raw: SettlementRefundRecord) {
    const f = SettlementRefundRecordSchema.parse(raw);
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_refunds (refund_id, provider_order_id, ledger, mode, onchain, treasury_credit, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [
        f.refundId,
        f.providerOrderId,
        f.ledger,
        f.mode,
        f.onchain !== null,
        f.treasuryCredit,
        JSON.stringify(f),
      ],
    );
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_refunds WHERE refund_id=$1`,
      [f.refundId],
    );
    const prior = SettlementRefundRecordSchema.parse(r.rows[0]!.data);
    if (!same({ ...prior, at: 0 }, { ...f, at: 0 }))
      throw new SettlementFabricError('RECORD_CONFLICT', f.refundId);
    return prior;
  }
  async putRefundCapped(raw: SettlementRefundRecord, cap: bigint) {
    const f = SettlementRefundRecordSchema.parse(raw);
    return this.tx(async (c) => {
      const o = await c.query(
        `SELECT 1 FROM ${this.s}.synq_settle_orders WHERE provider_order_id=$1 FOR UPDATE`,
        [f.providerOrderId],
      );
      if (!o.rows.length)
        throw new SettlementFabricError('NOT_FOUND', f.providerOrderId);
      const prior = await c.query(
        `SELECT data FROM ${this.s}.synq_settle_refunds WHERE refund_id=$1`,
        [f.refundId],
      );
      if (prior.rows[0]) {
        const p = SettlementRefundRecordSchema.parse(prior.rows[0].data);
        if (!sameRefund(p, f))
          throw new SettlementFabricError('RECORD_CONFLICT', f.refundId);
        return p;
      }
      const sum = await c.query(
        `SELECT COALESCE(SUM((data->'amount'->>'amount')::numeric),0)::text AS s
         FROM ${this.s}.synq_settle_refunds WHERE provider_order_id=$1 AND ledger=$2`,
        [f.providerOrderId, f.ledger],
      );
      if (BigInt(sum.rows[0]!.s as string) + BigInt(f.amount.amount) > cap)
        throw new SettlementFabricError('REFUND_EXCEEDS_ORDER');
      await c.query(
        `INSERT INTO ${this.s}.synq_settle_refunds (refund_id, provider_order_id, ledger, mode, onchain, treasury_credit, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          f.refundId,
          f.providerOrderId,
          f.ledger,
          f.mode,
          f.onchain !== null,
          f.treasuryCredit,
          JSON.stringify(f),
        ],
      );
      return f;
    });
  }
  async markRefundCredited(refundId: string, credited: boolean) {
    const r = await this.pool.query(
      `UPDATE ${this.s}.synq_settle_refunds SET treasury_credit=$2,
         data = jsonb_set(data, '{treasuryCredit}', to_jsonb($2::boolean))
       WHERE refund_id=$1 RETURNING data`,
      [refundId, credited],
    );
    if (!r.rows[0]) throw new SettlementFabricError('NOT_FOUND', refundId);
    return SettlementRefundRecordSchema.parse(r.rows[0].data);
  }
  async listRefunds(orderId: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_refunds WHERE provider_order_id=$1 ORDER BY refund_id`,
      [orderId],
    );
    return r.rows.map((x) => SettlementRefundRecordSchema.parse(x.data));
  }

  async putReceipt(raw: SettlementReceipt) {
    const rc = SettlementReceiptSchema.parse(raw);
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_settle_receipts (receipt_id, data) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [rc.receiptId, JSON.stringify(rc)],
    );
    return (await this.getReceipt(rc.receiptId))!;
  }
  async getReceipt(id: string) {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_settle_receipts WHERE receipt_id=$1`,
      [id],
    );
    return r.rows[0] ? SettlementReceiptSchema.parse(r.rows[0].data) : null;
  }
}
