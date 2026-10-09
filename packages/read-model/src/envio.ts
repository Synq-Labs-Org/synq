import { ChainEventSchema, type ChainEvent } from './index.js';
import { type SqlConnection, type PostgresReadModel } from './storage.js';

export type IndexedProof = {
  chainId: number;
  indexedThroughBlock: number;
  sourceBlock: number;
  events: ChainEvent[];
};
export async function readEnvioProof(
  db: SqlConnection,
  chainId: number,
  schema = 'public',
): Promise<IndexedProof> {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema))
    throw new Error('Invalid Envio database schema');
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const progress = await db.query(
      `SELECT progress_block,source_block FROM "${schema}".envio_chains WHERE id=$1`,
      [chainId],
    );
    const row = progress.rows[0];
    if (!row) throw new Error('Envio chain not initialized');
    const indexedThroughBlock = Number(row.progress_block),
      sourceBlock = Number(row.source_block);
    if (
      !Number.isSafeInteger(indexedThroughBlock) ||
      indexedThroughBlock < 0 ||
      !Number.isSafeInteger(sourceBlock) ||
      sourceBlock < indexedThroughBlock
    )
      throw new Error('Invalid Envio progress');
    const rows = await db.query(
      `SELECT "eventJson" FROM "${schema}"."ChainEvent" WHERE "chainId"=$1 AND "blockNumber"<=$2 ORDER BY "blockNumber","transactionIndex","logIndex"`,
      [chainId, indexedThroughBlock],
    );
    const events = rows.rows.map((x) =>
      ChainEventSchema.parse(JSON.parse(String(x.eventJson))),
    );
    if (
      events.some(
        (x) => x.chainId !== chainId || x.blockNumber > indexedThroughBlock,
      )
    )
      throw new Error('Inconsistent Envio proof');
    await db.query('COMMIT');
    return { chainId, indexedThroughBlock, sourceBlock, events };
  } catch (error) {
    await db.query('ROLLBACK');
    throw error;
  }
}

export async function syncEnvioProjection(
  sourceDb: SqlConnection,
  target: PostgresReadModel,
  schema = 'public',
): Promise<IndexedProof> {
  const proof = await readEnvioProof(sourceDb, target.chainId, schema);
  await target.rebuildFromProof(proof.events, proof.indexedThroughBlock);
  return proof;
}
