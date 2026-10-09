import { formatUnits, hashTypedData, type Address, type Hex } from 'viem';
import {
  AssetSchema,
  GrantDraftSchema,
  GrantPreviewSchema,
  type Asset,
  type GrantDraft,
  type GrantApprovalChallenge,
  type GrantPreview,
} from '@synq/schemas';
import { IdentityError } from './errors.js';

export const EXECUTION_GRANT_TYPES = {
  ExecutionGrant: [
    { name: 'groupId', type: 'bytes32' },
    { name: 'account', type: 'address' },
    { name: 'mandateId', type: 'bytes32' },
    { name: 'mandateVersion', type: 'uint256' },
    { name: 'executor', type: 'address' },
    { name: 'pluginId', type: 'bytes32' },
    { name: 'chainId', type: 'uint256' },
    { name: 'target', type: 'address' },
    { name: 'selector', type: 'bytes4' },
    { name: 'calldataHash', type: 'bytes32' },
    { name: 'token', type: 'address' },
    { name: 'maxInputAmount', type: 'uint256' },
    { name: 'nativeValue', type: 'uint256' },
    { name: 'minOutputAmount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'intentHash', type: 'bytes32' },
  ],
} as const;
export const ERC20_TRANSFER_SELECTOR = '0xa9059cbb';

export function grantTypedData(raw: GrantDraft) {
  const { domain, grant } = GrantDraftSchema.parse(raw);
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.verifyingContract as Address,
    },
    types: EXECUTION_GRANT_TYPES,
    primaryType: 'ExecutionGrant' as const,
    message: {
      groupId: grant.groupId as Hex,
      account: grant.account as Address,
      mandateId: grant.mandateId as Hex,
      mandateVersion: BigInt(grant.mandateVersion),
      executor: grant.executor as Address,
      pluginId: grant.pluginId as Hex,
      chainId: BigInt(grant.chainId),
      target: grant.target as Address,
      selector: grant.selector as Hex,
      calldataHash: grant.calldataHash as Hex,
      token: grant.token as Address,
      maxInputAmount: BigInt(grant.maxInputAmount),
      nativeValue: BigInt(grant.nativeValue),
      minOutputAmount: BigInt(grant.minOutputAmount),
      recipient: grant.recipient as Address,
      validAfter: BigInt(grant.validAfter),
      validUntil: BigInt(grant.validUntil),
      nonce: BigInt(grant.nonce),
      intentHash: grant.intentHash as Hex,
    },
  };
}

export function grantDigest(draft: GrantDraft): Hex {
  return hashTypedData(grantTypedData(draft));
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
  if (
    grant.selector !== ERC20_TRANSFER_SELECTOR ||
    grant.target !== grant.token ||
    asset.address !== grant.token ||
    asset.chainId !== Number(grant.chainId) ||
    grant.nativeValue !== '0'
  )
    throw new IdentityError('DRAFT_INVALID', 'preview requires ERC20 transfer');
  return GrantPreviewSchema.parse({
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

export const APPROVAL_ATTESTATION_TYPES = {
  SynqApprovalAttestation: [
    { name: 'challengeId', type: 'bytes32' },
    { name: 'challengeNonce', type: 'bytes32' },
    { name: 'draftDigest', type: 'bytes32' },
    { name: 'groupId', type: 'bytes32' },
    { name: 'membershipEpoch', type: 'uint256' },
    { name: 'expiresAt', type: 'uint256' },
  ],
} as const;

export function approvalAttestationTypedData(
  draft: GrantDraft,
  challenge: GrantApprovalChallenge,
) {
  return {
    domain: synqIdentityDomain(draft),
    types: APPROVAL_ATTESTATION_TYPES,
    primaryType: 'SynqApprovalAttestation' as const,
    message: {
      challengeId: challenge.challengeId as Hex,
      challengeNonce: challenge.challengeNonce as Hex,
      draftDigest: challenge.draftDigest as Hex,
      groupId: draft.grant.groupId as Hex,
      membershipEpoch: BigInt(challenge.membershipEpoch),
      expiresAt: BigInt(challenge.expiresAt),
    },
  };
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
