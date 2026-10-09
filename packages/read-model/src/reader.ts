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
  CheckpointStampSchema,
  GroupStampSchema,
  ProgressSchema,
  groupState,
  groupStateHash,
  type BuildIdentity,
  type CheckpointStamp,
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
  checkpointStamp(): Promise<CheckpointStamp>;
}

export type CurrentMandateArtifact = {
  groupId: Hex;
  account: Hex;
  mandateId: Hex;
  version: number;
  minValidVersion: number;
  mandateHash: Hex;
  artifact: unknown;
  indexedThroughBlock: number;
};

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
        lineage: cp.lineage,
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
        revisionLineage: await s.lineageAt(g.revision),
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
        revisionLineage: await s.lineageAt(g.revision),
        accountingStatus: g.accounting_status,
      });
    });
  }
  async checkpointStamp(): Promise<CheckpointStamp> {
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      return CheckpointStampSchema.parse({
        build: this.build(cp),
        generation: cp.generation,
        lineage: cp.lineage,
      });
    });
  }
  async currentMandateArtifacts(): Promise<CurrentMandateArtifact[]> {
    return this.store.read(async (s) => {
      const cp = await this.checkpoint(s);
      const groups = await s.groupIndex();
      const tables = new Tables();
      await s.loadGroups(
        groups.map((g) => g.group_id),
        tables,
      );
      const artifacts = new Map(
        (await s.artifacts()).map((a) => [a.mandateHash, a.artifact]),
      );
      const out: CurrentMandateArtifact[] = [];
      for (const m of tables.rows('mandate')) {
        if (m.status !== 'ACTIVE') continue;
        const group = tables.get('group', m.group_id);
        const version = tables
          .rows('mandate_version')
          .find(
            (v) =>
              v.group_id === m.group_id &&
              v.mandate_id === m.mandate_id &&
              v.version === m.current_version,
          );
        if (!group || !version || !artifacts.has(version.mandate_hash))
          continue;
        out.push({
          groupId: m.group_id,
          account: group.account,
          mandateId: m.mandate_id,
          version: Number(m.current_version),
          minValidVersion: Number(m.min_valid_version),
          mandateHash: version.mandate_hash,
          artifact: structuredClone(artifacts.get(version.mandate_hash)),
          indexedThroughBlock: cp.indexedThroughBlock,
        });
      }
      return out.sort((a, b) =>
        a.mandateHash < b.mandateHash
          ? -1
          : a.mandateHash > b.mandateHash
            ? 1
            : 0,
      );
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
