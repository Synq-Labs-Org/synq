'use client';
import { useState } from 'react';
import { formatUnits, getAddress } from 'viem';
import { z } from 'zod';
import { WorkspaceDealViewSchema } from '@synq/workspaces/deal-contracts';
import { api, describeError } from '../../lib/api';

type Deal = z.output<typeof WorkspaceDealViewSchema>;
type Provider = {
  request(i: { method: string; params?: unknown[] }): Promise<unknown>;
};
const Tx = z.strictObject({
  step: z.string(),
  label: z.string(),
  to: z.string(),
  data: z.string(),
});
const Prepared = z
  .object({
    key: z.string(),
    state: z.string(),
    mandateTypedData: z.unknown().optional(),
    transactions: z.array(Tx).optional(),
  })
  .passthrough();
const Authorized = z
  .object({
    state: z.string(),
    approvalTypedData: z.unknown().optional(),
    transactions: z.array(Tx).optional(),
  })
  .passthrough();
const Attest = z
  .object({ nonce: z.string(), deadline: z.number(), typedData: z.unknown() })
  .passthrough();

function wallet(): Provider {
  const p = (window as unknown as { ethereum?: Provider }).ethereum;
  if (!p) throw new Error('Connect the wallet you signed this deal with.');
  return p;
}
async function account(p: Provider, expected: string) {
  const accounts = z
    .array(z.string())
    .min(1)
    .parse(await p.request({ method: 'eth_requestAccounts' }));
  const a = getAddress(accounts[0]!);
  if (a !== getAddress(expected))
    throw new Error(`Switch to your deal wallet ${expected}.`);
  await p.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: `0x${(5042002).toString(16)}` }],
  });
  return a;
}
const sign = async (p: Provider, from: string, typed: unknown) =>
  z
    .string()
    .regex(/^0x[0-9a-fA-F]{130}$/)
    .parse(
      await p.request({
        method: 'eth_signTypedData_v4',
        params: [from, JSON.stringify(typed)],
      }),
    );
async function send(p: Provider, from: string, tx: z.output<typeof Tx>) {
  const hash = z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .parse(
      await p.request({
        method: 'eth_sendTransaction',
        params: [{ from, to: tx.to, data: tx.data, value: '0x0' }],
      }),
    );
  for (let i = 0; i < 90; i++) {
    const r = (await p.request({
      method: 'eth_getTransactionReceipt',
      params: [hash],
    })) as { status?: string } | null;
    if (r?.status === '0x1') return hash;
    if (r?.status === '0x0') throw new Error(`${tx.label} reverted.`);
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`${tx.label} is still pending; submit again shortly.`);
}

/**
 * Party actions for one deal. Every money movement is a transaction this
 * user's own wallet sends after signing a bounded mandate and an approval of
 * the exact escrow call; Synq proves it on chain before recording it.
 */
