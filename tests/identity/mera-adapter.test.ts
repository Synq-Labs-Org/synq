import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Address } from 'viem';
import type { GrantApprovalChallenge, IdentityChallenge } from '@synq/schemas';
import {
  approveGrantWithMera,
  enrollMeraPrincipal,
  recoverMeraPrincipal,
  signMeraIdentityChallenge,
  MeraAdapterError,
  type MeraCredential,
} from '../../packages/identity/src/mera-browser.js';
import {
  meraPrincipalId,
  recoverIdentityChallengeSigner,
} from '../../packages/identity/src/challenge.js';
import {
  grantPreview,
  grantTypedData,
} from '../../packages/identity/src/grant.js';
import {
  DeterministicAuthenticator,
  makeDraft,
  testAusd,
  word,
} from './fixtures.js';

const rpId = 'synq.test';
const challengeFor = (
  purpose: IdentityChallenge['purpose'],
  signer: Address,
  credentialId: string,
  extra: Partial<IdentityChallenge> = {},
): IdentityChallenge => ({
  schemaVersion: 1,
  challengeId: `c_${purpose}`,
  purpose,
  principalId: meraPrincipalId(signer) as IdentityChallenge['principalId'],
  principalKind: 'MERA_HUMAN',
  signer: signer.toLowerCase() as Address,
  rpId,
  origin: 'https://synq.test',
  credentialId,
  transports: [],
  groupId: '',
  memberId: '',
  membershipEpoch: 0,
  nonce: word(99),
  issuedAt: 1000,
  expiresAt: 1300,
  ...extra,
});

async function enroll(auth: DeterministicAuthenticator) {
  return enrollMeraPrincipal(
    {
      rpId,
      rpName: 'Synq',
      user: { name: 'ada', displayName: 'Ada' },
      requestChallenge: async ({ signer, credential }) =>
        challengeFor('ENROLL', signer, credential.credentialId),
    },
    { webAuthnClient: auth },
  );
}

