import { hashTypedData } from 'viem';
import { z } from 'zod';
import { ChainIdSchema } from './network.js';
import {
  AddressSchema,
  AmountSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  MemberIdSchema,
  PrincipalIdSchema,
  SelectorSchema,
  SignatureSchema,
  TimestampSchema,
} from './primitives.js';

export const IdentityPrincipalKindSchema = z.enum([
  'MERA_HUMAN',
  'PRIVY_DELEGATE',
  'DYNAMIC_OPERATOR',
  'LOCAL_FIXTURE',
]);
export type IdentityPrincipalKind = z.output<
  typeof IdentityPrincipalKindSchema
>;

export const APPROVAL_ELIGIBLE_KINDS = [
  'MERA_HUMAN',
  'LOCAL_FIXTURE',
] as const satisfies readonly IdentityPrincipalKind[];

export const OnchainGrantSchema = z.strictObject({
  groupId: HashSchema,
  account: AddressSchema,
  mandateId: HashSchema,
  mandateVersion: AmountSchema,
  executor: AddressSchema,
  pluginId: HashSchema,
  chainId: AmountSchema,
  target: AddressSchema,
  selector: SelectorSchema,
  calldataHash: HashSchema,
  token: AddressSchema,
  maxInputAmount: AmountSchema,
  nativeValue: AmountSchema,
  minOutputAmount: AmountSchema,
  recipient: AddressSchema,
  validAfter: AmountSchema,
  validUntil: AmountSchema,
  nonce: AmountSchema,
  intentHash: HashSchema,
});
export type OnchainGrant = z.output<typeof OnchainGrantSchema>;

export const GrantDomainSchema = z.strictObject({
  name: z.literal('SynqExecutionModule'),
  version: z.literal('1'),
  chainId: ChainIdSchema,
  verifyingContract: AddressSchema,
});
export type GrantDomain = z.output<typeof GrantDomainSchema>;

export const GrantDraftSchema = z.strictObject({
  schemaVersion: z.literal(1),
  groupId: GroupIdSchema,
  domain: GrantDomainSchema,
  grant: OnchainGrantSchema,
  digest: HashSchema,
  requiredApprovals: z.number().int().positive(),
  createdAt: TimestampSchema,
});
export type GrantDraft = z.output<typeof GrantDraftSchema>;

export const VerifiedApprovalSchema = z.strictObject({
  schemaVersion: z.literal(1),
  approvalId: IdSchema,
  challengeId: IdSchema,
  groupId: GroupIdSchema,
  memberId: MemberIdSchema,
  principalId: PrincipalIdSchema,
  principalKind: IdentityPrincipalKindSchema,
  signer: AddressSchema,
  draftDigest: HashSchema,
  signature: SignatureSchema,
  membershipEpoch: z.number().int().nonnegative(),
  verifiedAt: TimestampSchema,
});
export type VerifiedApproval = z.output<typeof VerifiedApprovalSchema>;

export interface ApprovalLedger {
  isConsumed(approval: VerifiedApproval): Promise<boolean>;
}

export type DirectoryMember = {
  groupId: string;
  memberId: string;
  principalId: string;
  principalKind: IdentityPrincipalKind;
  role: 'APPROVER' | 'OPERATOR';
  signer: `0x${string}`;
  membershipEpoch: number;
  ownerOfAccount: boolean;
};
export interface MembershipDirectory {
  activeMember(
    groupId: string,
    memberId: string,
  ): Promise<DirectoryMember | null>;
  membershipEpoch(groupId: string): Promise<number | null>;
}

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
export function executionGrantMessage(grant: OnchainGrant) {
  return {
    groupId: grant.groupId,
    account: grant.account,
    mandateId: grant.mandateId,
    mandateVersion: BigInt(grant.mandateVersion),
    executor: grant.executor,
    pluginId: grant.pluginId,
    chainId: BigInt(grant.chainId),
    target: grant.target,
    selector: grant.selector,
    calldataHash: grant.calldataHash,
    token: grant.token,
    maxInputAmount: BigInt(grant.maxInputAmount),
    nativeValue: BigInt(grant.nativeValue),
    minOutputAmount: BigInt(grant.minOutputAmount),
    recipient: grant.recipient,
    validAfter: BigInt(grant.validAfter),
    validUntil: BigInt(grant.validUntil),
    nonce: BigInt(grant.nonce),
    intentHash: grant.intentHash,
  };
}
export function executionGrantTypedData(
  domain: GrantDomain,
  grant: OnchainGrant,
) {
  return {
    domain: {
      name: domain.name,
      version: domain.version,
      chainId: domain.chainId,
      verifyingContract: domain.verifyingContract,
    },
    types: EXECUTION_GRANT_TYPES,
    primaryType: 'ExecutionGrant' as const,
    message: executionGrantMessage(grant),
  };
}
export function executionGrantDigest(
  domain: GrantDomain,
  grant: OnchainGrant,
): `0x${string}` {
  return hashTypedData(executionGrantTypedData(domain, grant));
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
export type ApprovalAttestation = {
  challengeId: `0x${string}`;
  challengeNonce: `0x${string}`;
  draftDigest: `0x${string}`;
  groupId: `0x${string}`;
  membershipEpoch: number;
  expiresAt: number;
};
export function approvalAttestationTypedData(
  domain: GrantDomain,
  attestation: ApprovalAttestation,
) {
  return {
    domain: {
      name: 'SynqIdentity',
      version: '1',
      chainId: BigInt(domain.chainId),
      verifyingContract: domain.verifyingContract,
    },
    types: APPROVAL_ATTESTATION_TYPES,
    primaryType: 'SynqApprovalAttestation' as const,
    message: {
      challengeId: attestation.challengeId,
      challengeNonce: attestation.challengeNonce,
      draftDigest: attestation.draftDigest,
      groupId: attestation.groupId,
      membershipEpoch: BigInt(attestation.membershipEpoch),
      expiresAt: BigInt(attestation.expiresAt),
    },
  };
}
