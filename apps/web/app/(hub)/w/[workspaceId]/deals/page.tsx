'use client';

import { useParams } from 'next/navigation';
import { DealPanel } from '../../../../workspaces/deal-panel';
import { LegacyWorkspace } from '../../../../_hub/legacy-workspace';
import { PageHeader } from '../../../../_hub/ui';

export default function DealsPage() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return (
    <>
      <PageHeader
        title="Deals"
        subtitle="Deals and escrow with your contacts."
      />
      <LegacyWorkspace workspaceId={workspaceId}>
        {({ view, principalId }) => (
          <DealPanel
            key={`deals-${view.workspace.id}`}
            workspaceId={view.workspace.id}
            principalId={principalId}
          />
        )}
      </LegacyWorkspace>
    </>
  );
}
