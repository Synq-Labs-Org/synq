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
import { keccak256, stringToHex } from 'viem';
import {
  PrincipalRefSchema,
  TX_MACHINE,
  createDomainEvent,
  domainEventSchema,
  recordTransition,
  transitionRecordSchema,
  verifyHistory,
  type PrincipalRef,
  type TransitionRecord,
  type TxState,
} from '@synq/domain';

const hex = z
  .string()
  .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
  .transform((v) => v as `0x${string}`);
const hash = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((v) => v as `0x${string}`);
const INCLUDED_STATES: readonly TxState[] = [
  'INCLUDED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'SETTLED',
];
export const JournalEntrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    grantId: hash,
    transactionHash: hash,
    rawTransaction: hex,
    state: TX_MACHINE.stateSchema(),
    chainId: z.union([z.literal(31337), z.literal(10143)]),
    blockNumber: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .nullable(),
    outcome: z.enum(['SUCCESS', 'REVERTED']).optional(),
  })
  .refine(
    (v) => keccak256(v.rawTransaction) === v.transactionHash,
    'raw transaction/hash mismatch',
  )
  .refine(
    (v) =>
      INCLUDED_STATES.includes(v.state) === (v.blockNumber !== null) &&
      (v.blockNumber !== null) === (v.outcome !== undefined),
    'inclusion requires block number and outcome',
  );
export type JournalEntry = z.output<typeof JournalEntrySchema>;
export type JournalPatch = Pick<JournalEntry, 'state' | 'blockNumber'> &
  Partial<Pick<JournalEntry, 'outcome'>>;
const TransitionEventSchema = domainEventSchema(
  transitionRecordSchema(TX_MACHINE),
);
export type TransitionEvent = z.output<typeof TransitionEventSchema>;
const JournalRecordSchema = z.strictObject({
  entry: JournalEntrySchema,
  events: z.array(TransitionEventSchema).min(1),
});
type JournalRecord = z.output<typeof JournalRecordSchema>;
export const EXECUTION_WORKER_PRINCIPAL: PrincipalRef =
  PrincipalRefSchema.parse({
    principalId: 'execution-worker',
    kind: 'SERVICE',
  });
