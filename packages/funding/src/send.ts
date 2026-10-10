import { formatDecimal, parseDecimal, type Mandate } from '@synq/domain';
import { profileForChainId } from '@synq/chain-registry';
import type { Asset } from '@synq/domain';
import { requireOfficialAusd } from './ausd.js';
import { contentHash } from './canonical.js';
import { FundingError } from './errors.js';
import type { AusdGuardResult } from './guard.js';

export type SendRecipient = {
  recipientId: string;
  kind: 'MEMBER' | 'CONTACT';
  label: string;
  address: `0x${string}`;
  memberId: string | null;
  principalId: string | null;
  /** Recipient is on the mandate allowlist; the Kernel rejects any other address. */
  sendable: boolean;
};

const lower = (a: string) => a.toLowerCase() as `0x${string}`;

/** Members (identity directory) plus mandate-allowlisted contacts, deduplicated by address. */
export function sendDirectory(input: {
  members: readonly {
    memberId: string;
    principalId: string;
    signer: string;
    label?: string;
  }[];
  contacts: readonly { label: string; address: string }[];
  mandate: Mandate;
}): SendRecipient[] {
  const allow = new Set(input.mandate.recipients.map((r) => lower(r.address)));
  const out: SendRecipient[] = [];
  const seen = new Set<string>();
  for (const m of input.members) {
    const address = lower(m.signer);
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({
      recipientId: `member:${m.memberId}`,
      kind: 'MEMBER',
      label: m.label ?? m.memberId,
      address,
      memberId: m.memberId,
      principalId: m.principalId,
      sendable: allow.has(address),
    });
  }
  for (const c of input.contacts) {
    const address = lower(c.address);
    if (seen.has(address)) continue;
    seen.add(address);
    out.push({
      recipientId: `contact:${address}`,
      kind: 'CONTACT',
      label: c.label,
      address,
      memberId: null,
      principalId: null,
      sendable: allow.has(address),
    });
  }
  return out;
}

export type SendPolicy = {
  tier: 'PERSONAL' | 'REVIEW' | 'QUORUM';
  kernelTier: 'AUTO' | 'REVIEW' | 'CONSENSUS';
  policyApprovals: number;
  accountThreshold: number;
  requiredApprovals: number;
};

/** Preview estimate of the Kernel tier; the Kernel's own decision is authoritative. */
export function sendPolicy(
  mandate: Mandate,
  amount: bigint,
  recipient?: string,
): SendPolicy {
  const t = mandate.tierPolicy.tokenSpend;
  const band =
    amount <= BigInt(t.autoMax)
      ? 'AUTO'
      : amount <= BigInt(t.reviewMax)
        ? 'REVIEW'
        : 'CONSENSUS';
  const withdrawal =
    recipient !== undefined &&
    mandate.recipients.some(
      (r) =>
        r.address.toLowerCase() === recipient.toLowerCase() &&
        r.purpose === 'MEMBER_WITHDRAWAL',
    );
  const kernelTier = withdrawal ? 'CONSENSUS' : band;
  const policyApprovals =
    kernelTier === 'AUTO'
      ? 0
      : kernelTier === 'REVIEW'
        ? mandate.approvalPolicy.reviewApprovals
        : withdrawal && mandate.tierPolicy.withdrawal === 'UNANIMOUS'
          ? mandate.members.filter((m) => m.active).length
          : mandate.approvalPolicy.quorum;
  return {
    tier:
      kernelTier === 'AUTO'
        ? 'PERSONAL'
        : kernelTier === 'REVIEW'
          ? 'REVIEW'
          : 'QUORUM',
    kernelTier,
    policyApprovals,
    accountThreshold: mandate.approvalPolicy.accountThreshold,
    requiredApprovals: Math.max(
      policyApprovals,
      mandate.approvalPolicy.accountThreshold,
    ),
  };
}

export type SendPreview = {
  schemaVersion: 1;
  previewId: `0x${string}`;
  groupId: string;
  account: `0x${string}`;
  mandateId: string;
  mandateVersion: number;
  recipient: SendRecipient;
  asset: Asset;
  amount: string;
  amountDecimal: string;
  chainId: number;
  profile: string;
  createdAt: number;
  expiresAt: number;
  policy: SendPolicy;
  treasury: { free: string; freeAfter: string };
  guard: AusdGuardResult;
  digest: `0x${string}`;
};

