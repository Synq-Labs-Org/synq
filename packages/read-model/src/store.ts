import type { ChainEvent } from './events.js';
import type { LoadRequest, ScopeKey } from './projection.js';
import type { GroupRow, Hex, TableChanges, Tables } from './tables.js';

export interface Checkpoint {
  chainId: number;
  indexedThroughBlock: number;
  generation: number;
  configHash: Hex;
  buildId: Hex;
}
export interface StoredEvent {
  event: ChainEvent;
  scope: readonly ScopeKey[];
}
export type SignalResolution = 'REOBSERVED' | 'DROPPED';
export interface ReconciliationReopened {
  id: string;
  seq: number;
  chainId: number;
  transactionHash: Hex;
  logIndex: number;
  blockNumber: number;
  orphanedBlockHash: Hex;
  eventName: 'Transfer' | 'GrantExecuted' | 'SpendRecorded';
  groupIds: Hex[];
  intentHash: Hex | null;
  nonce: string | null;
  fingerprint: string;
  status: 'OPEN' | 'RESOLVED';
  resolution: SignalResolution | null;
  reobservedBlock: number | null;
  reobservedBlockHash: Hex | null;
  openedGeneration: number;
  resolvedGeneration: number | null;
  evidence: string | null;
}
export interface MandateArtifact {
  mandateHash: Hex;
  artifact: unknown;
}
export interface Scope2 {
  groups: Hex[];
  accounts: Hex[];
}

export interface ProjectionSession {
  checkpoint(): Promise<Checkpoint | null>;
  saveCheckpoint(checkpoint: Checkpoint): Promise<void>;
  journalRange(
    fromExclusive: number,
    toInclusive: number,
  ): Promise<StoredEvent[]>;
  journalByScope(
    keys: readonly ScopeKey[],
    beforeBlock: number,
  ): Promise<StoredEvent[]>;
  journalByTransactions(txHashes: readonly Hex[]): Promise<StoredEvent[]>;
  load(request: LoadRequest, into: Tables): Promise<void>;
  loadGroups(
    groupIds: readonly Hex[],
    into: Tables,
    full?: boolean,
  ): Promise<void>;
  groupIndex(groupIds?: readonly Hex[]): Promise<GroupRow[]>;
  clearScope(scope: Scope2): Promise<void>;
  write(changes: TableChanges): Promise<void>;
  insertEvents(
    events: readonly StoredEvent[],
    generation: number,
  ): Promise<void>;
  deleteEvents(events: readonly ChainEvent[]): Promise<void>;
  signals(status?: 'OPEN'): Promise<ReconciliationReopened[]>;
  saveSignal(signal: Omit<ReconciliationReopened, 'seq'>): Promise<void>;
  saveArtifact(artifact: MandateArtifact): Promise<void>;
  artifactHashes(): Promise<Set<string>>;
  allTables(): Promise<Tables>;
}

export interface ProjectionStore {
  readonly chainId: number;
  readonly namespace: string;
  transaction<T>(fn: (session: ProjectionSession) => Promise<T>): Promise<T>;
  read<T>(fn: (session: ProjectionSession) => Promise<T>): Promise<T>;
}
