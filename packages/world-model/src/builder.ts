import {
  WORLD_MODEL_SCHEMA_VERSION,
  WorldModelSnapshotSchema,
  canonicalArtifactHash,
  type Asset,
  type AssetIdentity,
  type FieldFreshness,
  type IdentityPrincipalKind,
  type NetworkProfile,
  type Observed,
  type SourceFreshness,
  type TreasuryPosition,
  type WorldMandate,
  type WorldModelSnapshot,
  type WorldModelSnapshotInput,
} from '@synq/schemas';
import { officialAssets } from '@synq/chain-registry';
import { onchainMandateId } from '@synq/kernel';
import type { PluginRegistry } from '@synq/plugin-sdk';
import type { GroupSnapshot, SnapshotSource } from '@synq/read-model';
import {
  CapabilityGraph,
  type CapabilityFactsFile,
  type ModelProviderState,
} from './capability-graph.js';
import {
  ageFreshness,
  errorCode,
  fieldMeta,
  observed,
  unknownField,
  worstFreshness,
} from './meta.js';
import type {
  IdentityDirectoryReader,
  IdentityGroupView,
  KernelStateReader,
  KernelStateSnapshot,
  MarketDataSource,
  RiskStateSource,
  WorkflowStatusReader,
} from './ports.js';

export type ReadModelPort = {
  snapshots: SnapshotSource;
  head: { head(): Promise<{ block: number }> };
  maxLagBlocks: number;
};
export type WorldSources = {
  network: NetworkProfile;
  now: () => number;
  readModel?: ReadModelPort;
  kernel?: KernelStateReader;
  identity?: IdentityDirectoryReader;
  plugins?: PluginRegistry;
  modelProviders?: Readonly<Record<string, ModelProviderState>>;
  mainnetBroadcastAllowed: boolean;
  workflows?: WorkflowStatusReader;
  market?: MarketDataSource;
  risk?: RiskStateSource;
  localAssets?: readonly Asset[];
  workflowMaxAgeSeconds?: number;
  capabilityFacts?: CapabilityFactsFile;
};
export type WorldTarget = { groupId: string; chainGroupId?: string };

type ReadModelRead = {
  snapshot: GroupSnapshot | null;
  head: number;
  freshness: FieldFreshness;
  status: 'FRESH' | 'STALE' | 'FROZEN' | 'INCONSISTENT';
  lag: number;
};

const lower = (v: string) => v.toLowerCase();

export class WorldSnapshotBuilder {
  constructor(private readonly sources: WorldSources) {}

