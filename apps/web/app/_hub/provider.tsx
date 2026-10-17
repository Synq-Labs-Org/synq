'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { usePathname } from 'next/navigation';
import {
  ContextSchema,
  ContextsSchema,
  StreamEventSchema,
} from '@synq/contracts';
import type { z } from 'zod';
import {
  useWorkspaceTheme,
  type WorkspaceTheme,
} from '../workspaces/theme-picker';
import { describeV3, onAuthLost, v3, V3Error } from '../../lib/v3';

type Contexts = z.output<typeof ContextsSchema>;
export type HubContextInfo = z.output<typeof ContextSchema>;
export type StreamEvent = z.output<typeof StreamEventSchema>;
export type LiveListener = (event: StreamEvent, inContext: boolean) => void;

type HubState = {
  status: 'loading' | 'signedOut' | 'ready' | 'error';
  error: string | null;
  contexts: Contexts | null;
  /** "personal", a workspace id, or null on pages that belong to no context. */
  contextId: string | null;
  current: HubContextInfo | null;
  principalId: string | null;
  reload: () => Promise<void>;
  signedIn: () => void;
  subscribe: (listener: LiveListener) => () => void;
  theme: WorkspaceTheme;
  setTheme: (theme: WorkspaceTheme) => void;
};

const HubContext = createContext<HubState | null>(null);

export function useHub(): HubState {
  const value = useContext(HubContext);
  if (!value) throw new Error('useHub outside the hub');
  return value;
}

const EVENT_TYPES = [
  'LEAD_UPDATED',
  'LEAD_MESSAGE',
  'OFFER_UPDATED',
  'AGENT_EVENT',
  'APPROVAL_CHANGED',
  'BALANCE_CHANGED',
  'NOTIFICATION',
  'CONTEXT_REVOKED',
];

function contextIdFromPath(pathname: string): string | null {
  if (pathname === '/personal' || pathname.startsWith('/personal/'))
    return 'personal';
  const match = /^\/w\/([^/]+)/.exec(pathname);
  return match?.[1] ?? null;
}

export function HubProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [contexts, setContexts] = useState<Contexts | null>(null);
  const [status, setStatus] = useState<HubState['status']>('loading');
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useWorkspaceTheme();
  const listeners = useRef(new Set<LiveListener>());
  const contextId = contextIdFromPath(pathname);

  const reload = useCallback(async () => {
    try {
      const result = await v3.get('/v3/me/contexts', ContextsSchema);
      setContexts(result);
      setError(null);
      setStatus('ready');
    } catch (e) {
      if (e instanceof V3Error && e.kind === 'AUTH') {
        setContexts(null);
        setStatus('signedOut');
        return;
      }
      setError(describeV3(e));
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    onAuthLost(() => {
      setContexts(null);
      setStatus('signedOut');
    });
    // Initial load; reload() only sets state after the request resolves.
    void reload();
    return () => onAuthLost(null);
  }, [reload]);

  const subscribe = useCallback((listener: LiveListener) => {
    listeners.current.add(listener);
    return () => {
      listeners.current.delete(listener);
    };
  }, []);

  // Live updates. One stream per signed-in context; closed on switch/unmount.
  useEffect(() => {
    if (status !== 'ready') return;
    const source = new EventSource('/api/v3/events', { withCredentials: true });
    const handle = (message: MessageEvent) => {
      let parsed: StreamEvent;
      try {
        const result = StreamEventSchema.safeParse(
          JSON.parse(String(message.data)),
        );
        if (!result.success) return;
        parsed = result.data;
      } catch {
        return;
      }
      if (parsed.type === 'CONTEXT_REVOKED') {
        setContexts(null);
        setStatus('signedOut');
        return;
      }
      const inContext =
        contextId === 'personal' ||
        (parsed.workspaceId !== null && parsed.workspaceId === contextId);
      for (const listener of listeners.current) listener(parsed, inContext);
    };
    source.onmessage = handle;
    for (const type of EVENT_TYPES) source.addEventListener(type, handle);
    source.onerror = () => {
      // The browser reconnects by itself unless the server closed the stream
      // (for example when the session ended). Check which it was.
      if (source.readyState === EventSource.CLOSED) void reload();
    };
    return () => source.close();
  }, [status, contextId, reload]);

  const current = useMemo(
    () => contexts?.contexts.find((c) => c.contextId === contextId) ?? null,
    [contexts, contextId],
  );

  const value = useMemo<HubState>(
    () => ({
      status,
      error,
      contexts,
      contextId,
      current,
      principalId: contexts?.principalId ?? null,
      reload,
      signedIn: () => {
        setStatus('loading');
        void reload();
      },
      subscribe,
      theme,
      setTheme,
    }),
    [
      status,
      error,
      contexts,
      contextId,
      current,
      reload,
      subscribe,
      theme,
      setTheme,
    ],
  );
  return (
    <HubContext.Provider value={value}>
      <div className="hub-shell" data-theme={theme}>
        {children}
      </div>
    </HubContext.Provider>
  );
}
