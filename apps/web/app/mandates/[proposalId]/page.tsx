'use client';

import { use, useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import {
  signMeraSafeTransaction,
  type MeraCredential,
} from '@synq/identity/mera-browser';
import { GroupViewSchema } from '@synq/schemas';
import { api, describeError } from '../../../lib/api';
import { loadCredential } from '../../../lib/session';

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/);
const ProposalSchema = z.looseObject({
  proposalId: Hex,
  groupId: z.string(),
  change: z.enum(['NEW', 'SUPERSEDE']),
  securitySensitive: z.boolean(),
  mandate: z.looseObject({
    mandateId: z.string(),
    version: z.number(),
    perActionCap: z.string(),
    cumulativeBudget: z.string(),
    validAfter: z.number(),
    validUntil: z.number(),
    inputAsset: z.looseObject({ symbol: z.string(), decimals: z.number() }),
    recipients: z.array(
      z.looseObject({ address: z.string(), purpose: z.string() }),
    ),
    bindings: z.array(
      z.looseObject({ action: z.string(), target: z.string() }),
    ),
  }),
  safeTx: z.looseObject({
    safe: Hex,
    chainId: z.number(),
    to: Hex,
    data: Hex,
    nonce: z.string(),
  }),
  safeTxHash: Hex,
  state: z.string(),
  required: z.number(),
  counted: z.array(z.looseObject({ memberId: z.string() })),
  executionTx: Hex.nullable(),
  reason: z.string().nullable(),
});
type Proposal = z.output<typeof ProposalSchema>;

const units = (amount: string, decimals: number) => {
  const digits = amount.padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
};

export default function MandateProposalPage({
  params,
}: {
  params: Promise<{ proposalId: string }>;
}) {
  const { proposalId } = use(params);
  const [record, setRecord] = useState<MeraCredential | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const p = await api.get(
      `/v1/mandate-proposals/${proposalId}`,
      ProposalSchema,
    );
    setProposal(p);
    return p;
  }, [proposalId]);

  useEffect(() => {
    const local = loadCredential();
    setRecord(local);
    load()
      .then(async (p) => {
        if (!local) return;
        const group = await api.get(`/v1/groups/${p.groupId}`, GroupViewSchema);
        const m = group.memberships.find(
          (x) => x.principalId === local.principalId && x.status === 'ACTIVE',
        );
        setMemberId(m?.memberId ?? null);
      })
      .catch((e) => setError(describeError(e)));
  }, [load]);

  async function approve() {
    if (!record || !proposal || !memberId) return;
    setBusy(true);
    setError(null);
    try {
      const signature = await signMeraSafeTransaction(record, {
        safe: proposal.safeTx.safe as `0x${string}`,
        chainId: proposal.safeTx.chainId,
        to: proposal.safeTx.to as `0x${string}`,
        data: proposal.safeTx.data as `0x${string}`,
        nonce: BigInt(proposal.safeTx.nonce),
      });
      setProposal(
        await api.post(
          `/v1/mandate-proposals/${proposalId}/approvals`,
          ProposalSchema,
          { memberId, signature },
        ),
      );
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const m = proposal?.mandate;
  const already =
    !!memberId && !!proposal?.counted.some((c) => c.memberId === memberId);
  return (
    <>
      <h1>Mandate proposal</h1>
      <p className="lead">
        A mandate gives the group agent bounded authority. It takes effect only
        after enough Safe owners approve this exact governance transaction with
        their passkeys and it is confirmed on chain. Chat messages never count.
      </p>
      {proposal && m && (
        <dl className="preview" data-testid="mandate-terms">
          <dt>Mandate</dt>
          <dd>
            {m.mandateId} v{m.version} (
            {proposal.change === 'NEW' ? 'new' : 'change'}
            {proposal.securitySensitive ? ', narrows existing limits' : ''})
          </dd>
          <dt>Per action</dt>
          <dd>
            {units(m.perActionCap, m.inputAsset.decimals)} {m.inputAsset.symbol}
          </dd>
          <dt>Total budget</dt>
          <dd>
            {units(m.cumulativeBudget, m.inputAsset.decimals)}{' '}
            {m.inputAsset.symbol}
          </dd>
          <dt>Recipients</dt>
          <dd>
            {m.recipients.map((r) => `${r.address} (${r.purpose})`).join(', ')}
          </dd>
          <dt>Allowed calls</dt>
          <dd>
            {m.bindings.map((b) => `${b.action} on ${b.target}`).join(', ')}
          </dd>
          <dt>Valid</dt>
          <dd>
            {new Date(m.validAfter * 1000).toISOString()} to{' '}
            {new Date(m.validUntil * 1000).toISOString()}
          </dd>
          <dt>Safe transaction</dt>
          <dd>
            {proposal.safeTxHash} (Safe {proposal.safeTx.safe}, nonce{' '}
            {proposal.safeTx.nonce}, chain {proposal.safeTx.chainId})
          </dd>
          <dt>Approvals</dt>
          <dd data-testid="mandate-count">
            {proposal.counted.length}/{proposal.required} verified owner
            approvals
          </dd>
          <dt>State</dt>
          <dd data-testid="mandate-state">
            {proposal.state}
            {proposal.reason ? ` (${proposal.reason})` : ''}
            {proposal.executionTx ? ` — tx ${proposal.executionTx}` : ''}
          </dd>
        </dl>
      )}
      {!record && (
        <p className="lead">
          <a href="/enroll">Create a passkey account</a> first.
        </p>
      )}
      {proposal && record && !memberId && (
        <p className="lead">
          This passkey is not an active member of the group.
        </p>
      )}
      {proposal &&
        memberId &&
        !already &&
        (proposal.state === 'PENDING' || proposal.state === 'READY') && (
          <>
            <label>
              <input
                type="checkbox"
                style={{ width: 'auto', marginRight: 8 }}
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              I checked the limits, recipients and validity
            </label>
            <button
              data-testid="mandate-approve"
              disabled={busy || !confirmed}
              onClick={approve}
            >
              {busy ? 'Waiting for passkey…' : `Approve as ${memberId}`}
            </button>
          </>
        )}
      {already && <div className="status">You approved this proposal.</div>}
      {error && <div className="status bad">{error}</div>}
    </>
  );
}
