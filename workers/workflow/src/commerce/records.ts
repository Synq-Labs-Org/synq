import {
  FulfillmentReceiptSchema,
  type FulfillmentReceipt,
} from '@synq/offer-exchange';
import { redact } from '@synq/profile-vault';
import type { SettlementSqlPool } from '@synq/settlement';

/**
 * Durable booking receipts and incidents. A receipt id is written once (the
 * same receipt again is a no-op); an incident is unique per booking and code.
 */
export class PostgresBookingRecords {
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
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS ${this.s}`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_booking_receipts (
      receipt_id text PRIMARY KEY, intent_id text NOT NULL, data jsonb NOT NULL)`);
    await this.pool
      .query(`CREATE TABLE IF NOT EXISTS ${this.s}.synq_booking_incidents (
      booking_id text NOT NULL, code text NOT NULL, detail text NOT NULL, opened_at bigint NOT NULL,
      PRIMARY KEY (booking_id, code))`);
  }

  async writeReceipt(raw: FulfillmentReceipt) {
    const r = FulfillmentReceiptSchema.parse(raw);
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_booking_receipts (receipt_id, intent_id, data) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [r.receiptId, r.intentId, JSON.stringify(r)],
    );
  }

  async receipt(receiptId: string): Promise<FulfillmentReceipt | null> {
    const r = await this.pool.query(
      `SELECT data FROM ${this.s}.synq_booking_receipts WHERE receipt_id=$1`,
      [receiptId],
    );
    return r.rows[0] ? FulfillmentReceiptSchema.parse(r.rows[0].data) : null;
  }

  async openIncident(input: {
    bookingId: string;
    code: string;
    detail: string;
    at: number;
  }) {
    await this.pool.query(
      `INSERT INTO ${this.s}.synq_booking_incidents (booking_id, code, detail, opened_at) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [
        input.bookingId,
        input.code.slice(0, 80),
        redact(input.detail).slice(0, 500),
        input.at,
      ],
    );
  }

  async incidents(bookingId: string) {
    const r = await this.pool.query(
      `SELECT code, detail FROM ${this.s}.synq_booking_incidents WHERE booking_id=$1 ORDER BY code`,
      [bookingId],
    );
    return r.rows.map((x) => ({
      code: String(x.code),
      detail: String(x.detail),
    }));
  }
}
