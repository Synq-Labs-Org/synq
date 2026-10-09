import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import type { GrantClaim } from '@synq/kernel';
import {
  ExecutionJournal,
  JournaledBroadcaster,
  EXECUTION_WORKER_PRINCIPAL,
  loadIntegrityKey,
  loadJournalKey,
  submitGrantTransaction,
  type IntegrityKey,
  type JournalEntry,
} from '@synq/execution-worker';

const raw = '0x1234' as const;
const grantId = `0x${'1'.repeat(64)}` as const;
const entry = (chainId: 31337 | 10143 = 31337): JournalEntry => ({
  schemaVersion: 1,
  grantId,
  transactionHash: keccak256(raw),
  rawTransaction: raw,
  state: 'SIGNED',
  chainId,
  blockNumber: null,
});
const roots: string[] = [];
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'synq-integrity-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function keyFile(dir: string, name = 'journal.key', hex = 'ab'.repeat(32)) {
  const path = join(dir, name);
  writeFileSync(path, `${hex}\n`, { mode: 0o600 });
  return path;
}
const testnet = (path?: string) => ({
  SYNQ_NETWORK: 'sandbox/monad-testnet',
  ...(path ? { SYNQ_JOURNAL_KEY_FILE: path } : {}),
});
function keyed(dir: string, path: string): IntegrityKey {
  return loadJournalKey(join(dir, 'journal'), testnet(path));
}
const port = {
  sendRawTransaction: async () => keccak256(raw),
  receipt: async () => ({ status: 'success' as const, blockNumber: 7n }),
};

describe('journal integrity key', () => {
  it('refuses to start outside the local profile without SYNQ_JOURNAL_KEY_FILE', () => {
    const dir = root();
    expect(() => loadJournalKey(join(dir, 'journal'), testnet())).toThrow(
      'INTEGRITY_KEY_REQUIRED',
    );
  });

  it('rejects keys inside the journal directory, shared, short, relative or non-hex', () => {
    const dir = root();
    const journal = join(dir, 'journal');
    mkdirSync(journal);
    const inside = keyFile(journal, 'inside.key');
    expect(() => loadJournalKey(journal, testnet(inside))).toThrow(
      'INTEGRITY_KEY_INVALID',
    );
    const shared = keyFile(dir, 'shared.key');
    chmodSync(shared, 0o644);
    expect(() => loadJournalKey(journal, testnet(shared))).toThrow(
      'INTEGRITY_KEY_INVALID',
    );
    const short = keyFile(dir, 'short.key', 'ab'.repeat(16));
    expect(() => loadJournalKey(journal, testnet(short))).toThrow(
      'INTEGRITY_KEY_INVALID',
    );
    const text = keyFile(dir, 'text.key', 'not-a-hex-key'.repeat(8));
    expect(() => loadJournalKey(journal, testnet(text))).toThrow(
      'INTEGRITY_KEY_INVALID',
    );
    expect(() => loadJournalKey(journal, testnet('journal.key'))).toThrow(
      'INTEGRITY_KEY_INVALID',
    );
    expect(() =>
      loadJournalKey(journal, testnet(join(dir, 'missing.key'))),
    ).toThrow('INTEGRITY_KEY_INVALID');
    const ok = keyFile(dir);
    expect(loadJournalKey(journal, testnet(ok)).bytes).toHaveLength(32);
    expect(() =>
      loadIntegrityKey({
        envVar: 'SYNQ_KERNEL_AUDIT_KEY_FILE',
        protectedDirectories: [dir],
        env: { SYNQ_KERNEL_AUDIT_KEY_FILE: ok },
      }),
    ).toThrow('INTEGRITY_KEY_INVALID');
  });

  it('local profile provisions a 0600 key beside, not inside, the journal and refuses non-local chains with it', () => {
    const dir = root();
    const journalDir = join(dir, 'journal');
    const key = loadJournalKey(journalDir, {});
    expect(key.source).toBe('LOCAL_GENERATED');
    expect(key.path).toBe(`${journalDir}.integrity-key`);
    expect(loadJournalKey(journalDir, {}).bytes).toEqual(key.bytes);
    const journal = new ExecutionJournal(
      journalDir,
      EXECUTION_WORKER_PRINCIPAL,
      undefined,
      key,
    );
    expect(() => journal.create(entry(10143))).toThrow(
      'INTEGRITY_KEY_REQUIRED',
    );
    journal.create(entry());
    expect(journal.get(grantId)?.state).toBe('SIGNED');
  });

  it('a whole-record rewrite with a recomputed unkeyed or wrongly keyed chain is detected', async () => {
    const dir = root();
    const journalDir = join(dir, 'journal');
    const key = keyed(dir, keyFile(dir));
    const journal = new ExecutionJournal(
      journalDir,
      EXECUTION_WORKER_PRINCIPAL,
      undefined,
      key,
    );
    await new JournaledBroadcaster(journal, port).submit(entry());
    expect(journal.get(grantId)?.state).toBe('SUBMITTED');
    const path = join(journalDir, `${grantId}.json`);
    const original = readFileSync(path, 'utf8');
    type Rec = {
      snapshots: { state: string; blockNumber: string | null }[];
      events: {
        type: string;
        payload: { evidenceHash: string; to: string };
      }[];
    };
    const recompute = (mac: (previous: string, state: string) => string) => {
      const record = JSON.parse(original) as Rec;
      let previous = `0x${'0'.repeat(64)}`;
      let txIndex = 0;
      for (const event of record.events) {
        if (event.type === 'execution.transaction.transitioned') {
          previous = mac(previous, record.snapshots[txIndex++]!.state);
          event.payload.evidenceHash = previous;
        } else event.payload.evidenceHash = previous;
      }
      return record;
    };
    const unkeyed = recompute((previous, state) =>
      keccak256(
        stringToHex(
          JSON.stringify([
            previous,
            grantId,
            keccak256(raw),
            state,
            null,
            null,
          ]),
        ),
      ),
    );
    writeFileSync(path, JSON.stringify(unkeyed));
    expect(() => journal.get(grantId)).toThrow('JOURNAL_HISTORY_MISMATCH');
    writeFileSync(path, original);
    expect(journal.get(grantId)?.state).toBe('SUBMITTED');
    const otherKey = keyed(dir, keyFile(dir, 'other.key', 'cd'.repeat(32)));
    const reopened = new ExecutionJournal(
      journalDir,
      EXECUTION_WORKER_PRINCIPAL,
      undefined,
      otherKey,
    );
    expect(() => reopened.get(grantId)).toThrow('JOURNAL_HISTORY_MISMATCH');
    expect(existsSync(join(journalDir, 'journal.key'))).toBe(false);
  });
});

