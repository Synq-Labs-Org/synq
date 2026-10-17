import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getAddress, type Address } from 'viem';
import { z } from 'zod';
import { CONTRACT_VERSION, ROUTES } from '@synq/contracts';
import {
  WorkspaceError,
  type PostgresWorkspaceStore,
  type Role,
  type Workspace,
  type WorkspaceDeviceSessions,
} from '@synq/workspaces';
import type { WorkspaceContributions } from '@synq/workspaces/contributions';
import type { WorkspaceGovernance } from '@synq/workspaces/governance';
import { workspaceHttp } from './workspace-http.js';

/*
 * The v3 app API (see packages/contracts): device sessions, contexts and the
 * personal view for the iOS app and web hub. It reads the same stores as /v2;
 * nothing here moves money. Routes not registered here report PLANNED in
 * GET /v3/meta.
 */

export type AppRouteDeps = {
  store: PostgresWorkspaceStore;
  devices: WorkspaceDeviceSessions;
  contributions?: {
    service: WorkspaceContributions;
    /** Vault USDC not held for payouts, members, bills or deals. */
    available: (workspaceId: string) => Promise<bigint>;
  };
  governance?: WorkspaceGovernance;
  balances?: {
    /** USDC balance of an address at the latest block. */
    address: (address: Address) => Promise<bigint>;
  };
};

const USDC = {
  assetId: 'arc-testnet:USDC',
  symbol: 'USDC',
  chainId: 5042002,
  decimals: 6,
} as const;
const money = (units: bigint | string) => ({ ...USDC, units: String(units) });
const balance = (settled: bigint, reserved = 0n) => ({
  ...USDC,
  settled: String(settled),
  reserved: String(
    reserved < 0n ? 0n : reserved > settled ? settled : reserved,
  ),
  pending: '0',
  quarantined: '0',
});
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const hint = (wallet: string) => `${wallet.slice(0, 6)}…${wallet.slice(-4)}`;
const txHash = (key: unknown) => {
  const m = /^(0x[0-9a-fA-F]{64})/.exec(String(key ?? ''));
  return m ? m[1]!.toLowerCase() : null;
};

