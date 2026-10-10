'use client';

import { useEffect, useState } from 'react';
import { z } from 'zod';
import {
  signMeraSendConfirmation,
  signMeraSendAccess,
  SendAccessChallengeSchema,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { api, describeError } from '../../lib/api';
import { loadCredential } from '../../lib/session';

const AccessSessionSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.number(),
  memberId: z.string(),
  principalId: z.string(),
  groupId: z.string(),
  scope: z.literal('SEND_READ_PREVIEW'),
});
const Hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const RecipientSchema = z.looseObject({
  recipientId: z.string(),
  kind: z.enum(['MEMBER', 'CONTACT']),
  label: z.string(),
  address: Hex,
  sendable: z.boolean(),
});
const DirectorySchema = z.looseObject({
  groupId: z.string(),
  asset: z.looseObject({ symbol: z.string(), decimals: z.number() }),
  recipients: z.array(RecipientSchema),
});
const PreviewSchema = z.looseObject({
  previewId: Hex,
  digest: Hex,
  groupId: z.string(),
  account: Hex,
  recipient: RecipientSchema,
  asset: z.looseObject({
    address: Hex,
    symbol: z.string(),
    decimals: z.number(),
    canonicalAssetId: z.string(),
  }),
  amount: z.string(),
  amountDecimal: z.string(),
  chainId: z.number(),
  expiresAt: z.number(),
  policy: z.looseObject({
    tier: z.string(),
    kernelTier: z.string(),
    requiredApprovals: z.number(),
  }),
  treasury: z.looseObject({ free: z.string(), freeAfter: z.string() }),
  guard: z.looseObject({ status: z.string(), reasons: z.array(z.string()) }),
});
type Preview = z.output<typeof PreviewSchema>;
const SendSchema = z.looseObject({
  sendId: Hex,
  state: z.string(),
  intentHash: z.string().nullable(),
  kernelCode: z.string().nullable(),
  receipt: z
    .looseObject({
      transactionHash: Hex,
      explorer: z.string().nullable(),
      recipientDelta: z.string(),
      latencyMs: z.looseObject({
        submitToConfirmed: z.number(),
        submitToIndexed: z.number(),
      }),
    })
    .nullable(),
});
type Send = z.output<typeof SendSchema>;

const units = (amount: string, decimals: number) => {
  const digits = amount.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
};