export function buildSendPreview(input: {
  groupId: string;
  mandate: Mandate;
  recipient: SendRecipient;
  amountDecimal: string;
  freeBalance: bigint;
  guard: AusdGuardResult;
  now: number;
  ttlSeconds: number;
  nonce: string;
}): SendPreview {
  const { mandate, recipient } = input;
  const asset = requireOfficialAusd(
    mandate.inputAsset,
    mandate.network.chainId,
  );
  if (!recipient.sendable)
    throw new FundingError(
      'RECIPIENT_UNKNOWN',
      `${recipient.address} is not on the mandate recipient allowlist`,
    );
  let amount: bigint;
  try {
    amount = parseDecimal(input.amountDecimal, asset.decimals);
  } catch {
    throw new FundingError('AMOUNT_INVALID', input.amountDecimal);
  }
  if (amount <= 0n) throw new FundingError('AMOUNT_INVALID', 'zero');
  if (amount > BigInt(mandate.perActionCap))
    throw new FundingError(
      'AMOUNT_EXCEEDS_MANDATE',
      `${amount} > per-action cap ${mandate.perActionCap}`,
    );
  if (amount > input.freeBalance)
    throw new FundingError(
      'INSUFFICIENT_FREE_BALANCE',
      `${amount} > free ${input.freeBalance}`,
    );
  if (
    input.guard.status !== 'PASS' ||
    input.guard.recipient.toLowerCase() !== recipient.address ||
    input.guard.amount !== String(amount) ||
    input.guard.account.toLowerCase() !== mandate.account.toLowerCase()
  )
    throw new FundingError(
      'AUSD_GUARD_BLOCKED',
      input.guard.reasons.join(',') || 'guard evidence does not bind this send',
    );
  const body = {
    schemaVersion: 1 as const,
    groupId: input.groupId,
    account: lower(mandate.account),
    mandateId: mandate.mandateId,
    mandateVersion: mandate.version,
    recipient,
    asset,
    amount: String(amount),
    amountDecimal: formatDecimal(amount, asset.decimals),
    chainId: mandate.network.chainId,
    profile:
      profileForChainId(mandate.network.chainId)?.network.profile ??
      mandate.network.profile,
    createdAt: input.now,
    expiresAt: Math.min(input.now + input.ttlSeconds, mandate.validUntil),
    policy: sendPolicy(mandate, amount, recipient.address),
    treasury: {
      free: String(input.freeBalance),
      freeAfter: String(input.freeBalance - amount),
    },
    guard: input.guard,
  };
  const previewId = contentHash({ ...body, nonce: input.nonce });
  return { ...body, previewId, digest: contentHash({ ...body, previewId }) };
}

/**
 * The confirming client echoes the exact recipient and amount it displayed;
 * any divergence from the stored preview blocks the proposal (AUSD-006).
 */
export function confirmSendPreview(
  preview: SendPreview,
  confirmation: {
    previewId: string;
    digest: string;
    recipientAddress: string;
    amount: string;
    chainId: number;
  },
  now: number,
): SendPreview {
  if (confirmation.previewId !== preview.previewId)
    throw new FundingError('PREVIEW_MISMATCH', 'previewId');
  const { previewId: _p, digest: _d, ...body } = preview;
  if (contentHash({ ...body, previewId: preview.previewId }) !== preview.digest)
    throw new FundingError('PREVIEW_MISMATCH', 'stored preview tampered');
  if (confirmation.digest !== preview.digest)
    throw new FundingError('PREVIEW_MISMATCH', 'digest');
  if (lower(confirmation.recipientAddress) !== preview.recipient.address)
    throw new FundingError(
      'RECIPIENT_MISMATCH',
      `${confirmation.recipientAddress} != ${preview.recipient.address}`,
    );
  if (confirmation.amount !== preview.amount)
    throw new FundingError('PREVIEW_MISMATCH', 'amount');
  if (confirmation.chainId !== preview.chainId)
    throw new FundingError('NETWORK_MISMATCH', String(confirmation.chainId));
  if (now >= preview.expiresAt) throw new FundingError('PREVIEW_EXPIRED');
  return preview;
}

export const SEND_STATES = [
  'PREVIEWED',
  'PENDING_APPROVAL',
  'AUTHORIZED',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXED',
  'REJECTED',
] as const;
export type SendState = (typeof SEND_STATES)[number];

