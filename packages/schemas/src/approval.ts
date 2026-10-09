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
