import { HedgeIntentSchema } from './hedge.js';
import { z } from 'zod';
import {
  GrantDraftSchema,
  IdentityPrincipalKindSchema,
  VerifiedApprovalSchema,
} from './approval.js';
import { AssetSchema, ChainIdSchema } from './network.js';
import {
  AddressSchema,
  AmountSchema,
  GroupIdSchema,
  HashSchema,
  IdSchema,
  MemberIdSchema,
  PrincipalIdSchema,
  SignatureSchema,
  TimestampSchema,
} from './primitives.js';

export const RpIdSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);
export const OriginSchema = z
  .string()
  .max(512)
  .regex(/^https?:\/\/[a-z0-9.-]+(:[0-9]{1,5})?$/);
export const CredentialIdSchema = z
  .string()
  .min(1)
  .max(1366)
  .regex(/^[A-Za-z0-9_-]+$/, 'canonical unpadded base64url required');
export const PasskeyCredentialSchema = z.strictObject({
  credentialId: CredentialIdSchema,
  transports: z.array(z.string().min(1).max(32)).max(8).optional(),
});
export type PasskeyCredential = z.output<typeof PasskeyCredentialSchema>;

export const IdentityChallengePurposeSchema = z.enum([
  'ENROLL',
  'RECOVER',
  'JOIN',
]);
export type IdentityChallengePurpose = z.output<
  typeof IdentityChallengePurposeSchema
>;

export const IdentityChallengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  challengeId: IdSchema,
  purpose: IdentityChallengePurposeSchema,
  principalId: PrincipalIdSchema,
  principalKind: IdentityPrincipalKindSchema,
  signer: AddressSchema,
  rpId: RpIdSchema,
  origin: OriginSchema,
  credentialId: z.string().max(1366),
  transports: z.array(z.string().min(1).max(32)).max(8),
  groupId: z.string().max(128),
  memberId: z.string().max(128),
  membershipEpoch: z.number().int().nonnegative(),
  nonce: HashSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type IdentityChallenge = z.output<typeof IdentityChallengeSchema>;

export const PrincipalViewSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: IdentityPrincipalKindSchema,
  signer: AddressSchema,
  rpId: RpIdSchema.nullable(),
  credential: PasskeyCredentialSchema.nullable(),
  status: z.enum(['ACTIVE', 'DISABLED']),
  enrolledAt: TimestampSchema,
});
export type PrincipalView = z.output<typeof PrincipalViewSchema>;

export const MembershipRoleSchema = z.enum(['APPROVER', 'OPERATOR']);
export const MembershipViewSchema = z.strictObject({
  groupId: GroupIdSchema,
  memberId: MemberIdSchema,
  principalId: PrincipalIdSchema,
  principalKind: IdentityPrincipalKindSchema,
  role: MembershipRoleSchema,
  signer: AddressSchema,
  status: z.enum(['ACTIVE', 'REVOKED']),
  joinedEpoch: z.number().int().nonnegative(),
  joinedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable(),
});
export type MembershipView = z.output<typeof MembershipViewSchema>;

export const GroupBindingInputSchema = z.strictObject({
  groupId: GroupIdSchema,
  chainGroupId: HashSchema,
  chainId: ChainIdSchema,
  account: AddressSchema,
  owners: z.array(AddressSchema).min(1).max(32),
  threshold: z.number().int().positive(),
  executors: z.array(AddressSchema).max(16).default([]),
});
export const GroupViewSchema = z.strictObject({
  groupId: GroupIdSchema,
  chainGroupId: HashSchema,
  chainId: ChainIdSchema,
  account: AddressSchema,
  owners: z.array(AddressSchema),
  threshold: z.number().int().positive(),
  executors: z.array(AddressSchema),
  membershipEpoch: z.number().int().nonnegative(),
  memberships: z.array(MembershipViewSchema),
});
export type GroupView = z.output<typeof GroupViewSchema>;

export const GrantPreviewSchema = z.strictObject({
  action: z.literal('PERP_HEDGE').optional(),
  target: AddressSchema.optional(),
  hedgeIntent: HedgeIntentSchema.optional(),
  groupId: GroupIdSchema,
  account: AddressSchema,
  chainId: z.number().int().positive(),
  recipient: AddressSchema,
  token: z.strictObject({
    address: AddressSchema,
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
  }),
  amount: z.strictObject({ raw: AmountSchema, display: z.string() }),
  nativeValue: AmountSchema,
  validAfter: AmountSchema,
  validUntil: AmountSchema,
  mandateId: HashSchema,
  mandateVersion: AmountSchema,
  nonce: AmountSchema,
  executor: AddressSchema,
  verifyingContract: AddressSchema,
  calldataHash: HashSchema,
  intentHash: HashSchema,
  digest: HashSchema,
});
export type GrantPreview = z.output<typeof GrantPreviewSchema>;

export const PendingIntentViewSchema = z.strictObject({
  intentId: HashSchema,
  status: z.enum(['PENDING_APPROVAL', 'APPROVED', 'INVALIDATED']),
  draft: GrantDraftSchema,
  asset: AssetSchema,
  preview: GrantPreviewSchema,
});
export type PendingIntentView = z.output<typeof PendingIntentViewSchema>;

