import { keccak256, stringToHex } from 'viem';
import type { ProjectionConfig } from './config.js';
import { ReadModelError, fail } from './errors.js';
import { canonicalJson } from './events.js';
import { initialCheckpoint } from './projector.js';
import type {
  Checkpoint,
  MandateArtifact,
  ProjectionSession,
  ProjectionStore,
} from './store.js';
import { Tables, stateHash, type Hex } from './tables.js';
import {
  GroupSnapshotSchema,
  GroupStampSchema,
  ProgressSchema,
  groupState,
  groupStateHash,
  type BuildIdentity,
  type GroupSnapshot,
  type GroupStamp,
  type Progress,
} from './views.js';
import { configHash } from './config.js';

export interface SnapshotSource {
  readonly chainId: number;
  readonly scope: string;
  progress(): Promise<Progress>;
  groupSnapshot(groupId: Hex): Promise<GroupSnapshot | null>;
  stamp(groupId: Hex): Promise<GroupStamp | null>;
}

export type ArtifactHasher = (artifact: unknown) => Hex;
export const defaultArtifactHasher: ArtifactHasher = (artifact) =>
  keccak256(stringToHex(canonicalJson(artifact)));

export class ProjectionReader implements SnapshotSource {
  readonly chainId: number;
  readonly scope: string;
  constructor(
    readonly store: ProjectionStore,
    readonly config: ProjectionConfig,
  ) {
    this.chainId = config.chainId;
    this.scope = `${store.namespace}:${configHash(config)}`;
  }
  private build(cp: Checkpoint): BuildIdentity {
    return {
      id: cp.buildId,
      store: this.store.namespace,
      configHash: cp.configHash,
    };
  }
  private async checkpoint(s: ProjectionSession) {
    const cp = (await s.checkpoint()) ?? initialCheckpoint(this.config);
    if (cp.configHash !== configHash(this.config))
      fail('CONFIG_MISMATCH', 'reader configuration differs from projection');
    return cp;
  }
  async progress(): Promise<Progress> {
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      const groups = (await s.groupIndex())
        .map((g) => ({
          groupId: g.group_id,
          account: g.account,
          revision: g.revision,
          accountingStatus: g.accounting_status,
        }))
        .sort((a, b) => (a.groupId < b.groupId ? -1 : 1));
      return ProgressSchema.parse({
        schemaVersion: 1,
        sourceChainId: this.config.chainId,
        profile: this.config.profile,
        build: this.build(cp),
        indexedThroughBlock: cp.indexedThroughBlock,
        generation: cp.generation,
        frozenGroups: groups
          .filter((g) => g.accountingStatus === 'FROZEN')
          .map((g) => g.groupId),
        groups,
      });
    });
  }
  async groupSnapshot(groupId: Hex): Promise<GroupSnapshot | null> {
    const id = groupId.toLowerCase() as Hex;
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      const tables = new Tables();
      await s.loadGroups([id], tables, true);
      const g = tables.get('group', id);
      if (!g) return null;
      const state = groupState(tables, id, await s.artifactHashes());
      if (!state) return null;
      return GroupSnapshotSchema.parse({
        schemaVersion: 1,
        sourceChainId: this.config.chainId,
        profile: this.config.profile,
        build: this.build(cp),
        indexedThroughBlock: cp.indexedThroughBlock,
        generation: cp.generation,
        groupRevision: g.revision,
        stateHash: groupStateHash(state),
        group: state,
      });
    });
  }
  async stamp(groupId: Hex): Promise<GroupStamp | null> {
    const id = groupId.toLowerCase() as Hex;
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      const [g] = await s.groupIndex([id]);
      if (!g || g.group_id !== id) return null;
      return GroupStampSchema.parse({
        build: this.build(cp),
        generation: cp.generation,
        indexedThroughBlock: cp.indexedThroughBlock,
        groupRevision: g.revision,
        accountingStatus: g.accounting_status,
      });
    });
  }
  async stateHash(): Promise<Hex> {
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      return stateHash(await s.allTables(), {
        chainId: cp.chainId,
        indexedThroughBlock: cp.indexedThroughBlock,
        configHash: cp.configHash,
        artifacts: [...(await s.artifactHashes())].sort(),
      });
    });
  }
}

export async function registerMandateArtifacts(
  store: ProjectionStore,
  artifacts: readonly MandateArtifact[],
  hasher: ArtifactHasher = defaultArtifactHasher,
): Promise<void> {
  for (const a of artifacts)
    if (hasher(a.artifact).toLowerCase() !== a.mandateHash.toLowerCase())
      throw new ReadModelError('MANDATE_ARTIFACT_MISMATCH', a.mandateHash);
  await store.transaction(async (s) => {
    for (const a of artifacts)
      await s.saveArtifact({
        mandateHash: a.mandateHash.toLowerCase() as Hex,
        artifact: a.artifact,
      });
  });
}
