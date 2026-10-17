'use client';

import { useParams } from 'next/navigation';
import { BooksPanel } from '../../../../workspaces/books-panel';
import { FinancePanel } from '../../../../workspaces/finance-panel';
import { GovernancePanel } from '../../../../workspaces/governance-panel';
import { InvoicePanel } from '../../../../workspaces/invoice-panel';
import { PayoutPanel } from '../../../../workspaces/payout-panel';
import { RevenuePanel } from '../../../../workspaces/revenue-panel';
import { VaultPanel } from '../../../../workspaces/vault-panel';
import { LegacyWorkspace } from '../../../../_hub/legacy-workspace';
import { PageHeader } from '../../../../_hub/ui';

export default function MoneyPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return (
    <>
      <PageHeader
        title="Money"
        subtitle="Finance, books, payouts, governance, vault, invoices and revenue."
      />
      <LegacyWorkspace workspaceId={workspaceId}>
        {({ view, owner }) => {
          const ws = view.workspace;
          const active = ws.status === 'ACTIVE' && ws.vault;
          return (
            <>
              {owner && (
                <VaultPanel
                  key={ws.id}
                  workspaceId={ws.id}
                  onActivated={() => window.location.reload()}
                />
              )}
              {!ws.vault && (
                <p>
                  No active vault yet. Proposed owners must review and sign
                  setup separately from sign-in.
                </p>
              )}
              {active && (
                <>
                  <FinancePanel
                    key={`finance-${ws.id}`}
                    workspaceId={ws.id}
                    vault={ws.vault!}
                    owner={owner}
                  />
                  <BooksPanel
                    key={`books-${ws.id}`}
                    workspaceId={ws.id}
                    owner={owner}
                  />
                  <PayoutPanel
                    key={`payouts-${ws.id}`}
                    workspaceId={ws.id}
                    vault={ws.vault!}
                    owner={owner}
                  />
                  <GovernancePanel
                    key={`governance-${ws.id}`}
                    workspaceId={ws.id}
                    vault={ws.vault!}
                    owner={owner}
                  />
                  <InvoicePanel
                    key={`invoices-${ws.id}`}
                    workspaceId={ws.id}
                    vault={ws.vault!}
                    owner={owner}
                  />
                  <RevenuePanel
                    key={`revenue-${ws.id}`}
                    workspaceId={ws.id}
                    vault={ws.vault!}
                    owner={owner}
                  />
                </>
              )}
            </>
          );
        }}
      </LegacyWorkspace>
    </>
  );
}