  async build(target: WorldTarget): Promise<WorldModelSnapshot> {
    const s = this.sources;
    const now = s.now();
    const sourceFreshness: SourceFreshness[] = [];
    const note = (
      source: string,
      provenance: SourceFreshness['provenance'],
      freshness: FieldFreshness,
      observedAt: number | null,
      reason: string | null = null,
    ) =>
      sourceFreshness.push({
        source,
        provenance,
        freshness,
        observedAt,
        reason: reason?.slice(0, 200) ?? null,
      });

    let identity: IdentityGroupView | null = null;
    let identityError: string | null = s.identity
      ? null
      : 'identity directory not configured';
    if (s.identity)
      try {
        identity = await s.identity.group(target.groupId);
        if (!identity) identityError = 'GROUP_NOT_FOUND';
      } catch (error) {
        identityError = errorCode(error);
      }
    note(
      'identity-directory',
      'POSTGRES',
      identity ? 'FRESH' : 'UNKNOWN',
      identity ? now : null,
      identityError,
    );
    const chainGroupId = lower(
      target.chainGroupId ?? identity?.chainGroupId ?? '',
    );

    let rm: ReadModelRead | null = null;
    let rmError: string | null = s.readModel
      ? null
      : 'read model not configured';
    if (s.readModel && /^0x[0-9a-f]{64}$/.test(chainGroupId))
      try {
        const [snapshot, head] = await Promise.all([
          s.readModel.snapshots.groupSnapshot(chainGroupId as `0x${string}`),
          s.readModel.head.head(),
        ]);
        const indexed =
          snapshot?.indexedThroughBlock ??
          (await s.readModel.snapshots.progress()).indexedThroughBlock;
        const lag = Math.max(0, head.block - indexed);
        const status =
          snapshot?.group.accountingStatus === 'FROZEN'
            ? 'FROZEN'
            : indexed > head.block + 2
              ? 'INCONSISTENT'
              : lag > s.readModel.maxLagBlocks
                ? 'STALE'
                : 'FRESH';
        rm = {
          snapshot,
          head: head.block,
          lag,
          status,
          freshness: status === 'FRESH' ? 'FRESH' : 'STALE',
        };
        if (!snapshot) rmError = 'GROUP_NOT_INDEXED';
      } catch (error) {
        rmError = errorCode(error);
      }
    else if (s.readModel) rmError = 'chain group id unknown';
    note(
      'envio-read-model',
      'ENVIO',
      rm?.snapshot ? rm.freshness : 'UNKNOWN',
      rm ? now : null,
      rmError ??
        (rm && rm.status !== 'FRESH' ? `read model ${rm.status}` : null),
    );

    let kernel: KernelStateSnapshot | null = null;
    let kernelError: string | null = s.kernel ? null : 'kernel not configured';
    if (s.kernel)
      try {
        kernel = await s.kernel.stateView();
      } catch (error) {
        kernelError = errorCode(error);
      }
    note(
      'kernel-state',
      'KERNEL',
      kernel ? 'FRESH' : 'UNKNOWN',
      kernel ? now : null,
      kernelError,
    );
    const mandates =
      kernel?.mandates.filter((m) => m.mandate.groupId === target.groupId) ??
      [];

    const graph = CapabilityGraph.build({
      network: s.network,
      now,
      ...(s.plugins ? { plugins: s.plugins } : {}),
      ...(s.capabilityFacts ? { facts: s.capabilityFacts } : {}),
      ...(s.modelProviders ? { modelProviders: s.modelProviders } : {}),
      mainnetBroadcastAllowed: s.mainnetBroadcastAllowed,
    });


    const rmMeta = (source: string) =>
      rm?.snapshot
        ? fieldMeta({
            provenance: 'ENVIO',
            source,
            observedAt: now,
            freshness: rm.freshness,
            ...(rm.status === 'FRESH'
              ? {}
              : { reason: `read model ${rm.status} (lag ${rm.lag})` }),
          })
        : null;

    const group: Observed<WorldModelSnapshotInput['group']['value']> =
      identity && rm?.snapshot
        ? observed(
            {
              groupId: target.groupId,
              chainGroupId: rm.snapshot.group.groupId,
              chainId: s.network.chainId,
              account: rm.snapshot.group.account,
              owners: rm.snapshot.group.owners,
              threshold: Number(rm.snapshot.group.threshold ?? '0'),
              paused: rm.snapshot.group.paused,
              accountingStatus: rm.snapshot.group.accountingStatus,
              membershipEpoch: identity.membershipEpoch,
            },
            rmMeta('envio-read-model')!,
          )
        : unknownField(
            null,
            'ENVIO',
            'envio-read-model',
            rmError ?? identityError ?? 'group unavailable',
          );

    const active = identity?.memberships.filter((m) => m.status === 'ACTIVE');
    const owners = new Set((rm?.snapshot?.group.owners ?? []).map(lower));
    const identityMeta = fieldMeta({
      provenance: 'POSTGRES',
      source: 'identity-directory',
      observedAt: identity ? now : null,
      freshness: identity ? 'FRESH' : 'UNKNOWN',
      ...(identityError ? { reason: identityError } : {}),
    });
    const members = observed(
      (active ?? []).map((m) => ({
        memberId: m.memberId,
        principalId: m.principalId,
        principalKind: m.principalKind,
        role: m.role,
        signer: lower(m.signer),
        ownerOfAccount: owners.has(lower(m.signer)),
      })),
      identityMeta,
    );
    const principalTypes = observed(
      [
        ...new Set((active ?? []).map((m) => m.principalKind)),
      ].sort() as IdentityPrincipalKind[],
      identityMeta,
    );

    const kernelMeta = (reason?: string) =>
      fieldMeta({
        provenance: 'KERNEL',
        source: 'kernel-state',
        observedAt: kernel ? now : null,
        freshness: kernel ? 'FRESH' : 'UNKNOWN',
        ...(kernelError ? { reason: kernelError } : reason ? { reason } : {}),
      });
    const quorum = observed(
      {
        accountThreshold: Number(rm?.snapshot?.group.threshold ?? 0),
        approvers: (active ?? []).filter((m) => m.role === 'APPROVER').length,
        mandates: mandates.map(({ mandate }) => ({
          mandateId: mandate.mandateId,
          quorum: mandate.approvalPolicy.quorum,
          reviewApprovals: mandate.approvalPolicy.reviewApprovals,
          accountThreshold: mandate.approvalPolicy.accountThreshold,
        })),
      },
      (() => {
        const threshold = rm?.snapshot?.group.threshold ?? null;
        if (threshold === null || !kernel)
          return fieldMeta({
            provenance: 'KERNEL',
            source: 'kernel-state+envio-read-model',
            observedAt: null,
            freshness: 'UNKNOWN',
            reason: !kernel
              ? (kernelError ?? 'kernel unavailable')
              : 'account threshold not indexed',
          });
        return fieldMeta({
          provenance: 'KERNEL',
          source: 'kernel-state+envio-read-model',
          observedAt: now,
          freshness: rm!.freshness,
        });
      })(),
    );

    const worldMandates: WorldMandate[] = mandates.map(
      ({ mandate, budget }) => {
        const chainId = onchainMandateId(mandate);
        const onchain = rm?.snapshot?.group.mandates.find(
          (m) => m.mandateId === chainId,
        );
        return {
          mandateId: mandate.mandateId,
          version: mandate.version,
          status: mandate.status,
          chainMandateId: chainId,
          onchainVersion: onchain ? Number(onchain.currentVersion) : null,
          inputAsset: mandate.inputAsset,
          outputAssets: mandate.outputAssets,
          perActionCap: mandate.perActionCap,
          cumulativeBudget: mandate.cumulativeBudget,
          spentToken: budget.spentToken,
          reservedToken: budget.reservedToken,
          maxSlippageBps: mandate.maxSlippageBps,
          pluginIds: [...new Set(mandate.bindings.map((b) => b.pluginId))],
          recipients: mandate.recipients.map((r) => r.address),
          validAfter: mandate.validAfter,
          validUntil: mandate.validUntil,
          terms: mandate,
        };
      },
    );
    const versionDrift = worldMandates.some(
      (m) => m.onchainVersion !== null && m.onchainVersion !== m.version,
    );
    const mandateFreshness: FieldFreshness = !kernel
      ? 'UNKNOWN'
      : versionDrift || (rm?.snapshot && rm.freshness !== 'FRESH')
        ? 'STALE'
        : 'FRESH';
    const mandatesField = observed(
      worldMandates,
      fieldMeta({
        provenance: 'KERNEL',
        source: 'kernel-state+envio-read-model',
        observedAt: kernel ? now : null,
        freshness: mandateFreshness,
        ...(versionDrift
          ? { reason: 'Kernel mandate version differs from chain' }
          : kernelError
            ? { reason: kernelError }
            : {}),
      }),
    );

    const treasury = this.treasury(rm, mandates, rmError);

    let drafts: Awaited<ReturnType<IdentityDirectoryReader['drafts']>> = [];
    let approvals: Awaited<ReturnType<IdentityDirectoryReader['approvals']>> =
      [];
    let draftError: string | null = s.identity
      ? null
      : 'identity directory not configured';
    if (s.identity)
      try {
        [drafts, approvals] = await Promise.all([
          s.identity.drafts(target.groupId),
          s.identity.approvals(target.groupId),
        ]);
      } catch (error) {
        draftError = errorCode(error);
      }
    const draftMeta = fieldMeta({
      provenance: 'POSTGRES',
      source: 'identity-approvals',
      observedAt: draftError ? null : now,
      freshness: draftError ? 'UNKNOWN' : 'FRESH',
      ...(draftError ? { reason: draftError } : {}),
    });
    const proposals = observed(
      drafts.map((d) => ({
        intentHash: d.intentHash,
        draftDigest: d.draftDigest,
        status: d.status,
        countedApprovals: approvals.filter(
          (a) => lower(a.draftDigest) === lower(d.draftDigest),
        ).length,
        createdAt: d.createdAt,
      })),
      draftMeta,
    );

    const kernelIntents = observed(kernel?.intents ?? [], kernelMeta());
    const pendingExecutions = observed(
      (kernel?.grants ?? [])
        .filter(
          (g) =>
            g.groupId === target.groupId &&
            ['RESERVED', 'CONSUMED', 'PREPARED'].includes(g.state),
        )
        .map((g) => ({
          grantId: g.grantId,
          intentId: g.intentId,
          mandateId: g.mandateId,
          state: g.state,
          maxInputAmount: g.maxInputAmount,
          nativeValue: g.nativeValue,
          validUntil: g.validUntil,
        })),
      kernelMeta(),
    );
    const recentExecutions = rm?.snapshot
      ? observed(
          rm.snapshot.group.grantsExecuted.slice(-20).map((g) => ({
            nonce: g.nonce,
            intentHash: g.intentHash,
            tokenAmount: g.tokenAmount,
            recipient: g.recipient,
            transactionHash: g.transactionHash,
            blockNumber: g.blockNumber,
          })),
          rmMeta('envio-read-model')!,
        )
      : unknownField([], 'ENVIO', 'envio-read-model', rmError ?? 'no index');

    const graphView = graph.toJSON();
    const pluginHealth = observed(
      graphView.nodes
        .filter((n) => n.kind === 'PLUGIN' && n.installed && n.pluginId)
        .map((n) => ({
          pluginId: n.pluginId!,
          available: n.health?.available ?? false,
          checkedAt: n.health?.checkedAt ?? null,
          reason: n.health?.reason ?? n.statusReason,
        })),
      fieldMeta({
        provenance: 'PLUGIN',
        source: 'plugin-registry',
        observedAt: now,
        freshness: s.plugins ? 'FRESH' : 'UNKNOWN',
        ...(s.plugins ? {} : { reason: 'plugin registry not configured' }),
      }),
    );
    const checks = graphView.nodes
      .filter((n) => n.kind === 'PLUGIN' && n.installed)
      .map((n) => n.health?.checkedAt ?? null);
    const oldestCheck =
      checks.length && checks.every((c) => c !== null)
        ? Math.min(...(checks as number[]))
        : null;
    const capabilities = observed(
      graphView,
      fieldMeta({
        provenance: 'PLUGIN',
        source: 'capability-graph',
        observedAt: oldestCheck,
        freshness: ageFreshness(oldestCheck, now, 60),
        ...(oldestCheck === null
          ? { reason: 'no completed health check for an installed plugin' }
          : {}),
      }),
    );
    note(
      'capability-graph',
      'PLUGIN',
      capabilities.meta.freshness,
      oldestCheck,
      capabilities.meta.reason ?? null,
    );

    const workflows = await this.workflows(target.groupId, now, note);
    const marketSnapshots = await this.market(now, note);
    const riskState = await this.risk(target.groupId, now, note);

    const readModel = rm
      ? observed(
          {
            indexedThroughBlock:
              rm.snapshot?.indexedThroughBlock ?? Math.max(0, rm.head - rm.lag),
            headBlock: rm.head,
            lagBlocks: rm.lag,
            maxLagBlocks: s.readModel!.maxLagBlocks,
            status: rm.status,
          },
          fieldMeta({
            provenance: 'ENVIO',
            source: 'envio-read-model',
            observedAt: now,
            freshness: rm.freshness,
          }),
        )
      : unknownField(null, 'ENVIO', 'envio-read-model', rmError ?? 'none');

    const body = {
      schemaVersion: WORLD_MODEL_SCHEMA_VERSION,
      generatedAt: now,
      network: observed(
        s.network,
        fieldMeta({
          provenance: 'CONFIG',
          source: 'chain-registry',
          observedAt: null,
          freshness: 'UNKNOWN',
          confidence: 1,
          reason: 'static chain registry profile, not an observation',
        }),
      ),
      readModel,
      group,
      members,
      principalTypes,
      quorum,
      treasury,
      mandates: mandatesField,
      proposals,
      approvals: observed(approvals, draftMeta),
      kernelIntents,
      pendingExecutions,
      recentExecutions,
      pluginHealth,
      capabilities,
      workflows,
      marketSnapshots,
      riskState,
      sourceFreshness,
    };
    return WorldModelSnapshotSchema.parse({
      ...body,
      snapshotId: canonicalArtifactHash(body),
    });
  }

