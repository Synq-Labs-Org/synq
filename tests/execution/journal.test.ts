import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { describe, it, expect } from 'vitest';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  type JournalEntry,
} from '../../workers/execution/src/journal.js';
const raw = '0x1234' as const;
function fixture(): JournalEntry {
  return {
    schemaVersion: 1,
    grantId: `0x${'1'.repeat(64)}`,
    transactionHash: keccak256(raw),
    rawTransaction: raw,
    state: 'SIGNED',
    chainId: 31337,
    blockNumber: null,
  };
}
describe('durable submission boundary', () => {
  it('timeout after broadcast does not resubmit after restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synq-journal-'));
    let calls = 0;
    let receipt: { status: 'success'; blockNumber: bigint } | null = null;
    const port = {
      sendRawTransaction: async () => {
        calls++;
        throw new Error('timeout after accepted');
      },
      receipt: async () => receipt,
    };
    try {
      const first = new JournaledBroadcaster(new ExecutionJournal(dir), port);
      expect((await first.submit(fixture())).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      const restarted = new JournaledBroadcaster(
        new ExecutionJournal(dir),
        port,
      );
      expect((await restarted.submit(fixture())).state).toBe(
        'RECONCILIATION_REQUIRED',
      );
      expect(calls).toBe(1);
      receipt = { status: 'success', blockNumber: 10n };
      expect((await restarted.submit(fixture())).state).toBe('CONFIRMED');
      expect(calls).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('exclusive claim prevents concurrent broadcasts and forged raw hash', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'synq-journal-'));
    let calls = 0;
    try {
      const journal = new ExecutionJournal(dir);
      expect(() =>
        journal.create({
          ...fixture(),
          transactionHash: `0x${'0'.repeat(64)}`,
        }),
      ).toThrow();
      const worker = new JournaledBroadcaster(journal, {
        sendRawTransaction: async () => {
          calls++;
          await Promise.resolve();
          return keccak256(raw);
        },
        receipt: async () => null,
      });
      const outcomes = await Promise.allSettled([
        worker.submit(fixture()),
        worker.submit(fixture()),
      ]);
      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
      expect(calls).toBe(1);
      await expect(
        worker.submit({
          ...fixture(),
          rawTransaction: '0x5678',
          transactionHash: keccak256('0x5678'),
        }),
      ).rejects.toThrow('GRANT_REPREPARATION_FORBIDDEN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
