import { keccak256, stringToHex, type Hex } from 'viem';
import { canonicalJson, deepFreeze } from './common.js';
import {
  DelegationRegistry,
  verifyDelegationRecords,
  type Delegation,
  type DelegationRecord,
  type DelegationRevocation,
} from './delegation.js';
import { GovernanceError } from './errors.js';
import type { GovernancePolicy } from './policy.js';

/**
 * Durable delegation state as an append-only, hash-chained event log per
 * (workspace, chain). Every registration and every revocation is one entry
 * with a gap-free sequence number and the hash of the entry before it, and
 * the store keeps the head (last sequence and hash) beside the log. Loading
 * re-verifies the whole chain, the head, and every signature, so a revocation
 * that was deleted, edited or reordered is detected instead of silently
 * reviving the delegation. A process also remembers the highest sequence it
 * has seen and refuses a log that went backwards. (Deleting the newest entry
 * AND rewriting the head is only detectable against an external anchor of
 * `head()`; see ADR-002.)
 */

export type DelegationLogEntry = Readonly<{
  seq: number;
  kind: 'REGISTER' | 'REVOKE';
  delegationId: Hex;
  /** The full record as of this event (a REVOKE carries the revoked record). */
  record: DelegationRecord;
  at: number;
  prevHash: Hex;
  hash: Hex;
}>;

export type DelegationLogHead = Readonly<{ seq: number; hash: Hex }>;

export const GENESIS_HASH: Hex = `0x${'00'.repeat(32)}`;

export interface DelegationLogStore {
  /** All entries for the scope in sequence order, plus the stored head. */
  load(
    workspaceId: string,
    chainId: number,
  ): Promise<{
    entries: readonly DelegationLogEntry[];
    head: DelegationLogHead | null;
  }>;
  /**
   * Appends `entry` only if the head is still `entry.seq - 1` with hash
   * `entry.prevHash` (compare-and-set); false when another writer won.
   */
  append(
    workspaceId: string,
    chainId: number,
    entry: DelegationLogEntry,
  ): Promise<boolean>;
}

export function delegationLogHash(
  workspaceId: string,
  chainId: number,
  e: Omit<DelegationLogEntry, 'hash'>,
): Hex {
  return keccak256(
    stringToHex(
      canonicalJson({
        workspaceId,
        chainId,
        seq: e.seq,
        kind: e.kind,
        delegationId: e.delegationId,
        record: e.record,
        at: e.at,
        prevHash: e.prevHash,
      }),
    ),
  );
}

export class MemoryDelegationLogStore implements DelegationLogStore {
  private logs = new Map<string, DelegationLogEntry[]>();
  async load(workspaceId: string, chainId: number) {
    const entries = this.logs.get(`${workspaceId}/${chainId}`) ?? [];
    const last = entries.at(-1);
    return {
      entries: [...entries],
      head: last ? { seq: last.seq, hash: last.hash } : null,
    };
  }
  async append(workspaceId: string, chainId: number, e: DelegationLogEntry) {
    const key = `${workspaceId}/${chainId}`;
    const log = this.logs.get(key) ?? [];
    const last = log.at(-1);
    if (
      (last?.seq ?? 0) !== e.seq - 1 ||
      (last?.hash ?? GENESIS_HASH) !== e.prevHash
    )
      return false;
    this.logs.set(key, [...log, e]);
    return true;
  }
}

const tampered = (why: string): never => {
  throw new GovernanceError('STORE_TAMPERED', `delegation log: ${why}`);
};

