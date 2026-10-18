'use client';

import { useEffect, useState } from 'react';
import type { MeraCredential } from '@synq/identity/mera-browser';
import { clearCredential, loadCredential } from '../../lib/session';

export default function Home() {
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    setRecord(loadCredential());
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <>
      <h1>Your Synq passkey</h1>
      {record ? (
        <>
          <p className="lead">
            This browser holds passkey metadata only. Your account is re-derived
            from the passkey each time you approve; there is no recovery phrase
            to write down.
          </p>
          <dl className="preview">
            <dt>Principal</dt>
            <dd data-testid="principal-id">{record.principalId}</dd>
            <dt>Account</dt>
            <dd data-testid="principal-signer">{record.signer}</dd>
          </dl>
          <button
            onClick={() => {
              clearCredential();
              setRecord(null);
            }}
          >
            Forget on this device
          </button>
        </>
      ) : (
        <p className="lead">
          <a href="/enroll">Create a passkey account</a> or{' '}
          <a href="/recover">recover one</a>.
        </p>
      )}
    </>
  );
}
