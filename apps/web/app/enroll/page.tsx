'use client';

import { useState } from 'react';
import { enrollMeraPrincipal } from '@synq/identity/mera-browser';
import { IdentityChallengeSchema, PrincipalViewSchema } from '@synq/schemas';
import { api, describeError } from '../../lib/api';
import { relyingParty, saveCredential } from '../../lib/session';

export default function EnrollPage() {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function enroll() {
    setBusy(true);
    setResult(null);
    try {
      const rp = relyingParty();
      const enrolled = await enrollMeraPrincipal({
        rpId: rp.rpId,
        rpName: rp.rpName,
        user: { name, displayName: name },
        requestChallenge: ({ signer, credential }) =>
          api.post(
            '/v1/principals/enrollment-challenges',
            IdentityChallengeSchema,
            {
              kind: 'MERA_HUMAN',
              signer,
              credential: {
                credentialId: credential.credentialId,
                ...(credential.transports
                  ? { transports: [...credential.transports] }
                  : {}),
              },
              rpId: rp.rpId,
              origin: rp.origin,
            },
          ),
      });
      const principal = await api.post('/v1/principals', PrincipalViewSchema, {
        challengeId: enrolled.challenge.challengeId,
        signature: enrolled.signature,
      });
      saveCredential(enrolled.record);
      setResult({ ok: true, text: `Enrolled ${principal.principalId}` });
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Create a passkey account</h1>
      <p className="lead">
        Your device creates a passkey and derives your account from it. You
        prove you hold it by signing a one-time challenge. No recovery phrase is
        shown or stored.
      </p>
      <label htmlFor="name">Name on this passkey</label>
      <input
        id="name"
        data-testid="enroll-name"
        value={name}
        maxLength={64}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        data-testid="enroll-submit"
        disabled={busy || !name.trim()}
        onClick={enroll}
      >
        {busy ? 'Waiting for passkey…' : 'Create passkey'}
      </button>
      {result && (
        <div
          className={`status ${result.ok ? 'ok' : 'bad'}`}
          data-testid="enroll-result"
        >
          {result.text}
        </div>
      )}
    </>
  );
}