describe('Mera adapter via injected WebAuthnClient (unit tier; not a real authenticator)', () => {
  it('derives a deterministic account from PRF output and proves possession of it', async () => {
    const a = await enroll(new DeterministicAuthenticator('alice'));
    const again = await enroll(new DeterministicAuthenticator('alice'));
    expect(a.record.signer).toBe(again.record.signer);
    expect(a.record.principalId).toBe(meraPrincipalId(a.record.signer));
    expect(await recoverIdentityChallengeSigner(a.challenge, a.signature)).toBe(
      a.record.signer,
    );
    const b = await enroll(new DeterministicAuthenticator('bob'));
    expect(b.record.signer).not.toBe(a.record.signer);
  });

  it('uses the documented fallback assertion when PRF is not evaluated during creation', async () => {
    const direct = await enroll(new DeterministicAuthenticator('carol'));
    const auth = new DeterministicAuthenticator('carol', {
      prfOnCreate: false,
    });
    const viaFallback = await enroll(auth);
    expect(auth.calls).toEqual({ create: 1, get: 1 });
    expect(viaFallback.record.signer).toBe(direct.record.signer);
  });

  it('raises a typed PRF_UNAVAILABLE error when the authenticator lacks PRF', async () => {
    await expect(
      enroll(new DeterministicAuthenticator('dave', { prfSupported: false })),
    ).rejects.toMatchObject({
      name: 'MeraAdapterError',
      code: 'PRF_UNAVAILABLE',
    });
  });

  it('recovers the same signer from the same passkey; a different passkey derives a different signer', async () => {
    const auth = new DeterministicAuthenticator('erin');
    const enrolled = await enroll(auth);
    const recover = (client: DeterministicAuthenticator) =>
      recoverMeraPrincipal(
        {
          rpId,
          requestChallenge: async ({ signer, credentialId }) =>
            challengeFor('RECOVER', signer, credentialId),
        },
        { webAuthnClient: client },
      );
    const recovered = await recover(auth);
    expect(recovered.record.signer).toBe(enrolled.record.signer);
    expect(recovered.record.credential.credentialId).toBe(
      enrolled.record.credential.credentialId,
    );
    expect(
      await recoverIdentityChallengeSigner(
        recovered.challenge,
        recovered.signature,
      ),
    ).toBe(enrolled.record.signer);
    const other = new DeterministicAuthenticator('mallory');
    await enroll(other);
    const wrong = await recover(other);
    expect(wrong.record.signer).not.toBe(enrolled.record.signer);
  });

  it('rejects a pinned credential answered by another passkey and a signer that does not match the record', async () => {
    const auth = new DeterministicAuthenticator('frank');
    const enrolled = await enroll(auth);
    const impostor = new DeterministicAuthenticator('impostor');
    await enroll(impostor);
    const join = challengeFor(
      'JOIN',
      enrolled.record.signer,
      enrolled.record.credential.credentialId,
    );
    await expect(
      signMeraIdentityChallenge(enrolled.record, join, {
        webAuthnClient: impostor,
      }),
    ).rejects.toMatchObject({ code: 'PASSKEY_FAILED' });
    const cloned = new DeterministicAuthenticator('not-frank');
    cloned.adopt(auth);
    await expect(
      signMeraIdentityChallenge(enrolled.record, join, {
        webAuthnClient: cloned,
      }),
    ).rejects.toMatchObject({ code: 'SIGNER_MISMATCH' });
    const signature = await signMeraIdentityChallenge(enrolled.record, join, {
      webAuthnClient: auth,
    });
    expect(await recoverIdentityChallengeSigner(join, signature)).toBe(
      enrolled.record.signer,
    );
  });

  it('rejects a challenge for another signer before any ceremony', async () => {
    const auth = new DeterministicAuthenticator('gina');
    const enrolled = await enroll(auth);
    const before = auth.calls.get;
    const forged = challengeFor('JOIN', `0x${'1'.repeat(40)}`, 'x');
    await expect(
      signMeraIdentityChallenge(enrolled.record, forged, {
        webAuthnClient: auth,
      }),
    ).rejects.toBeInstanceOf(MeraAdapterError);
    expect(auth.calls.get).toBe(before);
  });

  describe('grant approval (AUSD-006)', () => {
    async function setup() {
      const auth = new DeterministicAuthenticator('hank');
      const { record } = await enroll(auth);
      const draft = makeDraft();
      const preview = grantPreview(draft, testAusd);
      const challenge: GrantApprovalChallenge = {
        schemaVersion: 1,
        challengeId: 'g1',
        groupId: draft.groupId,
        memberId: 'member_0' as GrantApprovalChallenge['memberId'],
        principalId:
          record.principalId as GrantApprovalChallenge['principalId'],
        principalKind: 'MERA_HUMAN',
        signer: record.signer,
        draftDigest: draft.digest,
        membershipEpoch: 3,
        issuedAt: 1000,
        expiresAt: 1100,
      };
      return { auth, record, draft, preview, challenge };
    }
    const sign = (
      s: Awaited<ReturnType<typeof setup>>,
      over: Partial<Parameters<typeof approveGrantWithMera>[0]> = {},
    ) =>
      approveGrantWithMera(
        {
          record: s.record as MeraCredential,
          draft: s.draft,
          asset: testAusd,
          confirmedPreview: s.preview,
          challenge: s.challenge,
          ...over,
        },
        { webAuthnClient: s.auth },
      );

    it('signs exactly the previewed EIP-712 ExecutionGrant', async () => {
      const s = await setup();
      expect(s.preview.amount.display).toBe('12.5');
      expect(s.preview.token.symbol).toBe('AUSD');
      const signature = await sign(s);
      const signer = await recoverTypedDataAddress({
        ...grantTypedData(s.draft),
        signature,
      });
      expect(signer.toLowerCase()).toBe(s.record.signer);
    });

    it('blocks signing when the draft recipient differs from the confirmed preview', async () => {
      const s = await setup();
      const swapped = makeDraft({ recipient: `0x${'6'.repeat(40)}` });
      const before = s.auth.calls.get;
      await expect(
        sign(s, {
          draft: swapped,
          challenge: { ...s.challenge, draftDigest: swapped.digest },
        }),
      ).rejects.toMatchObject({ code: 'PREVIEW_MISMATCH' });
      expect(s.auth.calls.get).toBe(before);
    });

    it('blocks signing a draft whose fields no longer hash to its digest', async () => {
      const s = await setup();
      const tampered = {
        ...s.draft,
        grant: {
          ...s.draft.grant,
          recipient: `0x${'6'.repeat(40)}` as Address,
        },
      };
      await expect(sign(s, { draft: tampered })).rejects.toMatchObject({
        code: 'DIGEST_MISMATCH',
      });
    });

    it('blocks a challenge bound to another draft digest', async () => {
      const s = await setup();
      await expect(
        sign(s, { challenge: { ...s.challenge, draftDigest: word(5) } }),
      ).rejects.toMatchObject({ code: 'CHALLENGE_MISMATCH' });
    });
  });
});
