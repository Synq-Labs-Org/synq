import type { Hex } from 'viem';
import {
  fromJsonb,
  toJsonb,
  withTransaction,
  type SqlPool,
} from '@synq/domain/pg';
import type { CctpTransfer } from '@synq/plugin-circle-cctp';
import type { SignedCall } from './cctp.js';
import type { CctpSagaRecord, CctpSagaStore, SagaLeg } from './cctp-saga.js';
import { migrateExecution } from './pg-schema.js';

/** Postgres CCTP saga store: rev compare-and-set, legs recorded once (append-only). */
export class PostgresCctpSagaStore implements CctpSagaStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateExecution(this.pool);
  }

  async create(t: CctpTransfer, at: number) {
    const r = await this.pool.query(
      `INSERT INTO synq_cctp_sagas (transfer_id, state, rev, transfer, updated_at)
       VALUES ($1,$2,1,$3,$4) ON CONFLICT DO NOTHING RETURNING transfer_id`,
      [t.transferId, t.state, toJsonb(t), at],
    );
    return r.rows.length > 0;
  }

  async get(transferId: string): Promise<CctpSagaRecord | null> {
    const [saga, legs] = await Promise.all([
      this.pool.query(
        'SELECT transfer, rev, review FROM synq_cctp_sagas WHERE transfer_id=$1',
        [transferId],
      ),
      this.pool.query(
        `SELECT leg, chain_id, from_address, tx_nonce, hash, raw, to_address
         FROM synq_cctp_saga_legs WHERE transfer_id=$1`,
        [transferId],
      ),
    ]);
    const s = saga.rows[0];
    if (!s) return null;
    const out: Partial<Record<SagaLeg, SignedCall>> = {};
    for (const l of legs.rows)
      out[l.leg as SagaLeg] = Object.freeze({
        chainId: Number(l.chain_id),
        from: l.from_address as Hex,
        to: l.to_address as Hex,
        nonce: Number(l.tx_nonce),
        hash: l.hash as Hex,
        raw: l.raw as Hex,
      });
    return {
      transfer: fromJsonb<CctpTransfer>(s.transfer),
      rev: Number(s.rev),
      legs: out,
      review: (s.review as string | null) ?? null,
    };
  }

  async save(t: CctpTransfer, expectedRev: number, at: number) {
    const r = await this.pool.query(
      `UPDATE synq_cctp_sagas SET transfer=$2, state=$3, rev=rev+1, updated_at=$5
       WHERE transfer_id=$1 AND rev=$4 RETURNING rev`,
      [t.transferId, toJsonb(t), t.state, expectedRev, at],
    );
    return r.rows.length > 0;
  }

  async recordLeg(
    transferId: string,
    leg: SagaLeg,
    s: SignedCall,
    at: number,
  ): Promise<SignedCall> {
    await this.pool.query(
      `INSERT INTO synq_cctp_saga_legs (transfer_id, leg, chain_id, from_address, to_address, tx_nonce, hash, raw, recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (transfer_id, leg) DO NOTHING`,
      [
        transferId,
        leg,
        s.chainId,
        s.from.toLowerCase(),
        s.to.toLowerCase(),
        s.nonce,
        s.hash.toLowerCase(),
        s.raw,
        at,
      ],
    );
    const stored = (await this.get(transferId))?.legs[leg];
    if (!stored) throw new Error(`leg ${leg} of ${transferId} not recorded`);
    return stored;
  }

  async flagReview(transferId: string, note: string, at: number) {
    await this.pool.query(
      'UPDATE synq_cctp_sagas SET review=$2, updated_at=$3 WHERE transfer_id=$1',
      [transferId, note, at],
    );
  }
}

export class GatewayLedgerError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_ACCOUNT'
      | 'ACCOUNTING'
      | 'INSUFFICIENT_AVAILABLE'
      | 'DUPLICATE_SPEND'
      | 'WRONG_STATE',
    message: string = code,
  ) {
    super(message);
    this.name = 'GatewayLedgerError';
  }
}