  private resolveAsset(
    address: string,
    mandates: KernelStateSnapshot['mandates'],
  ): AssetIdentity | null {
    const chainId = this.sources.network.chainId;
    const candidates: AssetIdentity[] = [
      ...Object.values(officialAssets),
      ...(this.sources.localAssets ?? []),
      ...mandates.flatMap(({ mandate }) => [
        mandate.inputAsset,
        ...mandate.outputAssets,
      ]),
    ];
    return (
      candidates.find(
        (a): a is Asset =>
          'address' in a &&
          a.chainId === chainId &&
          a.address === lower(address),
      ) ?? null
    );
  }

  private treasury(
    rm: ReadModelRead | null,
    mandates: KernelStateSnapshot['mandates'],
    rmError: string | null,
  ): Observed<TreasuryPosition[]> {
    if (!rm?.snapshot)
      return unknownField(
        [],
        'ENVIO',
        'envio-read-model',
        rmError ?? 'no indexed treasury',
      );
    const positions: TreasuryPosition[] = [];
    const unresolved: string[] = [];
    for (const held of rm.snapshot.group.treasury) {
      const asset = this.resolveAsset(held.asset, mandates);
      if (!asset) {
        unresolved.push(held.asset);
        continue;
      }
      const reserved = mandates
        .filter(
          ({ mandate }) =>
            mandate.inputAsset.canonicalAssetId === asset.canonicalAssetId,
        )
        .reduce((sum, { budget }) => sum + BigInt(budget.reservedToken), 0n);
      const balance = BigInt(held.balance);
      positions.push({
        asset,
        balance: held.balance,
        reserved: reserved.toString(),
        free: (balance > reserved ? balance - reserved : 0n).toString(),
      });
    }
    return observed(
      positions,
      fieldMeta({
        provenance: 'ENVIO',
        source: 'envio-read-model+kernel-reservations',
        observedAt: this.sources.now(),
        freshness: rm.freshness,
        confidence:
          (rm.freshness === 'FRESH' ? 1 : 0.5) * (unresolved.length ? 0.8 : 1),
        ...(unresolved.length
          ? { reason: `unregistered assets ignored: ${unresolved.length}` }
          : rm.status !== 'FRESH'
            ? { reason: `read model ${rm.status}` }
            : {}),
      }),
    );
  }

