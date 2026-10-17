'use client';

import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AgentRunDetailSchema, AgentRunPageSchema } from '@synq/contracts';
import { formatMoney, safeHttpsUrl, shortDate } from '../../../../../lib/money';
import { seg } from '../../../../../lib/v3';
import { useLiveRefresh, usePaged, useV3 } from '../../../../_hub/hooks';
import {
  ACTOR_LABEL,
  Async,
  Empty,
  Hash,
  NetworkNote,
  Notice,
  PageHeader,
  Panel,
  humanize,
  runStatusLabel,
} from '../../../../_hub/ui';

function Inspector({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const state = useV3(
    `/v3/workspaces/${seg(workspaceId)}/agent-runs/${seg(runId)}`,
    AgentRunDetailSchema,
  );
  useLiveRefresh(state.reload, { types: ['AGENT_EVENT', 'BALANCE_CHANGED'] });
  return (
    <Async state={state}>
      {(d) => (
        <section className="hub-panel" aria-labelledby="run-h">
          <h2 id="run-h">{d.run.title}</h2>
          <p className="hub-sub">
            {humanize(d.run.trigger)} · started {shortDate(d.run.startedAt)} ·{' '}
            <span className="hub-status">{runStatusLabel(d.run.status)}</span> ·
            proof: {humanize(d.run.proofLevel)}
            {d.run.amount ? ` · ${formatMoney(d.run.amount)}` : ''}
          </p>
          <Notice tone="info">
            A model can suggest but never authorizes a payment. Each step shows
            who acted. Only chain-final steps are final.
          </Notice>
          <h3>Events</h3>
          {!d.events.length && <Empty>No events recorded.</Empty>}
          <ol className="hub-list" aria-label="Events in order">
            {[...d.events]
              .sort((a, b) =>
                BigInt(a.sequence) < BigInt(b.sequence)
                  ? -1
                  : BigInt(a.sequence) > BigInt(b.sequence)
                    ? 1
                    : 0,
              )
              .map((e) => (
                <li key={e.eventId}>
                  <strong>
                    #{e.sequence} {humanize(e.kind)}
                  </strong>{' '}
                  <span className="hub-status">{runStatusLabel(e.status)}</span>
                  <br />
                  <span>{e.summary}</span>
                  <br />
                  <small className="hub-sub">
                    Actor: {ACTOR_LABEL[e.actor] ?? humanize(e.actor)} · proof:{' '}
                    {humanize(e.proofLevel)} · {shortDate(e.observedAt)}
                    {e.amount ? ` · ${formatMoney(e.amount)}` : ''}
                    {e.recipientHint ? ` to ${e.recipientHint}` : ''}
                    {e.txHash ? ' · tx ' : ''}
                    {e.txHash && <Hash value={e.txHash} />}
                  </small>
                </li>
              ))}
          </ol>
          <h3>Chain receipts</h3>
          {!d.receipts.length && (
            <Empty>
              No chain receipts. Nothing on chain is claimed for this run.
            </Empty>
          )}
          {d.receipts.length > 0 && (
            <div className="hub-table-wrap">
              <table className="hub-table">
                <caption className="hub-sr">Chain receipts</caption>
                <thead>
                  <tr>
                    <th scope="col">Transaction</th>
                    <th scope="col">Finality</th>
                    <th scope="col">Block</th>
                    <th scope="col">Explorer</th>
                  </tr>
                </thead>
                <tbody>
                  {d.receipts.map((r) => {
                    const url = safeHttpsUrl(r.explorerUrl);
                    return (
                      <tr key={`${r.chainId}:${r.txHash}`}>
                        <th scope="row">
                          <Hash value={r.txHash} />
                          <br />
                          <small className="hub-sub">chain {r.chainId}</small>
                        </th>
                        <td>
                          <span className="hub-status">
                            {r.finality === 'FINALIZED'
                              ? 'Final'
                              : r.finality === 'REORGED'
                                ? 'Reorged (not final)'
                                : 'Pending (not final)'}
                          </span>
                        </td>
                        <td>{r.blockNumber ?? 'Not yet in a block'}</td>
                        <td>
                          {url ? (
                            <a
                              href={url}
                              target="_blank"
                              rel="noreferrer noopener"
                            >
                              View on explorer
                            </a>
                          ) : (
                            'No link'
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </Async>
  );
}

function AgentsInner() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const initial = useSearchParams().get('run');
  const [selected, setSelected] = useState<string | null>(initial);
  const list = usePaged(
    `/v3/workspaces/${seg(workspaceId)}/agent-runs`,
    '',
    AgentRunPageSchema,
  );
  useLiveRefresh(list.reload, { types: ['AGENT_EVENT'] });
  return (
    <>
      <PageHeader
        title="Agents"
        subtitle="What agents decided and what actually happened on chain."
      />
      <NetworkNote />
      <div className="hub-split">
        <Panel title="Runs" id="runs">
          {list.error && <Notice tone="danger">{list.error}</Notice>}
          {list.loading && !list.items.length && <p role="status">Loading…</p>}
          {!list.loading && !list.items.length && !list.error && (
            <Empty>No agent runs yet.</Empty>
          )}
          <div role="list">
            {list.items.map((r) => (
              <div role="listitem" key={r.runId}>
                <button
                  className="hub-lead-row"
                  aria-current={selected === r.runId}
                  onClick={() => setSelected(r.runId)}
                >
                  <strong>{r.title}</strong>
                  <small>
                    {runStatusLabel(r.status)} · {humanize(r.proofLevel)}
                    {r.amount ? ` · ${formatMoney(r.amount)}` : ''}
                  </small>
                  <small>{shortDate(r.updatedAt)}</small>
                </button>
              </div>
            ))}
          </div>
          {list.hasMore && (
            <div>
              <button className="hub-btn" onClick={() => void list.loadMore()}>
                Load more
              </button>
            </div>
          )}
        </Panel>
        <div>
          {selected ? (
            <Inspector
              key={selected}
              workspaceId={workspaceId}
              runId={selected}
            />
          ) : (
            <section className="hub-panel">
              <Empty>Choose a run to inspect its events and receipts.</Empty>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export default function AgentsPage() {
  return (
    <Suspense fallback={<p role="status">Loading…</p>}>
      <AgentsInner />
    </Suspense>
  );
}