export const GrantApprovalChallengeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  challengeId: HashSchema,
  challengeNonce: HashSchema,
  groupId: GroupIdSchema,
  memberId: MemberIdSchema,
  principalId: PrincipalIdSchema,
  principalKind: IdentityPrincipalKindSchema,
  signer: AddressSchema,
  draftDigest: HashSchema,
  membershipEpoch: z.number().int().nonnegative(),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type GrantApprovalChallenge = z.output<
  typeof GrantApprovalChallengeSchema
>;

export const QuorumViewSchema = z.strictObject({
  draftDigest: HashSchema,
  groupId: GroupIdSchema,
  draftStatus: z.enum(['PENDING', 'INVALIDATED']),
  required: z.number().int().positive(),
  membershipEpoch: z.number().int().nonnegative(),
  counted: z.array(VerifiedApprovalSchema),
  satisfied: z.boolean(),
});
export type QuorumView = z.output<typeof QuorumViewSchema>;
export const PublicApprovalSchema = VerifiedApprovalSchema.omit({
  signature: true,
});
export const PublicQuorumViewSchema = QuorumViewSchema.extend({
  counted: z.array(PublicApprovalSchema),
});
export type PublicQuorumView = z.output<typeof PublicQuorumViewSchema>;

export const DelegationPolicySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    policyId: IdSchema,
    groupId: GroupIdSchema,
    delegatePrincipalId: PrincipalIdSchema,
    delegatorMemberId: MemberIdSchema,
    asset: AssetSchema,
    recipient: AddressSchema,
    maxAmountPerPeriod: AmountSchema,
    maxAmountPerExecution: AmountSchema,
    periodSeconds: z.number().int().positive(),
    maxExecutionsPerPeriod: z.number().int().positive(),
    minIntervalSeconds: z.number().int().nonnegative(),
    validAfter: TimestampSchema,
    validUntil: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .refine(
    (v) =>
      v.validUntil > v.validAfter &&
      BigInt(v.maxAmountPerExecution) <= BigInt(v.maxAmountPerPeriod) &&
      BigInt(v.maxAmountPerExecution) > 0n,
    'invalid delegation envelope',
  );
export type DelegationPolicy = z.output<typeof DelegationPolicySchema>;

export const SignedChallengeInputSchema = z.strictObject({
  challengeId: IdSchema,
  signature: SignatureSchema,
});
export const GrantApprovalSubmissionSchema = z.strictObject({
  challengeId: HashSchema,
  grantSignature: SignatureSchema,
  attestationSignature: SignatureSchema,
});
export const ApiErrorSchema = z.strictObject({
  error: z.string(),
  message: z.string(),
});

export const EnrollmentChallengeRequestSchema = z.strictObject({
  kind: z.enum(['MERA_HUMAN', 'LOCAL_FIXTURE']),
  signer: AddressSchema,
  credential: PasskeyCredentialSchema.optional(),
  rpId: RpIdSchema,
  origin: OriginSchema,
});
export const RecoveryChallengeRequestSchema = z.strictObject({
  signer: AddressSchema,
  credentialId: CredentialIdSchema,
  rpId: RpIdSchema,
  origin: OriginSchema,
});
export const RecoveryResultSchema = z.strictObject({
  principal: PrincipalViewSchema,
  memberships: z.array(MembershipViewSchema),
});
export const MembershipRequestSchema = z.strictObject({
  memberId: MemberIdSchema,
  principalId: PrincipalIdSchema,
});
export const IntentProposalSchema = z.strictObject({
  intent: z.unknown(),
  risk: z.unknown(),
  simulation: z.unknown(),
});
export const IntentProposalResultSchema = z.strictObject({
  status: z.enum(['PENDING_APPROVAL', 'AUTHORIZED']),
  code: z.string().nullable(),
  intentId: z.string().nullable(),
  pending: PendingIntentViewSchema.nullable(),
});
export type IntentProposalResult = z.output<typeof IntentProposalResultSchema>;
export const ApprovalChallengeRequestSchema = z.strictObject({
  draftDigest: HashSchema,
  memberId: MemberIdSchema,
  principalId: PrincipalIdSchema,
  requestedAt: TimestampSchema,
  requestSignature: SignatureSchema,
});
export type ApprovalChallengeRequest = z.output<
  typeof ApprovalChallengeRequestSchema
>;
export const MandateViewSchema = z.strictObject({
  groupId: HashSchema,
  mandateId: HashSchema,
  version: AmountSchema,
  active: z.boolean(),
  terms: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  source: z.literal('indexed-read-model'),
  currentHeadVerified: z.boolean(),
});
export const ProviderStatusViewSchema = z.array(
  z.strictObject({
    provider: z.enum(['privy', 'dynamic']),
    status: z.enum(['CONFIGURED', 'BLOCKED']),
    missing: z.array(z.string()),
  }),
);
