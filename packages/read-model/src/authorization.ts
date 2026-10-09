import { ReadModelError } from './errors.js';
import { assessFreshness, type ChainHeadObserver } from './freshness.js';
import type { SnapshotSource } from './reader.js';
import type { Hex } from './tables.js';
import type {
  DirectVerificationResult,
  RpcDirectVerifier,
  VerificationTarget,
} from './verifier.js';
import type { Freshness, GroupSnapshot } from './views.js';
import type { ReconciliationReopened, SignalResolution } from './store.js';
import type { Projector } from './projector.js';

export interface AuthorizationRead {
  mode: 'INDEXED' | 'DIRECT';
  snapshot: GroupSnapshot;
  freshness: Freshness;
  direct: DirectVerificationResult | null;
}

export class StaleIndexError extends ReadModelError {
  constructor(
    readonly freshness: Freshness,
    readonly direct: DirectVerificationResult | null,
  ) {
    super(
      'STALE_INDEX',
      `indexed through ${freshness.indexedThroughBlock}, head ${freshness.observedHead}, lag ${freshness.lagBlocks} > ${freshness.maxLagBlocks}${direct ? '; direct chain read differs from projection' : ''}`,
    );
    this.name = 'StaleIndexError';
  }
}

export interface AuthorizationReadPort {
  readForAuthorization(
    groupId: Hex,
    targets?: readonly VerificationTarget[],
  ): Promise<AuthorizationRead>;
}

export interface ReconciliationSignalPort {
  openSignals(): Promise<ReconciliationReopened[]>;
  signal(id: string): Promise<ReconciliationReopened | null>;
  resolve(
    id: string,
    resolution: SignalResolution,
    evidence: string,
  ): Promise<ReconciliationReopened>;
}

export class ProjectionReconciliationSignals implements ReconciliationSignalPort {
  constructor(private readonly projector: Projector) {}
  async openSignals(): Promise<ReconciliationReopened[]> {
    return this.projector.store.read((s) => s.signals('OPEN'));
  }
  async signal(id: string): Promise<ReconciliationReopened | null> {
    const all = await this.projector.store.read((s) => s.signals());
    return all.find((x) => x.id === id) ?? null;
  }
  resolve(
    id: string,
    resolution: SignalResolution,
    evidence: string,
  ): Promise<ReconciliationReopened> {
    return this.projector.resolveSignal(id, resolution, evidence);
  }
}

export class ReadModelAuthorizationAdapter implements AuthorizationReadPort {
  constructor(
    private readonly deps: {
      source: SnapshotSource;
      head: ChainHeadObserver;
      verifier: RpcDirectVerifier | null;
      maxLagBlocks: number;
    },
  ) {}

  async freshness(groupId?: Hex): Promise<{
    freshness: Freshness;
    snapshot: GroupSnapshot | null;
  }> {
    const [snapshot, progress, head] = await Promise.all([
      groupId ? this.deps.source.groupSnapshot(groupId) : null,
      this.deps.source.progress(),
      this.deps.head.head(),
    ]);
    const indexed =
      snapshot?.indexedThroughBlock ?? progress.indexedThroughBlock;
    return {
      snapshot,
      freshness: assessFreshness({
        sourceChainId: this.deps.source.chainId,
        indexedThroughBlock: indexed,
        head,
        maxLagBlocks: this.deps.maxLagBlocks,
        frozen: snapshot?.group.accountingStatus === 'FROZEN',
      }),
    };
  }

  async readForAuthorization(
    groupId: Hex,
    targets?: readonly VerificationTarget[],
  ): Promise<AuthorizationRead> {
    const { snapshot, freshness } = await this.freshness(groupId);
    if (!snapshot) throw new ReadModelError('NOT_FOUND', groupId);
    if (freshness.status === 'FROZEN')
      throw new ReadModelError(
        'ACCOUNTING_FROZEN',
        `${groupId} has reopened reconciliation`,
      );
    if (freshness.status === 'INCONSISTENT')
      throw new ReadModelError(
        'INCONSISTENT_WITH_CHAIN',
        'index ahead of observed head',
      );
    if (freshness.status === 'FRESH')
      return { mode: 'INDEXED', snapshot, freshness, direct: null };
    if (!this.deps.verifier) throw new StaleIndexError(freshness, null);
    const direct = await this.deps.verifier.readAtHead(
      groupId,
      freshness.observedHead,
      targets,
    );
    if (!direct.consistent) throw new StaleIndexError(freshness, direct);
    return { mode: 'DIRECT', snapshot, freshness, direct };
  }
}
