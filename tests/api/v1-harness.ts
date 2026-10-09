import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type {
  GrantApprovalChallenge,
  GrantDraft,
  GrantPreview,
  IdentityChallenge,
} from '@synq/schemas';
import {
  approveGrantWithMera,
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
  type MeraCredential,
} from '../../packages/identity/src/mera-browser.js';
import { DeterministicAuthenticator, testAusd } from '../identity/fixtures.js';

export const rpId = 'synq.test';
export const origin = 'https://synq.test';
export const ADMIN = 'admin-token-for-tests-only-0123456789abcdef';

export function client(app: FastifyInstance) {
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      headers:
        method === 'POST'
          ? { 'idempotency-key': randomUUID(), ...headers }
          : headers,
    });
    return {
      status: res.statusCode,
      body: res.json() as Record<string, unknown>,
      headers: res.headers,
    };
  };
  const admin = { authorization: `Bearer ${ADMIN}` };
  return { call, admin };
}

export async function enrollViaApi(app: FastifyInstance, secret: string) {
  const { call } = client(app);
  const auth = new DeterministicAuthenticator(secret);
  const result = await enrollMeraPrincipal(
    {
      rpId,
      rpName: 'Synq',
      user: { name: secret, displayName: secret },
      requestChallenge: async ({ signer, credential }) => {
        const res = await call('POST', '/v1/principals/enrollment-challenges', {
          kind: 'MERA_HUMAN',
          signer,
          credential: {
            credentialId: credential.credentialId,
            transports: [...(credential.transports ?? [])],
          },
          rpId,
          origin,
        });
        if (res.status !== 201) throw new Error(JSON.stringify(res.body));
        return res.body as unknown as IdentityChallenge;
      },
    },
    { webAuthnClient: auth },
  );
  const enrolled = await call('POST', '/v1/principals', {
    challengeId: result.challenge.challengeId,
    signature: result.signature,
  });
  if (enrolled.status !== 201) throw new Error(JSON.stringify(enrolled.body));
  return { auth, record: result.record };
}
export type ApiHuman = Awaited<ReturnType<typeof enrollViaApi>>;

export async function joinViaApi(
  app: FastifyInstance,
  groupId: string,
  h: ApiHuman,
  memberId: string,
) {
  const { call } = client(app);
  const c = await call('POST', `/v1/groups/${groupId}/membership-challenges`, {
    memberId,
    principalId: h.record.principalId,
  });
  if (c.status !== 201) return c;
  const signature = await signMeraIdentityChallenge(
    h.record,
    c.body as unknown as IdentityChallenge,
    {
      webAuthnClient: h.auth,
    },
  );
  return call('POST', `/v1/groups/${groupId}/memberships`, {
    challengeId: c.body.challengeId,
    signature,
  });
}

export async function approvalSignature(
  app: FastifyInstance,
  h: ApiHuman,
  memberId: string,
  draft: GrantDraft,
  preview: GrantPreview,
) {
  const { call } = client(app);
  const c = await call('POST', '/v1/approvals/challenges', {
    draftDigest: draft.digest,
    memberId,
  });
  if (c.status !== 201)
    return { challenge: null, signature: null, response: c };
  const challenge = c.body as unknown as GrantApprovalChallenge;
  const signature = await approveGrantWithMera(
    {
      record: h.record as MeraCredential,
      draft,
      asset: testAusd,
      confirmedPreview: preview,
      challenge,
    },
    { webAuthnClient: h.auth },
  );
  return { challenge, signature, response: c };
}
