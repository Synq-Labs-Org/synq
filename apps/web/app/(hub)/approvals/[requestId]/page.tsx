'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { SignatureResultSchema, SigningRequestSchema } from '@synq/contracts';
import type { z } from 'zod';
import { signSteps } from '../../../../lib/approval-signing';
import { formatMoney, shortDate } from '../../../../lib/money';
import { describeV3, seg, v3, V3Error } from '../../../../lib/v3';
import { useLiveRefresh, useV3 } from '../../../_hub/hooks';
import {
  Async,
  NetworkNote,
  Notice,
  PageHeader,
  Panel,
  humanize,
} from '../../../_hub/ui';

type Result = z.output<typeof SignatureResultSchema>;

export default function ApprovalDetailPage() {
  const { requestId } = useParams<{ requestId: string }>();
  const state = useV3(`/v3/approvals/${seg(requestId)}`, SigningRequestSchema);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  useLiveRefresh(state.reload, {
    types: ['APPROVAL_CHANGED'],
    anyContext: true,
  });

  return (
    <>
      <p>
        <Link href="/approvals">← Approvals</Link>
      </p>
      <Async state={state}>
        {(r) => (
          <>
            <PageHeader
              title={r.request.summary}
              subtitle={`${r.request.workspaceName} · ${humanize(r.request.purpose)}`}
            />
            <NetworkNote />
            <Panel title="What you would sign" id="details">
              <dl className="hub-defs">
                <div>
                  <dt>Amount</dt>
                  <dd>
                    {r.request.amount
                      ? formatMoney(r.request.amount)
                      : 'No amount: this changes settings or authority.'}
                  </dd>
                </div>
                <div>
                  <dt>Recipient</dt>
                  <dd>{r.request.recipientHint ?? 'None'}</dd>
                </div>
                <div>
                  <dt>Must be signed by</dt>
                  <dd>{r.signer}</dd>
                </div>
                <div>
                  <dt>Enforced by</dt>
                  <dd>{r.enforcedBy}</dd>
                </div>
                <div>
                  <dt>Signatures so far</dt>
                  <dd>
                    {r.request.approvals} of {r.request.threshold}
                  </dd>
                </div>
                <div>
                  <dt>Expires</dt>
                  <dd>
                    {r.request.expiresAt
                      ? shortDate(r.request.expiresAt)
                      : 'No expiry'}
                  </dd>
                </div>
              </dl>
              <h3>Signatures your wallet will ask for, in order</h3>
              <ol className="hub-steps">
                {r.steps.map((s, i) => (
                  <li key={i}>{s.label}</li>
                ))}
              </ol>
              <Notice tone="info">
                Signing in to Synq never approves money. Only these signatures
                do. Your wallet shows the exact data; check it matches what you
                see here before approving it.
              </Notice>
              {error && <Notice tone="danger">{error}</Notice>}
              {result && (
                <Notice
                  tone={result.status === 'REJECTED' ? 'danger' : 'positive'}
                  live
                >
                  {result.status === 'RECORDED' &&
                    `Signature recorded. ${result.approvals} of ${result.threshold} signatures.`}
                  {result.status === 'READY' &&
                    `Signature recorded. ${result.approvals} of ${result.threshold}: ready to submit. Nothing has moved yet.`}
                  {result.status === 'SUBMITTED' &&
                    'Submitted to the chain. It is not final until the receipt shows finality.'}
                  {result.status === 'REJECTED' &&
                    'The server rejected this signature. Nothing was approved.'}
                </Notice>
              )}
              <div>
                <button
                  className="hub-btn hub-btn-primary"
                  disabled={busy || result?.status === 'RECORDED'}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    setResult(null);
                    signSteps(r)
                      .then((signatures) =>
                        v3.post(
                          `/v3/approvals/${seg(requestId)}/signature`,
                          SignatureResultSchema,
                          { signatures },
                        ),
                      )
                      .then((res) => {
                        setResult(res);
                        void state.reload();
                      })
                      .catch((e: unknown) => {
                        setError(
                          e instanceof V3Error ? describeV3(e) : errorText(e),
                        );
                        if (e instanceof V3Error && e.kind === 'CONFLICT')
                          void state.reload();
                      })
                      .finally(() => setBusy(false));
                  }}
                >
                  {busy
                    ? 'Waiting for wallet…'
                    : `Sign ${r.steps.length === 1 ? 'with my wallet' : `${r.steps.length} messages with my wallet`}`}
                </button>
              </div>
            </Panel>
          </>
        )}
      </Async>
    </>
  );
}

function errorText(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && e.code === 4001)
    return 'You declined in your wallet. Nothing was signed.';
  return e instanceof Error ? e.message : 'Signing failed.';
}
