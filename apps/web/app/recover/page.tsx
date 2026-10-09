'use client';

import { useState } from 'react';
import { recoverMeraPrincipal } from '@synq/identity/mera-browser';
import { IdentityChallengeSchema, RecoveryResultSchema } from '@synq/schemas';
import { api, describeError } from '../../lib/api';
import { relyingParty, saveCredential } from '../../lib/session';

export default function RecoverPage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  async function recover() {
    setBusy(true);
    setResult(null);
    try {
      const rp = relyingParty();
      const recovered = await recoverMeraPrincipal({
        rpId: rp.rpId,
        requestChallenge: ({ signer, credentialId }) =>
          api.post(
            '/v1/principals/recovery-challenges',
            IdentityChallengeSchema,
            {
              signer,
              credentialId,
              rpId: rp.rpId,
              origin: rp.origin,
            },
          ),
      });
      const session = await api.post(
        '/v1/principals/recover',
        RecoveryResultSchema,
        {
          challengeId: recovered.challenge.challengeId,
          signature: recovered.signature,
        },
      );
      saveCredential({
        ...recovered.record,
        credential: session.principal.credential ?? recovered.record.credential,
      });
      setResult({
        ok: true,
        text: `Recovered ${session.principal.principalId} with ${session.memberships.length} active membership(s)`,
      });
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Recover with your passkey</h1>
      <p className="lead">
        Choose the passkey you enrolled. The same passkey re-derives the same
        account; any other passkey derives a different account and is rejected.
      </p>
      <button data-testid="recover-submit" disabled={busy} onClick={recover}>
        {busy ? 'Waiting for passkey…' : 'Recover'}
      </button>
      {result && (
        <div
          className={`status ${result.ok ? 'ok' : 'bad'}`}
          data-testid="recover-result"
        >
          {result.text}
        </div>
      )}
    </>
  );
}
