'use client';

import Link from 'next/link';
import { PersonalOverviewSchema } from '@synq/contracts';
import { formatMoney, shortDate } from '../../../lib/money';
import { useLiveRefresh, useV3 } from '../../_hub/hooks';
import {
  Async,
  BalanceTable,
  Empty,
  Hash,
  NetworkNote,
  PageHeader,
  Panel,
  humanize,
} from '../../_hub/ui';

export default function PersonalPage() {
  const state = useV3('/v3/personal/overview', PersonalOverviewSchema);
  useLiveRefresh(state.reload, { types: ['BALANCE_CHANGED', 'NOTIFICATION'] });
  return (
    <>
      <PageHeader
        title="Personal"
        subtitle="Your own wallets, circles and vaults. Nothing here moves money."
      />
      <NetworkNote />
      <Async state={state}>
        {(o) => (
          <>
            <Panel title="Wallets" id="wallets">
              {!o.wallets.length && <Empty>No wallets linked yet.</Empty>}
              {o.wallets.map((w) => (
                <div key={w.address}>
                  <h3>
                    {w.label} <code className="hub-hash">{w.address}</code>
                  </h3>
                  <BalanceTable balances={w.balances} />
                  <p className="hub-sub">
                    As of {shortDate(w.freshness.observedAt)} from{' '}
                    {humanize(w.freshness.source)}
                    {w.freshness.stale ? ' (stale)' : ''}
                  </p>
                </div>
              ))}
            </Panel>
            <Panel title="Circles" id="circles">
              {!o.circles.length && (
                <Empty>You are not a member of any circle yet.</Empty>
              )}
              {o.circles.length > 0 && (
                <div className="hub-table-wrap">
                  <table className="hub-table">
                    <caption className="hub-sr">Your circles</caption>
                    <thead>
                      <tr>
                        <th scope="col">Circle</th>
                        <th scope="col">Role</th>
                        <th scope="col" className="num">
                          Members
                        </th>
                        <th scope="col" className="num">
                          Held
                        </th>
                        <th scope="col" className="num">
                          My contribution
                        </th>
                        <th scope="col" className="num">
                          Open proposals
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.circles.map((c) => (
                        <tr key={c.circleId}>
                          <th scope="row">
                            <Link
                              href={`/personal/circles/${encodeURIComponent(c.circleId)}`}
                            >
                              {c.displayName}
                            </Link>
                            <br />
                            <small className="hub-sub">
                              {humanize(c.status)}
                              {c.threshold
                                ? ` · ${c.threshold} signatures needed`
                                : ''}
                            </small>
                          </th>
                          <td>{humanize(c.role)}</td>
                          <td className="num">{c.memberCount}</td>
                          <td className="num">
                            {c.held
                              ? formatMoney({
                                  units: c.held.settled,
                                  decimals: c.held.decimals,
                                  symbol: c.held.symbol,
                                })
                              : 'Not available'}
                          </td>
                          <td className="num">
                            {c.myContribution
                              ? formatMoney(c.myContribution)
                              : 'None'}
                          </td>
                          <td className="num">{c.openProposals}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel title="Personal vaults" id="vaults">
              {!o.vaults.length && <Empty>No personal vaults.</Empty>}
              {o.vaults.map((v) => (
                <div key={v.workspaceId}>
                  <h3>
                    {v.displayName}{' '}
                    <small className="hub-sub">
                      {humanize(v.kind)} · {humanize(v.status)}
                    </small>
                  </h3>
                  {v.vault ? (
                    <p className="hub-sub">
                      Vault <Hash value={v.vault} />
                    </p>
                  ) : (
                    <p className="hub-sub">No active vault yet.</p>
                  )}
                  <BalanceTable balances={v.balances} />
                </div>
              ))}
            </Panel>
            <Panel title="Recent activity" id="activity">
              {!o.recent.length && <Empty>No activity yet.</Empty>}
              {o.recent.length > 0 && (
                <div className="hub-table-wrap">
                  <table className="hub-table">
                    <caption className="hub-sr">Recent activity</caption>
                    <thead>
                      <tr>
                        <th scope="col">When</th>
                        <th scope="col">What</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {o.recent.map((a) => (
                        <tr key={a.activityId}>
                          <td>{shortDate(a.occurredAt)}</td>
                          <td>
                            {a.title}
                            <br />
                            <small className="hub-sub">
                              {humanize(a.kind)}
                              {a.txHash ? ' · ' : ''}
                              {a.txHash && <Hash value={a.txHash} />}
                            </small>
                          </td>
                          <td>
                            <span className="hub-status">
                              {a.status === 'FINAL'
                                ? 'Final'
                                : a.status === 'PENDING'
                                  ? 'Pending, not final'
                                  : humanize(a.status)}
                            </span>
                          </td>
                          <td className="num">
                            {a.amount ? formatMoney(a.amount) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </Async>
    </>
  );
}
