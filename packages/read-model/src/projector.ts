import { randomBytes } from 'node:crypto';
import { configHash, type ProjectionConfig } from './config.js';
import { ReadModelError, fail } from './errors.js';
import {
  ECONOMIC_EVENTS,
  canonicalJson,
  compareEvents,
  eventFingerprint,
  eventKey,
  parseChainEvent,
  sameEvent,
  type ChainEvent,
} from './events.js';
import { Projection, loadRequest, type ScopeKey } from './projection.js';
import type {
  Checkpoint,
  ProjectionSession,
  ProjectionStore,
  ReconciliationReopened,
  SignalResolution,
  StoredEvent,
} from './store.js';
import { Tables, type Hex } from './tables.js';

export interface EventWindow {
  fromBlockExclusive: number;
  toBlockInclusive: number;
  events: readonly unknown[];
  sourceProgressBlock?: number;
}
export interface ReorgReport {
  forkBlock: number;
  removed: number;
  orphaned: number;
  reapplied: number;
}
export interface WindowOutcome {
  generation: number;
  indexedThroughBlock: number;
  appended: number;
  duplicates: number;
  reorg: ReorgReport | null;
  reopened: ReconciliationReopened[];
  resolved: ReconciliationReopened[];
  changedGroups: Hex[];
}
export type ReconciliationListener = (
  signals: readonly ReconciliationReopened[],
) => void | Promise<void>;

const isBlock = (n: number) => Number.isSafeInteger(n) && n >= 0;

function blockSignatures(events: readonly ChainEvent[]): Map<number, string> {
  const byBlock = new Map<number, ChainEvent[]>();
  for (const e of events) {
    const list = byBlock.get(e.blockNumber) ?? [];
    list.push(e);
    byBlock.set(e.blockNumber, list);
  }
  const out = new Map<number, string>();
  for (const [block, list] of byBlock)
    out.set(
      block,
      canonicalJson(
        [...list]
          .sort(compareEvents)
          .map((e) => [e.blockHash, eventKey(e), eventFingerprint(e)]),
      ),
    );
  return out;
}

export function initialCheckpoint(config: ProjectionConfig): Checkpoint {
  return {
    chainId: config.chainId,
    indexedThroughBlock: config.startBlock - 1,
    generation: 0,
    configHash: configHash(config),
    buildId: newBuildId(),
  };
}

export function newBuildId(): Hex {
  return `0x${randomBytes(16).toString('hex')}`;
}

export class Projector {
  private readonly listeners: ReconciliationListener[] = [];
  constructor(
    readonly store: ProjectionStore,
    readonly config: ProjectionConfig,
  ) {
    if (store.chainId !== config.chainId)
      fail('CONFIG_MISMATCH', 'store/config chain mismatch');
    if (config.startBlock < 1) fail('CONFIG_MISMATCH', 'start block');
  }
  onReconciliationReopened(listener: ReconciliationListener): void {
    this.listeners.push(listener);
  }

  async checkpoint(): Promise<Checkpoint> {
    return this.store.transaction((s) => this.current(s));
  }

  private async current(s: ProjectionSession): Promise<Checkpoint> {
    const cp = (await s.checkpoint()) ?? initialCheckpoint(this.config);
    if (cp.configHash !== configHash(this.config))
      fail('CONFIG_MISMATCH', 'projection built with another configuration');
    return cp;
  }

  async applyWindow(window: EventWindow): Promise<WindowOutcome> {
    const outcome = await this.store.transaction((s) =>
      this.applyIn(s, window),
    );
    if (outcome.reopened.length)
      for (const l of this.listeners) await l(outcome.reopened);
    return outcome;
  }

  async resolveSignal(
    id: string,
    resolution: SignalResolution,
    evidence: string,
  ): Promise<ReconciliationReopened> {
    if (!evidence.trim()) fail('INVALID_TRANSITION', 'resolution evidence');
    return this.store.transaction(async (s) => {
      const cp = await this.current(s);
      const open = await s.signals('OPEN');
      const signal = open.find((x) => x.id === id);
      if (!signal) fail('NOT_FOUND', `open signal ${id}`);
      const generation = cp.generation + 1;
      const resolved = {
        ...signal,
        status: 'RESOLVED' as const,
        resolution,
        resolvedGeneration: generation,
        evidence,
      };
      await s.saveSignal(resolved);
      const tables = new Tables();
      await s.loadGroups(signal.groupIds, tables);
      await this.refreeze(s, tables, signal.groupIds, generation);
      await s.write(tables.changes());
      await s.saveCheckpoint({ ...cp, generation });
      return { ...resolved, seq: signal.seq };
    });
  }