function evidenceOf(entry: JournalEntry): `0x${string}` {
  return keccak256(
    stringToHex(
      JSON.stringify([
        entry.grantId,
        entry.transactionHash,
        entry.state,
        entry.blockNumber,
        entry.outcome ?? null,
      ]),
    ),
  );
}
function fsyncDirectory(directory: string): void {
  const fd = openSync(directory, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export class ExecutionJournal {
  constructor(
    readonly directory: string,
    private readonly actor: PrincipalRef = EXECUTION_WORKER_PRINCIPAL,
    private readonly clock: () => Date = () => new Date(),
  ) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  private path(grantId: string) {
    if (!/^0x[0-9a-f]{64}$/.test(grantId)) throw new Error('INVALID_GRANT_ID');
    return join(this.directory, `${grantId}.json`);
  }
  private read(grantId: string): JournalRecord | null {
    const path = this.path(grantId);
    if (!existsSync(path)) return null;
    const record = JournalRecordSchema.parse(
      JSON.parse(readFileSync(path, 'utf8')),
    );
    const transitions = record.events.map((e) => e.payload);
    if (verifyHistory(TX_MACHINE, transitions) !== record.entry.state)
      throw new Error('JOURNAL_HISTORY_MISMATCH');
    return record;
  }
  get(grantId: string): JournalEntry | null {
    return this.read(grantId)?.entry ?? null;
  }
  history(grantId: string): TransitionRecord<TxState>[] {
    return (this.read(grantId)?.events ?? []).map((e) => e.payload);
  }
  events(grantId: string): TransitionEvent[] {
    return this.read(grantId)?.events ?? [];
  }
  private event(
    entry: JournalEntry,
    history: readonly TransitionRecord<TxState>[],
  ): TransitionEvent {
    const at = this.clock().toISOString();
    const payload = recordTransition(TX_MACHINE, history, {
      actor: this.actor,
      at,
      to: entry.state,
      evidenceHash: evidenceOf(entry),
    });
    return createDomainEvent(transitionRecordSchema(TX_MACHINE), {
      type: 'execution.transaction.transitioned',
      actor: this.actor,
      correlationId: entry.grantId,
      occurredAt: new Date(at),
      payload,
    });
  }
  create(input: JournalEntry): void {
    const entry = JournalEntrySchema.parse(input);
    if (entry.state !== 'SIGNED') throw new Error('INVALID_NEW_SUBMISSION');
    const record: JournalRecord = {
      entry,
      events: [this.event(entry, [])],
    };
    const fd = openSync(this.path(entry.grantId), 'wx', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    fsyncDirectory(this.directory);
  }
  update(grantId: string, patch: JournalPatch): JournalEntry {
    const current = this.read(grantId);
    if (!current) throw new Error('UNKNOWN_EXECUTION');
    if (
      patch.state !== current.entry.state &&
      !TX_MACHINE.canTransition(current.entry.state, patch.state)
    )
      throw new Error('INVALID_EXECUTION_TRANSITION');
    const { outcome: _previous, ...base } = current.entry;
    const entry = JournalEntrySchema.parse({ ...base, ...patch });
    if (entry.state === current.entry.state) {
      if (evidenceOf(entry) !== evidenceOf(current.entry))
        throw new Error('INVALID_EXECUTION_TRANSITION');
      return current.entry;
    }
    const history = current.events.map((e) => e.payload);
    const record: JournalRecord = {
      entry,
      events: [...current.events, this.event(entry, history)],
    };
    const path = this.path(grantId);
    const temporary = `${path}.${process.pid}.tmp`;
    const fd = openSync(temporary, 'w', 0o600);
    try {
      writeFileSync(fd, JSON.stringify(record) + '\n');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, path);
    fsyncDirectory(this.directory);
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
const RECONCILABLE_STATES: readonly TxState[] = [
  'SIGNED',
  'SUBMITTED',
  'INCLUDED',
  'RECONCILIATION_REQUIRED',
];
export interface BroadcastPort {
  sendRawTransaction(raw: `0x${string}`): Promise<`0x${string}`>;
  receipt(
    hash: `0x${string}`,
  ): Promise<{ status: 'success' | 'reverted'; blockNumber: bigint } | null>;
  blockNumber?(): Promise<bigint>;
}
export class JournaledBroadcaster {
  constructor(
    readonly journal: ExecutionJournal,
    private readonly port: BroadcastPort,
    private readonly confirmationDepth = 1,
  ) {
    if (!Number.isSafeInteger(confirmationDepth) || confirmationDepth < 1)
      throw new Error('INVALID_CONFIRMATION_DEPTH');
    if (confirmationDepth > 1 && !port.blockNumber)
      throw new Error('CONFIRMATION_DEPTH_REQUIRES_HEAD');
  }
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
    let entry = this.journal.get(grantId);
    if (!entry) throw new Error('UNKNOWN_EXECUTION');
    if (!RECONCILABLE_STATES.includes(entry.state)) return entry;
    const reopen = () =>
      this.journal.update(grantId, {
        state: 'RECONCILIATION_REQUIRED',
        blockNumber: null,
      });
    const receipt = await this.port.receipt(entry.transactionHash);
    if (!receipt) return reopen();
    const included: JournalPatch = {
      state: 'INCLUDED',
      blockNumber: String(receipt.blockNumber),
      outcome: receipt.status === 'success' ? 'SUCCESS' : 'REVERTED',
    };
    if (
      entry.state === 'SIGNED' ||
      (entry.state === 'INCLUDED' &&
        (entry.blockNumber !== included.blockNumber ||
          entry.outcome !== included.outcome))
    )
      entry = reopen();
    entry = this.journal.update(grantId, included);
    const head =
      this.confirmationDepth === 1 || !this.port.blockNumber
        ? receipt.blockNumber
        : await this.port.blockNumber();
    if (head - receipt.blockNumber + 1n < BigInt(this.confirmationDepth))
      return entry;
    return this.journal.update(grantId, { ...included, state: 'CONFIRMED' });
  }
}
