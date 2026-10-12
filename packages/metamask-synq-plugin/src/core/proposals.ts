import { parseUnits } from 'viem';
import { fail } from './errors.js';
import { memberApi, verifiedGroup, type Deps } from './group.js';
import { NETWORK, sameAddress } from './network.js';
import type { MandateProposalView } from './synq-api.js';

export type ProposalResult = {
  proposalId: string;
  groupId: string;
  change: 'NEW' | 'SUPERSEDE';
  mandateId: string;
  mandateHash: string;
  safe: string;
  safeTxHash: string;
  state: MandateProposalView['state'];
  approvals: { counted: number; required: number };
  securitySensitive: boolean;
  authority: 'GROUP_QUORUM_REQUIRED';
  note: string;
};

type MandateDoc = Record<string, unknown> & {
  mandateId?: unknown;
  account?: unknown;
  chainGroupId?: unknown;
  network?: { chainId?: unknown; profile?: unknown };
  inputAsset?: { chainId?: unknown; address?: unknown; decimals?: unknown };
  bindings?: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function assertBinding(
  mandate: unknown,
  group: { chainGroupId: string },
  safe: string,
): asserts mandate is MandateDoc {
  if (!isObject(mandate))
    fail('INVALID_INPUT', 'mandate must be a JSON object');
  const m = mandate as MandateDoc;
  if (typeof m.mandateId !== 'string')
    fail('MANDATE_MISMATCH', 'mandate has no mandateId');
  if (typeof m.account !== 'string' || !sameAddress(m.account, safe))
    fail(
      'WRONG_SAFE',
      `mandate account ${String(m.account)} is not the registered Safe ${safe}`,
    );
  if (
    typeof m.chainGroupId !== 'string' ||
    m.chainGroupId.toLowerCase() !== group.chainGroupId.toLowerCase()
  )
    fail('MANDATE_MISMATCH', 'mandate chainGroupId does not match the group');
  if (
    !isObject(m.network) ||
    m.network.chainId !== NETWORK.chainId ||
    m.network.profile !== NETWORK.profile
  )
    fail('WRONG_CHAIN', `mandate must target ${NETWORK.profile}`);
  if (!isObject(m.inputAsset) || m.inputAsset.chainId !== NETWORK.chainId)
    fail('WRONG_CHAIN', 'mandate input asset is on another chain');
}

const view = (
  p: MandateProposalView,
  mandateId: string,
  safe: string,
): ProposalResult => ({
  proposalId: p.proposalId,
  groupId: p.groupId,
  change: p.change,
  mandateId,
  mandateHash: p.mandateHash,
  safe,
  safeTxHash: p.safeTxHash,
  state: p.state,
  approvals: { counted: p.counted, required: p.required },
  securitySensitive: p.securitySensitive,
  authority: 'GROUP_QUORUM_REQUIRED',
  note: 'Proposal only: the Kernel and the group approver quorum must authorize it; this plugin never approves or executes group spending.',
});

export async function propose(
  deps: Deps,
  input: { groupId: string; mandate: unknown; change: 'NEW' | 'SUPERSEDE' },
): Promise<ProposalResult> {
  const verified = await verifiedGroup(deps, input.groupId);
  const { group, safe } = verified;
  assertBinding(input.mandate, group, safe);
  const p = await (
    await memberApi(deps, verified)
  ).propose({
    groupId: group.groupId,
    mandate: input.mandate,
    change: input.change,
  });
  if (!sameAddress(p.safeTx.safe, safe) || p.safeTx.chainId !== NETWORK.chainId)
    fail(
      'WRONG_SAFE',
      `Synq built a Safe transaction for ${p.safeTx.safe} on ${p.safeTx.chainId}`,
    );
  if (!sameAddress(p.safeTx.to, NETWORK.mandateRegistry))
    fail(
      'MANDATE_MISMATCH',
      `proposal targets ${p.safeTx.to}, not MandateRegistry`,
    );
  return view(p, String(input.mandate.mandateId), safe);
}

export type DcaInput = {
  groupId: string;
  template: unknown;
  perBuy: string;
  budget: string;
  intervalSeconds: number;
  maxExecutions: number;
  validUntil: number;
  mandateId?: string;
  change: 'NEW' | 'SUPERSEDE';
};

/** A DCA is a mandate whose cadence and caps bound every buy; Synq still needs quorum. */
export async function dca(
  deps: Deps,
  input: DcaInput,
): Promise<ProposalResult> {
  if (!isObject(input.template))
    fail('INVALID_INPUT', 'template must be a mandate JSON object');
  const t = input.template as MandateDoc;
  if (
    !isObject(t.inputAsset) ||
    !sameAddress(String(t.inputAsset.address), NETWORK.ausd.address)
  )
    fail(
      'INVALID_TOKEN',
      'DCA mandates spend AUSD; template inputAsset must be AUSD',
    );
  const decimals = NETWORK.ausd.decimals;
  const dec = /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/;
  if (!dec.test(input.perBuy) || !dec.test(input.budget))
    fail('INVALID_AMOUNT', 'per-buy and budget are decimal AUSD amounts');
  const perBuy = parseUnits(input.perBuy, decimals);
  const budget = parseUnits(input.budget, decimals);
  if (perBuy <= 0n || budget < perBuy)
    fail('INVALID_AMOUNT', 'need 0 < per-buy <= budget');
  if (
    !Number.isSafeInteger(input.intervalSeconds) ||
    input.intervalSeconds < 3600
  )
    fail('INVALID_INPUT', 'interval must be at least 3600 seconds');
  if (
    !Number.isSafeInteger(input.maxExecutions) ||
    input.maxExecutions < 1 ||
    input.maxExecutions > 1000
  )
    fail('INVALID_INPUT', 'max executions must be 1..1000');
  if (perBuy * BigInt(input.maxExecutions) < budget)
    fail(
      'INVALID_INPUT',
      'budget is unreachable: per-buy x max-executions is below it',
    );
  const now = Math.floor(deps.now() / 1000);
  if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= now)
    fail('INTENT_EXPIRED', 'valid-until must be in the future');
  if (
    input.mandateId !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(input.mandateId)
  )
    fail('INVALID_INPUT', 'mandate id is not a Synq id');
  const mandate = {
    ...t,
    ...(input.mandateId ? { mandateId: input.mandateId } : {}),
    perActionCap: perBuy.toString(),
    cumulativeBudget: budget.toString(),
    minIntervalSeconds: input.intervalSeconds,
    maxExecutions: input.maxExecutions,
    validAfter: Math.min(Number(t.validAfter ?? now), now),
    validUntil: input.validUntil,
  };
  return propose(deps, {
    groupId: input.groupId,
    mandate,
    change: input.change,
  });
}
