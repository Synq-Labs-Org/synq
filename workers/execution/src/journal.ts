import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  existsSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { keccak256 } from 'viem';
const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .transform((v) => v as `0x${string}`);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v as `0x${string}`);
export const JournalEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    grantId: hash,
    transactionHash: hash,
    rawTransaction: hex,
    state: z.enum([
      'SIGNED',
      'SUBMITTED',
      'CONFIRMED',
      'REVERTED',
      'RECONCILIATION_REQUIRED',
    ]),
    chainId: z.union([z.literal(31337), z.literal(10143)]),
    blockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
  })
  .refine(
    (v) => keccak256(v.rawTransaction) === v.transactionHash,
    'raw transaction/hash mismatch',
  )
  .refine(
    (v) =>
      ['CONFIRMED', 'REVERTED'].includes(v.state) === (v.blockNumber !== null),
    'terminal receipt block required',
  );
export type JournalEntry = z.infer<typeof JournalEntrySchema>;
export class ExecutionJournal {
  constructor(readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(grantId: string) {
    if (!/^0x[0-9a-f]{64}$/.test(grantId)) throw new Error('INVALID_GRANT_ID');
    return join(this.directory, `${grantId}.json`);
  }
  get(grantId: string): JournalEntry | null {
    const path = this.path(grantId);
    return existsSync(path)
      ? JournalEntrySchema.parse(JSON.parse(readFileSync(path, 'utf8')))
      : null;
  }
  create(entry: JournalEntry): void {
    const parsed = JournalEntrySchema.parse(entry);
    const path = this.path(parsed.grantId);
    const fd = openSync(path, 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(parsed) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    const directoryFd = openSync(this.directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
  }
  update(
    grantId: string,
    patch: Pick<JournalEntry, 'state' | 'blockNumber'>,
  ): JournalEntry {
    const current = this.get(grantId);
    if (!current) throw new Error('UNKNOWN_EXECUTION');
    const allowed: Record<JournalEntry['state'], JournalEntry['state'][]> = {
      SIGNED: ['SUBMITTED', 'RECONCILIATION_REQUIRED', 'CONFIRMED', 'REVERTED'],
      SUBMITTED: ['CONFIRMED', 'REVERTED', 'RECONCILIATION_REQUIRED'],
      RECONCILIATION_REQUIRED: [
        'RECONCILIATION_REQUIRED',
        'CONFIRMED',
        'REVERTED',
      ],
      CONFIRMED: ['CONFIRMED'],
      REVERTED: ['REVERTED'],
    };
    if (!allowed[current.state].includes(patch.state))
      throw new Error('INVALID_EXECUTION_TRANSITION');
    const entry = JournalEntrySchema.parse({ ...current, ...patch });
    const path = this.path(grantId);
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(entry) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    const directoryFd = openSync(this.directory, 'r');
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    return entry;
  }
  withGrantLock<T>(grantId: string, command: () => Promise<T>): Promise<T> {
    const lock = `${this.path(grantId)}.lock`;
    const claim = () => {
      const fd = openSync(lock, 'wx', 0o600);
      try {
        writeFileSync(fd, String(process.pid));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    };
    try {
      claim();
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !('code' in error) ||
        error.code !== 'EEXIST'
      )
        throw error;
      const owner = Number(readFileSync(lock, 'utf8'));
      if (!Number.isSafeInteger(owner) || owner <= 0)
        throw new Error('EXECUTION_LOCK_OWNER_UNKNOWN');
      try {
        process.kill(owner, 0);
        throw new Error('EXECUTION_ALREADY_RUNNING');
      } catch (probe) {
        if (
          !(probe instanceof Error) ||
          !('code' in probe) ||
          probe.code !== 'ESRCH'
        )
          throw probe;
      }
      unlinkSync(lock);
      claim();
    }
    return command().finally(() => unlinkSync(lock));
  }
}
export interface BroadcastPort {
  sendRawTransaction(raw: `0x${string}`): Promise<`0x${string}`>;
  receipt(
    hash: `0x${string}`,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
}
export class JournaledBroadcaster {
  constructor(
    readonly journal: ExecutionJournal,
    private readonly port: BroadcastPort,
  ) {}
  async submit(rawEntry: JournalEntry): Promise<JournalEntry> {
    const entry = JournalEntrySchema.parse(rawEntry);
    if (entry.state !== 'SIGNED' || entry.blockNumber !== null)
      throw new Error('INVALID_NEW_SUBMISSION');
    return this.journal.withGrantLock(entry.grantId, async () => {
      const existing = this.journal.get(entry.grantId);
      if (existing) {
        if (existing.transactionHash !== entry.transactionHash)
          throw new Error('GRANT_REPREPARATION_FORBIDDEN');
        return this.reconcile(entry.grantId);
      }
      this.journal.create(entry);
      try {
        const returned = await this.port.sendRawTransaction(
          entry.rawTransaction,
        );
        if (returned !== entry.transactionHash)
          throw new Error('RPC_TRANSACTION_HASH_MISMATCH');
        return this.journal.update(entry.grantId, {
          state: 'SUBMITTED',
          blockNumber: null,
        });
      } catch {
        return this.journal.update(entry.grantId, {
          state: 'RECONCILIATION_REQUIRED',
          blockNumber: null,
        });
      }
    });
  }
  async reconcile(grantId: string): Promise<JournalEntry> {
    const entry = this.journal.get(grantId);
    if (!entry) throw new Error('UNKNOWN_EXECUTION');
    if (['CONFIRMED', 'REVERTED'].includes(entry.state)) return entry;
    const receipt = await this.port.receipt(entry.transactionHash);
    if (!receipt)
      return this.journal.update(grantId, {
        state: 'RECONCILIATION_REQUIRED',
        blockNumber: null,
      });
    return this.journal.update(grantId, {
      state: receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED',
      blockNumber: String(receipt.blockNumber),
    });
  }
}
