import { compareEvents, eventKey, type ChainEvent } from './events.js';
import type { LoadRequest, ScopeKey } from './projection.js';
import type {
  Checkpoint,
  MandateArtifact,
  ProjectionSession,
  ProjectionStore,
  ReconciliationReopened,
  Scope2,
  StoredEvent,
} from './store.js';
import {
  TABLE_NAMES,
  TABLES,
  Tables,
  type Hex,
  type TableChanges,
  type TableName,
  type TableRows,
} from './tables.js';

interface MemoryState {
  checkpoint: Checkpoint | null;
  lineage: Map<number, Hex>;
  journal: Map<string, StoredEvent & { generation: number }>;
  tables: Tables;
  signals: Map<string, ReconciliationReopened>;
  artifacts: Map<string, MandateArtifact>;
  seq: number;
}

function cloneTables(t: Tables): Tables {
  const copy = new Tables();
  for (const name of TABLE_NAMES)
    copy.load(name, structuredClone(t.rows(name)));
  return copy;
}

export class MemoryProjectionStore implements ProjectionStore {
  private state: MemoryState = {
    checkpoint: null,
    lineage: new Map(),
    journal: new Map(),
    tables: new Tables(),
    signals: new Map(),
    artifacts: new Map(),
    seq: 0,
  };
  constructor(
    readonly chainId: number,
    readonly namespace = 'memory',
  ) {}
  snapshotTables(): Tables {
    return cloneTables(this.state.tables);
  }
  journal(): StoredEvent[] {
    return [...this.state.journal.values()]
      .map(({ event, scope }) => structuredClone({ event, scope }))
      .sort((a, b) => compareEvents(a.event, b.event));
  }
  readCount = 0;
  async read<T>(fn: (s: ProjectionSession) => Promise<T>): Promise<T> {
    this.readCount++;
    return fn(new MemorySession(this.state));
  }
  async transaction<T>(fn: (s: ProjectionSession) => Promise<T>): Promise<T> {
    const working: MemoryState = {
      checkpoint: structuredClone(this.state.checkpoint),
      lineage: new Map(this.state.lineage),
      journal: new Map(
        [...this.state.journal].map(([k, v]) => [k, structuredClone(v)]),
      ),
      tables: cloneTables(this.state.tables),
      signals: new Map(
        [...this.state.signals].map(([k, v]) => [k, structuredClone(v)]),
      ),
      artifacts: new Map(
        [...this.state.artifacts].map(([k, v]) => [k, structuredClone(v)]),
      ),
      seq: this.state.seq,
    };
    const result = await fn(new MemorySession(working));
    this.state = working;
    return result;
  }
}

