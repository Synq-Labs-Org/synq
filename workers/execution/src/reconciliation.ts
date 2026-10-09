import { ExecutionError, parseOrThrow, type TxState } from '@synq/domain';
import type { GrantClaim, Kernel } from '@synq/kernel';
import {
  JournalEntrySchema,
  type ExecutionJournal,
  type JournalEntry,
  type JournaledBroadcaster,
} from './journal.js';

export async function submitGrantTransaction(
  kernel: Pick<Kernel, 'recordSubmission'>,
  claim: GrantClaim,
  broadcaster: JournaledBroadcaster,
  rawEntry: JournalEntry,
): Promise<JournalEntry> {
  const entry = parseOrThrow(JournalEntrySchema, rawEntry);
  if (entry.grantId !== claim.grantId || entry.state !== 'SIGNED')
    throw new ExecutionError('INVALID_NEW_SUBMISSION');
  const existing = broadcaster.journal.get(entry.grantId);
  if (existing && existing.transactionHash !== entry.transactionHash)
    throw new ExecutionError('GRANT_REPREPARATION_FORBIDDEN');
  kernel.recordSubmission(claim, entry.transactionHash);
  return broadcaster.submit(entry);
}

export interface ReorgSignal {
  id: string;
  chainId: number;
  transactionHash: string;
  status: 'OPEN' | 'RESOLVED';
}
export interface ReorgSignalSource {
  openSignals(): Promise<readonly ReorgSignal[]>;
}
export type ReorgSyncResult = {
  reopened: `0x${string}`[];
  held: `0x${string}`[];
  reconfirmed: `0x${string}`[];
  unresolved: `0x${string}`[];
};

const REOPENABLE: readonly TxState[] = [
  'INCLUDED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'SETTLED',
];

export class ReorgReconciler {
  constructor(
    private readonly broadcaster: JournaledBroadcaster,
    private readonly signals: ReorgSignalSource,
    private readonly chainId: number,
  ) {}
  private get journal(): ExecutionJournal {
    return this.broadcaster.journal;
  }
  private reopenedByReorg(grantId: `0x${string}`): boolean {
    return this.journal
      .history(grantId)
      .some(
        (t) =>
          t.to === 'RECONCILIATION_REQUIRED' && REOPENABLE.includes(t.from),
      );
  }
  async sync(): Promise<ReorgSyncResult> {
    const open = new Set(
      (await this.signals.openSignals())
        .filter((s) => s.status === 'OPEN' && s.chainId === this.chainId)
        .map((s) => s.transactionHash.toLowerCase()),
    );
    const result: ReorgSyncResult = {
      reopened: [],
      held: [],
      reconfirmed: [],
      unresolved: [],
    };
    for (const grantId of this.journal.grantIds())
      await this.journal.withGrantLock(grantId, async () => {
        const entry = this.journal.get(grantId);
        if (!entry || entry.chainId !== this.chainId) return;
        if (open.has(entry.transactionHash.toLowerCase())) {
          if (REOPENABLE.includes(entry.state)) {
            this.journal.update(grantId, {
              state: 'RECONCILIATION_REQUIRED',
              blockNumber: null,
            });
            result.reopened.push(grantId);
          } else result.held.push(grantId);
          return;
        }
        if (
          (entry.state === 'RECONCILIATION_REQUIRED' ||
            entry.state === 'INCLUDED') &&
          this.reopenedByReorg(grantId)
        ) {
          const after = await this.broadcaster.reconcile(grantId);
          (after.state === 'CONFIRMED'
            ? result.reconfirmed
            : result.unresolved
          ).push(grantId);
        }
      });
    return result;
  }
}
