'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { WorkspaceOverviewSchema } from '@synq/contracts';
import { formatAmount, formatMoney, shortDate } from '../../../../lib/money';
import { seg } from '../../../../lib/v3';
import { useLiveRefresh, useV3 } from '../../../_hub/hooks';
import {
  Async,
  BalanceTable,
  CapabilityList,
  Empty,
  NetworkNote,
  PageHeader,
  Panel,
  humanize,
} from '../../../_hub/ui';

function Stat(props: { label: string; value: string; note?: string }) {
  return (
    <div className="hub-stat">
      <span className="label">{props.label}</span>
      <span className="value">{props.value}</span>
      {props.note && <span className="hub-sub">{props.note}</span>}
    </div>
  );
}

export default function WorkspaceOverviewPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const base = `/w/${seg(workspaceId)}`;
  const state = useV3(
    `/v3/workspaces/${seg(workspaceId)}/overview`,
    WorkspaceOverviewSchema,
  );
  useLiveRefresh(state.reload);
  return (
    <Async state={state}>
      {(o) => {
        const decimals = o.balances[0]?.decimals ?? 6;
        const symbol = o.balances[0]?.symbol ?? 'USDC';
        return (
          <>
            <PageHeader
              title={o.displayName}
              subtitle={`${humanize(o.status)} · your role: ${humanize(o.role)}`}
            />
            <NetworkNote />
            <Panel
              title="Balances"
              id="balances"
              note={`Spendable is settled minus reserved. Pending is not final and quarantined funds are never spendable. As of ${shortDate(o.freshness.observedAt)} from ${humanize(o.freshness.source)}${o.freshness.stale ? ' (stale)' : ''}.`}
            >
              <BalanceTable balances={o.balances} />
            </Panel>
            <div className="hub-grid hub-grid-3">
              <Panel title="Receivables" id="receivables">
                <Stat
                  label="Open invoices"
                  value={String(o.receivables.open)}
                  note={`${formatAmount(o.receivables.units, decimals)} ${symbol} owed to you`}
                />
              </Panel>
              <Panel title="Payables" id="payables">
                <Stat
                  label="Open bills"
                  value={String(o.payables.open)}
                  note={`${formatAmount(o.payables.units, decimals)} ${symbol} you owe`}
                />
              </Panel>
              <Panel title="Leads" id="leads">
                <Stat
                  label="Open leads"
                  value={String(o.leads.open)}
                  note={`${o.leads.needsOwner} need an owner`}
                />
                {(o.role === 'OWNER' || o.role === 'ADMIN') && (
                  <Link href={`${base}/inbox`}>Open inbox</Link>
                )}
              </Panel>
            </div>
            <Panel title="Waiting for signatures" id="approvals">
              <p>
                {o.pendingApprovals === 0
                  ? 'Nothing is waiting in this workspace.'
                  : `${o.pendingApprovals} request${o.pendingApprovals === 1 ? '' : 's'} waiting.`}{' '}
                <Link href="/approvals">Go to approvals</Link>
              </p>
            </Panel>
            <Panel
              title="Agent highlights"
              id="agents"
              actions={<Link href={`${base}/agents`}>All runs</Link>}
            >
              {!o.agentHighlights.length && (
                <Empty>No agent activity yet.</Empty>
              )}
              {o.agentHighlights.length > 0 && (
                <ul className="hub-list">
                  {o.agentHighlights.map((r) => (
                    <li key={r.runId}>
                      <Link
                        href={`${base}/agents?run=${encodeURIComponent(r.runId)}`}
                      >
                        {r.title}
                      </Link>
                      <br />
                      <small className="hub-sub">
                        <span className="hub-status">{humanize(r.status)}</span>
                        {' · '}
                        {humanize(r.proofLevel)}
                        {r.amount ? ` · ${formatMoney(r.amount)}` : ''}
                        {' · '}
                        {shortDate(r.updatedAt)}
                      </small>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <Panel
              title="Capabilities"
              id="capabilities"
              note="Only what is not fully available is listed, with the reason."
            >
              <CapabilityList capabilities={o.capabilities} />
            </Panel>
          </>
        );
      }}
    </Async>
  );
}