class MemorySession implements ProjectionSession {
  constructor(private readonly s: MemoryState) {}
  async checkpoint() {
    return structuredClone(this.s.checkpoint);
  }
  async saveCheckpoint(cp: Checkpoint) {
    this.s.checkpoint = structuredClone(cp);
  }
  async saveLineage(generation: number, lineage: Hex) {
    this.s.lineage.set(generation, lineage);
  }
  async lineageAt(generation: number) {
    return this.s.lineage.get(generation) ?? null;
  }
  private events(filter: (e: StoredEvent) => boolean): StoredEvent[] {
    return [...this.s.journal.values()]
      .filter(filter)
      .map(({ event, scope }) => structuredClone({ event, scope }))
      .sort((a, b) => compareEvents(a.event, b.event));
  }
  async journalRange(fromExclusive: number, toInclusive: number) {
    return this.events(
      (x) =>
        x.event.blockNumber > fromExclusive &&
        x.event.blockNumber <= toInclusive,
    );
  }
  async journalByScope(keys: readonly ScopeKey[], beforeBlock: number) {
    const set = new Set<string>(keys);
    return this.events(
      (x) =>
        x.event.blockNumber < beforeBlock && x.scope.some((k) => set.has(k)),
    );
  }
  async journalByTransactions(txHashes: readonly Hex[]) {
    const set = new Set<string>(txHashes);
    return this.events((x) => set.has(x.event.transactionHash));
  }
  private copy<T extends TableName>(
    into: Tables,
    table: T,
    predicate: (row: TableRows[T]) => boolean,
  ) {
    into.load(table, structuredClone(this.s.tables.where(table, predicate)));
  }
  async load(request: LoadRequest, into: Tables) {
    const accounts = new Set<string>(request.accounts);
    this.copy(into, 'tracked_account', (r) => accounts.has(r.account));
    const groups = new Set<string>(request.groups);
    for (const r of into.rows('tracked_account'))
      if (r.group_id) groups.add(r.group_id);
    await this.loadGroups([...groups] as Hex[], into);
    this.copy(into, 'balance', (r) => accounts.has(r.account));
    const nonces = new Set(request.grantNonces.map(([g, n]) => `${g}|${n}`));
    const intents = new Set(request.grantIntents.map(([g, i]) => `${g}|${i}`));
    this.copy(
      into,
      'grant_executed',
      (r) =>
        nonces.has(`${r.group_id}|${r.nonce}`) ||
        intents.has(`${r.group_id}|${r.intent_hash}`),
    );
    const cancelled = new Set(
      request.cancelledNonces.map(([g, n]) => `${g}|${n}`),
    );
    this.copy(into, 'cancelled_nonce', (r) =>
      cancelled.has(`${r.group_id}|${r.nonce}`),
    );
  }
  async loadGroups(groupIds: readonly Hex[], into: Tables, full = false) {
    const groups = new Set<string>(groupIds);
    this.copy(into, 'group', (r) => groups.has(r.group_id));
    for (const t of [
      'owner',
      'safe_module',
      'executor',
      'mandate',
      'mandate_version',
    ] as const)
      this.copy(into, t, (r) => groups.has(r.group_id));
    if (full)
      for (const t of ['grant_executed', 'cancelled_nonce', 'spend'] as const)
        this.copy(into, t, (r) => groups.has(r.group_id));
    const accounts = new Set(into.rows('group').map((g) => g.account));
    this.copy(into, 'tracked_account', (r) => accounts.has(r.account));
    this.copy(into, 'balance', (r) => accounts.has(r.account));
  }
  async clearScope(scope: Scope2) {
    const groups = new Set<string>(scope.groups);
    const t = this.s.tables;
    for (const name of TABLE_NAMES) {
      const col = TABLES[name].groupColumn;
      if (!col || name === 'tracked_account') continue;
      for (const row of t.rows(name)) {
        const values = row as unknown as Record<string, unknown>;
        if (groups.has(String(values[col])))
          t.remove(
            name,
            TABLES[name].pk.map((c) => String(values[c])).join('|'),
          );
      }
    }
    const owned = new Set(
      t
        .rows('tracked_account')
        .filter((r) => r.group_id && groups.has(r.group_id))
        .map((r) => r.account),
    );
    for (const a of owned) t.remove('tracked_account', a);
    for (const b of t.rows('balance')) {
      if (owned.has(b.account)) t.remove('balance', `${b.account}|${b.asset}`);
      else if ((scope.accounts as string[]).includes(b.account))
        t.put('balance', {
          ...b,
          balance: b.baseline_balance,
          last_block: b.baseline_block,
        });
    }
    t.clearChanges();
  }
  async write(changes: TableChanges) {
    for (const name of TABLE_NAMES) {
      for (const row of changes.deletes[name] ?? []) {
        const values = row as unknown as Record<string, unknown>;
        this.s.tables.remove(
          name,
          TABLES[name].pk.map((c) => String(values[c])).join('|'),
        );
      }
      for (const row of changes.upserts[name] ?? [])
        this.s.tables.put(name, structuredClone(row) as never);
    }
    this.s.tables.clearChanges();
  }
  async insertEvents(events: readonly StoredEvent[], generation: number) {
    for (const e of events) {
      const key = eventKey(e.event);
      if (this.s.journal.has(key)) throw new Error(`duplicate journal ${key}`);
      this.s.journal.set(key, { ...structuredClone(e), generation });
    }
  }
  async deleteEvents(events: readonly ChainEvent[]) {
    for (const e of events) this.s.journal.delete(eventKey(e));
  }
  async signals(status?: 'OPEN') {
    return [...this.s.signals.values()]
      .filter((x) => !status || x.status === status)
      .sort((a, b) => a.seq - b.seq)
      .map((x) => structuredClone(x));
  }
  async saveSignal(signal: Omit<ReconciliationReopened, 'seq'>) {
    const prev = this.s.signals.get(signal.id);
    const seq = prev?.seq ?? ++this.s.seq;
    this.s.signals.set(signal.id, { ...structuredClone(signal), seq });
  }
  async saveArtifact(artifact: MandateArtifact) {
    this.s.artifacts.set(artifact.mandateHash, structuredClone(artifact));
  }
  async artifactHashes() {
    return new Set(this.s.artifacts.keys());
  }
  async artifacts() {
    return structuredClone([...this.s.artifacts.values()]);
  }
  async groupIndex(groupIds?: readonly Hex[]) {
    const rows = this.s.tables.rows('group');
    return structuredClone(
      groupIds ? rows.filter((r) => groupIds.includes(r.group_id)) : rows,
    );
  }
  async allTables() {
    return cloneTables(this.s.tables);
  }
}
