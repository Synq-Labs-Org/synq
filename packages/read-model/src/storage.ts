import { readFile } from 'node:fs/promises';
import type { Address } from 'viem';
import {
  DeterministicReadModel,
  ChainEventSchema,
  encodeJson,
  eventId,
  type GroupBinding,
  type GroupSnapshot,
  type ChainEvent,
} from './index.js';

export interface SqlConnection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface RedisConnection {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options: { EX: number }): Promise<unknown>;
}

export class PostgresReadModel {
  constructor(
    readonly db: SqlConnection,
    readonly chainId: number,
    readonly treasuryToken: Address,
    readonly bindings: readonly GroupBinding[],
  ) {}
  async migrate(): Promise<void> {
    await this.db.query(
      await readFile(
        new URL('../sql/001-read-model.sql', import.meta.url),
        'utf8',
      ),
    );
  }
  async ingest(
    events: readonly unknown[],
    checkpoint: number,
    rollbackFrom?: number,
  ): Promise<void> {
    await this.db.query('BEGIN');
    try {
      await this.db.query('SELECT pg_advisory_xact_lock($1)', [this.chainId]);
      const stored = await this.db.query(
        'SELECT * FROM synq_projection_checkpoint WHERE chain_id=$1 FOR UPDATE',
        [this.chainId],
      );
      const row = stored.rows[0];
      const bindingJson = encodeJson({
        treasuryToken: this.treasuryToken.toLowerCase(),
        bindings: this.bindings,
      });
      if (
        row &&
        canonical(row.binding_json) !== canonical(JSON.parse(bindingJson))
      )
        throw new Error(
          'Projection binding changed; explicit rebuild required',
        );
      const journal = await this.db.query(
        'SELECT event_json FROM synq_chain_event WHERE chain_id=$1',
        [this.chainId],
      );
      const model = new DeterministicReadModel(
        this.chainId,
        this.treasuryToken,
        this.bindings,
      );
      model.rebuild(
        journal.rows.map((x) => x.event_json),
        Number(row?.indexed_through_block ?? 0),
      );
      if (rollbackFrom !== undefined) model.rollback(rollbackFrom);
      model.ingest(events, checkpoint);
      await this.db.query('DELETE FROM synq_chain_event WHERE chain_id=$1', [
        this.chainId,
      ]);
      for (const e of model.events())
        await this.db.query(
          'INSERT INTO synq_chain_event(chain_id,id,block_number,event_json) VALUES($1,$2,$3,$4)',
          [this.chainId, eventId(e), e.blockNumber, encodeJson(e)],
        );
      await this.db.query(
        'DELETE FROM synq_group_projection WHERE chain_id=$1',
        [this.chainId],
      );
      for (const b of this.bindings)
        await this.db.query(
          'INSERT INTO synq_group_projection(chain_id,group_id,state_json) VALUES($1,$2,$3)',
          [
            this.chainId,
            b.groupId.toLowerCase(),
            encodeJson(model.snapshot(b.groupId, checkpoint, 0)),
          ],
        );
      await this.db.query(
        'INSERT INTO synq_projection_checkpoint(chain_id,indexed_through_block,revision,binding_json) VALUES($1,$2,$3,$4) ON CONFLICT(chain_id) DO UPDATE SET indexed_through_block=EXCLUDED.indexed_through_block,revision=EXCLUDED.revision,binding_json=EXCLUDED.binding_json',
        [this.chainId, checkpoint, Number(row?.revision ?? 0) + 1, bindingJson],
      );
      await this.db.query('COMMIT');
    } catch (error) {
      await this.db.query('ROLLBACK');
      throw error;
    }
  }
  async snapshot(
    groupId: string,
    head: number,
    now: number,
  ): Promise<GroupSnapshot> {
    const result = await this.db.query(
      "SELECT s.state_json,c.indexed_through_block,c.revision,c.binding_json,(SELECT COALESCE(jsonb_agg(e.event_json),'[]'::jsonb) FROM synq_chain_event e WHERE e.chain_id=s.chain_id) AS proof_json FROM synq_group_projection s JOIN synq_projection_checkpoint c USING(chain_id) WHERE s.chain_id=$1 AND s.group_id=$2",
      [this.chainId, groupId.toLowerCase()],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Unknown persisted group');
    const checkpoint = Number(row.indexed_through_block);
    const revision = Number(row.revision);
    if (
      !Number.isSafeInteger(checkpoint) ||
      checkpoint < 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      !Number.isSafeInteger(head) ||
      head < checkpoint
    )
      throw new Error('Inconsistent chain head');
    if (
      canonical(row.binding_json) !==
      canonical({
        treasuryToken: this.treasuryToken.toLowerCase(),
        bindings: this.bindings,
      })
    )
      throw new Error('Projection binding mismatch');
    if (!Array.isArray(row.proof_json))
      throw new Error('Missing canonical event proof');
    const rebuilt = new DeterministicReadModel(
      this.chainId,
      this.treasuryToken,
      this.bindings,
    );
    rebuilt.rebuild(row.proof_json, checkpoint);
    const snapshot = rebuilt.snapshot(groupId, head, now);
    const economic = (value: unknown): Record<string, unknown> => {
      if (!value || typeof value !== 'object')
        throw new Error('Invalid materialized state');
      const state = value as Record<string, unknown>;
      return Object.fromEntries(
        [
          'groupId',
          'account',
          'members',
          'mandates',
          'paused',
          'treasuryBalance',
          'executed',
        ].map((key) => [key, state[key]]),
      );
    };
    if (canonical(economic(row.state_json)) !== canonical(economic(snapshot)))
      throw new Error(
        'Materialized state conflicts with canonical event proof',
      );
    return { ...snapshot, generation: revision };
  }
  async rebuildFromProof(
    events: readonly unknown[],
    checkpoint: number,
  ): Promise<void> {
    await this.ingest(events, checkpoint, 0);
  }
}

export class RedisSnapshotCache {
  constructor(
    readonly redis: RedisConnection,
    readonly source: Pick<PostgresReadModel, 'snapshot'>,
    readonly ttlSeconds = 15,
  ) {
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1)
      throw new Error('Invalid cache TTL');
  }
  async snapshot(
    groupId: string,
    head: number,
    now: number,
  ): Promise<GroupSnapshot> {
    const current = await this.source.snapshot(groupId, head, now);
    const key = `synq:snapshot:${current.chainId}:${groupId.toLowerCase()}:${current.generation}`;
    const cached = await this.redis.get(key);
    if (cached) {
      const parsed = JSON.parse(cached) as GroupSnapshot;
      if (
        encodeJson({
          ...parsed,
          generatedAt: now,
          observedHeadBlock: head,
          lagBlocks: head - parsed.indexedThroughBlock,
        }) === encodeJson(current)
      )
        return current;
    }
    await this.redis.set(key, encodeJson(current), { EX: this.ttlSeconds });
    return current;
  }
}

export function parseEnvioEvents(
  rows: readonly { eventJson: string }[],
): ChainEvent[] {
  return rows.map((row) => ChainEventSchema.parse(JSON.parse(row.eventJson)));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, x]) => `${JSON.stringify(key)}:${canonical(x)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
