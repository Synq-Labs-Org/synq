'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { CircleDetailSchema } from '@synq/contracts';
import { formatAmount, formatMoney, shortDate } from '../../../../../lib/money';
import { seg } from '../../../../../lib/v3';
import { useLiveRefresh, useV3 } from '../../../../_hub/hooks';
import {
  Async,
  CapabilityList,
  Empty,
  Hash,
  NetworkNote,
  PageHeader,
  Panel,
  humanize,
} from '../../../../_hub/ui';

export default function CirclePage() {
  const { id } = useParams<{ id: string }>();
  const state = useV3(`/v3/personal/circles/${seg(id)}`, CircleDetailSchema);
  useLiveRefresh(state.reload, {
    types: ['BALANCE_CHANGED', 'APPROVAL_CHANGED'],
  });
  return (
    <Async state={state}>
      {(d) => {
        const decimals = d.circle.held?.decimals ?? 6;
        return (
          <>
            <p>
              <Link href="/personal">← Personal</Link>
            </p>
            <PageHeader
              title={d.circle.displayName}
              subtitle={`${humanize(d.circle.status)} · your role: ${humanize(d.circle.role)}${
                d.circle.threshold
                  ? ` · ${d.circle.threshold} signatures needed`
                  : ''
              }`}
            />
            <NetworkNote />
            <Panel title="Held by the circle" id="held">
              {d.circle.held ? (
                <p>
                  Settled{' '}
                  <strong>
                    {formatMoney({
                      units: d.circle.held.settled,
                      decimals: d.circle.held.decimals,
                      symbol: d.circle.held.symbol,
                    })}
                  </strong>
                  , pending (not final){' '}
                  {formatAmount(d.circle.held.pending, d.circle.held.decimals)}.
                </p>
              ) : (
                <Empty>No balance reported yet.</Empty>
              )}
              {d.circle.vault && (
                <p className="hub-sub">
                  Vault <Hash value={d.circle.vault} />
                </p>
              )}
            </Panel>
            <Panel title="Members" id="members">
              <div className="hub-table-wrap">
                <table className="hub-table">
                  <caption className="hub-sr">Circle members</caption>
                  <thead>
                    <tr>
                      <th scope="col">Member</th>
                      <th scope="col">Role</th>
                      <th scope="col" className="num">
                        Contributed
                      </th>
                      <th scope="col" className="num">
                        Refunded
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.members.map((m) => (
                      <tr key={m.principalId}>
                        <th scope="row">{m.walletHint}</th>
                        <td>{humanize(m.role)}</td>
                        <td className="num">
                          {formatAmount(m.contributed, decimals)}
                        </td>
                        <td className="num">
                          {formatAmount(m.refunded, decimals)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
            <Panel title="Contributions" id="contributions">
              {!d.contributions.length && <Empty>No contributions yet.</Empty>}
              {d.contributions.length > 0 && (
                <div className="hub-table-wrap">
                  <table className="hub-table">
                    <caption className="hub-sr">
                      Attributed contributions
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Seen</th>
                        <th scope="col">From</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.contributions.map((c) => (
                        <tr key={c.contributionId}>
                          <td>{shortDate(c.observedAt)}</td>
                          <td>
                            {c.payerHint}
                            {c.txHash && (
                              <>
                                <br />
                                <Hash value={c.txHash} />
                              </>
                            )}
                          </td>
                          <td>
                            <span className="hub-status">
                              {c.status === 'CREDITED'
                                ? 'Credited (final)'
                                : c.status === 'PENDING'
                                  ? 'Pending, not final'
                                  : humanize(c.status)}
                            </span>
                          </td>
                          <td className="num">{formatMoney(c.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel
              title="Proposals"
              id="proposals"
              note="Proposals need member signatures on the Approvals page. Nothing moves until the threshold is met and the transaction is final."
            >
              {!d.proposals.length && <Empty>No proposals.</Empty>}
              {d.proposals.length > 0 && (
                <div className="hub-table-wrap">
                  <table className="hub-table">
                    <caption className="hub-sr">Circle proposals</caption>
                    <thead>
                      <tr>
                        <th scope="col">Proposal</th>
                        <th scope="col">Status</th>
                        <th scope="col" className="num">
                          Approvals
                        </th>
                        <th scope="col" className="num">
                          Amount
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.proposals.map((p) => (
                        <tr key={p.proposalId}>
                          <th scope="row">
                            {p.title}
                            <br />
                            <small className="hub-sub">
                              {humanize(p.kind)}
                              {p.recipientHint ? ` to ${p.recipientHint}` : ''}
                              {p.txHash ? ' · ' : ''}
                              {p.txHash && <Hash value={p.txHash} />}
                            </small>
                          </th>
                          <td>
                            <span className="hub-status">
                              {humanize(p.status)}
                            </span>
                          </td>
                          <td className="num">
                            {p.approvals} of {p.threshold}
                          </td>
                          <td className="num">
                            {p.amount ? formatMoney(p.amount) : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
            <Panel title="Capabilities" id="capabilities">
              <CapabilityList capabilities={d.capabilities} showAvailable />
            </Panel>
          </>
        );
      }}
    </Async>
  );
}