  private async applyIn(
    s: ProjectionSession,
    window: EventWindow,
  ): Promise<WindowOutcome> {
    const cp = await this.current(s);
    const from = window.fromBlockExclusive;
    const to = window.toBlockInclusive;
    if (!isBlock(from) || !isBlock(to) || to < from)
      fail('INVALID_EVENT', 'invalid window');
    if (from < this.config.startBlock - 1)
      fail('GAP_DETECTED', 'window precedes start block');
    if (from > cp.indexedThroughBlock)
      fail(
        'GAP_DETECTED',
        `window starts after ${from}, checkpoint is ${cp.indexedThroughBlock}`,
      );
    const progress = window.sourceProgressBlock;
    if (progress !== undefined && (!isBlock(progress) || progress < to))
      fail('INCONSISTENT_PROOF', 'source progress below window end');
    const source = this.parseWindow(window);

    const journal = await s.journalRange(from, cp.indexedThroughBlock);
    const journalEvents = journal.map((x) => x.event);
    const overlapTo = Math.min(cp.indexedThroughBlock, to);
    const regression =
      progress !== undefined && progress < cp.indexedThroughBlock
        ? progress
        : null;
    const srcSig = blockSignatures(
      source.filter((e) => e.blockNumber <= overlapTo),
    );
    const jSig = blockSignatures(
      journalEvents.filter((e) => e.blockNumber <= overlapTo),
    );
    let fork: number | null = null;
    for (const block of new Set([...srcSig.keys(), ...jSig.keys()]))
      if (srcSig.get(block) !== jSig.get(block))
        fork = fork === null ? block : Math.min(fork, block);
    if (fork !== null) {
      const at = fork;
      const sHash = source.find((e) => e.blockNumber === at)?.blockHash;
      const jHash = journalEvents.find((e) => e.blockNumber === at)?.blockHash;
      if (sHash && jHash && sHash === jHash)
        fail(
          'INCONSISTENT_PROOF',
          `events of block ${at} changed without a block hash change`,
        );
    }
    if (regression !== null) {
      const above = journalEvents.filter((e) => e.blockNumber > regression);
      const first = Math.min(...above.map((e) => e.blockNumber));
      if (above.length) fork = fork === null ? first : Math.min(fork, first);
    }

    const newCheckpoint =
      regression !== null
        ? regression
        : fork !== null
          ? to
          : Math.max(cp.indexedThroughBlock, to);
    const removed =
      fork === null ? [] : journal.filter((x) => x.event.blockNumber >= fork);
    const toApply = source
      .filter((e) =>
        fork === null
          ? e.blockNumber > cp.indexedThroughBlock
          : e.blockNumber >= fork,
      )
      .sort(compareEvents);
    const duplicates = source.length - toApply.length;
    const removedKeys = new Set(removed.map((x) => eventKey(x.event)));
    const existing = await s.journalByTransactions([
      ...new Set(toApply.map((e) => e.transactionHash)),
    ]);
    for (const old of existing) {
      if (removedKeys.has(eventKey(old.event))) continue;
      const clash = toApply.find(
        (e) =>
          e.transactionHash === old.event.transactionHash &&
          (e.blockNumber !== old.event.blockNumber ||
            eventKey(e) === eventKey(old.event)),
      );
      if (clash)
        fail(
          'CONFLICTING_DUPLICATE',
          `${eventKey(clash)} already indexed at block ${old.event.blockNumber}`,
        );
    }

    const generation =
      cp.generation +
      (toApply.length ||
      removed.length ||
      newCheckpoint !== cp.indexedThroughBlock
        ? 1
        : 0);
    const tables = new Tables();
    const projection = new Projection(this.config, tables);
    const changed = new Set<Hex>();
    let scopeGroups: Hex[] = [];
    if (fork !== null && removed.length) {
      const scope = await this.expandScope(
        s,
        removed.flatMap((x) => x.scope),
      );
      scopeGroups = scope.groups;
      await s.deleteEvents(removed.map((x) => x.event));
      await s.clearScope(scope);
      const keys: ScopeKey[] = [
        ...scope.groups.map((g) => `g:${g}` as const),
        ...scope.accounts.map((a) => `a:${a}` as const),
      ];
      const replay = (await s.journalByScope(keys, fork)).map((x) => x.event);
      await s.load(loadRequest([...replay, ...toApply], this.config), tables);
      await s.loadGroups(scope.groups, tables);
      projection.seedObservedAccounts();
      const replayed = projection.apply(replay, generation, {
        groups: new Set(scope.groups),
        accounts: new Set(scope.accounts),
      });
      for (const g of replayed.touchedGroups) changed.add(g);
      for (const g of scope.groups) changed.add(g);
    } else {
      await s.load(loadRequest(toApply, this.config), tables);
      if (cp.generation === 0) projection.seedObservedAccounts();
    }
    const applied = projection.apply(toApply, generation);
    for (const g of applied.touchedGroups) changed.add(g);
    const stored: StoredEvent[] = toApply.map((e) => ({
      event: e,
      scope: applied.scopes.get(`${e.transactionHash}:${e.logIndex}`) ?? [],
    }));
    await s.insertEvents(stored, generation);

    const sourceKeys = new Map(source.map((e) => [eventKey(e), e]));
    const orphaned = removed.filter((x) => {
      const replacement = sourceKeys.get(eventKey(x.event));
      return !replacement || !sameEvent(replacement, x.event);
    });
    const reopened: ReconciliationReopened[] = [];
    const accountGroup = (account: Hex) =>
      tables.get('tracked_account', account)?.group_id ?? null;
    const prior = await s.signals();
    for (const x of orphaned) {
      const e = x.event;
      if (!ECONOMIC_EVENTS.includes(e.eventName)) continue;
      const id = `${e.chainId}:${e.transactionHash}:${e.logIndex}:${e.blockHash}`;
      if (prior.some((p) => p.id === id)) continue;
      const groupIds = [
        ...new Set(
          x.scope
            .map((k) =>
              k.startsWith('g:')
                ? (k.slice(2) as Hex)
                : accountGroup(k.slice(2) as Hex),
            )
            .filter((g): g is Hex => g !== null),
        ),
      ].sort();
      const signal: ReconciliationReopened = {
        id,
        seq: 0,
        chainId: e.chainId,
        transactionHash: e.transactionHash,
        logIndex: e.logIndex,
        blockNumber: e.blockNumber,
        orphanedBlockHash: e.blockHash,
        eventName: e.eventName as ReconciliationReopened['eventName'],
        groupIds,
        intentHash:
          e.eventName === 'GrantExecuted' ? e.payload.intentHash : null,
        nonce: e.eventName === 'GrantExecuted' ? e.payload.nonce : null,
        fingerprint: eventFingerprint(e),
        status: 'OPEN',
        resolution: null,
        reobservedBlock: null,
        reobservedBlockHash: null,
        openedGeneration: generation,
        resolvedGeneration: null,
        evidence: null,
      };
      await s.saveSignal(signal);
      reopened.push(signal);
    }
    const resolved = await this.resolveReobserved(
      s,
      [...prior.filter((p) => p.status === 'OPEN'), ...reopened],
      newCheckpoint,
      generation,
    );
    const stillOpen = prior.filter(
      (p) => p.status === 'OPEN' && !resolved.some((r) => r.id === p.id),
    );
    const freezeGroups = [
      ...new Set([
        ...scopeGroups,
        ...reopened.flatMap((x) => x.groupIds),
        ...resolved.flatMap((x) => x.groupIds),
        ...stillOpen.flatMap((x) => x.groupIds),
      ]),
    ];
    await s.loadGroups(freezeGroups, tables);
    for (const g of await this.refreeze(s, tables, freezeGroups, generation))
      changed.add(g);
    await s.write(tables.changes());
    await s.saveCheckpoint({
      ...cp,
      indexedThroughBlock: newCheckpoint,
      generation,
    });
    return {
      generation,
      indexedThroughBlock: newCheckpoint,
      appended: toApply.length,
      duplicates,
      reorg:
        fork === null
          ? null
          : {
              forkBlock: fork,
              removed: removed.length,
              orphaned: orphaned.length,
              reapplied: toApply.filter((e) => e.blockNumber >= fork).length,
            },
      reopened,
      resolved,
      changedGroups: [...changed].sort(),
    };
  }

