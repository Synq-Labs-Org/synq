import { z } from 'zod';
import { AddressSchema, HashSchema } from '@synq/schemas';

export const SendAccessChallengeSchema = z.strictObject({
  challengeId: HashSchema,
  groupId: HashSchema,
  memberId: z.string().min(1),
  principalId: z.string().min(1),
  signer: AddressSchema,
  membershipEpoch: z.number().int().nonnegative(),
  chainId: z.number().int().positive(),
  account: AddressSchema,
  /** SEND_READ_PREVIEW: reads and previews. MEMBER_CONTRIBUTE: also own-wallet funding and mandate proposals. */
  scope: z.enum(['SEND_READ_PREVIEW', 'MEMBER_CONTRIBUTE']),
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
});
export type SendAccessChallenge = z.output<typeof SendAccessChallengeSchema>;
export function sendAccessTypedData(raw: SendAccessChallenge) {
  const c = SendAccessChallengeSchema.parse(raw);
  return {
    domain: {
      name: 'Synq Send Access',
      version: '1',
      chainId: c.chainId,
      verifyingContract: c.account,
    },
    types: {
      SendAccess: [
        { name: 'challengeId', type: 'bytes32' },
        { name: 'groupId', type: 'bytes32' },
        { name: 'memberId', type: 'string' },
        { name: 'principalId', type: 'string' },
        { name: 'signer', type: 'address' },
        { name: 'membershipEpoch', type: 'uint64' },
        { name: 'scope', type: 'string' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    } as const,
    primaryType: 'SendAccess' as const,
    message: {
      challengeId: c.challengeId,
      groupId: c.groupId,
      memberId: c.memberId,
      principalId: c.principalId,
      signer: c.signer,
      membershipEpoch: BigInt(c.membershipEpoch),
      scope: c.scope,
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
    },
  };
}