export function DealEscrowActions({
  workspaceId,
  principalId,
  deal,
  onChange,
}: {
  workspaceId: string;
  principalId: string;
  deal: Deal;
  onChange: (d: Deal) => void;
}) {
  const me = deal.parties.find((p) => p.principalId === principalId);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState<string | null>(null),
    [error, setError] = useState<string | null>(null),
    [evidence, setEvidence] = useState(''),
    [evidenceUrl, setEvidenceUrl] = useState('');
  const ws = `/v2/workspaces/${encodeURIComponent(workspaceId)}`;
  if (!me) return null;
  async function run(label: string, fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(label);
    try {
      await fn();
      setStatus(null);
    } catch (e) {
      setError(describeError(e));
      setStatus(null);
    } finally {
      setBusy(false);
    }
  }
  async function escrow(
    op: 'FUND' | 'RELEASE' | 'REFUND' | 'DISPUTE',
    milestone: number | null,
  ) {
    const p = wallet(),
      from = await account(p, me!.wallet);
    const prepared = await api.post(
      `${ws}/deals/${deal.id}/escrow/prepare`,
      Prepared,
      { op, milestone },
    );
    let txs = prepared.transactions;
    if (!txs) {
      setStatus('Sign the spending limit for this exact escrow call…');
      const mandateSignature = await sign(p, from, prepared.mandateTypedData);
      let auth = await api.post(`${ws}/escrow/authorize`, Authorized, {
        key: prepared.key,
        mandateSignature,
      });
      if (auth.approvalTypedData) {
        setStatus('Approve this exact call…');
        const approvalSignature = await sign(p, from, auth.approvalTypedData);
        auth = await api.post(`${ws}/escrow/authorize`, Authorized, {
          key: prepared.key,
          mandateSignature,
          approvalSignature,
        });
      }
      txs = auth.transactions;
    }
    if (!txs?.length) throw new Error('The escrow call was not granted.');
    const hashes: Record<string, string> = {};
    for (const tx of txs) {
      setStatus(`${tx.label}: confirm in your wallet…`);
      hashes[tx.step] = await send(p, from, tx);
    }
    setStatus('Proving the transactions on chain…');
    onChange(
      await api.post(`${ws}/escrow/submit`, WorkspaceDealViewSchema, {
        key: prepared.key,
        hashes,
      }),
    );
  }
  async function attest(
    milestone: number,
    kind:
      | 'DELIVERED'
      | 'ACCEPT_RELEASE'
      | 'DISPUTE'
      | 'ARBITER_RELEASE'
      | 'ARBITER_REFUND'
      | 'CANCEL_REFUND',
    claim: unknown = null,
  ) {
    const p = wallet(),
      from = await account(p, me!.wallet);
    const req = await api.post(
      `${ws}/deals/${deal.id}/attestations/prepare`,
      Attest,
      { milestone, kind, evidence: claim },
    );
    const signature = await sign(p, from, req.typedData);
    const d = await api.post(
      `${ws}/deals/${deal.id}/attestations`,
      WorkspaceDealViewSchema,
      {
        milestone,
        kind,
        evidence: claim,
        nonce: req.nonce,
        deadline: req.deadline,
        signature,
      },
    );
    onChange(d);
    return d;
  }
  const fileClaim = () => {
    if (!/^[0-9a-f]{64}$/.test(evidence.trim()))
      throw new Error('Paste the SHA-256 of the delivered file (64 hex).');
    if (!/^https:\/\/\S+$/.test(evidenceUrl.trim()))
      throw new Error(
        'Give the https link where the client can fetch the file.',
      );
    return {
      type: 'FILE_SHA256',
      url: evidenceUrl.trim(),
      repo: null,
      commitSha: null,
      prNumber: null,
      sha256: evidence.trim(),
    };
  };
  const role = me.role;
  return (
    <section>
      <p>
        You are the {role.toLowerCase()} · escrow{' '}
        {deal.escrow ? `deal ${deal.escrow.escrowDealId}` : 'not funded'}
        {deal.dispute
          ? ` · dispute raised by ${deal.dispute.raisedBy.toLowerCase()}`
          : ''}
      </p>
      {status && <p role="status">{status}</p>}
      {error && <p role="alert">{error}</p>}
      {role === 'CLIENT' && deal.status === 'ACCEPTED' && (
        <button
          disabled={busy}
          onClick={() =>
            void run('Funding the escrow…', () => escrow('FUND', null))
          }
        >
          Fund escrow with {formatUnits(BigInt(deal.total), 6)} USDC from my
          wallet
        </button>
      )}
      {deal.escrow &&
        deal.milestones.map((m) => (
          <div key={m.index}>
            <p>
              Milestone {m.index + 1}: {m.title} ·{' '}
              {formatUnits(BigInt(m.amount), 6)} USDC · {m.status}
            </p>
            {role === 'FREELANCER' && m.status === 'FUNDED' && (
              <>
                <label>
                  Link to the delivered file
                  <input
                    value={evidenceUrl}
                    onChange={(e) => setEvidenceUrl(e.target.value)}
                  />
                </label>
                <label>
                  SHA-256 of the delivered file
                  <input
                    value={evidence}
                    onChange={(e) => setEvidence(e.target.value)}
                  />
                </label>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Signing delivery…', async () => {
                      await attest(m.index, 'DELIVERED', fileClaim());
                    })
                  }
                >
                  Mark delivered
                </button>
              </>
            )}
            {role === 'CLIENT' && m.status === 'DELIVERED' && (
              <button
                disabled={busy}
                onClick={() =>
                  void run('Accepting and releasing…', async () => {
                    await attest(m.index, 'ACCEPT_RELEASE');
                    await escrow('RELEASE', m.index);
                  })
                }
              >
                Accept and release payment
              </button>
            )}
            {role === 'CLIENT' && m.status === 'ACCEPTED' && (
              <button
                disabled={busy}
                onClick={() =>
                  void run('Releasing…', () => escrow('RELEASE', m.index))
                }
              >
                Release payment
              </button>
            )}
            {(role === 'CLIENT' || role === 'FREELANCER') &&
              ['FUNDED', 'DELIVERED', 'ACCEPTED'].includes(m.status) &&
              !deal.dispute && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Raising the dispute…', async () => {
                      await attest(m.index, 'DISPUTE');
                      await escrow('DISPUTE', null);
                    })
                  }
                >
                  Raise dispute
                </button>
              )}
            {role === 'ARBITER' && m.status === 'DISPUTED' && (
              <>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Arbiter release…', async () => {
                      await attest(m.index, 'ARBITER_RELEASE');
                      await escrow('RELEASE', m.index);
                    })
                  }
                >
                  Release to the payee
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Arbiter refund…', async () => {
                      await attest(m.index, 'ARBITER_REFUND');
                      await escrow('REFUND', m.index);
                    })
                  }
                >
                  Refund the client
                </button>
              </>
            )}
            {role === 'FREELANCER' &&
              ['FUNDED', 'DELIVERED', 'DISPUTED'].includes(m.status) && (
                <button
                  disabled={busy}
                  onClick={() =>
                    void run('Giving the milestone back…', async () => {
                      await attest(m.index, 'CANCEL_REFUND');
                      await escrow('REFUND', m.index);
                    })
                  }
                >
                  Give this milestone back to the client
                </button>
              )}
            {m.status === 'REFUNDING' && role !== 'CLIENT' && (
              <button
                disabled={busy}
                onClick={() =>
                  void run('Refunding…', () => escrow('REFUND', m.index))
                }
              >
                Send the authorized refund
              </button>
            )}
          </div>
        ))}
    </section>
  );
}
