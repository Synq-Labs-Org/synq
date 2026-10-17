'use client';

import { useState } from 'react';
import { describeError } from '../../lib/api';
import { signInWithWallet } from '../../lib/wallet-login';
import { Notice } from './ui';

/** Wallet sign-in shared with /workspaces. Signing in never approves money. */
export function SignInPanel(props: {
  title?: string;
  intro?: string;
  onSignedIn: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <section className="hub-panel hub-signin" aria-labelledby="signin-h">
      <h2 id="signin-h">{props.title ?? 'Sign in to Synq'}</h2>
      <p>
        {props.intro ??
          'Connect your wallet and sign a login message. Signing in proves the wallet is yours. It never approves a payment or moves money.'}
      </p>
      {error && <Notice tone="danger">{error}</Notice>}
      <button
        className="hub-btn hub-btn-primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          signInWithWallet()
            .then(() => props.onSignedIn())
            .catch((e: unknown) =>
              setError(e instanceof Error ? e.message : describeError(e)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? 'Waiting for wallet…' : 'Connect wallet and sign in'}
      </button>
    </section>
  );
}
