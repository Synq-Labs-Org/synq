'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  signMeraSendAccess,
  SendAccessChallengeSchema,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { CardResolutionSchema, type CardResolution } from '@synq/schemas';
import { ApiFailure, api, describeError } from '../../lib/api';
import { loadCredential } from '../../lib/session';
import { CardView } from './card-view';

const AccessSessionSchema = z.looseObject({ token: z.string() });
const LinkSchema = z.strictObject({
  p: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
  g: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  n: z.string().min(1).max(200),
});
const FAILURES: Record<string, string> = {
  LINK_EXPIRED:
    'This card link has expired. Send /status in your group chat for a fresh one.',
  LINK_INVALID: 'This link was not issued for this group. Nothing was opened.',
  LINK_MALFORMED: 'This link is incomplete.',
  NOT_A_MEMBER: 'Your passkey is not an active member of this group.',
  PROPOSAL_NOT_FOUND: 'This proposal is not open in this group.',
  MEMBER_ACCESS_REQUIRED: 'Sign in with your passkey first.',
};

/**
 * Landing page for a tapped card (Telegram, iMessage, native extension).
 * It authenticates the member, resolves the group-bound link on the server,
 * shows the canonical proposal, and hands off to the existing passkey review
 * page. Opening this page approves nothing.
 */
export default function ApproveCardPage() {
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [link, setLink] = useState<z.output<typeof LinkSchema> | null>(null);
  const [resolved, setResolved] = useState<CardResolution | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecord(loadCredential());
    const q = new URLSearchParams(window.location.search);
    // Only p, g and n are read; any embedded card preview is ignored.
    const parsed = LinkSchema.safeParse({
      p: q.get('p'),
      g: q.get('g'),
      n: q.get('n'),
    });
    if (parsed.success) setLink(parsed.data);
    else setError(FAILURES.LINK_MALFORMED!);
  }, []);

  async function open() {
    if (!link || !record) return;
    setBusy(true);
    setError(null);
    try {
      const challenge = await api.post(
        '/v1/send/access/challenges',
        SendAccessChallengeSchema,
        { groupId: link.g.toLowerCase(), principalId: record.principalId },
      );
      const signature = await signMeraSendAccess(record, challenge);
      const session = await api.post('/v1/send/access', AccessSessionSchema, {
        challengeId: challenge.challengeId,
        signature,
      });
      setResolved(
        await api.post(
          '/v1/cards/resolve',
          CardResolutionSchema,
          { proposalId: link.p, groupId: link.g, nonce: link.n },
          session.token,
        ),
      );
    } catch (e) {
      setError(
        e instanceof ApiFailure && FAILURES[e.code]
          ? FAILURES[e.code]!
          : describeError(e),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Review a group proposal</h1>
      <p className="lead">
        Tapping a card only opens this page. Nothing is approved until you
        review the exact details and sign with your passkey.
      </p>
      {!record && (
        <p className="lead">
          <a href="/enroll">Create</a> or <a href="/recover">recover</a> your
          passkey account on this device first.
        </p>
      )}
      {link && !resolved && (
        <button
          data-testid="card-open"
          disabled={busy || !record}
          onClick={open}
        >
          {busy ? 'Waiting for passkey…' : 'Sign in with passkey to view'}
        </button>
      )}
      {resolved && (
        <>
          <CardView card={resolved.card} showActions={false} />
          {resolved.status === 'OK' ? (
            <p>
              <a
                data-testid="card-continue"
                className="button"
                href={resolved.reviewPath}
              >
                Continue to passkey approval
              </a>{' '}
              Signed in as {resolved.memberId}. To decline, do not sign.
            </p>
          ) : (
            <div className="status">
              This proposal is no longer awaiting approval (
              {resolved.card.status}).
            </div>
          )}
        </>
      )}
      {error && <div className="status bad">{error}</div>}
    </>
  );
}
