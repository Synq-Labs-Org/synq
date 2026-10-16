import type { Address, Hex } from 'viem';
import {
  applyMigrations,
  withTransaction,
  type Migration,
  type SqlPool,
} from '@synq/domain/pg';
import {
  ArcIndexerError,
  type ArcIndexStore,
  type ChainBlock,
  type IndexedEvent,
  type IndexedEventKind,
  type StreamCursor,
} from './arc-chain-indexer.js';

/**
 * Postgres state of the Arc indexer service. Own migrations table:
 * `synq_arc_indexer_migrations`. One live event per (stream, chain, tx, log
 * index, kind); removed (reorged) rows are kept with provenance for audit.
 */
export const ARC_INDEXER_MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    up: `CREATE TABLE IF NOT EXISTS synq_arc_index_cursors (
      stream text PRIMARY KEY,
      block_number bigint NOT NULL,
      block_hash text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS synq_arc_index_blocks (
      stream text NOT NULL,
      block_number bigint NOT NULL,
      block_hash text NOT NULL,
      parent_hash text NOT NULL,
      PRIMARY KEY (stream, block_number));
    CREATE TABLE IF NOT EXISTS synq_arc_index_events (
      id bigserial PRIMARY KEY,
      stream text NOT NULL,
      chain_id int NOT NULL,
      kind text NOT NULL CHECK (kind IN ('TRANSFER','MEMO')),
      block_number bigint NOT NULL,
      block_hash text NOT NULL,
      tx_hash text NOT NULL,
      log_index int NOT NULL,
      emitter text NOT NULL,
      data jsonb NOT NULL,
      removed boolean NOT NULL DEFAULT false,
      removed_at timestamptz,
      effected_at timestamptz,
      effect_outcome text,
      effect_reversed_at timestamptz,
      effect_reversal text,
      ingested_at timestamptz NOT NULL DEFAULT now());
    CREATE UNIQUE INDEX IF NOT EXISTS synq_arc_index_events_once
      ON synq_arc_index_events (stream, chain_id, tx_hash, log_index, kind) WHERE NOT removed;
    CREATE INDEX IF NOT EXISTS synq_arc_index_events_pending
      ON synq_arc_index_events (stream, id) WHERE effected_at IS NULL OR (removed AND effect_reversed_at IS NULL);`,
    down: `DROP TABLE IF EXISTS synq_arc_index_events;
    DROP TABLE IF EXISTS synq_arc_index_blocks;
    DROP TABLE IF EXISTS synq_arc_index_cursors;`,
  },
];

export const migrateArcIndexer = (pool: SqlPool, target?: number) =>
  applyMigrations(
    pool,
    'synq_arc_indexer_migrations',
    ARC_INDEXER_MIGRATIONS,
    target,
  );

const eventOf = (r: Record<string, unknown>): IndexedEvent =>
  Object.freeze({
    id: Number(r.id),
    chainId: Number(r.chain_id),
    kind: r.kind as IndexedEventKind,
    blockNumber: BigInt(r.block_number as string),
    blockHash: r.block_hash as Hex,
    txHash: r.tx_hash as Hex,
    logIndex: Number(r.log_index),
    emitter: r.emitter as Address,
    data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data) as Record<
      string,
      string
    >,
    removed: Boolean(r.removed),
  });

const EVENT_COLUMNS =
  'id, chain_id, kind, block_number, block_hash, tx_hash, log_index, emitter, data, removed';

export class PostgresArcIndexStore implements ArcIndexStore {
  constructor(readonly pool: SqlPool) {}

  async migrate() {
    await migrateArcIndexer(this.pool);
  }

  async cursor(stream: string): Promise<StreamCursor | null> {
    const r = await this.pool.query(
      'SELECT block_number, block_hash FROM synq_arc_index_cursors WHERE stream=$1',
      [stream],
    );
    const x = r.rows[0];
    return x
      ? { block: BigInt(x.block_number as string), hash: x.block_hash as Hex }
      : null;
  }

  async blockHash(stream: string, n: bigint) {
    const r = await this.pool.query(
      'SELECT block_hash FROM synq_arc_index_blocks WHERE stream=$1 AND block_number=$2',
      [stream, n.toString()],
    );
    return (r.rows[0]?.block_hash as Hex | undefined) ?? null;
  }

  async recordedBlocksDesc(stream: string, below: bigint, limit: number) {
    const r = await this.pool.query(
      `SELECT block_number, block_hash FROM synq_arc_index_blocks
       WHERE stream=$1 AND block_number <= $2 ORDER BY block_number DESC LIMIT $3`,
      [stream, below.toString(), limit],
    );
    return r.rows.map((x) => ({
      number: BigInt(x.block_number as string),
      hash: x.block_hash as Hex,
    }));
  }