export type GatewayBuckets = Readonly<{
  sourceFree: bigint;
  pending: bigint;
  available: bigint;
  reserved: bigint;
}>;

export type BurnIntentState =
  | 'RESERVED'
  | 'SUBMITTED'
  | 'ATTESTED'
  | 'SETTLED'
  | 'RELEASED';

/**
 * Durable Gateway buckets (the persistent form of `GatewayAccount`).
 *
 * - A deposit is credited once per (chain, tx): replaying the same deposit
 *   is DUPLICATE, never a second credit.
 * - A burn intent's salt is reserved once. Before the signed intent is sent
 *   to Circle the row moves RESERVED → SUBMITTED; a restart that finds
 *   SUBMITTED never sends it again (the API outcome is unknown, so it stops
 *   for review), and an ATTESTED intent is only ever minted, not resubmitted.
 * - Every bucket change happens under the account row lock; the database
 *   refuses negative buckets.
 */
export class PostgresGatewayLedger {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateExecution(this.pool);
  }

  async open(accountId: string, sourceFree: bigint, at: number) {
    await this.pool.query(
      `INSERT INTO synq_gateway_accounts (account_id, source_free, pending, available, reserved, updated_at)
       VALUES ($1,$2,0,0,0,$3) ON CONFLICT DO NOTHING`,
      [accountId, sourceFree.toString(), at],
    );
  }

  async buckets(accountId: string): Promise<GatewayBuckets> {
    const r = await this.pool.query(
      'SELECT source_free, pending, available, reserved FROM synq_gateway_accounts WHERE account_id=$1',
      [accountId],
    );
    const x = r.rows[0];
    if (!x) throw new GatewayLedgerError('UNKNOWN_ACCOUNT', accountId);
    return {
      sourceFree: BigInt(x.source_free as string),
      pending: BigInt(x.pending as string),
      available: BigInt(x.available as string),
      reserved: BigInt(x.reserved as string),
    };
  }

  /** A submitted deposit tx moves source funds to pending, once per (chain, tx). */
  async deposit(
    accountId: string,
    d: { chainId: number; txHash: Hex; amount: bigint },
    at: number,
  ): Promise<'CREDITED' | 'DUPLICATE'> {
    if (d.amount <= 0n)
      throw new GatewayLedgerError('ACCOUNTING', 'deposit must be positive');
    return withTransaction(this.pool, async (c) => {
      const acct = await c.query(
        'SELECT source_free FROM synq_gateway_accounts WHERE account_id=$1 FOR UPDATE',
        [accountId],
      );
      if (!acct.rows[0])
        throw new GatewayLedgerError('UNKNOWN_ACCOUNT', accountId);
      const ins = await c.query(
        `INSERT INTO synq_gateway_deposits (chain_id, tx_hash, account_id, amount, recorded_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING tx_hash`,
        [d.chainId, d.txHash.toLowerCase(), accountId, d.amount.toString(), at],
      );
      if (!ins.rows.length) return 'DUPLICATE' as const;
      if (BigInt(acct.rows[0].source_free as string) < d.amount)
        throw new GatewayLedgerError(
          'ACCOUNTING',
          'deposit exceeds free source funds',
        );
      await c.query(
        `UPDATE synq_gateway_accounts SET source_free = source_free - $2, pending = pending + $2, updated_at=$3
         WHERE account_id=$1`,
        [accountId, d.amount.toString(), at],
      );
      return 'CREDITED' as const;
    });
  }

  /** Gateway reports `total` available: move the newly available part out of pending. */
  async observeAvailable(accountId: string, total: bigint, at: number) {
    await withTransaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT pending, available, reserved, updated_at FROM synq_gateway_accounts WHERE account_id=$1 FOR UPDATE',
        [accountId],
      );
      const x = r.rows[0];
      if (!x) throw new GatewayLedgerError('UNKNOWN_ACCOUNT', accountId);
      if (at <= Number(x.updated_at)) return;
      const newly =
        total - BigInt(x.available as string) - BigInt(x.reserved as string);
      if (newly <= 0n) return;
      if (newly > BigInt(x.pending as string))
        throw new GatewayLedgerError(
          'ACCOUNTING',
          'Gateway reports more than was deposited',
        );
      await c.query(
        `UPDATE synq_gateway_accounts SET pending = pending - $2, available = available + $2, updated_at=$3
         WHERE account_id=$1`,
        [accountId, newly.toString(), at],
      );
    });
  }

  /** Reserves value for a signed burn intent; each salt can be spent once, ever. */
  async reserve(
    accountId: string,
    input: { salt: Hex; value: bigint; intent: unknown; signature: Hex },
    at: number,
  ) {
    await withTransaction(this.pool, async (c) => {
      const r = await c.query(
        'SELECT available FROM synq_gateway_accounts WHERE account_id=$1 FOR UPDATE',
        [accountId],
      );
      if (!r.rows[0])
        throw new GatewayLedgerError('UNKNOWN_ACCOUNT', accountId);
      const ins = await c.query(
        `INSERT INTO synq_gateway_burn_intents (salt, account_id, value, intent, signature, state, updated_at)
         VALUES ($1,$2,$3,$4,$5,'RESERVED',$6) ON CONFLICT DO NOTHING RETURNING salt`,
        [
          input.salt.toLowerCase(),
          accountId,
          input.value.toString(),
          toJsonb(input.intent),
          input.signature,
          at,
        ],
      );
      if (!ins.rows.length)
        throw new GatewayLedgerError('DUPLICATE_SPEND', input.salt);
      if (BigInt(r.rows[0].available as string) < input.value)
        throw new GatewayLedgerError(
          'INSUFFICIENT_AVAILABLE',
          `${input.value} > ${r.rows[0].available as string}`,
        );
      await c.query(
        `UPDATE synq_gateway_accounts SET available = available - $2, reserved = reserved + $2, updated_at=$3
         WHERE account_id=$1`,
        [accountId, input.value.toString(), at],
      );
    });
  }

  async intent(salt: Hex) {
    const r = await this.pool.query(
      'SELECT account_id, value, intent, signature, state, attestation, mint_tx FROM synq_gateway_burn_intents WHERE salt=$1',
      [salt.toLowerCase()],
    );
    const x = r.rows[0];
    return x
      ? {
          accountId: String(x.account_id),
          value: BigInt(x.value as string),
          intent: fromJsonb<unknown>(x.intent),
          signature: x.signature as Hex,
          state: x.state as BurnIntentState,
          attestation: x.attestation
            ? fromJsonb<{ attestation: Hex; signature: Hex }>(x.attestation)
            : null,
          mintTx: (x.mint_tx as Hex | null) ?? null,
        }
      : null;
  }

  private async transition(
    salt: Hex,
    from: BurnIntentState,
    to: BurnIntentState,
    at: number,
    extra: { attestation?: unknown; mintTx?: Hex } = {},
  ) {
    const r = await this.pool.query(
      `UPDATE synq_gateway_burn_intents SET state=$3, updated_at=$4,
         attestation = COALESCE($5::jsonb, attestation), mint_tx = COALESCE($6, mint_tx)
       WHERE salt=$1 AND state=$2 RETURNING salt`,
      [
        salt.toLowerCase(),
        from,
        to,
        at,
        extra.attestation === undefined ? null : toJsonb(extra.attestation),
        extra.mintTx ?? null,
      ],
    );
    return r.rows.length > 0;
  }

  /**
   * Sends a reserved intent to Circle at most once: the row moves to
   * SUBMITTED before `send` runs. Any later call (retry, restart, second
   * worker) gets the recorded attestation or `NEEDS_REVIEW`, never a resend.
   */
  async submitOnce(
    salt: Hex,
    send: () => Promise<{ attestation: Hex; signature: Hex }>,
    now: () => number,
  ): Promise<
    | { outcome: 'ATTESTED'; attestation: { attestation: Hex; signature: Hex } }
    | { outcome: 'NEEDS_REVIEW'; state: BurnIntentState }
  > {
    const current = await this.intent(salt);
    if (!current) throw new GatewayLedgerError('WRONG_STATE', 'unknown salt');
    if (current.attestation)
      return { outcome: 'ATTESTED', attestation: current.attestation };
    if (!(await this.transition(salt, 'RESERVED', 'SUBMITTED', now())))
      return {
        outcome: 'NEEDS_REVIEW',
        state: (await this.intent(salt))!.state,
      };
    const attestation = await send();
    await this.transition(salt, 'SUBMITTED', 'ATTESTED', now(), {
      attestation,
    });
    return { outcome: 'ATTESTED', attestation };
  }

  /** Reconcile an ambiguous submit through a trusted Gateway reader, never resend. */
  async reconcileSubmission(
    salt: Hex,
    lookup: (salt: Hex) => Promise<
      | {
          outcome: 'ATTESTED';
          attestation: { attestation: Hex; signature: Hex };
        }
      | { outcome: 'EXPIRED'; salt: Hex; expiresAt: number }
      | { outcome: 'UNKNOWN' }
    >,
    now: () => number,
  ) {
    const proof = await lookup(salt);
    if (proof.outcome === 'UNKNOWN') return 'NEEDS_REVIEW' as const;
    if (proof.outcome === 'ATTESTED') {
      await this.transition(salt, 'SUBMITTED', 'ATTESTED', now(), {
        attestation: proof.attestation,
      });
      return (await this.intent(salt))?.state ?? 'NEEDS_REVIEW';
    }
    const at = now();
    if (
      proof.salt.toLowerCase() !== salt.toLowerCase() ||
      !Number.isSafeInteger(proof.expiresAt) ||
      proof.expiresAt >= at
    )
      throw new GatewayLedgerError(
        'WRONG_STATE',
        'expiry proof does not cover this salt',
      );
    const current = await this.intent(salt);
    if (!current) throw new GatewayLedgerError('WRONG_STATE', 'unknown salt');
    return withTransaction(this.pool, async (c) => {
      // Same account-first lock order as reserve/observe.
      await c.query(
        'SELECT account_id FROM synq_gateway_accounts WHERE account_id=$1 FOR UPDATE',
        [current.accountId],
      );
      const r = await c.query(
        `UPDATE synq_gateway_burn_intents SET state='RELEASED', updated_at=$2
         WHERE salt=$1 AND state='SUBMITTED' RETURNING account_id, value`,
        [salt.toLowerCase(), at],
      );
      const x = r.rows[0];
      if (!x) return 'NEEDS_REVIEW' as const;
      await c.query(
        `UPDATE synq_gateway_accounts SET reserved=reserved-$2, available=available+$2, updated_at=$3 WHERE account_id=$1`,
        [x.account_id, x.value, at],
      );
      return 'RELEASED' as const;
    });
  }

  /** Destination mint reconciled: the reservation is consumed once. */
  async settle(salt: Hex, mintTx: Hex, at: number) {
    await withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE synq_gateway_burn_intents SET state='SETTLED', mint_tx=$2, updated_at=$3
         WHERE salt=$1 AND state='ATTESTED' RETURNING account_id, value`,
        [salt.toLowerCase(), mintTx.toLowerCase(), at],
      );
      const x = r.rows[0];
      if (!x) return;
      await c.query(
        `UPDATE synq_gateway_accounts SET reserved = reserved - $2, updated_at=$3 WHERE account_id=$1`,
        [x.account_id, x.value, at],
      );
    });
  }
}