/** Verifies the chain and folds it into the current records (signatures checked by the caller). */
export function replayDelegationLog(
  workspaceId: string,
  chainId: number,
  entries: readonly DelegationLogEntry[],
  head: DelegationLogHead | null,
): { records: DelegationRecord[]; head: DelegationLogHead | null } {
  const byId = new Map<string, DelegationRecord>();
  let prev = GENESIS_HASH;
  for (const [i, e] of entries.entries()) {
    if (e.seq !== i + 1) tampered(`sequence gap at ${i + 1} (found ${e.seq})`);
    if (e.prevHash !== prev) tampered(`entry ${e.seq} does not chain`);
    const { hash, ...body } = e;
    if (delegationLogHash(workspaceId, chainId, body) !== hash)
      tampered(`entry ${e.seq} hash mismatch`);
    if (e.record.id !== e.delegationId)
      tampered(`entry ${e.seq} names another delegation`);
    const existing = byId.get(e.delegationId);
    if (e.kind === 'REGISTER') {
      if (existing)
        tampered(`entry ${e.seq} registers ${e.delegationId} twice`);
      if (e.record.revokedAt !== null)
        tampered(`entry ${e.seq} registers a revoked record`);
    } else {
      if (!existing || existing.revokedAt !== null)
        tampered(`entry ${e.seq} revokes an unknown or revoked delegation`);
      if (
        canonicalJson({
          ...e.record,
          revokedAt: null,
          revocation: null,
          revocationSignature: null,
        }) !== canonicalJson(existing) ||
        e.record.revokedAt === null
      )
        tampered(`entry ${e.seq} changes more than the revocation`);
    }
    byId.set(e.delegationId, e.record);
    prev = hash;
  }
  const last = entries.at(-1);
  const computed = last ? { seq: last.seq, hash: last.hash } : null;
  if (
    (head?.seq ?? 0) !== (computed?.seq ?? 0) ||
    (head?.hash ?? GENESIS_HASH) !== (computed?.hash ?? GENESIS_HASH)
  )
    tampered('stored head does not match the log (entries dropped or added)');
  return { records: [...byId.values()], head: computed };
}

/**
 * `DelegationRegistry` over a durable log. Each write loads and verifies the
 * log, applies the same in-memory rules (live window, signature, one active
 * delegation per delegator, depth, cycles) to the verified records, and
 * appends with compare-and-set; a lost race reloads and re-checks, so two
 * processes can never both register conflicting delegations.
 */
export class DurableDelegationRegistry {
  private highWater = 0;
  constructor(
    readonly policy: GovernancePolicy,
    readonly store: DelegationLogStore,
    private readonly maxAttempts = 5,
  ) {}

  private async state() {
    const { workspaceId, chainId } = this.policy;
    const loaded = await this.store.load(workspaceId, chainId);
    const replayed = replayDelegationLog(
      workspaceId,
      chainId,
      loaded.entries,
      loaded.head,
    );
    const seq = replayed.head?.seq ?? 0;
    if (seq < this.highWater)
      tampered(`log went back from ${this.highWater} to ${seq} entries`);
    this.highWater = seq;
    const records = replayed.records.map((r) => deepFreeze(r));
    await verifyDelegationRecords(records, this.policy);
    return { records, head: replayed.head };
  }

  /** The verified current records (pass to `tally`). */
  async list(): Promise<readonly DelegationRecord[]> {
    return (await this.state()).records;
  }

  /** The current head, for anchoring outside this database. */
  async head(): Promise<DelegationLogHead | null> {
    return (await this.state()).head;
  }

  private async write(
    kind: DelegationLogEntry['kind'],
    apply: (r: DelegationRegistry) => Promise<DelegationRecord>,
    now: number,
  ): Promise<DelegationRecord> {
    const { workspaceId, chainId } = this.policy;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      const { records, head } = await this.state();
      const registry = new DelegationRegistry(this.policy, records);
      const before = new Map(records.map((r) => [r.id, r]));
      const record = await apply(registry);
      if (before.get(record.id) === record) return record; // idempotent revoke
      const body = {
        seq: (head?.seq ?? 0) + 1,
        kind,
        delegationId: record.id,
        record,
        at: now,
        prevHash: head?.hash ?? GENESIS_HASH,
      };
      const entry: DelegationLogEntry = deepFreeze({
        ...body,
        hash: delegationLogHash(workspaceId, chainId, body),
      });
      if (await this.store.append(workspaceId, chainId, entry)) {
        this.highWater = entry.seq;
        return record;
      }
    }
    throw new GovernanceError(
      'CONCURRENT_UPDATE',
      'delegation log kept advancing; retry',
    );
  }

  register(d: Delegation, signature: unknown, now: number) {
    return this.write('REGISTER', (r) => r.register(d, signature, now), now);
  }

  revoke(r: DelegationRevocation, signature: unknown, now: number) {
    return this.write('REVOKE', (x) => x.revoke(r, signature, now), now);
  }
}