  async commit(
    stream: string,
    expected: StreamCursor | null,
    next: StreamCursor,
    blocks: readonly ChainBlock[],
    events: readonly IndexedEvent[],
  ) {
    return withTransaction(this.pool, async (c) => {
      const moved = expected
        ? await c.query(
            `UPDATE synq_arc_index_cursors SET block_number=$4, block_hash=$5, updated_at=now()
             WHERE stream=$1 AND block_number=$2 AND block_hash=$3 RETURNING stream`,
            [
              stream,
              expected.block.toString(),
              expected.hash,
              next.block.toString(),
              next.hash,
            ],
          )
        : await c.query(
            `INSERT INTO synq_arc_index_cursors (stream, block_number, block_hash)
             VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING stream`,
            [stream, next.block.toString(), next.hash],
          );
      if (!moved.rows.length)
        throw new ArcIndexerError(
          'CONCURRENT_INDEXER',
          `cursor of ${stream} moved; another indexer owns this stream`,
        );
      if (blocks.length)
        await c.query(
          `INSERT INTO synq_arc_index_blocks (stream, block_number, block_hash, parent_hash)
           SELECT $1, x.n::bigint, x.h, x.p FROM jsonb_to_recordset($2::jsonb) AS x(n text, h text, p text)
           ON CONFLICT DO NOTHING`,
          [
            stream,
            JSON.stringify(
              blocks.map((b) => ({
                n: b.number.toString(),
                h: b.hash,
                p: b.parentHash,
              })),
            ),
          ],
        );
      let inserted = 0;
      if (events.length) {
        const r = await c.query(
          `INSERT INTO synq_arc_index_events
             (stream, chain_id, kind, block_number, block_hash, tx_hash, log_index, emitter, data)
           SELECT $1, x.chain_id, x.kind, x.block_number::bigint, x.block_hash, x.tx_hash, x.log_index, x.emitter, x.data
           FROM jsonb_to_recordset($2::jsonb) AS x(chain_id int, kind text, block_number text,
             block_hash text, tx_hash text, log_index int, emitter text, data jsonb)
           ON CONFLICT DO NOTHING RETURNING id`,
          [
            stream,
            JSON.stringify(
              events.map((e) => ({
                chain_id: e.chainId,
                kind: e.kind,
                block_number: e.blockNumber.toString(),
                block_hash: e.blockHash.toLowerCase(),
                tx_hash: e.txHash.toLowerCase(),
                log_index: e.logIndex,
                emitter: e.emitter.toLowerCase(),
                data: e.data,
              })),
            ),
          ],
        );
        inserted = r.rows.length;
      }
      return { inserted, duplicates: events.length - inserted };
    });
  }

  async rollback(stream: string, fork: StreamCursor) {
    return withTransaction(this.pool, async (c) => {
      const r = await c.query(
        `UPDATE synq_arc_index_events SET removed=true, removed_at=now()
         WHERE stream=$1 AND block_number > $2 AND NOT removed RETURNING id`,
        [stream, fork.block.toString()],
      );
      await c.query(
        'DELETE FROM synq_arc_index_blocks WHERE stream=$1 AND block_number > $2',
        [stream, fork.block.toString()],
      );
      await c.query(
        `UPDATE synq_arc_index_cursors SET block_number=$2, block_hash=$3, updated_at=now() WHERE stream=$1`,
        [stream, fork.block.toString(), fork.hash],
      );
      return r.rows.length;
    });
  }

  async pendingEffects(stream: string, limit: number) {
    const r = await this.pool.query(
      `SELECT ${EVENT_COLUMNS} FROM synq_arc_index_events
       WHERE stream=$1 AND ((NOT removed AND effected_at IS NULL)
         OR (removed AND effect_reversed_at IS NULL))
       ORDER BY id LIMIT $2`,
      [stream, limit],
    );
    return r.rows.map(eventOf);
  }

  async markEffected(stream: string, id: number, outcome: string) {
    await this.pool.query(
      `UPDATE synq_arc_index_events SET
         effected_at = CASE WHEN removed THEN effected_at ELSE now() END,
         effect_outcome = CASE WHEN removed THEN effect_outcome ELSE $3 END,
         effect_reversed_at = CASE WHEN removed THEN now() ELSE NULL END,
         effect_reversal = CASE WHEN removed THEN $3 ELSE NULL END
       WHERE stream=$1 AND id=$2`,
      [stream, id, outcome],
    );
  }

  /** Live events of a stream (for reconciliation and audit). */
  async events(stream: string, kind?: IndexedEventKind) {
    const r = await this.pool.query(
      `SELECT ${EVENT_COLUMNS} FROM synq_arc_index_events
       WHERE stream=$1 AND NOT removed AND ($2::text IS NULL OR kind=$2) ORDER BY block_number, log_index`,
      [stream, kind ?? null],
    );
    return r.rows.map(eventOf);
  }
}
