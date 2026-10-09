import { z } from 'zod';
import { ReadModelError, fail } from './errors.js';
import type { Projector, WindowOutcome } from './projector.js';
import type { SqlConnection, SqlTarget } from './storage.js';

export interface EnvioProgress {
  chainId: number;
  startBlock: number;
  progressBlock: number;
  sourceBlock: number;
  maxReorgDepth: number;
}
export interface IndexedProofSource {
  readonly chainId: number;
  read(
    plan: (progress: EnvioProgress) => { from: number; to: number } | null,
  ): Promise<{ progress: EnvioProgress; events: unknown[] } | null>;
}

const int = (v: unknown, name: string) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isSafeInteger(n))
    throw new ReadModelError('SOURCE_UNAVAILABLE', `invalid Envio ${name}`);
  return n;
};
const EventRow = z.object({ eventJson: z.string().min(2) });

export class EnvioPostgresSource implements IndexedProofSource {
  constructor(
    private readonly target: SqlTarget,
    readonly chainId: number,
    readonly schema: string,
    readonly entityTable = 'ChainEvent',
  ) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema))
      throw new ReadModelError('CONFIG_MISMATCH', 'invalid Envio schema');
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(entityTable))
      throw new ReadModelError('CONFIG_MISMATCH', 'invalid Envio table');
  }
  private async withDb<T>(fn: (db: SqlConnection) => Promise<T>): Promise<T> {
    if ('client' in this.target) return fn(this.target.client);
    const client = await this.target.pool.connect();
    try {
      const out = await fn(client);
      client.release();
      return out;
    } catch (error) {
      client.release(error instanceof Error ? error : true);
      throw error;
    }
  }
  async progress(): Promise<EnvioProgress | null> {
    return this.withDb((db) => this.readProgress(db));
  }
  private async readProgress(db: SqlConnection): Promise<EnvioProgress | null> {
    let rows: Record<string, unknown>[];
    try {
      ({ rows } = await db.query(
        `SELECT start_block, progress_block, source_block, max_reorg_depth FROM "${this.schema}".envio_chains WHERE id=$1`,
        [this.chainId],
      ));
    } catch (error) {
      throw new ReadModelError('SOURCE_UNAVAILABLE', 'Envio tables missing', {
        cause: error,
      });
    }
    const row = rows[0];
    if (!row) return null;
    const progress = {
      chainId: this.chainId,
      startBlock: int(row.start_block, 'start_block'),
      progressBlock: int(row.progress_block, 'progress_block'),
      sourceBlock: int(row.source_block, 'source_block'),
      maxReorgDepth: int(row.max_reorg_depth, 'max_reorg_depth'),
    };
    if (progress.startBlock < 0)
      throw new ReadModelError('SOURCE_UNAVAILABLE', 'invalid Envio start');
    return progress;
  }
  async read(
    plan: (progress: EnvioProgress) => { from: number; to: number } | null,
  ): Promise<{ progress: EnvioProgress; events: unknown[] } | null> {
    return this.withDb(async (db) => {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const progress = await this.readProgress(db);
        const range = progress ? plan(progress) : null;
        let events: unknown[] = [];
        if (progress && range) {
          const { rows } = await db.query(
            `SELECT "eventJson" FROM "${this.schema}"."${this.entityTable}" WHERE "chainId"=$1 AND "blockNumber">$2 AND "blockNumber"<=$3 ORDER BY "blockNumber","transactionIndex","logIndex"`,
            [this.chainId, range.from, range.to],
          );
          events = rows.map((r) => {
            const parsed = EventRow.safeParse(r);
            if (!parsed.success)
              throw new ReadModelError('INCONSISTENT_PROOF', 'Envio row shape');
            try {
              return JSON.parse(parsed.data.eventJson) as unknown;
            } catch {
              throw new ReadModelError('INCONSISTENT_PROOF', 'Envio row JSON');
            }
          });
        }
        await db.query('COMMIT');
        return progress ? { progress, events } : null;
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
    });
  }
}

export interface SyncOptions {
  maxBlocksPerSync?: number;
  untilBlock?: number;
}

export async function syncOnce(
  source: IndexedProofSource,
  projector: Projector,
  options: SyncOptions = {},
): Promise<WindowOutcome | null> {
  const config = projector.config;
  if (source.chainId !== config.chainId)
    fail('CONFIG_MISMATCH', 'source/projection chain mismatch');
  const cp = (await projector.checkpoint()).indexedThroughBlock;
  const span = options.maxBlocksPerSync ?? 5000;
  let window: { from: number; to: number; progress: number } | null = null;
  const read = await source.read((p) => {
    if (p.startBlock > config.startBlock)
      fail(
        'CONFIG_MISMATCH',
        `indexer starts at ${p.startBlock}, after deployment block ${config.startBlock}`,
      );
    const target =
      options.untilBlock === undefined
        ? p.progressBlock
        : Math.min(p.progressBlock, options.untilBlock);
    if (target < config.startBlock - 1) return null;
    if (target < cp) {
      if (options.untilBlock !== undefined && target === options.untilBlock)
        return null;
      if (cp - target > config.reorgWindowBlocks)
        fail(
          'CHECKPOINT_REGRESSION',
          `indexer progress ${target} is ${cp - target} blocks behind the projection; explicit rebuild required`,
        );
    }
    const from = Math.max(
      config.startBlock - 1,
      Math.min(cp, target) - config.reorgWindowBlocks,
    );
    const to = Math.min(target, Math.max(cp, from) + span);
    window = { from, to, progress: p.progressBlock };
    return { from, to };
  });
  if (!read || !window) return null;
  const w: { from: number; to: number; progress: number } = window;
  return projector.applyWindow({
    fromBlockExclusive: w.from,
    toBlockInclusive: w.to,
    events: read.events,
    sourceProgressBlock: w.to < cp ? w.to : undefined,
  });
}

export async function syncToTarget(
  source: IndexedProofSource,
  projector: Projector,
  options: SyncOptions = {},
): Promise<WindowOutcome[]> {
  const outcomes: WindowOutcome[] = [];
  let previous = -1;
  for (;;) {
    const out = await syncOnce(source, projector, options);
    if (!out) break;
    outcomes.push(out);
    const read = await source.read(() => null);
    const target = Math.min(
      read?.progress.progressBlock ?? 0,
      options.untilBlock ?? Number.MAX_SAFE_INTEGER,
    );
    if (
      out.indexedThroughBlock >= target ||
      out.indexedThroughBlock === previous
    )
      break;
    previous = out.indexedThroughBlock;
  }
  return outcomes;
}