  private parseWindow(window: EventWindow): ChainEvent[] {
    const out = new Map<string, ChainEvent>();
    const txBlock = new Map<string, number>();
    for (const raw of window.events) {
      const e = parseChainEvent(raw);
      if (e.chainId !== this.config.chainId)
        fail('UNTRUSTED_SOURCE', `event for chain ${e.chainId}`);
      if (
        e.blockNumber <= window.fromBlockExclusive ||
        e.blockNumber > window.toBlockInclusive
      )
        fail(
          'GAP_DETECTED',
          `event at ${e.blockNumber} outside window (${window.fromBlockExclusive}, ${window.toBlockInclusive}]`,
        );
      const key = eventKey(e);
      const prev = out.get(key);
      if (prev && !sameEvent(prev, e)) fail('CONFLICTING_DUPLICATE', key);
      const block = txBlock.get(e.transactionHash);
      if (block !== undefined && block !== e.blockNumber)
        fail('CONFLICTING_DUPLICATE', `${e.transactionHash} in two blocks`);
      txBlock.set(e.transactionHash, e.blockNumber);
      out.set(key, e);
    }
    const hashes = new Map<number, string>();
    for (const e of out.values()) {
      const h = hashes.get(e.blockNumber);
      if (h && h !== e.blockHash)
        fail('INCONSISTENT_PROOF', `two hashes for block ${e.blockNumber}`);
      hashes.set(e.blockNumber, e.blockHash);
    }
    return [...out.values()];
  }

