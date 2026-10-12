import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type JournalState =
  | 'PREPARED'
  | 'SUBMITTED'
  | 'MINED'
  | 'CREDITED'
  | 'RECONCILIATION_PENDING'
  | 'FAILED';

export type JournalEntry = {
  requestId: string;
  groupId: string;
  chainGroupId: string;
  safe: string;
  spender: string;
  amount: string;
  sessionId: string | null;
  txHash: string | null;
  state: JournalState;
  updatedAt: number;
};

/** Local idempotency record: one claim per request id, never re-submitted. */
export interface ContributionJournal {
  /** Returns null when newly claimed, else the existing entry. */
  claim(entry: JournalEntry): Promise<JournalEntry | null>;
  update(
    requestId: string,
    patch: Partial<JournalEntry>,
  ): Promise<JournalEntry>;
  get(requestId: string): Promise<JournalEntry | null>;
  list(): Promise<JournalEntry[]>;
  /** Exclusive, permanent submission right for a request id; false if already taken. */
  lockSubmission(requestId: string): Promise<boolean>;
}

export class MemoryJournal implements ContributionJournal {
  readonly entries = new Map<string, JournalEntry>();
  private readonly locks = new Set<string>();
  async lockSubmission(requestId: string) {
    if (this.locks.has(requestId)) return false;
    this.locks.add(requestId);
    return true;
  }
  async claim(entry: JournalEntry) {
    const existing = this.entries.get(entry.requestId);
    if (existing) return existing;
    this.entries.set(entry.requestId, { ...entry });
    return null;
  }
  async update(requestId: string, patch: Partial<JournalEntry>) {
    const current = this.entries.get(requestId);
    if (!current) throw new Error(`journal entry ${requestId} missing`);
    const next = { ...current, ...patch, requestId };
    this.entries.set(requestId, next);
    return next;
  }
  async get(requestId: string) {
    return this.entries.get(requestId) ?? null;
  }
  async list() {
    return [...this.entries.values()];
  }
}

const fileName = (requestId: string) =>
  `${createHash('sha256').update(requestId).digest('hex')}.json`;

export class FileJournal implements ContributionJournal {
  constructor(private readonly dir: string) {}

  static fromEnv(env: Record<string, string | undefined>) {
    return new FileJournal(
      env.SYNQ_MM_JOURNAL_DIR ?? join(homedir(), '.synq-mm', 'contributions'),
    );
  }

  async claim(entry: JournalEntry) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(
        join(this.dir, fileName(entry.requestId)),
        JSON.stringify(entry),
        {
          flag: 'wx',
          mode: 0o600,
        },
      );
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      return this.get(entry.requestId);
    }
  }

  async lockSubmission(requestId: string) {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      await writeFile(join(this.dir, `${fileName(requestId)}.submit`), '', {
        flag: 'wx',
        mode: 0o600,
      });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  async update(requestId: string, patch: Partial<JournalEntry>) {
    const current = await this.get(requestId);
    if (!current) throw new Error(`journal entry ${requestId} missing`);
    const next = { ...current, ...patch, requestId };
    const path = join(this.dir, fileName(requestId));
    await writeFile(`${path}.tmp`, JSON.stringify(next), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    return next;
  }

  async get(requestId: string) {
    try {
      return JSON.parse(
        await readFile(join(this.dir, fileName(requestId)), 'utf8'),
      ) as JournalEntry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async list() {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const entries = await Promise.all(
      names
        .filter((n) => n.endsWith('.json'))
        .map(
          async (n) =>
            JSON.parse(
              await readFile(join(this.dir, n), 'utf8'),
            ) as JournalEntry,
        ),
    );
    return entries.sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