  private async workflows(
    groupId: string,
    now: number,
    note: (
      s: string,
      p: SourceFreshness['provenance'],
      f: FieldFreshness,
      o: number | null,
      r?: string | null,
    ) => void,
  ): Promise<WorldModelSnapshot['workflows']> {
    if (!this.sources.workflows) {
      note('temporal-workflows', 'TEMPORAL', 'UNKNOWN', null, 'not configured');
      return unknownField(
        [],
        'TEMPORAL',
        'temporal-workflows',
        'not configured',
      );
    }
    try {
      const { workflows, observedAt } =
        await this.sources.workflows.list(groupId);
      const freshness = ageFreshness(
        observedAt,
        now,
        this.sources.workflowMaxAgeSeconds ?? 60,
      );
      note('temporal-workflows', 'TEMPORAL', freshness, observedAt);
      return observed(
        workflows,
        fieldMeta({
          provenance: 'TEMPORAL',
          source: 'temporal-workflows',
          observedAt,
          freshness,
        }),
      );
    } catch (error) {
      note('temporal-workflows', 'TEMPORAL', 'UNKNOWN', null, errorCode(error));
      return unknownField(
        [],
        'TEMPORAL',
        'temporal-workflows',
        errorCode(error),
      );
    }
  }

  private async market(
    now: number,
    note: (
      s: string,
      p: SourceFreshness['provenance'],
      f: FieldFreshness,
      o: number | null,
      r?: string | null,
    ) => void,
  ): Promise<WorldModelSnapshot['marketSnapshots']> {
    if (!this.sources.market) {
      note('market-data', 'MARKET', 'UNKNOWN', null, 'not configured');
      return unknownField([], 'MARKET', 'market-data', 'not configured');
    }
    try {
      const quotes = await this.sources.market.quotes(this.sources.network);
      const each = quotes.map((q) =>
        ageFreshness(q.observedAt, now, q.maxAgeSeconds),
      );
      const freshness = quotes.length ? worstFreshness(each) : 'UNKNOWN';
      const oldest = quotes.length
        ? Math.min(...quotes.map((q) => q.observedAt))
        : null;
      note(
        'market-data',
        'MARKET',
        freshness,
        oldest,
        freshness === 'STALE' ? 'quote older than its max age' : null,
      );
      return observed(
        quotes,
        fieldMeta({
          provenance: 'MARKET',
          source: 'market-data',
          observedAt: oldest,
          freshness,
          ...(freshness === 'STALE'
            ? { reason: 'quote older than its max age' }
            : quotes.length
              ? {}
              : { reason: 'no quotes' }),
        }),
      );
    } catch (error) {
      note('market-data', 'MARKET', 'UNKNOWN', null, errorCode(error));
      return unknownField([], 'MARKET', 'market-data', errorCode(error));
    }
  }

