import { formatUnits, type Address } from 'viem';
import { ausdBalance } from './chain.js';
import { SynqPluginError, fail } from './errors.js';
import { membershipStatus, verifiedGroup, type Deps } from './group.js';
import type { ContributionJournal } from './journal.js';
import { NETWORK, explorerTxUrl, sameAddress } from './network.js';

const fmt = (v: bigint | string) =>
  formatUnits(BigInt(v), NETWORK.ausd.decimals);

const selectedOrNull = (deps: Deps): Address | null => {
  const { selected, all } = deps.host.walletAddresses();
  return selected ?? (all.length === 1 ? all[0]! : null);
};

export type GroupSummary = {
  groupId: string;
  chainGroupId: string;
  safe: Address | null;
  verifiedOnChain: boolean;
  members: number;
  activeMembers: number;
  threshold: number;
  myMembership: 'ACTIVE' | 'REVOKED' | 'NONE' | 'UNKNOWN';
  error?: string;
};

export async function groups(
  deps: Deps,
  groupIds: string[],
): Promise<{ wallet: Address | null; groups: GroupSummary[] }> {
  if (!groupIds.length)
    fail(
      'INVALID_INPUT',
      'pass --group or set SYNQ_MM_GROUPS (comma-separated group ids)',
    );
  const wallet = selectedOrNull(deps);
  const out: GroupSummary[] = [];
  for (const id of groupIds) {
    try {
      const { group, safe } = await verifiedGroup(deps, id);
      out.push({
        groupId: group.groupId,
        chainGroupId: group.chainGroupId,
        safe,
        verifiedOnChain: true,
        members: group.memberships.length,
        activeMembers: group.memberships.filter((m) => m.status === 'ACTIVE')
          .length,
        threshold: group.threshold,
        myMembership: membershipStatus(group, wallet),
      });
    } catch (error) {
      if (!(error instanceof SynqPluginError) || error.code === 'WRONG_CHAIN')
        throw error;
      out.push({
        groupId: id,
        chainGroupId: '',
        safe: null,
        verifiedOnChain: false,
        members: 0,
        activeMembers: 0,
        threshold: 0,
        myMembership: 'UNKNOWN',
        error: `${error.code}: ${error.message}`,
      });
    }
  }
  return { wallet, groups: out };
}

export type TreasurySummary = {
  groupId: string;
  safe: Address;
  token: Address;
  onChainBalance: string;
  indexedBalance: string;
  free: string;
  reserved: string;
  pendingInbound: string;
  indexedThroughBlock: string;
  consistent: boolean;
  contributions: { total: string; count: number };
};

export async function treasury(
  deps: Deps,
  groupId: string,
): Promise<TreasurySummary> {
  const { group, safe, client } = await verifiedGroup(deps, groupId);
  const [view, onChain] = await Promise.all([
    deps.api.treasury(group.chainGroupId),
    ausdBalance(client, safe),
  ]);
  if (!sameAddress(view.account, safe))
    fail(
      'WRONG_SAFE',
      `read model reports account ${view.account}, registry binds ${safe}`,
    );
  if (!sameAddress(view.coreAsset.address, NETWORK.ausd.address))
    fail('INVALID_TOKEN', `read model core asset is ${view.coreAsset.address}`);
  return {
    groupId: group.groupId,
    safe,
    token: NETWORK.ausd.address,
    onChainBalance: fmt(onChain),
    indexedBalance: fmt(view.core.balance),
    free: fmt(view.core.free),
    reserved: fmt(view.core.reserved),
    pendingInbound: fmt(view.pendingInbound),
    indexedThroughBlock: String(view.indexedThroughBlock),
    consistent: onChain === BigInt(view.core.balance),
    contributions: {
      total: fmt(view.contributions.total),
      count: view.contributions.count,
    },
  };
}

export async function risk(deps: Deps, groupId: string) {
  await verifiedGroup(deps, groupId);
  const w = await deps.api.world(groupId);
  return {
    groupId,
    snapshotId: w.snapshotId,
    status: w.riskState.value.status,
    reasons: w.riskState.value.reasons,
    attestationRef: w.riskState.value.attestationRef,
    referenceDeviationBps: w.riskState.value.referenceDeviationBps,
    freshness: w.riskState.meta.freshness,
    market: w.marketSnapshots.value.map((m) => ({
      pair: m.pair,
      price: formatUnits(BigInt(m.price), m.priceDecimals),
      source: m.source,
      observedAt: m.observedAt,
    })),
  };
}

export async function strategies(deps: Deps, groupId: string) {
  await verifiedGroup(deps, groupId);
  const w = await deps.api.world(groupId);
  return {
    groupId,
    snapshotId: w.snapshotId,
    mandates: w.mandates.value.map((m) => ({
      mandateId: m.mandateId,
      chainMandateId: m.chainMandateId,
      version: m.version,
      status: m.status,
      perActionCap: fmt(m.perActionCap),
      cumulativeBudget: fmt(m.cumulativeBudget),
      spent: fmt(m.spentToken),
      reserved: fmt(m.reservedToken),
      maxSlippageBps: m.maxSlippageBps,
      plugins: m.pluginIds,
      validUntil: m.validUntil,
    })),
    workflows: w.workflows.value.map((f) => ({
      workflowId: f.workflowId,
      type: f.type,
      status: f.status,
      nextEventAt: f.nextEventAt,
    })),
  };
}

export async function receipts(
  deps: Deps,
  journal: ContributionJournal,
  groupId: string,
) {
  const { group } = await verifiedGroup(deps, groupId);
  const wallet = selectedOrNull(deps);
  const local = (await journal.list()).filter(
    (e) => e.groupId === group.groupId || e.chainGroupId === group.chainGroupId,
  );
  let indexed: {
    transactionHash: string;
    from: string;
    amount: string;
    blockNumber: number;
  }[] = [];
  let indexedError: string | null = null;
  try {
    indexed = (await deps.api.treasury(group.chainGroupId)).contributions
      .events;
  } catch (error) {
    if (!(error instanceof SynqPluginError)) throw error;
    indexedError = `${error.code}: ${error.message}`;
  }
  const indexedHashes = new Set(
    indexed.map((e) => e.transactionHash.toLowerCase()),
  );
  return {
    groupId: group.groupId,
    wallet,
    local: local.map((e) => ({
      requestId: e.requestId,
      state: e.state,
      amount: fmt(e.amount),
      txHash: e.txHash,
      explorerUrl: e.txHash ? explorerTxUrl(e.txHash) : null,
      indexed: e.txHash ? indexedHashes.has(e.txHash.toLowerCase()) : false,
    })),
    indexed: indexed
      .filter((e) => !wallet || sameAddress(e.from, wallet))
      .map((e) => ({
        txHash: e.transactionHash,
        from: e.from,
        amount: fmt(e.amount),
        blockNumber: e.blockNumber,
        explorerUrl: explorerTxUrl(e.transactionHash),
      })),
    indexedError,
  };
}
