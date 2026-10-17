'use client';

import { useEffect, useState } from 'react';
import { getAddress } from 'viem';
import { z } from 'zod';
import {
  ARC_WORKSPACE_CHAIN,
  WalletSchema,
  WorkspaceListSchema,
  WorkspaceViewSchema,
  type Workspace,
} from '@synq/workspaces/contracts';
import { api, ApiFailure, describeError } from '../../lib/api';
import './theme.css';
import { VaultPanel } from './vault-panel';
import { ChannelPanel } from './channel-panel';
import { FinancePanel } from './finance-panel';
import { BooksPanel } from './books-panel';
import { GroupPanel } from './group-panel';
import { PayoutPanel } from './payout-panel';
import { GovernancePanel } from './governance-panel';
import { InvoicePanel } from './invoice-panel';
import { RevenuePanel } from './revenue-panel';
import { DealPanel } from './deal-panel';
import { TeamPanel } from './team-panel';

type Provider = {
  request(input: { method: string; params?: unknown[] }): Promise<unknown>;
};
const ChallengeSchema = z.strictObject({
  challengeId: z.string().uuid(),
  typedData: z.strictObject({
    domain: z.strictObject({
      name: z.literal('Synq Workspace Login'),
      version: z.literal('1'),
      chainId: z.literal(ARC_WORKSPACE_CHAIN),
    }),
    primaryType: z.literal('WorkspaceLogin'),
    types: z.record(
      z.string(),
      z.array(z.strictObject({ name: z.string(), type: z.string() })),
    ),
    message: z.strictObject({
      challengeId: z.string().uuid(),
      wallet: WalletSchema,
      origin: z.string().url(),
      audience: z.literal('web'),
      nonce: z.string().regex(/^[0-9a-f]{64}$/),
      expiresAt: z.string().regex(/^\d+$/),
      statement: z.literal(
        'Sign in to Synq on Arc testnet. This signature does not approve payments or vault setup.',
      ),
    }),
  }),
});
const SessionSchema = z.strictObject({
  principalId: z.string(),
  expiresAt: z.number(),
});
const InviteResponseSchema = z.strictObject({
  token: z.string(),
  expiresAt: z.number(),
});
type View = z.output<typeof WorkspaceViewSchema>;

