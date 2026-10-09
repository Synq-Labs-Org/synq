import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { describe, it, expect } from 'vitest';
import {
  ACTION_MACHINE,
  ExecutionError,
  TX_MACHINE,
  verifyHistory,
} from '@synq/domain';
import {
  EXECUTION_WORKER_PRINCIPAL,
  ExecutionJournal,
  JournalEntrySchema,
  JournaledBroadcaster,
  type BroadcastPort,
  type JournalEntry,
} from '@synq/execution-worker/journal';
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
type Receipt = Awaited<ReturnType<BroadcastPort['receipt']>>;
function harness(
  receipt: () => Receipt,
  options: { depth?: number; head?: () => bigint } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'synq-journal-'));
  const journal = new ExecutionJournal(dir);
  const head = options.head;
  const port: BroadcastPort = {
    sendRawTransaction: async () => keccak256(raw),
    receipt: async () => receipt(),
    ...(head ? { blockNumber: async () => head() } : {}),
  };
  return {
    dir,
    journal,
    port,
    worker: new JournaledBroadcaster(journal, port, options.depth),
  };
}
describe('journal follows the canonical transaction lifecycle', () => {
  it('DOM-003 records every transition with actor and evidence and never skips SUBMITTED', async () => {
    let receipt: Receipt = null;
    const { dir, journal, worker } = harness(() => receipt);
    const id = fixture().grantId;
    try {
      expect((await worker.submit(fixture())).state).toBe('SUBMITTED');
      receipt = { status: 'success', blockNumber: 7n };
      const done = await worker.reconcile(id);
      expect(done).toMatchObject({
        state: 'CONFIRMED',
        blockNumber: '7',
        outcome: 'SUCCESS',
      });
      const history = journal.history(id);
      expect(history.map((r) => `${r.from}->${r.to}`)).toEqual([
        'PREPARED->SIGNED',
        'SIGNED->SUBMITTED',
        'SUBMITTED->INCLUDED',
        'INCLUDED->CONFIRMED',
      ]);
      expect(verifyHistory(TX_MACHINE, history)).toBe('CONFIRMED');
      for (const record of history) {
        expect(record.actor).toEqual(EXECUTION_WORKER_PRINCIPAL);
        expect(record.evidenceHash).toMatch(/^0x[0-9a-f]{64}$/);
      }
      const events = journal.events(id);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(7);
      expect(events[0]).toMatchObject({
        type: 'execution.transaction.transitioned',
        schemaVersion: 1,
        correlationId: id,
      });
      const actions = journal.actionHistory(id);
      expect(actions.map((r) => `${r.from}->${r.to}`)).toEqual([
        'PREPARED->SIGNED',
        'SIGNED->SUBMITTED',
        'SUBMITTED->CONFIRMED',
      ]);
      expect(verifyHistory(ACTION_MACHINE, actions, 'PREPARED')).toBe(
        'CONFIRMED',
      );
      const actionEvents = events.filter(
        (e) => e.type === 'action.transitioned',
      );
      for (const event of actionEvents)
        expect(events.map((e) => e.eventId)).toContain(event.causationId);
      expect(await worker.reconcile(id)).toEqual(done);
      expect(journal.history(id)).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a reverted receipt is an INCLUDED outcome, not a parallel REVERTED state', async () => {
    const { dir, worker } = harness(() => ({
      status: 'reverted',
      blockNumber: 3n,
    }));
    try {
      await worker.submit(fixture());
      expect(await worker.reconcile(fixture().grantId)).toMatchObject({
        state: 'CONFIRMED',
        outcome: 'REVERTED',
      });
      expect(
        JournalEntrySchema.safeParse({ ...fixture(), state: 'REVERTED' })
          .success,
      ).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('crash recovery from SIGNED passes through RECONCILIATION_REQUIRED before inclusion', async () => {
    const { dir, journal, worker } = harness(() => ({
      status: 'success',
      blockNumber: 9n,
    }));
    try {
      journal.create(fixture());
      await worker.reconcile(fixture().grantId);
      expect(journal.history(fixture().grantId).map((r) => r.to)).toEqual([
        'SIGNED',
        'RECONCILIATION_REQUIRED',
        'INCLUDED',
        'CONFIRMED',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('confirmation depth waits for the head and a moved receipt reopens reconciliation', async () => {
    let head = 10n;
    let block = 10n;
    const { dir, journal, port, worker } = harness(
      () => ({ status: 'success', blockNumber: block }),
      { depth: 2, head: () => head },
    );
    const id = fixture().grantId;
    try {
      await worker.submit(fixture());
      expect((await worker.reconcile(id)).state).toBe('INCLUDED');
      block = 11n;
      head = 11n;
      expect((await worker.reconcile(id)).state).toBe('INCLUDED');
      head = 12n;
      expect(await worker.reconcile(id)).toMatchObject({
        state: 'CONFIRMED',
        blockNumber: '11',
      });
      expect(journal.history(id).map((r) => r.to)).toEqual([
        'SIGNED',
        'SUBMITTED',
        'INCLUDED',
        'RECONCILIATION_REQUIRED',
        'INCLUDED',
        'CONFIRMED',
      ]);
      expect(() =>
        journal.update(id, { state: 'SUBMITTED', blockNumber: null }),
      ).toThrow('INVALID_EXECUTION_TRANSITION');
      const { blockNumber: _head, ...headless } = port;
      expect(() => new JournaledBroadcaster(journal, headless, 3)).toThrow(
        'CONFIRMATION_DEPTH_REQUIRES_HEAD',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('a tampered transition history is rejected on read', async () => {
    const { dir, journal, worker } = harness(() => null);
    try {
      await worker.submit(fixture());
      const path = join(dir, `${fixture().grantId}.json`);
      const record = JSON.parse(readFileSync(path, 'utf8'));
      record.events.pop();
      writeFileSync(path, JSON.stringify(record));
      expect(() => journal.get(fixture().grantId)).toThrow(
        'JOURNAL_HISTORY_MISMATCH',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe('execution worker errors', () => {
  it('journal failures are typed SynqErrors with stable codes and safe messages', async () => {
    const { dir, journal, worker } = harness(() => null);
    const port: BroadcastPort = {
      sendRawTransaction: async () => keccak256(raw),
      receipt: async () => null,
    };
    try {
      const failures: [string, () => unknown][] = [
        ['INVALID_GRANT_ID', () => journal.get('../etc/passwd')],
        [
          'UNKNOWN_EXECUTION',
          () =>
            journal.update(`0x${'2'.repeat(64)}`, {
              state: 'SUBMITTED',
              blockNumber: null,
            }),
        ],
        [
          'CONFIRMATION_DEPTH_REQUIRES_HEAD',
          () => new JournaledBroadcaster(journal, port, 2),
        ],
        [
          'INVALID_CONFIRMATION_DEPTH',
          () => new JournaledBroadcaster(journal, port, 0),
        ],
      ];
      for (const [code, run] of failures) {
        let error: unknown;
        try {
          run();
        } catch (caught) {
          error = caught;
        }
        expect(error, code).toBeInstanceOf(ExecutionError);
        expect(JSON.parse(JSON.stringify(error))).toMatchObject({ code });
      }
      await expect(
        worker.submit({ ...fixture(), state: 'SUBMITTED' }),
      ).rejects.toBeInstanceOf(ExecutionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const file of ['journal.ts', 'index.ts'])
      expect(
        readFileSync(join('workers/execution/src', file), 'utf8'),
      ).not.toMatch(/new Error\(/);
  });
});
type JournalFile = {
  entry: Record<string, unknown>;
  snapshots: Record<string, unknown>[];
  events: {
    type: string;
    eventId: string;
    causationId?: string;
    correlationId: string;
    actor: unknown;
    payload: { evidenceHash: string; actor: unknown };
  }[];
};
const actionEvents = (r: JournalFile) =>
  r.events.filter((e) => e.type === 'action.transitioned');
const txEvents = (r: JournalFile) =>
  r.events.filter((e) => e.type === 'execution.transaction.transitioned');
const mallory = { principalId: 'mallory', kind: 'HUMAN' };
describe('journal integrity verification fails closed on tampering', () => {
  it.each<[string, (r: JournalFile) => void]>([
    [
      'action evidenceHash swapped',
      (r) => {
        actionEvents(r)[0]!.payload.evidenceHash = `0x${'f'.repeat(64)}`;
      },
    ],
    [
      'action actor forged in envelope and payload',
      (r) => {
        actionEvents(r)[0]!.payload.actor = mallory;
        actionEvents(r)[0]!.actor = mallory;
      },
    ],
    [
      'every actor forged consistently',
      (r) => {
        for (const e of r.events) {
          e.actor = mallory;
          e.payload.actor = mallory;
        }
      },
    ],
    [
      'transaction evidenceHash swapped',
      (r) => {
        txEvents(r)[1]!.payload.evidenceHash = `0x${'e'.repeat(64)}`;
      },
    ],
    [
      'causationId dropped',
      (r) => {
        for (const e of actionEvents(r)) delete e.causationId;
      },
    ],
    [
      'causationId pointed at another transaction',
      (r) => {
        actionEvents(r)[1]!.causationId = txEvents(r)[0]!.eventId;
      },
    ],
    [
      'events reordered',
      (r) => {
        r.events = [...txEvents(r), ...actionEvents(r)];
      },
    ],
    [
      'eventId duplicated',
      (r) => {
        actionEvents(r)[1]!.eventId = actionEvents(r)[0]!.eventId;
      },
    ],
    [
      'envelope actor differs from payload actor',
      (r) => {
        txEvents(r)[0]!.actor = { principalId: 'other', kind: 'AGENT' };
      },
    ],
    [
      'entry blockNumber edited without history',
      (r) => {
        r.entry.blockNumber = '8';
      },
    ],
    [
      'snapshot blockNumber edited',
      (r) => {
        r.snapshots.at(-1)!.blockNumber = '8';
        r.entry.blockNumber = '8';
      },
    ],
    [
      'last event removed and entry rolled back',
      (r) => {
        r.events = r.events.slice(0, -1);
        r.entry.state = 'INCLUDED';
      },
    ],
    [
      'foreign correlation id',
      (r) => {
        txEvents(r)[0]!.correlationId = `0x${'3'.repeat(64)}`;
      },
    ],
    [
      'action projection dropped',
      (r) => {
        r.events = r.events.filter((e) => e !== actionEvents(r)[1]);
      },
    ],
  ])('%s', async (_name, tamper) => {
    const { dir, journal, worker } = harness(() => ({
      status: 'success',
      blockNumber: 7n,
    }));
    const id = fixture().grantId;
    try {
      await worker.submit(fixture());
      await worker.reconcile(id);
      expect(journal.get(id)?.state).toBe('CONFIRMED');
      const path = join(dir, `${id}.json`);
      const record: JournalFile = JSON.parse(readFileSync(path, 'utf8'));
      tamper(record);
      writeFileSync(path, JSON.stringify(record));
      let error: unknown;
      try {
        journal.get(id);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ExecutionError);
      expect(error).toMatchObject({ code: 'JOURNAL_HISTORY_MISMATCH' });
      await expect(worker.reconcile(id)).rejects.toBeInstanceOf(ExecutionError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