  private async expandScope(
    s: ProjectionSession,
    keys: readonly ScopeKey[],
  ): Promise<{ groups: Hex[]; accounts: Hex[] }> {
    const groups = new Set<Hex>();
    const accounts = new Set<Hex>();
    for (const k of keys)
      (k.startsWith('g:') ? groups : accounts).add(k.slice(2) as Hex);
    const t = new Tables();
    await s.loadGroups([...groups], t);
    for (const g of t.rows('group')) accounts.add(g.account);
    return { groups: [...groups].sort(), accounts: [...accounts].sort() };
  }

  private async resolveReobserved(
    s: ProjectionSession,
    open: readonly ReconciliationReopened[],
    checkpoint: number,
    generation: number,
  ): Promise<ReconciliationReopened[]> {
    const resolved: ReconciliationReopened[] = [];
    if (!open.length) return resolved;
    const found = await s.journalByTransactions([
      ...new Set(open.map((x) => x.transactionHash)),
    ]);
    for (const signal of open) {
      const match = found.find(
        (x) =>
          eventFingerprint(x.event) === signal.fingerprint &&
          x.event.blockHash !== signal.orphanedBlockHash &&
          checkpoint - x.event.blockNumber + 1 >= this.config.confirmationDepth,
      );
      if (!match) continue;
      const done: ReconciliationReopened = {
        ...signal,
        status: 'RESOLVED',
        resolution: 'REOBSERVED',
        reobservedBlock: match.event.blockNumber,
        reobservedBlockHash: match.event.blockHash,
        resolvedGeneration: generation,
        evidence: `${eventKey(match.event)}@${match.event.blockHash}`,
      };
      await s.saveSignal(done);
      resolved.push(done);
    }
    return resolved;
  }

  private async refreeze(
    s: ProjectionSession,
    tables: Tables,
    groupIds: readonly Hex[],
    generation: number,
  ): Promise<Hex[]> {
    if (!groupIds.length) return [];
    const open = await s.signals('OPEN');
    const changed: Hex[] = [];
    for (const groupId of groupIds) {
      const g = tables.get('group', groupId);
      if (!g) continue;
      const status = open.some((x) => x.groupIds.includes(groupId))
        ? 'FROZEN'
        : 'OPEN';
      if (g.accounting_status !== status) {
        tables.put('group', {
          ...g,
          accounting_status: status,
          revision: generation,
        });
        changed.push(groupId);
      }
    }
    return changed;
  }
}

export function isReadModelError(
  error: unknown,
  code?: ReadModelError['code'],
): error is ReadModelError {
  return error instanceof ReadModelError && (!code || error.code === code);
}
