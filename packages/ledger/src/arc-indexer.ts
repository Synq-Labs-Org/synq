import type { Account, JournalEntry, Ledger } from './index.js';

/**
 * Turns registry-token Transfer logs touching one wallet into cash postings.
 *
 * - Only logs emitted by the registry token count. Arc also emits a native
 *   mirror Transfer for the same movement; counting both would double cash.
 * - Each log posts once, keyed by (chain, tx, logIndex, blockHash), so a
 *   duplicate delivery is a no-op.
 * - A `removed` log (reorg) reverses exactly the entry for that block; if the
 *   transaction is re-included in another block it posts again under the new
 *   block hash. Replaying any interleaving of the same canonical logs therefore
 *   lands on the same balances as a clean rebuild.
 */

export type IndexedTransferLog = Readonly<{
  chainId: number;
  blockNumber: bigint;
  blockHash: `0x${string}`;
  txHash: `0x${string}`;
  logIndex: number;
  removed: boolean;
  token: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
}>;

export type CashClassification = Readonly<{
  counterAccount: Account;
  memo: string;
  counterpartyId?: string;
}>;

export type IndexerConfig = Readonly<{
  workspaceId: string;
  wallet: `0x${string}`;
  assetId: string;
  token: `0x${string}`;
  chainId: number;
  classify: (
    log: IndexedTransferLog,
    direction: 'IN' | 'OUT',
  ) => CashClassification;
}>;

const lower = (a: string) => a.toLowerCase();

export class ArcCashIndexer {
  private tombstones = new Set<string>();
  constructor(
    readonly ledger: Ledger,
    readonly cfg: IndexerConfig,
  ) {}

  private key(l: IndexedTransferLog) {
    return `idx:${l.chainId}:${lower(l.txHash)}:${l.logIndex}:${lower(l.blockHash)}`;
  }

  /** Returns what happened, for audit: POSTED, DUPLICATE, REVERSED, IGNORED. */
  async ingest(
    l: IndexedTransferLog,
  ): Promise<'POSTED' | 'DUPLICATE' | 'REVERSED' | 'IGNORED'> {
    if (
      l.chainId !== this.cfg.chainId ||
      lower(l.token) !== lower(this.cfg.token)
    )
      return 'IGNORED';
    const w = lower(this.cfg.wallet);
    const direction =
      lower(l.to) === w ? 'IN' : lower(l.from) === w ? 'OUT' : null;
    if (!direction || lower(l.from) === lower(l.to)) return 'IGNORED';
    const key = this.key(l);
    if (l.removed) {
      this.tombstones.add(key);
      const existing = await this.ledger.store.get(key);
      if (!existing || (await this.ledger.store.reversed(key)))
        return 'IGNORED';
      await this.ledger.reverse(
        key,
        `reorg removed block ${l.blockHash}`,
        Number(l.blockNumber),
      );
      return 'REVERSED';
    }
    if (this.tombstones.has(key)) return 'IGNORED';
    const c = this.cfg.classify(l, direction);
    const sign = direction === 'IN' ? 1n : -1n;
    const entry: JournalEntry = {
      entryId: key,
      workspaceId: this.cfg.workspaceId,
      occurredAt: Number(l.blockNumber),
      memo: c.memo,
      source: { kind: 'CHAIN_TX', ref: l.txHash },
      evidence: {
        chainId: l.chainId,
        txHash: l.txHash,
        logIndex: l.logIndex,
        recipient: l.to,
      },
      idempotencyKey: key,
      postings: [
        {
          account: 'CASH_ARC_USDC',
          assetId: this.cfg.assetId,
          amount: sign * l.value,
        },
        {
          account: c.counterAccount,
          assetId: this.cfg.assetId,
          amount: -sign * l.value,
          ...(c.counterpartyId ? { counterpartyId: c.counterpartyId } : {}),
        },
      ],
      reversalOf: null,
    };
    const r = await this.ledger.post(entry);
    return r.created ? 'POSTED' : 'DUPLICATE';
  }
}