const PageQuery = z.strictObject({
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
const cursorOf = (id: string) => Buffer.from(id).toString('base64url');
const cursorValue = (c: string | undefined) => {
  if (c === undefined) return null;
  const v = Buffer.from(c, 'base64url').toString();
  if (!z.uuid().safeParse(v).success)
    throw new WorkspaceError('INVALID_CURSOR', 400);
  return v;
};

export function registerAppRoutes(app: FastifyInstance, deps: AppRouteDeps) {
  const { store, devices } = deps;
  const { handle, token, auth, anonymous } = workspaceHttp(store);
  const implemented = new Set<string>();
  const route = (id: string) => {
    if (!ROUTES.some((r) => r.id === id))
      throw new Error(`route ${id} is not in the contract`);
    implemented.add(id);
  };
  /** v3 mutations carry an Idempotency-Key; cookie sessions also need the origin. */
  const mutation = async (req: FastifyRequest) => {
    if (!z.uuid().safeParse(req.headers['idempotency-key']).success)
      throw new WorkspaceError('IDEMPOTENCY_KEY_REQUIRED', 400);
    return auth(req, true);
  };
  const now = () => store.now();

  route('meta');
  app.get('/v3/meta', (_req, reply) =>
    handle(reply, async () => ({
      contractVersion: CONTRACT_VERSION,
      routes: ROUTES.map((r) => ({
        id: r.id,
        status: implemented.has(r.id) ? 'IMPLEMENTED' : 'PLANNED',
      })),
    })),
  );

  // MARK: Sessions

  route('auth.deviceSession');
  app.post('/v3/auth/device-session', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      return devices.fromSignature(req.body);
    }),
  );
  route('auth.deviceSessionFromCode');
  app.post('/v3/auth/device-session/code', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      return devices.fromCode(req.body);
    }),
  );
  route('auth.refresh');
  app.post('/v3/auth/refresh', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      return devices.refresh(req.body);
    }),
  );
  route('auth.sessions');
  app.get('/v3/auth/sessions', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      return devices.list(s.principalId, s.deviceSessionId);
    }),
  );
  route('auth.logout');
  app.post('/v3/auth/logout', (req, reply) =>
    handle(reply, async () => {
      const s = await mutation(req);
      return devices.logout(token(req).value, s.deviceSessionId);
    }),
  );
  route('auth.revokeAll');
  app.post('/v3/auth/revoke-all', (req, reply) =>
    handle(reply, async () => {
      const s = await mutation(req);
      return devices.revokeAll(s.principalId);
    }),
  );

  // MARK: Contexts and personal

  route('me.contexts');
  app.get('/v3/me/contexts', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      const list = await store.listWithRoles(s.principalId);
      return {
        principalId: s.principalId,
        walletHint: hint(getAddress(s.wallet)),
        contexts: [
          {
            contextId: 'personal',
            kind: 'PERSONAL' as const,
            workspaceId: null,
            displayName: 'Personal',
            role: null,
            workspaceStatus: null,
            unreadCount: 0,
          },
          ...list
            .filter((w) => w.workspace.kind === 'BUSINESS')
            .map((w) => ({
              contextId: w.workspace.id,
              kind: 'BUSINESS' as const,
              workspaceId: w.workspace.id,
              displayName: w.workspace.displayName,
              role: w.role,
              workspaceStatus: w.workspace.status,
              unreadCount: 0,
            })),
        ],
      };
    }),
  );

  /** Reads that need finance tables answer "unknown" when those tables are absent. */
  const optional = async <T>(fallback: T, run: () => Promise<T>) => {
    try {
      return await run();
    } catch {
      return fallback;
    }
  };

  const vaultBalance = async (w: Workspace) => {
    if (!w.vault || !deps.balances || w.status !== 'ACTIVE') return null;
    const vault = w.vault;
    return optional(null, async () => {
      const held = await deps.balances!.address(getAddress(vault));
      const free = deps.contributions
        ? await deps.contributions.available(w.id)
        : held;
      return balance(held, held - free);
    });
  };

  const circleSummary = async (
    w: Workspace,
    role: Role,
    principalId: string,
  ) => {
    const [members, mine, held, open] = await Promise.all([
      store.pool.query(
        'SELECT count(*)::int AS n FROM synq_ws_members WHERE workspace_id=$1',
        [w.id],
      ),
      deps.contributions
        ? optional(null, async () =>
            money(
              (await deps.contributions!.service.equity(w.id)).get(
                principalId,
              ) ?? 0n,
            ),
          )
        : Promise.resolve(null),
      vaultBalance(w),
      optional(0, async () =>
        Number(
          (
            await store.pool.query(
              "SELECT count(*)::int AS n FROM synq_ws_safe_actions WHERE workspace_id=$1 AND state IN ('REVIEW','READY')",
              [w.id],
            )
          ).rows[0].n,
        ),
      ),
    ]);
    return {
      circleId: w.id,
      displayName: w.displayName,
      status: w.status,
      role,
      memberCount: Number(members.rows[0].n),
      threshold: w.threshold,
      vault: w.vault === null ? null : getAddress(w.vault),
      myContribution: mine,
      held,
      openProposals: open,
      freshness: {
        observedAt: iso(now()),
        source: held ? ('CHAIN' as const) : ('LEDGER' as const),
        stale: false,
      },
    };
  };

  route('personal.overview');
  app.get('/v3/personal/overview', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      const list = await store.listWithRoles(s.principalId);
      const wallet = getAddress(s.wallet);
      const own = deps.balances
        ? await optional(null, () => deps.balances!.address(wallet))
        : null;
      const circles = list.filter((w) => w.workspace.kind === 'GROUP');
      const names = new Map(list.map((w) => [w.workspace.id, w]));
      const recent = deps.contributions
        ? await optional([] as Record<string, unknown>[], async () =>
            (
              await store.pool.query(
                'SELECT id,workspace_id,amount,state,receipt_key,created_at,paid_at FROM synq_ws_contributions WHERE principal_id=$1 ORDER BY created_at DESC LIMIT 10',
                [s.principalId],
              )
            ).rows.filter((r) => names.has(String(r.workspace_id))),
          )
        : [];
      return {
        principalId: s.principalId,
        wallets: [
          {
            address: wallet,
            label: 'Sign-in wallet',
            balances: own === null ? [] : [balance(own)],
            freshness: {
              observedAt: iso(now()),
              source: 'CHAIN' as const,
              stale: own === null,
            },
          },
        ],
        circles: await Promise.all(
          circles
            .slice(0, 5)
            .map((w) => circleSummary(w.workspace, w.role, s.principalId)),
        ),
        vaults: await Promise.all(
          list
            .filter((w) => w.workspace.kind === 'PERSONAL')
            .map(async (w) => {
              const b = await vaultBalance(w.workspace);
              return {
                workspaceId: w.workspace.id,
                displayName: w.workspace.displayName,
                kind: w.workspace.kind,
                status: w.workspace.status,
                vault:
                  w.workspace.vault === null
                    ? null
                    : getAddress(w.workspace.vault),
                balances: b ? [b] : [],
              };
            }),
        ),
        recent: recent.map((r) => {
          const paid = r.state === 'PAID';
          return {
            activityId: `contribution:${String(r.id)}`,
            kind: 'CONTRIBUTION' as const,
            title: `Contribution to ${names.get(String(r.workspace_id))!.workspace.displayName}`,
            workspaceId: String(r.workspace_id),
            amount: money(String(r.amount)),
            status: paid ? ('FINAL' as const) : ('PENDING' as const),
            txHash: paid ? txHash(r.receipt_key) : null,
            occurredAt: iso(Number(r.paid_at ?? r.created_at)),
          };
        }),
      };
    }),
  );

  route('personal.circles');
  app.get('/v3/personal/circles', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      const q = PageQuery.parse(req.query);
      const after = cursorValue(q.cursor);
      const limit = q.limit ?? 20;
      const circles = (await store.listWithRoles(s.principalId)).filter(
        (w) =>
          w.workspace.kind === 'GROUP' &&
          (after === null || w.workspace.id > after),
      );
      const page = circles.slice(0, limit);
      return {
        items: await Promise.all(
          page.map((w) => circleSummary(w.workspace, w.role, s.principalId)),
        ),
        nextCursor:
          circles.length > limit ? cursorOf(page.at(-1)!.workspace.id) : null,
      };
    }),
  );

  route('personal.circle');
  app.get('/v3/personal/circles/:circleId', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      const { circleId } = z
        .strictObject({ circleId: z.uuid() })
        .parse(req.params);
      await store.throttle(`workspace:${circleId}`, 240);
      const found = (await store.listWithRoles(s.principalId)).find(
        (w) => w.workspace.id === circleId && w.workspace.kind === 'GROUP',
      );
      // Not a member, not a circle and nonexistent all look the same.
      if (!found) throw new WorkspaceError('NOT_FOUND', 404);
      const w = found.workspace;
      const members = (
        await store.pool.query(
          'SELECT principal_id,wallet,role FROM synq_ws_members WHERE workspace_id=$1 ORDER BY joined_at,principal_id',
          [w.id],
        )
      ).rows;
      const sums = async (sql: string) =>
        optional(new Map<string, bigint>(), async () => {
          const r = await store.pool.query(sql, [w.id]);
          return new Map(
            r.rows.map((x) => [String(x.principal_id), BigInt(x.total)]),
          );
        });
      const [paid, refunded, view, actions] = await Promise.all([
        sums(
          "SELECT principal_id,sum(amount)::text AS total FROM synq_ws_contributions WHERE workspace_id=$1 AND state='PAID' GROUP BY principal_id",
        ),
        sums(
          "SELECT principal_id,sum(amount)::text AS total FROM synq_ws_refunds WHERE workspace_id=$1 AND state='PAID' GROUP BY principal_id",
        ),
        deps.contributions
          ? optional(null, () =>
              deps.contributions!.service.view(w.id, s.principalId),
            )
          : Promise.resolve(null),
        deps.governance
          ? optional([], () => deps.governance!.list(w.id, s.principalId))
          : Promise.resolve([]),
      ]);
      const status = {
        OPEN: 'REQUESTED',
        PAID: 'CREDITED',
        REVIEW: 'PENDING',
      } as const;
      return {
        circle: await circleSummary(w, found.role, s.principalId),
        members: members.map((m) => ({
          principalId: String(m.principal_id),
          walletHint: hint(getAddress(String(m.wallet))),
          role: m.role as Role,
          contributed: String(paid.get(String(m.principal_id)) ?? 0n),
          refunded: String(refunded.get(String(m.principal_id)) ?? 0n),
        })),
        contributions: (view?.contributions ?? []).map((c) => ({
          contributionId: c.id,
          payerHint: c.member,
          amount: money(c.amount),
          status: status[c.state as keyof typeof status] ?? 'PENDING',
          txHash: null,
          observedAt: iso(c.paidAt ?? c.createdAt),
        })),
        proposals: actions.map((v) => {
          const a = v.action as Record<string, unknown>;
          const kind = String(a.kind);
          return {
            proposalId: String(a.id),
            kind:
              kind === 'PAY_VENDOR'
                ? ('PAYMENT' as const)
                : kind === 'REFUND_MEMBER'
                  ? ('REFUND' as const)
                  : kind.startsWith('TREASURY')
                    ? ('OTHER' as const)
                    : ('SETTINGS' as const),
            title: kind.replaceAll('_', ' ').toLowerCase(),
            amount: typeof a.amount === 'string' ? money(a.amount) : null,
            recipientHint:
              typeof a.recipient === 'string'
                ? hint(getAddress(a.recipient))
                : null,
            approvals: v.signedBy.length,
            threshold: w.threshold ?? 1,
            status: v.state,
            txHash: txHash(
              (v.evidence as { txHash?: unknown } | null)?.txHash ?? null,
            ),
          };
        }),
        capabilities: {
          groupFunds: deps.contributions
            ? {
                status: 'AVAILABLE' as const,
                reason:
                  'Contributions are credited only to the paying wallet; spending and refunds need the owner quorum.',
              }
            : {
                status: 'BLOCKED' as const,
                reason: 'The workspace vault runtime is not configured.',
              },
        },
      };
    }),
  );

  return { implemented };
}
