'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ContextsSchema, LeadInviteRedeemResultSchema } from '@synq/contracts';
import { useWorkspaceTheme } from '../../../workspaces/theme-picker';
import { SignInPanel } from '../../../_hub/sign-in';
import { Notice } from '../../../_hub/ui';
import '../../../_hub/hub.css';
import { v3, V3Error } from '../../../../lib/v3';

const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
type Phase =
  | 'checking'
  | 'signedOut'
  | 'ready'
  | 'working'
  | 'done'
  | 'invalid'
  | 'retry';

export default function DealInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [leadId, setLeadId] = useState<string | null>(null);
  const [theme] = useWorkspaceTheme();
  const valid = TOKEN.test(token);
  const [phase, setPhase] = useState<Phase>(valid ? 'checking' : 'invalid');

  useEffect(() => {
    if (!valid) return;
    let active = true;
    v3.get('/v3/me/contexts', ContextsSchema)
      .then(() => active && setPhase('ready'))
      .catch((e: unknown) => {
        if (!active) return;
        setPhase(
          e instanceof V3Error && e.kind === 'AUTH' ? 'signedOut' : 'retry',
        );
      });
    return () => {
      active = false;
    };
  }, [valid]);

  function redeem() {
    setPhase('working');
    v3.post('/v3/lead-invites/redeem', LeadInviteRedeemResultSchema, { token })
      .then((result) => {
        // The link is single-use; move to the private conversation page so the
        // token leaves the address bar and history.
        setLeadId(result.leadId);
        setPhase('done');
        router.replace(`/lead/${encodeURIComponent(result.leadId)}`);
      })
      .catch((e: unknown) => {
        if (e instanceof V3Error && e.kind === 'AUTH') setPhase('signedOut');
        else if (
          e instanceof V3Error &&
          (e.kind === 'NETWORK' ||
            e.kind === 'RATE_LIMITED' ||
            e.kind === 'UNAVAILABLE')
        )
          setPhase('retry');
        else setPhase('invalid');
      });
  }

  return (
    <div className="hub-shell" data-theme={theme}>
      <div className="hub-center">
        <p className="hub-network">Synq · Arc testnet</p>
        <h1>A business would like to talk with you privately</h1>
        <p>
          You have been invited to a private conversation. The business can read
          this conversation. Nothing here moves money: no payment, deposit or
          agreement happens by opening this link or signing in.
        </p>
        {phase === 'checking' && <p role="status">Checking your session…</p>}
        {phase === 'signedOut' && (
          <SignInPanel
            title="Sign in with your wallet"
            intro="Sign in so the invitation can be tied to you. Signing in proves the wallet is yours and never approves a payment."
            onSignedIn={() => setPhase('ready')}
          />
        )}
        {(phase === 'ready' || phase === 'working') && (
          <section className="hub-panel" aria-labelledby="accept-h">
            <h2 id="accept-h">Accept the invitation</h2>
            <p>
              This link works once. Accepting starts a private conversation with
              the business.
            </p>
            <div>
              <button
                className="hub-btn hub-btn-primary"
                disabled={phase === 'working'}
                onClick={redeem}
              >
                {phase === 'working' ? 'Accepting…' : 'Accept and start'}
              </button>
            </div>
          </section>
        )}
        {phase === 'done' && (
          <Notice tone="positive" live>
            Done. Your private conversation is ready. The business can now reply
            to you where you came from.{' '}
            {leadId && (
              <Link href={`/lead/${encodeURIComponent(leadId)}`}>
                Open the conversation
              </Link>
            )}
          </Notice>
        )}
        {phase === 'invalid' && (
          <Notice tone="danger">
            This invitation is invalid, already used or expired. Ask the
            business for a new link.
          </Notice>
        )}
        {phase === 'retry' && (
          <Notice tone="warning">
            Could not complete this right now. Wait a moment and reload this
            page.
          </Notice>
        )}
      </div>
    </div>
  );
}