export default function WorkspacesPage() {
  const [items, setItems] = useState<Workspace[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'PERSONAL' | 'GROUP' | 'BUSINESS'>(
    'PERSONAL',
  );
  const [inviteToken, setInviteToken] = useState('');
  const [inviteLink, setInviteLink] = useState('');
  const [role, setRole] = useState<'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER'>(
    'MEMBER',
  );
  const [connected, setConnected] = useState(false);
  const [nativeCode, setNativeCode] = useState<{
    code: string;
    expiresAt: number;
  } | null>(null);
  const [principal, setPrincipal] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const result = await api.get('/v2/workspaces', WorkspaceListSchema);
    setItems(result.workspaces);
    setConnected(true);
  }
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      if (e instanceof ApiFailure && e.status === 401) {
        setConnected(false);
        setView(null);
        setItems([]);
        setPrincipal(null);
        setNativeCode(null);
        setInviteLink('');
      }
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!nativeCode) return;
    const timer = setTimeout(
      () => setNativeCode(null),
      Math.max(0, nativeCode.expiresAt * 1000 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [nativeCode]);
  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const token = fragment.get('invite');
    if (token && /^[0-9a-f]{64}$/.test(token)) setInviteToken(token);
    if (token) window.history.replaceState(null, '', window.location.pathname);
    let active = true;
    Promise.all([
      api.get('/v2/workspaces', WorkspaceListSchema),
      api.get('/v2/auth/me', z.strictObject({ principalId: z.string() })),
    ])
      .then(([r, me]) => {
        if (active) {
          setItems(r.workspaces);
          setPrincipal(me.principalId);
          setConnected(true);
          const selected = new URLSearchParams(window.location.search).get(
            'workspace',
          );
          if (selected && r.workspaces.some((w) => w.id === selected))
            void api
              .get(`/v2/workspaces/${selected}`, WorkspaceViewSchema)
              .then((v) => {
                if (active) setView(v);
              })
              .catch((e: unknown) => {
                if (active) setError(describeError(e));
              });
        }
      })
      .catch((e: unknown) => {
        if (active && !(e instanceof ApiFailure && e.status === 401))
          setError(describeError(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function signIn() {
    const provider = (window as unknown as { ethereum?: Provider }).ethereum;
    if (!provider) {
      setError(
        'Open this page in a browser with an injected Ethereum wallet. WalletConnect is not connected yet.',
      );
      return;
    }
    await run(async () => {
      const wallets = z
        .array(WalletSchema)
        .min(1)
        .parse(await provider.request({ method: 'eth_requestAccounts' }));
      const wallet = wallets[0]!;
      const c = await api.post('/v2/auth/challenge', ChallengeSchema, {
        wallet,
        audience: 'web',
      });
      const m = c.typedData.message;
      const now = Math.floor(Date.now() / 1000);
      if (
        m.origin !== window.location.origin ||
        m.wallet !== getAddress(wallet) ||
        m.challengeId !== c.challengeId ||
        Number(m.expiresAt) <= now ||
        Number(m.expiresAt) > now + 300
      )
        throw new Error('Invalid sign-in challenge');
      const signature = z
        .string()
        .regex(/^0x[0-9a-fA-F]{130}$/)
        .parse(
          await provider.request({
            method: 'eth_signTypedData_v4',
            params: [wallet, JSON.stringify(c.typedData)],
          }),
        );
      const session = await api.post('/v2/auth/session', SessionSchema, {
        challengeId: c.challengeId,
        signature,
      });
      setPrincipal(session.principalId);
      await refresh();
      const requested = new URLSearchParams(window.location.search).get(
        'workspace',
      );
      if (requested && z.string().uuid().safeParse(requested).success)
        setView(
          await api.get(`/v2/workspaces/${requested}`, WorkspaceViewSchema),
        );
    });
  }
  const isOwner =
    view?.members.some(
      (m) => m.principalId === principal && m.role === 'OWNER',
    ) ?? false;
  return (
    <div className="workspace-shell" data-theme="ascii">
      <p className="workspace-network">
        Arc testnet · identity and workspace setup
      </p>
      <h1>Workspaces</h1>
      <p>
        Connect your wallet to create or join a workspace. Signing in grants no
        payment authority.
      </p>
      {busy && <p role="status">Loading…</p>}
      {error && <p role="alert">{error}</p>}
      {!connected ? (
        <section>
          <h2>Start</h2>
          <button disabled={busy} onClick={() => void signIn()}>
            Connect wallet and sign in
          </button>
          <p>Circle Wallets: requires Circle credentials.</p>
        </section>
      ) : (
        <>
          <section>
            <h2>Your workspaces</h2>
            {!items.length && (
              <p>No workspaces yet. Create one or accept an invitation.</p>
            )}
            {items.map((w) => (
              <button
                disabled={busy}
                key={w.id}
                onClick={() =>
                  void run(async () => {
                    setView(
                      await api.get(
                        `/v2/workspaces/${w.id}`,
                        WorkspaceViewSchema,
                      ),
                    );
                    setInviteLink('');
                  })
                }
              >
                {w.displayName} · {w.status}
              </button>
            ))}
          </section>
          <section>
            <h2>Sign in to iMessage</h2>
            <p>
              Generate a private one-use code, then paste it into Synq’s
              iMessage extension. It expires in two minutes and grants no
              payment authority.
            </p>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setNativeCode(
                    await api.post(
                      '/v2/auth/native-code',
                      z.strictObject({
                        code: z.string(),
                        expiresAt: z.number(),
                      }),
                      {},
                    ),
                  );
                })
              }
            >
              Generate private sign-in code
            </button>
            {nativeCode && (
              <>
                <p className="workspace-secret">{nativeCode.code}</p>
                <button
                  disabled={busy || Date.now() / 1000 >= nativeCode.expiresAt}
                  onClick={() =>
                    void run(async () => {
                      await navigator.clipboard.writeText(nativeCode.code);
                      setNativeCode(null);
                    })
                  }
                >
                  Copy code for iMessage
                </button>
              </>
            )}
          </section>
          <section>
            <h2>Create a workspace</h2>
            <label htmlFor="workspace-name">Name</label>
            <input
              id="workspace-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
            <label htmlFor="workspace-kind">Type</label>
            <select
              id="workspace-kind"
              value={kind}
              onChange={(e) => setKind(e.target.value as typeof kind)}
            >
              <option value="PERSONAL">Personal</option>
              <option value="GROUP">Group</option>
              <option value="BUSINESS">Business</option>
            </select>
            <button
              disabled={busy || !name.trim()}
              onClick={() =>
                void run(async () => {
                  const v = await api.post(
                    '/v2/workspaces',
                    WorkspaceViewSchema,
                    { displayName: name, kind },
                  );
                  setView(v);
                  setPrincipal(v.workspace.createdBy);
                  setName('');
                  await refresh();
                })
              }
            >
              Create workspace
            </button>
          </section>
          <section>
            <h2>Join a workspace</h2>
            <label htmlFor="workspace-invite">One-use invitation token</label>
            <input
              id="workspace-invite"
              autoComplete="off"
              value={inviteToken}
              maxLength={64}
              onChange={(e) => setInviteToken(e.target.value)}
            />
            <button
              disabled={busy || !/^[0-9a-f]{64}$/.test(inviteToken)}
              onClick={() =>
                void run(async () => {
                  const r = await api.post(
                    '/v2/workspace-invites/accept',
                    z.strictObject({ workspaceId: z.string().uuid() }),
                    { token: inviteToken },
                  );
                  setInviteToken('');
                  await refresh();
                  setView(
                    await api.get(
                      `/v2/workspaces/${r.workspaceId}`,
                      WorkspaceViewSchema,
                    ),
                  );
                })
              }
            >
              Accept invitation
            </button>
          </section>
          {view && (
            <section>
              <h2>{view.workspace.displayName}</h2>
              <p>{view.workspace.status} · Arc testnet</p>
              {view.workspace.vault ? (
                <p>
                  Vault: {view.workspace.vault} · {view.workspace.threshold}{' '}
                  owner signatures required.
                </p>
              ) : (
                <p>
                  No active vault yet. Proposed owners must review and sign
                  setup separately from sign-in.
                </p>
              )}
              {isOwner && (
                <VaultPanel
                  key={view.workspace.id}
                  workspaceId={view.workspace.id}
                  onActivated={() =>
                    void run(async () => {
                      setView(
                        await api.get(
                          `/v2/workspaces/${view.workspace.id}`,
                          WorkspaceViewSchema,
                        ),
                      );
                      await refresh();
                    })
                  }
                />
              )}
              {view.workspace.status === 'ACTIVE' && view.workspace.vault && (
                <FinancePanel
                  key={`finance-${view.workspace.id}`}
                  workspaceId={view.workspace.id}
                  vault={view.workspace.vault}
                  owner={isOwner}
                />
              )}
              {view.workspace.status === 'ACTIVE' &&
                view.workspace.vault &&
                view.workspace.kind === 'GROUP' && (
                  <GroupPanel
                    key={`group-${view.workspace.id}`}
                    workspaceId={view.workspace.id}
                    owner={isOwner}
                  />
                )}
              {view.workspace.status === 'ACTIVE' && view.workspace.vault && (
                <BooksPanel
                  key={`books-${view.workspace.id}`}
                  workspaceId={view.workspace.id}
                  owner={isOwner}
                />
              )}
              {view.workspace.status === 'ACTIVE' && view.workspace.vault && (
                <PayoutPanel
                  key={`payouts-${view.workspace.id}`}
                  workspaceId={view.workspace.id}
                  vault={view.workspace.vault}
                  owner={isOwner}
                />
              )}
              {view.workspace.status === 'ACTIVE' && view.workspace.vault && (
                <GovernancePanel
                  key={`governance-${view.workspace.id}`}
                  workspaceId={view.workspace.id}
                  vault={view.workspace.vault}
                  owner={isOwner}
                />
              )}
              {view.workspace.status === 'ACTIVE' && view.workspace.vault && (
                <>
                  <InvoicePanel
                    key={`invoices-${view.workspace.id}`}
                    workspaceId={view.workspace.id}
                    vault={view.workspace.vault}
                    owner={isOwner}
                  />
                  <RevenuePanel
                    key={`revenue-${view.workspace.id}`}
                    workspaceId={view.workspace.id}
                    vault={view.workspace.vault}
                    owner={isOwner}
                  />
                </>
              )}
              {principal && (
                <DealPanel
                  key={`deals-${view.workspace.id}`}
                  workspaceId={view.workspace.id}
                  principalId={principal}
                />
              )}
              <TeamPanel
                key={`team-${view.workspace.id}`}
                workspaceId={view.workspace.id}
              />
              <ChannelPanel
                key={`channel-${view.workspace.id}`}
                workspaceId={view.workspace.id}
              />
              <ul>
                {view.members.map((m) => (
                  <li key={m.principalId}>
                    {m.walletHint} · {m.role}
                    {view.workspace.status === 'FORMING' && m.role === 'OWNER'
                      ? ' (proposed signer; no vault yet)'
                      : ''}
                  </li>
                ))}
              </ul>
              {isOwner && (
                <>
                  <label htmlFor="invite-role">Invite role</label>
                  <select
                    id="invite-role"
                    value={role}
                    onChange={(e) => setRole(e.target.value as typeof role)}
                  >
                    <option value="MEMBER">Member</option>
                    <option value="VIEWER">Viewer</option>
                    <option value="ADMIN">Admin (no signing authority)</option>
                    {view.workspace.kind !== 'PERSONAL' &&
                      view.workspace.status === 'FORMING' && (
                        <option value="OWNER">
                          Proposed owner (requires signed vault setup)
                        </option>
                      )}
                  </select>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const r = await api.post(
                          `/v2/workspaces/${view.workspace.id}/invites`,
                          InviteResponseSchema,
                          { role },
                        );
                        setInviteLink(
                          `${window.location.origin}/workspaces#invite=${r.token}`,
                        );
                      })
                    }
                  >
                    Create one-use invite
                  </button>
                  {inviteLink && (
                    <p className="workspace-secret">
                      Share privately; expires in one hour:{' '}
                      <a href={inviteLink}>{inviteLink}</a>
                    </p>
                  )}
                </>
              )}
            </section>
          )}
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.post(
                  '/v2/auth/logout',
                  z.strictObject({ ok: z.literal(true) }),
                  {},
                );
                setConnected(false);
                setItems([]);
                setView(null);
                setPrincipal(null);
                setNativeCode(null);
                setInviteLink('');
              })
            }
          >
            Sign out
          </button>
        </>
      )}
      <p>
        Payments require a separate owner signature, Kernel decision and one-use
        execution permission. Chat never approves money.
      </p>
    </div>
  );
}