export type SendReceipt = {
  transactionHash: `0x${string}`;
  blockNumber: string;
  explorer: string | null;
  recipientBalanceBefore: string;
  recipientBalanceAfter: string;
  recipientDelta: string;
  indexedThroughBlock: number;
  grantExecutedIndexed: boolean;
  submittedAt: number;
  confirmedAt: number;
  indexedAt: number;
  latencyMs: { submitToConfirmed: number; submitToIndexed: number };
};

export type SendRecord = {
  sendId: `0x${string}`;
  state: SendState;
  preview: SendPreview;
  intentId: string | null;
  intentHash: string | null;
  draftDigest: string | null;
  kernelCode: string | null;
  kernelTier: string | null;
  grantId: string | null;
  receipt: SendReceipt | null;
  /** Sender member whose passkey signed the preview confirmation. */
  sender: {
    memberId: string;
    signer: `0x${string}`;
    signature: `0x${string}`;
  } | null;
  /** Kernel proposal (intent, risk packet, simulation, calldata) as JSON. */
  proposal: unknown;
  history: { state: SendState; at: number; note: string }[];
};

const SEND_NEXT: Record<SendState, readonly SendState[]> = {
  PREVIEWED: ['PENDING_APPROVAL', 'AUTHORIZED', 'REJECTED'],
  PENDING_APPROVAL: ['AUTHORIZED', 'REJECTED'],
  AUTHORIZED: ['SUBMITTED', 'REJECTED'],
  SUBMITTED: ['CONFIRMED', 'REJECTED'],
  CONFIRMED: ['INDEXED'],
  INDEXED: [],
  REJECTED: [],
};

export function advanceSend(
  record: SendRecord,
  state: SendState,
  at: number,
  note: string,
  patch: Partial<
    Omit<SendRecord, 'sendId' | 'preview' | 'history' | 'state'>
  > = {},
): SendRecord {
  if (record.state === state) return { ...record, ...patch };
  if (!SEND_NEXT[record.state].includes(state))
    throw new FundingError('INVALID_TRANSITION', `${record.state} -> ${state}`);
  return {
    ...record,
    ...patch,
    state,
    history: [...record.history, { state, at, note }],
  };
}

export function newSendRecord(preview: SendPreview, at: number): SendRecord {
  return {
    sendId: contentHash({ kind: 'SynqSend', previewId: preview.previewId }),
    state: 'PREVIEWED',
    preview,
    intentId: null,
    intentHash: null,
    draftDigest: null,
    kernelCode: null,
    kernelTier: null,
    grantId: null,
    receipt: null,
    sender: null,
    proposal: null,
    history: [{ state: 'PREVIEWED', at, note: 'preview created' }],
  };
}

export interface SendStore {
  savePreview(preview: SendPreview): Promise<void>;
  preview(previewId: string): Promise<SendPreview | null>;
  /** Creates the record once per preview; a second confirmation returns the existing record. */
  createOnce(
    record: SendRecord,
  ): Promise<{ record: SendRecord; created: boolean }>;
  get(sendId: string): Promise<SendRecord | null>;
  byIntentHash(intentHash: string): Promise<SendRecord | null>;
  save(record: SendRecord): Promise<void>;
}

export class MemorySendStore implements SendStore {
  private readonly previews = new Map<string, SendPreview>();
  private readonly records = new Map<string, SendRecord>();
  async savePreview(p: SendPreview) {
    this.previews.set(p.previewId, structuredClone(p));
  }
  async preview(id: string) {
    const p = this.previews.get(id);
    return p ? structuredClone(p) : null;
  }
  async createOnce(record: SendRecord) {
    const existing = this.records.get(record.sendId);
    if (existing) return { record: structuredClone(existing), created: false };
    this.records.set(record.sendId, structuredClone(record));
    return { record: structuredClone(record), created: true };
  }
  async get(id: string) {
    const r = this.records.get(id);
    return r ? structuredClone(r) : null;
  }
  async byIntentHash(h: string) {
    for (const r of this.records.values())
      if (r.intentHash === h) return structuredClone(r);
    return null;
  }
  async save(record: SendRecord) {
    if (!this.records.has(record.sendId))
      throw new FundingError('INVALID_TRANSITION', 'unknown send');
    this.records.set(record.sendId, structuredClone(record));
  }
}
