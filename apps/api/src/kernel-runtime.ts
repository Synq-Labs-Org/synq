import type { PublicClient } from 'viem';
import {
  MandateSchema,
  type ApprovalLedger,
  type Mandate,
  type NetworkProfile,
  type TreasuryBalance,
} from '@synq/schemas';
import {
  Kernel,
  KernelError,
  artifactHash,
  onchainMandateId,
  type AuditRecord,
  type AuthorizationDecision,
  type KernelDependencies,
  type Clock,
  type DelegationEvaluator,
  type FreshnessProbe,
  type MembershipDirectory,
} from '@synq/kernel';
import {
  StoreApprovalLedger,
  StoreDelegationEvaluator,
  StoreMembershipDirectory,
  type IdentityStore,
} from '@synq/identity';
import type {
  ChainHeadObserver,
  CurrentMandateArtifact,
  GroupSnapshot,
  ProjectionConfig,
  SnapshotSource,
} from '@synq/read-model';
import {
  ReadModelFreshnessProbe,
  RpcKernelDirectVerifier,
  RpcNonceStatusReader,
} from '@synq/read-model/kernel';
import {
  anchoredSink,
  kernelStateMac,
  verifyPersistedKernel,
  type KernelStateStore,
} from './kernel-store.js';

export class KernelRuntimeError extends Error {
  constructor(
    readonly code:
      | 'MANDATE_ARTIFACT_INVALID'
      | 'MANDATE_ARTIFACT_MISMATCH'
      | 'MANDATE_BALANCE_MISSING',
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = 'KernelRuntimeError';
  }
}

export type KernelIdentityPorts = {
  approvalLedger: ApprovalLedger;
  membershipDirectory: MembershipDirectory;
  delegations?: DelegationEvaluator;
};

export function identityPorts(store: IdentityStore): KernelIdentityPorts {
  return {
    approvalLedger: new StoreApprovalLedger(store),
    membershipDirectory: new StoreMembershipDirectory(store),
    delegations: new StoreDelegationEvaluator(store),
  };
}

export type KernelState = {
  mandates: Mandate[];
  balances: TreasuryBalance[];
  balanceBlock: string;
};

export type IntentKernelConfig = {
  network: NetworkProfile;
  executionModule: `0x${string}`;
  clock?: Clock;
  identity: KernelIdentityPorts;
  client: PublicClient;
  projection: ProjectionConfig;
  snapshots: () => Promise<SnapshotSource>;
  head: ChainHeadObserver;
  maxLagBlocks: number;
  auditKey?: Uint8Array;
  plugins: readonly unknown[];
  state: KernelState;
};

export const systemClock: Clock = {
  now: () => Math.floor(Date.now() / 1000),
};

type KernelHolder = { kernel: Kernel | null };

export function reconcileFromSnapshot(
  kernel: Kernel,
  snapshot: GroupSnapshot,
): void {
  const account = snapshot.group.account as `0x${string}`;
  for (const mandate of kernel.listMandates()) {
    if (mandate.account.toLowerCase() !== account) continue;
    const id = onchainMandateId(mandate);
    const chain = snapshot.group.mandates.find((m) => m.mandateId === id);
    if (!chain) continue;
    const executed = snapshot.group.grantsExecuted.filter(
      (g) => g.mandateId === id,
    );
    kernel.observeChainUsage({
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      chainId: snapshot.sourceChainId,
      account,
      spentToken: chain.spentToken,
      spentNative: chain.spentNative,
      executed: executed.length,
      nonces: [
        ...executed.map((g) => g.nonce),
        ...snapshot.group.cancelledNonces,
      ],
      intentHashes: executed.map((g) => g.intentHash),
    });
    const asset = mandate.inputAsset;
    const held = snapshot.group.treasury.find(
      (t) => t.asset === asset.address.toLowerCase(),
    );
    if (!held) continue;
    try {
      kernel.observeBalance(
        { account, asset, balance: held.balance },
        String(snapshot.indexedThroughBlock),
      );
    } catch (error) {
      if (
        !(error instanceof KernelError && error.code === 'BALANCE_REGRESSION')
      )
        throw error;
    }
  }
}

async function reconcileAccount(
  kernel: Kernel,
  source: SnapshotSource,
  account: string,
): Promise<void> {
  const entry = (await source.progress()).groups.find(
    (g) => g.account === account.toLowerCase(),
  );
  if (!entry) return;
  const snapshot = await source.groupSnapshot(entry.groupId as `0x${string}`);
  if (snapshot) reconcileFromSnapshot(kernel, snapshot);
}

export function readModelFreshnessProbe(
  snapshots: () => Promise<SnapshotSource>,
  head: ChainHeadObserver,
  holder?: KernelHolder,
): FreshnessProbe {
  return {
    async observe(query) {
      const source = await snapshots();
      const observation = await new ReadModelFreshnessProbe(
        source,
        head,
      ).observe(query);
      if (holder?.kernel)
        await reconcileAccount(holder.kernel, source, query.account);
      return observation;
    },
  };
}

function kernelDependencies(
  config: IntentKernelConfig,
  holder: KernelHolder,
): KernelDependencies {
  return {
    clock: config.clock ?? systemClock,
    approvalLedger: config.identity.approvalLedger,
    membershipDirectory: config.identity.membershipDirectory,
    ...(config.identity.delegations
      ? { delegations: config.identity.delegations }
      : {}),
    freshness: {
      probe: readModelFreshnessProbe(config.snapshots, config.head, holder),
      verifier: new RpcKernelDirectVerifier(config.client, config.projection),
      maxLagBlocks: config.maxLagBlocks,
    },
    nonceStatus: new RpcNonceStatusReader(config.client, config.projection),
    ...(config.auditKey ? { auditKey: config.auditKey } : {}),
    plugins: config.plugins,
  };
}

