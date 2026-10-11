import {
  keccak256,
  stringToHex,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import {
  AssetSchema,
  GrantDraftSchema,
  GrantPreviewSchema,
  executionGrantDigest,
  executionGrantTypedData,
  approvalAttestationTypedData as sharedAttestationTypedData,
  type Asset,
  type GrantDraft,
  type GrantApprovalChallenge,
  type GrantPreview,
} from '@synq/schemas';
import { IdentityError } from './errors.js';

export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

export function grantTypedData(raw: GrantDraft) {
  const { domain, grant } = GrantDraftSchema.parse(raw);
  return executionGrantTypedData(domain, grant);
}

export function grantDigest(draft: GrantDraft): Hex {
  const { domain, grant } = GrantDraftSchema.parse(draft);
  return executionGrantDigest(domain, grant);
}

export function assertDraftConsistent(raw: GrantDraft): GrantDraft {
  const parsed = GrantDraftSchema.safeParse(raw);
  if (!parsed.success) throw new IdentityError('DRAFT_INVALID', 'schema');
  const draft = parsed.data;
  if (BigInt(draft.grant.chainId) !== BigInt(draft.domain.chainId))
    throw new IdentityError('DRAFT_INVALID', 'chain');
  if (grantDigest(draft) !== draft.digest.toLowerCase())
    throw new IdentityError('DRAFT_INVALID', 'digest');
  return draft;
}

export function grantPreview(
  rawDraft: GrantDraft,
  rawAsset: Asset,
): GrantPreview {
  const draft = assertDraftConsistent(rawDraft);
  const asset = AssetSchema.parse(rawAsset);
  const { grant } = draft;
  const hedge = draft.hedgeIntent;
  if (hedge) {
    const canonical = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
      if (value !== null && typeof value === 'object')
        return `{${Object.entries(value)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
          .join(',')}}`;
      const wire = JSON.stringify(value);
      if (wire === undefined) throw new IdentityError('DRAFT_INVALID');
      return wire;
    };
    const hash = keccak256(stringToHex(canonical(hedge)));
    if (
      draft.groupId !== hedge.groupId ||
      grant.chainId !== String(hedge.chainId) ||
      asset.address !== grant.token ||
      asset.chainId !== hedge.chainId ||
      grant.maxInputAmount !== hedge.collateral ||
      grant.intentHash !== hash ||
      grant.calldataHash !== hash ||
      grant.pluginId !== keccak256(stringToHex('perpl')) ||
      grant.nativeValue !== '0' ||
      Number(grant.validUntil) > hedge.expiresAt
    )
      throw new IdentityError('DRAFT_INVALID', 'hedge preview binding');
  } else if (
    grant.selector !== ERC20_TRANSFER_SELECTOR ||
    grant.target !== grant.token ||
    asset.address !== grant.token ||
    asset.chainId !== Number(grant.chainId) ||
    grant.nativeValue !== '0'
  )
    throw new IdentityError('DRAFT_INVALID', 'preview requires ERC20 transfer');
  return GrantPreviewSchema.parse({
    ...(hedge
      ? { action: 'PERP_HEDGE', target: grant.target, hedgeIntent: hedge }
      : {}),
    groupId: draft.groupId,
    account: grant.account,
    chainId: Number(grant.chainId),
    recipient: grant.recipient,
    token: {
      address: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
    },
    amount: {
      raw: grant.maxInputAmount,
      display: formatUnits(BigInt(grant.maxInputAmount), asset.decimals),
    },
    nativeValue: grant.nativeValue,
    validAfter: grant.validAfter,
    validUntil: grant.validUntil,
    mandateId: grant.mandateId,
    mandateVersion: grant.mandateVersion,
    nonce: grant.nonce,
    executor: grant.executor,
    verifyingContract: draft.domain.verifyingContract,
    calldataHash: grant.calldataHash,
    intentHash: grant.intentHash,
    digest: draft.digest,
  });
}

export function previewsEqual(a: GrantPreview, b: GrantPreview): boolean {
  const x = GrantPreviewSchema.parse(a),
    y = GrantPreviewSchema.parse(b);
  return JSON.stringify(sortKeys(x)) === JSON.stringify(sortKeys(y));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  return value;
}

export function synqIdentityDomain(draft: GrantDraft) {
  const { domain } = GrantDraftSchema.parse(draft);
  return {
    name: 'SynqIdentity',
    version: '1',
    chainId: BigInt(domain.chainId),
    verifyingContract: domain.verifyingContract as Address,
  } as const;
}

export { APPROVAL_ATTESTATION_TYPES } from '@synq/schemas';

export function approvalAttestationTypedData(
  draft: GrantDraft,
  challenge: GrantApprovalChallenge,
) {
  const parsed = GrantDraftSchema.parse(draft);
  return sharedAttestationTypedData(parsed.domain, {
    challengeId: challenge.challengeId,
    challengeNonce: challenge.challengeNonce,
    draftDigest: challenge.draftDigest,
    groupId: parsed.grant.groupId,
    membershipEpoch: challenge.membershipEpoch,
    expiresAt: challenge.expiresAt,
  });
}

export const CHALLENGE_REQUEST_TYPES = {
  SynqChallengeRequest: [
    { name: 'draftDigest', type: 'bytes32' },
    { name: 'principalId', type: 'string' },
    { name: 'memberId', type: 'string' },
    { name: 'requestedAt', type: 'uint256' },
  ],
} as const;

export function challengeRequestTypedData(
  draft: GrantDraft,
  request: { principalId: string; memberId: string; requestedAt: number },
) {
  return {
    domain: synqIdentityDomain(draft),
    types: CHALLENGE_REQUEST_TYPES,
    primaryType: 'SynqChallengeRequest' as const,
    message: {
      draftDigest: draft.digest as Hex,
      principalId: request.principalId,
      memberId: request.memberId,
      requestedAt: BigInt(request.requestedAt),
    },
  };
}