describe('submission is recorded with the Kernel before broadcast', () => {
  const claim: GrantClaim = {
    grantId,
    workerId: 'w',
    claimId: `0x${'2'.repeat(64)}`,
    claimedAt: 1,
  };
  it('records keccak256(raw) first, then broadcasts', async () => {
    const dir = root();
    const order: string[] = [];
    const kernel = {
      recordSubmission: (c: GrantClaim, hash: `0x${string}`) => {
        expect(c).toEqual(claim);
        order.push(`record:${hash}`);
      },
    };
    const journal = new ExecutionJournal(
      join(dir, 'journal'),
      EXECUTION_WORKER_PRINCIPAL,
      undefined,
      keyed(dir, keyFile(dir)),
    );
    const broadcaster = new JournaledBroadcaster(journal, {
      ...port,
      sendRawTransaction: async (r) => {
        order.push('broadcast');
        return keccak256(r);
      },
    });
    const submitted = await submitGrantTransaction(
      kernel,
      claim,
      broadcaster,
      entry(),
    );
    expect(submitted.state).toBe('SUBMITTED');
    expect(order).toEqual([`record:${keccak256(raw)}`, 'broadcast']);
  });

  it('does not broadcast when the Kernel refuses, the claim names another grant, or the grant was journaled with another transaction', async () => {
    const dir = root();
    let broadcasts = 0;
    const journal = new ExecutionJournal(
      join(dir, 'journal'),
      EXECUTION_WORKER_PRINCIPAL,
      undefined,
      keyed(dir, keyFile(dir)),
    );
    const broadcaster = new JournaledBroadcaster(journal, {
      ...port,
      sendRawTransaction: async (r) => {
        broadcasts++;
        return keccak256(r);
      },
    });
    const refusing = {
      recordSubmission: () => {
        throw new Error('GRANT_CLAIM_INVALID');
      },
    };
    await expect(
      submitGrantTransaction(refusing, claim, broadcaster, entry()),
    ).rejects.toThrow('GRANT_CLAIM_INVALID');
    const accepting = { recordSubmission: () => undefined };
    await expect(
      submitGrantTransaction(
        accepting,
        { ...claim, grantId: `0x${'3'.repeat(64)}` },
        broadcaster,
        entry(),
      ),
    ).rejects.toThrow('INVALID_NEW_SUBMISSION');
    expect(broadcasts).toBe(0);
    await submitGrantTransaction(accepting, claim, broadcaster, entry());
    const other = '0x5678' as const;
    let recorded = 0;
    await expect(
      submitGrantTransaction(
        { recordSubmission: () => void recorded++ },
        claim,
        broadcaster,
        {
          ...entry(),
          rawTransaction: other,
          transactionHash: keccak256(other),
        },
      ),
    ).rejects.toThrow('GRANT_REPREPARATION_FORBIDDEN');
    expect(recorded).toBe(0);
    expect(broadcasts).toBe(1);
  });
});
