import { IdentityChallengeSchema, PrincipalViewSchema } from '@synq/schemas';
import {
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import type { SoftwareAuthenticatorStore } from './software-authenticator.js';
import { ApiCallError, type SynqApiClient } from './testnet-api.js';
import { LABELS, RP } from './testnet-config.js';

export type EnrolledPrincipal = { label: string; record: MeraCredential };

export async function enrollPrincipals(input: {
  api: SynqApiClient;
  authenticators: SoftwareAuthenticatorStore;
  webAuthn: (label: string) => Parameters<typeof enrollMeraPrincipal>[1];
  log: (message: string) => void;
}): Promise<EnrolledPrincipal[]> {
  const { api, authenticators, webAuthn, log } = input;
  const principals: EnrolledPrincipal[] = [];
  for (const label of LABELS) {
    let record = authenticators.record(label);
    if (!record) {
      const enrolled = await enrollMeraPrincipal(
        {
          rpId: RP.rpId,
          rpName: RP.rpName,
          user: { name: label, displayName: label },
          requestChallenge: async ({ signer, credential }) =>
            IdentityChallengeSchema.parse(
              await api.post('/v1/principals/enrollment-challenges', {
                kind: 'MERA_HUMAN',
                signer,
                credential: {
                  credentialId: credential.credentialId,
                  ...(credential.transports
                    ? { transports: [...credential.transports] }
                    : {}),
                },
                rpId: RP.rpId,
                origin: RP.origin,
              }),
            ),
        },
        webAuthn(label),
      );
      await api.post('/v1/principals', {
        challengeId: enrolled.challenge.challengeId,
        signature: enrolled.signature,
      });
      record = enrolled.record;
      authenticators.saveRecord(label, record);
      log(`enrolled new Mera principal ${label} ${record.principalId}`);
    } else {
      try {
        await api.get(
          `/v1/principals/${encodeURIComponent(record.principalId)}`,
        );
        log(`reusing enrolled Mera principal ${label} ${record.principalId}`);
      } catch (error) {
        if (!(error instanceof ApiCallError) || error.status !== 404)
          throw error;
        const challenge = IdentityChallengeSchema.parse(
          await api.post('/v1/principals/enrollment-challenges', {
            kind: 'MERA_HUMAN',
            signer: record.signer,
            credential: { credentialId: record.credential.credentialId },
            rpId: RP.rpId,
            origin: RP.origin,
          }),
        );
        await api.post('/v1/principals', {
          challengeId: challenge.challengeId,
          signature: await signMeraIdentityChallenge(
            record,
            challenge,
            webAuthn(label),
          ),
        });
        log(`re-enrolled stored Mera passkey ${label} ${record.principalId}`);
      }
    }
    PrincipalViewSchema.parse(
      await api.get(`/v1/principals/${encodeURIComponent(record.principalId)}`),
    );
    principals.push({ label, record });
  }
  return principals.sort((a, b) =>
    a.record.signer < b.record.signer ? -1 : 1,
  );
}
