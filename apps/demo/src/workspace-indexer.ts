import type { Address } from 'viem';
import { contract, token, tokenEntry } from '@synq/chain-registry/arc';
import {
  ArcChainIndexer,
  PostgresArcIndexStore,
  migrateArcIndexer,
  type ArcIndexerConfig,
  type IndexerChain,
} from '@synq/ledger';
import type { WorkspaceReceipts } from '@synq/workspaces/receipts';

/** Discovers new active vaults on every pass; no environment wallet list. */
export class WorkspaceIndexer {
  private after = '';
  private providerOffset = 0;
  constructor(
    readonly receipts: WorkspaceReceipts,
    readonly providers: readonly IndexerChain[],
    readonly config: Pick<
      ArcIndexerConfig,
      'token' | 'memo' | 'batchSize' | 'confirmations'
    > = {
      token: {
        address: token('arc-testnet', 'USDC').address,
        codeHash: tokenEntry(token('arc-testnet', 'USDC')).codeHash!,
      },
      memo: {
        address: contract('arc-testnet', 'MEMO').address,
        codeHash: contract('arc-testnet', 'MEMO').codeHash!,
      },
      batchSize: 2000n,
      confirmations: 0,
    },
  ) {}
  async migrate() {
    await migrateArcIndexer(this.receipts.finance.workspaces.pool);
  }
  async tick() {
    const pool = this.receipts.finance.workspaces.pool;
    const rows = await pool.query(
      "SELECT w.id,w.vault,s.evidence FROM synq_workspaces w JOIN synq_ws_vault_setups s ON s.workspace_id=w.id WHERE w.status='ACTIVE' AND s.state='ACTIVE' AND w.id::text>$1 ORDER BY w.id LIMIT 20",
      [this.after],
    );
    if (!rows.rowCount) {
      this.after = '';
      this.providerOffset = (this.providerOffset + 1) % this.providers.length;
      return [];
    }
    const providers = [
      ...this.providers.slice(this.providerOffset),
      ...this.providers.slice(0, this.providerOffset),
    ];
    const outcomes: { workspaceId: string; state: string }[] = [];
    for (const row of rows.rows) {
      this.after = row.id;
      const evidence = row.evidence;
      if (
        !evidence ||
        evidence.safe?.toLowerCase() !== row.vault.toLowerCase() ||
        !/^[0-9]+$/.test(evidence.blockNumber)
      ) {
        outcomes.push({
          workspaceId: row.id,
          state: 'INVALID_FACTORY_EVIDENCE',
        });
        continue;
      }
      const indexer = new ArcChainIndexer(
        providers,
        new PostgresArcIndexStore(pool),
        {
          ...this.config,
          stream: `workspace:${row.id}`,
          chainId: 5042002,
          wallets: [row.vault as Address],
          startBlock: BigInt(evidence.blockNumber),
        },
      );
      try {
        await indexer.step();
        await indexer.applyEffects({
          TRANSFER: (e) => this.receipts.apply(row.id, indexer.chain, e),
          MEMO: async () => 'MEMO_HANDLED_WITH_TRANSFER',
        });
        outcomes.push({ workspaceId: row.id, state: 'INDEXED' });
      } catch {
        // Keep cursor/effects pending; one failing workspace cannot starve the next.
        outcomes.push({ workspaceId: row.id, state: 'RETRY_OR_REVIEW' });
      }
    }
    return outcomes;
  }
}