function seededKernel(
  config: IntentKernelConfig,
  dependencies: KernelDependencies,
): Kernel {
  return new Kernel({
    ...dependencies,
    network: config.network,
    executionModule: config.executionModule,
    mandates: config.state.mandates,
    balances: config.state.balances,
    balanceBlock: config.state.balanceBlock,
  });
}

export function createIntentKernel(config: IntentKernelConfig): Kernel {
  const holder: KernelHolder = { kernel: null };
  holder.kernel = seededKernel(config, kernelDependencies(config, holder));
  return holder.kernel;
}

async function reconcileAll(kernel: Kernel, source: SnapshotSource) {
  const accounts = new Set(
    kernel.listMandates().map((m) => m.account.toLowerCase()),
  );
  for (const account of accounts)
    await reconcileAccount(kernel, source, account);
}

export class DurableKernel {
  private failed = false;
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    readonly kernel: Kernel,
    private readonly store: KernelStateStore,
    private readonly key: Uint8Array,
    private persistedSequence: number,
  ) {}
  private persist(): Promise<void> {
    const run = this.chain.then(async () => {
      const snapshot = this.kernel.snapshot();
      const audit = snapshot.audit as AuditRecord[];
      const head = audit.at(-1)!.hash;
      const state = { ...snapshot, audit: [] };
      await this.store.save({
        state,
        records: audit.slice(this.persistedSequence),
        fromSequence: this.persistedSequence,
        head,
        sequence: audit.length,
        mac: kernelStateMac(this.key, {
          state,
          head,
          sequence: audit.length,
        }),
      });
      this.persistedSequence = audit.length;
    });
    this.chain = run.catch(() => undefined);
    return run;
  }
  async mutate<T>(fn: (kernel: Kernel) => T | Promise<T>): Promise<T> {
    if (this.failed) throw new KernelError('AUDIT_UNAVAILABLE');
    const result = await fn(this.kernel);
    try {
      await this.persist();
    } catch {
      this.failed = true;
      throw new KernelError('AUDIT_UNAVAILABLE');
    }
    return result;
  }
  authorize(request: unknown): Promise<AuthorizationDecision> {
    return this.mutate((kernel) => kernel.authorize(request));
  }
}

export async function openDurableKernel(
  config: IntentKernelConfig & { auditKey: Uint8Array },
  store: KernelStateStore,
): Promise<DurableKernel> {
  const holder: KernelHolder = { kernel: null };
  const dependencies = kernelDependencies(config, holder);
  const persisted = await store.load();
  let kernel: Kernel;
  if (persisted) {
    kernel = Kernel.restore(verifyPersistedKernel(persisted, config.auditKey), {
      ...dependencies,
      auditSink: anchoredSink(() => persisted.head),
    });
    if (
      kernel.network.chainId !== config.network.chainId ||
      kernel.executionModule !== config.executionModule.toLowerCase()
    )
      throw new KernelError('SNAPSHOT_INVALID');
    const known = new Set(
      kernel.listMandates().map((m) => `${m.groupId}|${m.mandateId}`),
    );
    for (const mandate of config.state.mandates)
      if (!known.has(`${mandate.groupId}|${mandate.mandateId}`))
        kernel.configureMandate(mandate);
  } else kernel = seededKernel(config, dependencies);
  holder.kernel = kernel;
  const durable = new DurableKernel(
    kernel,
    store,
    config.auditKey,
    persisted?.sequence ?? 0,
  );
  const source = await config.snapshots();
  await durable.mutate((k) => reconcileAll(k, source));
  return durable;
}

export function mandateFromArtifact(entry: CurrentMandateArtifact): Mandate {
  const parsed = MandateSchema.safeParse(entry.artifact);
  if (!parsed.success)
    throw new KernelRuntimeError('MANDATE_ARTIFACT_INVALID', entry.mandateHash);
  const mandate = parsed.data;
  if (
    artifactHash(mandate) !== entry.mandateHash ||
    onchainMandateId(mandate) !== entry.mandateId ||
    mandate.version !== entry.version ||
    mandate.account.toLowerCase() !== entry.account ||
    (mandate.chainGroupId !== undefined &&
      mandate.chainGroupId.toLowerCase() !== entry.groupId)
  )
    throw new KernelRuntimeError(
      'MANDATE_ARTIFACT_MISMATCH',
      entry.mandateHash,
    );
  return mandate;
}

export async function kernelStateFromReadModel(reader: {
  currentMandateArtifacts(): Promise<CurrentMandateArtifact[]>;
  groupSnapshot: SnapshotSource['groupSnapshot'];
}): Promise<KernelState> {
  const entries = await reader.currentMandateArtifacts();
  const mandates = entries.map(mandateFromArtifact);
  const balances = new Map<string, TreasuryBalance>();
  let balanceBlock = 0;
  for (const [i, mandate] of mandates.entries()) {
    const entry = entries[i]!;
    const snapshot = await reader.groupSnapshot(entry.groupId);
    if (!snapshot)
      throw new KernelRuntimeError('MANDATE_BALANCE_MISSING', entry.groupId);
    balanceBlock = Math.max(balanceBlock, snapshot.indexedThroughBlock);
    const asset = mandate.inputAsset;
    const key = `${entry.account}:${asset.canonicalAssetId}`;
    if (balances.has(key)) continue;
    balances.set(key, {
      account: entry.account,
      asset,
      balance:
        snapshot.group.treasury.find(
          (t) => t.asset === asset.address.toLowerCase(),
        )?.balance ?? '0',
    });
  }
  return {
    mandates,
    balances: [...balances.values()],
    balanceBlock: String(balanceBlock),
  };
}
