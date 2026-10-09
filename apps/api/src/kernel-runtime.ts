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
  artifactHash,
  onchainMandateId,
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
  ProjectionConfig,
  SnapshotSource,
} from '@synq/read-model';
import {
  ReadModelFreshnessProbe,
  RpcKernelDirectVerifier,
  RpcNonceStatusReader,
} from '@synq/read-model/kernel';

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

export function readModelFreshnessProbe(
  snapshots: () => Promise<SnapshotSource>,
  head: ChainHeadObserver,
): FreshnessProbe {
  return {
    async observe(query) {
      return new ReadModelFreshnessProbe(await snapshots(), head).observe(
        query,
      );
    },
  };
}

export function createIntentKernel(config: IntentKernelConfig): Kernel {
  return new Kernel({
    network: config.network,
    executionModule: config.executionModule,
    clock: config.clock ?? systemClock,
    approvalLedger: config.identity.approvalLedger,
    membershipDirectory: config.identity.membershipDirectory,
    ...(config.identity.delegations
      ? { delegations: config.identity.delegations }
      : {}),
    freshness: {
      probe: readModelFreshnessProbe(config.snapshots, config.head),
      verifier: new RpcKernelDirectVerifier(config.client, config.projection),
      maxLagBlocks: config.maxLagBlocks,
    },
    nonceStatus: new RpcNonceStatusReader(config.client, config.projection),
    ...(config.auditKey ? { auditKey: config.auditKey } : {}),
    plugins: config.plugins,
    mandates: config.state.mandates,
    balances: config.state.balances,
    balanceBlock: config.state.balanceBlock,
  });
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
