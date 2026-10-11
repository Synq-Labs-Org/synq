import { decodeEventLog, type Hex, type PublicClient } from 'viem';
import { PostgresIdentityStore } from '../../../packages/identity/src/index.js';
import type { GrantDraft } from '../../../packages/schemas/src/index.js';
import { onchainMandateId } from '../../../packages/kernel/src/index.js';
import { PostgresKernelStateStore } from '../../../apps/api/src/kernel-store.js';
import {
  moduleAbi,
  registryAbi,
  tokenAbi,
} from '../../../workers/execution/src/abi.js';
import type { LocalEnvironment } from '../../../workers/workflow/src/local/bootstrap.js';
import { approveAsMember } from '../../../workers/workflow/src/local/identity.js';

export async function draftFor(
  local: LocalEnvironment,
  digest: string,
): Promise<GrantDraft> {
  const record = await new PostgresIdentityStore(local.pool).transaction((tx) =>
    tx.getDraft(digest),
  );
  if (!record) throw new Error(`draft ${digest} not registered`);
  return record.draft;
}

export async function memberApproves(
  local: LocalEnvironment,
  digest: string,
  index: number,
) {
  return approveAsMember(local.gateway, await draftFor(local, digest), {
    index,
    owner: local.owners[index]!,
    principalId: local.principalIds[index]!,
  });
}

/** Every GrantExecuted the module ever emitted, decoded. */
export async function grantExecutions(local: LocalEnvironment) {
  const client = local.chain.client as unknown as PublicClient;
  const logs = await client.getLogs({
    address: local.manifest.module,
    fromBlock: BigInt(local.manifest.deploymentBlock),
    toBlock: 'latest',
  });
  return logs.flatMap((log) => {
    try {
      const decoded = decodeEventLog({
        abi: moduleAbi,
        data: log.data,
        topics: log.topics,
      });
      return decoded.eventName === 'GrantExecuted'
        ? [{ ...decoded.args, transactionHash: log.transactionHash as Hex }]
        : [];
    } catch {
      return [];
    }
  });
}

export async function chainSpent(local: LocalEnvironment): Promise<bigint> {
  const state = await local.chain.client.readContract({
    address: local.manifest.registry,
    abi: registryAbi,
    functionName: 'mandateState',
    args: [local.manifest.account, onchainMandateId(local.manifest.mandate)],
  });
  return state.spentToken;
}

export async function balanceOf(
  local: LocalEnvironment,
  who: Hex,
): Promise<bigint> {
  return local.chain.client.readContract({
    address: local.manifest.token,
    abi: tokenAbi,
    functionName: 'balanceOf',
    args: [who],
  });
}

/** Reads the Kernel exactly as the next worker would restore it: the committed Postgres state. */
export async function persistedKernel(local: LocalEnvironment) {
  const persisted = await new PostgresKernelStateStore(
    local.pool,
    local.manifest.kernelInstance,
  ).load();
  if (!persisted) throw new Error('kernel never persisted');
  const key = JSON.stringify([
    local.manifest.groupId,
    local.manifest.mandate.mandateId,
  ]);
  const budget = persisted.state.budgets.find(([k]) => k === key)?.[1];
  return {
    budget: budget ?? null,
    grants: persisted.state.grants.map((g) => ({
      grantId: g.grant.grantId,
      intentId: g.grant.intentId,
      state: g.state,
      submissions: g.submissions,
      execution: g.execution,
    })),
    lifecycles: persisted.state.lifecycles,
  };
}
