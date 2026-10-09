import type { IdentityChallenge, PrincipalView } from '@synq/schemas';
import { identityChallengeTypedData } from '../challenge.js';
import type { PrincipalService } from '../principals.js';

export type ProviderChallengeSigner = {
  address: `0x${string}`;
  providerRef: string;
  signTypedData(
    typedData: ReturnType<typeof identityChallengeTypedData>,
  ): Promise<`0x${string}`>;
};

export async function enrollProviderPrincipal(
  principals: PrincipalService,
  kind: 'PRIVY_DELEGATE' | 'DYNAMIC_OPERATOR',
  signer: ProviderChallengeSigner,
): Promise<PrincipalView> {
  const challenge: IdentityChallenge =
    await principals.issueEnrollmentChallenge({
      kind,
      signer: signer.address,
      rpId: principals.config.rpId,
      origin: principals.config.origin,
      providerRef: signer.providerRef,
    });
  const signature = await signer.signTypedData(
    identityChallengeTypedData(challenge),
  );
  return principals.enroll({ challengeId: challenge.challengeId, signature });
}