  private async risk(
    groupId: string,
    now: number,
    note: (
      s: string,
      p: SourceFreshness['provenance'],
      f: FieldFreshness,
      o: number | null,
      r?: string | null,
    ) => void,
  ): Promise<WorldModelSnapshot['riskState']> {
    const unknown = (reason: string) => {
      note('risk-state', 'MARKET', 'UNKNOWN', null, reason);
      return unknownField(
        {
          status: 'UNKNOWN' as const,
          reasons: [reason],
          attestationRef: null,
          referenceDeviationBps: null,
        },
        'MARKET',
        'risk-state',
        reason,
      );
    };
    if (!this.sources.risk) return unknown('not configured');
    try {
      const r = await this.sources.risk.current(groupId);
      const freshness = ageFreshness(r.observedAt, now, r.maxAgeSeconds);
      note('risk-state', 'MARKET', freshness, r.observedAt);
      return observed(
        freshness === 'STALE'
          ? {
              ...r.state,
              status: 'STALE' as const,
              reasons: [...r.state.reasons, 'risk attestation expired'],
            }
          : r.state,
        fieldMeta({
          provenance: 'MARKET',
          source: 'risk-state',
          observedAt: r.observedAt,
          freshness,
        }),
      );
    } catch (error) {
      return unknown(errorCode(error));
    }
  }
}
