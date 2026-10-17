'use client';

import Link from 'next/link';
import { ApprovalPageSchema } from '@synq/contracts';
import { formatMoney, shortDate } from '../../../lib/money';
import { useLiveRefresh, usePaged } from '../../_hub/hooks';
import { Empty, Notice, PageHeader, humanize } from '../../_hub/ui';

export default function ApprovalsPage() {
  const list = usePaged('/v3/approvals', '', ApprovalPageSchema);
  useLiveRefresh(list.reload, {
    types: ['APPROVAL_CHANGED'],
    anyContext: true,
  });
  return (
    <>
      <PageHeader
        title="Approvals"
        subtitle="Requests waiting for your wallet signature, across all workspaces."
      />
      <Notice tone="info">
        Signing in never approves money. Only the signatures you make on this
        page do, and you see exactly what you sign first.
      </Notice>
      {list.error && <Notice tone="danger">{list.error}</Notice>}
      {list.loading && !list.items.length && <p role="status">Loading…</p>}
      {!list.loading && !list.items.length && !list.error && (
        <Empty>Nothing is waiting for your signature.</Empty>
      )}
      {list.items.length > 0 && (
        <div className="hub-panel hub-table-wrap">
          <table className="hub-table">
            <caption className="hub-sr">
              Requests waiting for your signature
            </caption>
            <thead>
              <tr>
                <th scope="col">Request</th>
                <th scope="col">Workspace</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col" className="num">
                  Signatures
                </th>
                <th scope="col">Expires</th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((a) => (
                <tr key={a.requestId}>
                  <th scope="row">
                    <Link
                      href={`/approvals/${encodeURIComponent(a.requestId)}`}
                    >
                      {a.summary}
                    </Link>
                    <br />
                    <small className="hub-sub">
                      {humanize(a.purpose)}
                      {a.recipientHint ? ` to ${a.recipientHint}` : ''}
                    </small>
                  </th>
                  <td>{a.workspaceName}</td>
                  <td className="num">
                    {a.amount ? formatMoney(a.amount) : '—'}
                  </td>
                  <td className="num">
                    {a.approvals} of {a.threshold}
                  </td>
                  <td>{a.expiresAt ? shortDate(a.expiresAt) : 'No expiry'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.hasMore && (
        <div>
          <button className="hub-btn" onClick={() => void list.loadMore()}>
            Load more
          </button>
        </div>
      )}
    </>
  );
}
