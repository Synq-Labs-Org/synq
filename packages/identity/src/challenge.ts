import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { IdentityChallengeSchema, type IdentityChallenge } from '@synq/schemas';

export const IDENTITY_DOMAIN = { name: 'Synq Identity', version: '1' } as const;
export const IDENTITY_CHALLENGE_TYPES = {
  IdentityChallenge: [
    { name: 'purpose', type: 'string' },
    { name: 'challengeId', type: 'string' },
    { name: 'principalId', type: 'string' },
    { name: 'principalKind', type: 'string' },
    { name: 'signer', type: 'address' },
    { name: 'rpId', type: 'string' },
    { name: 'origin', type: 'string' },
    { name: 'credentialId', type: 'string' },
    { name: 'groupId', type: 'string' },
    { name: 'memberId', type: 'string' },
    { name: 'membershipEpoch', type: 'uint64' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function identityChallengeTypedData(raw: IdentityChallenge) {
  const c = IdentityChallengeSchema.parse(raw);
  return {
    domain: IDENTITY_DOMAIN,
    types: IDENTITY_CHALLENGE_TYPES,
    primaryType: 'IdentityChallenge' as const,
    message: {
      purpose: c.purpose,
      challengeId: c.challengeId,
      principalId: c.principalId,
      principalKind: c.principalKind,
      signer: c.signer as Address,
      rpId: c.rpId,
      origin: c.origin,
      credentialId: c.credentialId,
      groupId: c.groupId,
      memberId: c.memberId,
      membershipEpoch: BigInt(c.membershipEpoch),
      nonce: c.nonce as Hex,
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
    },
  };
}

export async function recoverIdentityChallengeSigner(
  challenge: IdentityChallenge,
  signature: Hex,
): Promise<Address> {
  const recovered = await recoverTypedDataAddress({
    ...identityChallengeTypedData(challenge),
    signature,
  });
  return recovered.toLowerCase() as Address;
}

export const meraPrincipalId = (signer: string) =>
  `mera:${signer.toLowerCase()}`;
export const fixturePrincipalId = (signer: string) =>
  `fixture:${signer.toLowerCase()}`;
