'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { z } from 'zod';
import { WorkspaceViewSchema } from '@synq/workspaces/contracts';
import { api, ApiFailure, describeError } from '../../lib/api';
import '../workspaces/theme.css';
import { useHub } from './provider';
import { NetworkNote, Notice } from './ui';

type View = z.output<typeof WorkspaceViewSchema>;

/**
 * Loads the existing v2 workspace view and hands it, with the viewer's owner
 * flag, to the existing panels. The panels keep their own money logic.
 */
export function LegacyWorkspace(props: {
  workspaceId: string;
  children: (ctx: {
    view: View;
    owner: boolean;
    principalId: string;
  }) => ReactNode;
}) {
  const { principalId, theme, signedIn } = useHub();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setView(
        await api.get(
          `/v2/workspaces/${encodeURIComponent(props.workspaceId)}`,
          WorkspaceViewSchema,
        ),
      );
      setError(null);
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) signedIn();
      setError(describeError(e));
    }
  }, [props.workspaceId, signedIn]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!view)
    return error ? (
      <Notice tone="danger">{error}</Notice>
    ) : (
      <p role="status">Loading…</p>
    );
  const owner = view.members.some(
    (m) => m.principalId === principalId && m.role === 'OWNER',
  );
  return (
    <>
      <NetworkNote />
      <Notice tone="info">
        Money here is moved only by owner signatures on Arc testnet. Signing in
        never approves a payment.
      </Notice>
      {error && <Notice tone="warning">{error}</Notice>}
      <div className="workspace-shell hub-legacy" data-theme={theme}>
        {principalId && props.children({ view, owner, principalId })}
      </div>
    </>
  );
}