export default function SendPage() {
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [access, setAccess] = useState<z.output<
    typeof AccessSessionSchema
  > | null>(null);
  const [groupId, setGroupId] = useState('');
  const [memberId, setMemberId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<z.output<
    typeof DirectorySchema
  > | null>(null);
  const [recipientId, setRecipientId] = useState('');
  const [amount, setAmount] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [send, setSend] = useState<Send | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setRecord(loadCredential()), []);
  useEffect(() => {
    if (!send || send.state === 'INDEXED' || send.state === 'REJECTED') return;
    const t = setInterval(() => {
      api
        .get(`/v1/send/${send.sendId}`, SendSchema, access?.token)
        .then(setSend)
        .catch(() => undefined);
    }, 3000);
    return () => clearInterval(t);
  }, [send, access]);

  async function load() {
    setError(null);
    try {
      if (!record) throw new Error('Create or recover your passkey first.');
      const challenge = await api.post(
        '/v1/send/access/challenges',
        SendAccessChallengeSchema,
        { groupId, principalId: record.principalId },
      );
      const signature = await signMeraSendAccess(record, challenge);
      const session = await api.post('/v1/send/access', AccessSessionSchema, {
        challengeId: challenge.challengeId,
        signature,
      });
      setAccess(session);
      setMemberId(session.memberId);
      const d = await api.get(
        `/v1/send/${groupId}/recipients`,
        DirectorySchema,
        session.token,
      );
      setDirectory(d);
    } catch (e) {
      setError(describeError(e));
    }
  }
  async function makePreview() {
    setError(null);
    setPreview(null);
    setConfirmed(false);
    try {
      setPreview(
        await api.post(
          '/v1/send/previews',
          PreviewSchema,
          {
            groupId,
            recipientId,
            amount,
          },
          access?.token,
        ),
      );
    } catch (e) {
      setError(describeError(e));
    }
  }
  async function confirm() {
    if (!preview || !record || !memberId) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await signMeraSendConfirmation(record, {
        previewId: preview.previewId as `0x${string}`,
        digest: preview.digest as `0x${string}`,
        groupId: preview.groupId,
        memberId,
        recipient: preview.recipient.address as `0x${string}`,
        token: preview.asset.address as `0x${string}`,
        amount: BigInt(preview.amount),
        chainId: preview.chainId,
        expiresAt: preview.expiresAt,
      });
      setSend(
        await api.post('/v1/send', SendSchema, {
          previewId: preview.previewId,
          digest: preview.digest,
          recipientAddress: preview.recipient.address,
          amount: preview.amount,
          chainId: preview.chainId,
          sender: { memberId, signature },
        }),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Synq Send</h1>
      <p className="lead">
        Send AUSD from your group to a member or saved contact. You confirm the
        exact recipient, amount, chain and expiry with your passkey; the group
        policy decides how many approvals the transfer needs.
      </p>
      {!record && (
        <p className="lead">
          <a href="/enroll">Create a passkey account</a> first.
        </p>
      )}
      <label>
        Group id
        <input
          data-testid="send-group"
          value={groupId}
          onChange={(e) => {
            setGroupId(e.target.value.trim());
            setAccess(null);
            setDirectory(null);
            setPreview(null);
            setSend(null);
            setMemberId(null);
          }}
          placeholder="0x…"
        />
      </label>
      <button onClick={load} disabled={!groupId || !record}>
        Load recipients
      </button>
      {directory && (
        <>
          <label>
            Recipient
            <select
              data-testid="send-recipient"
              value={recipientId}
              onChange={(e) => setRecipientId(e.target.value)}
            >
              <option value="">Choose…</option>
              {directory.recipients.map((r) => (
                <option
                  key={r.recipientId}
                  value={r.recipientId}
                  disabled={!r.sendable}
                >
                  {r.label} ({r.kind.toLowerCase()}) {r.address}
                  {r.sendable ? '' : ' — not on the group mandate'}
                </option>
              ))}
            </select>
          </label>
          <label>
            Amount ({directory.asset.symbol})
            <input
              data-testid="send-amount"
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.trim())}
            />
          </label>
          <button
            onClick={makePreview}
            disabled={!recipientId || !amount || !access}
            data-testid="send-preview"
          >
            Preview
          </button>
        </>
      )}
      {preview && (
        <dl className="preview" data-testid="send-preview-details">
          <dt>Send</dt>
          <dd>
            {preview.amountDecimal} {preview.asset.symbol} ({preview.amount}{' '}
            base units)
          </dd>
          <dt>To</dt>
          <dd data-testid="send-preview-recipient">
            {preview.recipient.label} — {preview.recipient.address}
          </dd>
          <dt>Token</dt>
          <dd>{preview.asset.canonicalAssetId}</dd>
          <dt>Network</dt>
          <dd>Chain {preview.chainId}</dd>
          <dt>Expires</dt>
          <dd>{new Date(preview.expiresAt * 1000).toISOString()}</dd>
          <dt>Approval</dt>
          <dd>
            {preview.policy.tier} ({preview.policy.requiredApprovals} passkey
            approvals)
          </dd>
          <dt>Free AUSD after</dt>
          <dd>{units(preview.treasury.freeAfter, preview.asset.decimals)}</dd>
          <dt>AUSD controls</dt>
          <dd>
            {preview.guard.status}
            {preview.guard.reasons.length
              ? ` (${preview.guard.reasons.join(', ')})`
              : ''}
          </dd>
        </dl>
      )}
      {preview && record && memberId && !send && (
        <>
          <label>
            <input
              type="checkbox"
              style={{ width: 'auto', marginRight: 8 }}
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I checked the recipient, amount, chain and expiry
          </label>
          <button
            data-testid="send-confirm"
            disabled={busy || !confirmed}
            onClick={confirm}
          >
            {busy ? 'Waiting for passkey…' : `Confirm as ${memberId}`}
          </button>
        </>
      )}
      {preview && record && !memberId && (
        <p className="lead">This passkey is not an active member.</p>
      )}
      {send && (
        <div className="status" data-testid="send-status">
          {send.state}
          {send.kernelCode ? ` (${send.kernelCode})` : ''}
          {send.intentHash && send.state === 'PENDING_APPROVAL' && (
            <>
              {' '}
              — <a href={`/intents/${send.intentHash}`}>review and approve</a>
            </>
          )}
          {send.receipt && (
            <>
              {' '}
              — tx {send.receipt.transactionHash}, recipient +
              {units(send.receipt.recipientDelta, preview?.asset.decimals ?? 6)}
              , confirmed in {send.receipt.latencyMs.submitToConfirmed} ms
              {send.state === 'INDEXED'
                ? `, indexed in ${send.receipt.latencyMs.submitToIndexed} ms`
                : ''}
            </>
          )}
        </div>
      )}
      {error && <div className="status bad">{error}</div>}
    </>
  );
}
