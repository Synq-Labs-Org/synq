'use client';

import { use, useCallback, useEffect, useState } from 'react';
import {
  approveGrantWithMera,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { grantPreview } from '@synq/identity/grant';
import {
  GrantApprovalChallengeSchema,
  GroupViewSchema,
  PendingIntentViewSchema,
  PublicQuorumViewSchema,
  VerifiedApprovalSchema,
  type GrantPreview,
  type PendingIntentView,
  type PublicQuorumView,
} from '@synq/schemas';
import { api, describeError } from '../../../lib/api';
import { loadCredential } from '../../../lib/session';

const when = (seconds: string) => {
  const n = Number(seconds);
  return n > 8.64e12
    ? `${seconds} (unix)`
    : `${new Date(n * 1000).toISOString()}`;
};

export default function IntentPage({
  params,
}: {
  params: Promise<{ intentId: string }>;
}) {
  const { intentId } = use(params);
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [intent, setIntent] = useState<PendingIntentView | null>(null);
  const [preview, setPreview] = useState<GrantPreview | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [quorum, setQuorum] = useState<PublicQuorumView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(
    null,
  );

  const refresh = useCallback(async (digest: string) => {
    setQuorum(
      await api.get(`/v1/approvals/${digest}/quorum`, PublicQuorumViewSchema),
    );
  }, []);

  useEffect(() => {
    const local = loadCredential();
    setRecord(local);
    (async () => {
      const view = await api.get(
        `/v1/intents/${intentId}`,
        PendingIntentViewSchema,
      );
      setIntent(view);
      setPreview(grantPreview(view.draft, view.asset));
      const group = await api.get(
        `/v1/groups/${view.draft.groupId}`,
        GroupViewSchema,
      );
      const mine = group.memberships.find(
        (m) => m.status === 'ACTIVE' && m.principalId === local?.principalId,
      );
      setMemberId(mine?.memberId ?? null);
      await refresh(view.draft.digest);
    })().catch((e: unknown) =>
      setResult({ ok: false, text: describeError(e) }),
    );
  }, [intentId, refresh]);

  async function approve() {
    if (!record || !intent || !preview || !memberId) return;
    setBusy(true);
    setResult(null);
    try {
      const signed = await approveGrantWithMera({
        record,
        memberId,
        draft: intent.draft,
        asset: intent.asset,
        confirmedPreview: preview,
        requestChallenge: (request) =>
          api.post(
            '/v1/approvals/challenges',
            GrantApprovalChallengeSchema,
            request,
          ),
      });
      const approval = await api.post('/v1/approvals', VerifiedApprovalSchema, {
        challengeId: signed.challenge.challengeId,
        grantSignature: signed.grantSignature,
        attestationSignature: signed.attestationSignature,
      });
      setResult({ ok: true, text: `Approved by ${approval.signer}` });
      await refresh(intent.draft.digest);
    } catch (error) {
      setResult({ ok: false, text: describeError(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Approve transfer</h1>
      <p className="lead">
        Check every field. Your passkey signs exactly these values; if anything
        differs, signing is blocked.
      </p>
      {preview && (
        <dl className="preview" data-testid="grant-preview">
          <dt>Send</dt>
          <dd data-testid="preview-amount">
            {preview.amount.display} {preview.token.symbol}
          </dd>
          <dt>To</dt>
          <dd data-testid="preview-recipient">{preview.recipient}</dd>
          <dt>From group account</dt>
          <dd>{preview.account}</dd>
          <dt>Token contract</dt>
          <dd data-testid="preview-token">{preview.token.address}</dd>
          <dt>Network</dt>
          <dd>Chain {preview.chainId}</dd>
          <dt>Valid until</dt>
          <dd data-testid="preview-expiry">{when(preview.validUntil)}</dd>
          <dt>Mandate version</dt>
          <dd>{preview.mandateVersion}</dd>
          <dt>Executor</dt>
          <dd data-testid="preview-executor">{preview.executor}</dd>
          <dt>Execution module</dt>
          <dd data-testid="preview-module">{preview.verifyingContract}</dd>
          <dt>Grant nonce</dt>
          <dd>{preview.nonce}</dd>
          <dt>Calldata hash</dt>
          <dd>
            <code>{preview.calldataHash}</code>
          </dd>
          <dt>Digest</dt>
          <dd>
            <code>{preview.digest}</code>
          </dd>
        </dl>
      )}
      {quorum && (
        <div
          className={`status ${quorum.satisfied ? 'ok' : ''}`}
          data-testid="quorum"
        >
          {quorum.counted.length} of {quorum.required} approvals
          {quorum.satisfied ? ' — quorum reached' : ''}
        </div>
      )}
      {intent?.status === 'INVALIDATED' && (
        <div className="status bad" data-testid="intent-invalidated">
          This draft was invalidated by a membership change. A new draft is
          required before anyone can approve.
        </div>
      )}
      {preview && record && memberId && intent?.status !== 'INVALIDATED' && (
        <>
          <label>
            <input
              type="checkbox"
              data-testid="confirm-preview"
              style={{ width: 'auto', marginRight: 8 }}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I checked the recipient, amount, token and expiry
          </label>
          <button
            data-testid="approve-submit"
            disabled={busy || !confirmed}
            onClick={approve}
          >
            {busy ? 'Waiting for passkey…' : `Approve as ${memberId}`}
          </button>
        </>
      )}
      {preview && record && !memberId && (
        <p className="lead">
          This passkey is not an active member of the group.
        </p>
      )}
      {result && (
        <div
          className={`status ${result.ok ? 'ok' : 'bad'}`}
          data-testid="approve-result"
        >
          {result.text}
        </div>
      )}
    </>
  );
}
