import {
  fromJsonb,
  toJsonb,
  withTransaction,
  type SqlPool,
} from '@synq/domain/pg';
import type { ExecutionGrant } from '@synq/kernel/arc';
import { ArcExecutionError } from './arc.js';
import type { SignedCall } from './cctp.js';
import type { EscrowBroadcast, EscrowBroadcastJournal } from './escrow.js';
import { PostgresGrantFence } from './pg-outbox.js';

/** Durable grant admission and immutable signed-call journal for escrow. */
export class PostgresEscrowJournal implements EscrowBroadcastJournal {
  constructor(readonly pool: SqlPool) {}

  async admit(grant: ExecutionGrant, at: number): Promise<boolean> {
    return withTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `escrow-nonce:${grant.nonce.toLowerCase()}`,
      ]);
      const revoked = await c.query(
        'SELECT 1 FROM synq_revoked_grants WHERE nonce=$1',
        [grant.nonce.toLowerCase()],
      );
      if (revoked.rows.length) return false;
      const prior = await c.query(
        'SELECT grant_data FROM synq_escrow_admissions WHERE grant_id=$1',
        [grant.grantId],
      );
      if (prior.rows[0]) {
        const known = fromJsonb<ExecutionGrant>(prior.rows[0].grant_data);
        if (
          known.mac !== grant.mac ||
          known.intentId !== grant.intentId ||
          known.nonce !== grant.nonce
        )
          throw new ArcExecutionError(
            'TX_MISMATCH',
            'escrow grant differs from durable admission',
          );
        return true;
      }
      const txPool: SqlPool = {
        query: c.query.bind(c),
        connect: async () => {
          throw new Error('nested transaction');
        },
      };
      if (!(await new PostgresGrantFence(txPool).consumeGrant(grant, at)))
        return false;
      await c.query('INSERT INTO synq_escrow_admissions VALUES ($1,$2)', [
        grant.grantId,
        toJsonb(grant),
      ]);
      return true;
    });
  }

  async signed(key: string): Promise<SignedCall | null> {
    const r = await this.pool.query(
      'SELECT data FROM synq_escrow_signed_calls WHERE call_key=$1',
      [key],
    );
    return r.rows[0] ? fromJsonb<SignedCall>(r.rows[0].data) : null;
  }

  async storeSigned(key: string, call: SignedCall): Promise<SignedCall> {
    return withTransaction(this.pool, async (c) => {
      const grantId = key.slice(0, key.lastIndexOf(':'));
      const admission = await c.query(
        'SELECT grant_data FROM synq_escrow_admissions WHERE grant_id=$1',
        [grantId],
      );
      if (admission.rows[0]) {
        const g = fromJsonb<ExecutionGrant>(admission.rows[0].grant_data);
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `escrow-nonce:${g.nonce.toLowerCase()}`,
        ]);
        if (
          (
            await c.query('SELECT 1 FROM synq_revoked_grants WHERE nonce=$1', [
              g.nonce.toLowerCase(),
            ])
          ).rows.length
        )
          throw new ArcExecutionError(
            'TX_MISMATCH',
            'escrow grant revoked before recording',
          );
      }
      await c.query(
        `INSERT INTO synq_escrow_signed_calls VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (call_key) DO NOTHING`,
        [
          key,
          call.chainId,
          call.from.toLowerCase(),
          call.nonce,
          call.hash,
          toJsonb(call),
        ],
      );
      const stored = await c.query(
        'SELECT data FROM synq_escrow_signed_calls WHERE call_key=$1',
        [key],
      );
      return fromJsonb<SignedCall>(stored.rows[0]!.data);
    });
  }

  async record(entry: EscrowBroadcast) {
    await this.pool.query(
      'INSERT INTO synq_escrow_broadcasts VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [entry.hash, toJsonb(entry)],
    );
  }

  async forGrant(grantId: string): Promise<EscrowBroadcast[]> {
    const r = await this.pool.query(
      "SELECT data FROM synq_escrow_broadcasts WHERE data->>'grantId'=$1",
      [grantId],
    );
    const entries = r.rows.map((x) => fromJsonb<EscrowBroadcast>(x.data));
    const signed = await this.pool.query(
      "SELECT call_key,data FROM synq_escrow_signed_calls WHERE left(call_key,length($1)+1)=$1 || ':'",
      [grantId],
    );
    for (const row of signed.rows) {
      const call = fromJsonb<SignedCall>(row.data);
      if (!entries.some((e) => e.hash === call.hash))
        entries.push({
          grantId,
          step: String(row.call_key).slice(
            grantId.length + 1,
          ) as EscrowBroadcast['step'],
          label: 'durable signed escrow call (broadcast outcome unknown)',
          hash: call.hash,
          from: call.from,
          chainId: call.chainId,
        });
    }
    return entries;
  }
}
