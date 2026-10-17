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
import type { WorkspaceInvoices } from '@synq/workspaces/invoices';
import type { WorkspaceBooks } from '@synq/workspaces/books';
import type { WorkspaceLeads } from '@synq/workspaces/leads';
import type { WorkspaceOffers } from '@synq/workspaces/offers';
import type { AgentEvents } from '@synq/workspaces/agent-events';
import type { AppApprovals } from './app-approvals.js';
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
  approvals?: AppApprovals;
  invoices?: () => WorkspaceInvoices | undefined;
  books?: WorkspaceBooks;
  /** The /v2 capability report; entries with a status and reason are passed on. */
  capabilities?: () => Record<string, unknown>;
  leads?: WorkspaceLeads;
  offers?: WorkspaceOffers;
  events?: AgentEvents;
  /** How long one event-stream connection stays open (default 10 minutes). */
  streamWindowMs?: number;
  /** Poll interval of the event stream (default 2 seconds). */
  streamPollMs?: number;
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
const STATUSES = new Set([
  'AVAILABLE',
  'BLOCKED',
  'NOT_CONFIGURED',
  'UNSUPPORTED',
  'OFFCHAIN_ONLY',
  'ONCHAIN_AUTHENTICATED',
  'VERIFIED_TESTNET',
]);
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

  // MARK: Approvals

  const approvals = deps.approvals;
  if (approvals) {
    route('approvals.list');
    app.get('/v3/approvals', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const q = PageQuery.parse(req.query);
        const after = cursorValue(q.cursor);
        const limit = q.limit ?? 20;
        const all = (await approvals.pending(s.principalId, s.wallet)).map(
          (p) => p.item,
        );
        const start =
          after === null ? 0 : all.findIndex((i) => i.requestId === after) + 1;
        const page = all.slice(start, start + limit);
        return {
          items: page,
          nextCursor:
            start + limit < all.length
              ? cursorOf(page.at(-1)!.requestId)
              : null,
        };
      }),
    );
    route('approvals.get');
    app.get('/v3/approvals/:requestId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const { requestId } = z
          .strictObject({ requestId: z.uuid() })
          .parse(req.params);
        const p = await approvals.find(s.principalId, s.wallet, requestId);
        return {
          request: p.item,
          signer: hint(getAddress(s.wallet)),
          signerAddress: getAddress(s.wallet),
          enforcedBy: p.enforcedBy,
          steps: p.steps,
        };
      }),
    );
    route('approvals.sign');
    app.post('/v3/approvals/:requestId/signature', (req, reply) =>
      handle(reply, async () => {
        const s = await mutation(req);
        const { requestId } = z
          .strictObject({ requestId: z.uuid() })
          .parse(req.params);
        return approvals.sign(s.principalId, s.wallet, requestId, req.body);
      }),
    );
  }

  // MARK: Business overview

  route('workspace.overview');
  app.get('/v3/workspaces/:workspaceId/overview', (req, reply) =>
    handle(reply, async () => {
      const s = await auth(req);
      const { workspaceId } = z
        .strictObject({ workspaceId: z.uuid() })
        .parse(req.params);
      await store.throttle(`workspace:${workspaceId}`, 240);
      const found = (await store.listWithRoles(s.principalId)).find(
        (w) => w.workspace.id === workspaceId,
      );
      if (!found) throw new WorkspaceError('NOT_FOUND', 404);
      const w = found.workspace;
      const invoices = deps.invoices?.();
      const [held, open, payables, pending] = await Promise.all([
        vaultBalance(w),
        invoices
          ? optional(null, () => invoices.list(w.id, s.principalId))
          : Promise.resolve(null),
        deps.books
          ? optional(null, () => deps.books!.view(w.id, s.principalId))
          : Promise.resolve(null),
        approvals
          ? approvals.pending(s.principalId, s.wallet)
          : Promise.resolve([]),
      ]);
      const receivable = (open ?? []).filter(
        (i) => i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID',
      );
      const owed = (payables?.payables ?? []).filter(
        (p) => p.status === 'OPEN',
      );
      const capabilities: Record<string, { status: string; reason: string }> =
        {};
      for (const [key, value] of Object.entries(deps.capabilities?.() ?? {}))
        if (
          value &&
          typeof value === 'object' &&
          STATUSES.has(String((value as { status?: unknown }).status)) &&
          typeof (value as { reason?: unknown }).reason === 'string'
        )
          capabilities[key] = {
            status: String((value as { status: string }).status),
            reason: String((value as { reason: string }).reason).slice(0, 600),
          };
      capabilities.leadInbox = deps.leads
        ? {
            status: 'AVAILABLE',
            reason:
              'Private enquiries through single-use invitations; prospects are outside counterparties, never members.',
          }
        : {
            status: 'NOT_CONFIGURED',
            reason: 'The private lead inbox is not configured on this server.',
          };
      capabilities.agentRuns = deps.events
        ? {
            status: 'AVAILABLE',
            reason:
              'Typed agent steps with the actor, status and proof level of each; final only from chain evidence.',
          }
        : {
            status: 'NOT_CONFIGURED',
            reason: 'Agent run history is not configured on this server.',
          };
      return {
        workspaceId: w.id,
        displayName: w.displayName,
        status: w.status,
        role: found.role,
        balances: held ? [held] : [],
        receivables: {
          open: receivable.length,
          units: String(
            receivable.reduce((n, i) => n + BigInt(i.amountDue), 0n),
          ),
        },
        payables: {
          open: owed.length,
          units: String(owed.reduce((n, p) => n + BigInt(p.amount), 0n)),
        },
        leads: deps.leads
          ? await deps.leads.counts(w.id)
          : { open: 0, needsOwner: 0 },
        pendingApprovals: pending.filter((p) => p.item.workspaceId === w.id)
          .length,
        agentHighlights: deps.events ? await deps.events.highlights(w.id) : [],
        capabilities,
        freshness: {
          observedAt: iso(now()),
          source: held ? ('CHAIN' as const) : ('LEDGER' as const),
          stale: !held && w.status === 'ACTIVE',
        },
      };
    }),
  );

  // MARK: Leads and offers

  const leads = deps.leads;
  const offers = deps.offers;
  if (leads) {
    const leadParams = (req: FastifyRequest) =>
      z
        .strictObject({ workspaceId: z.uuid(), leadId: z.uuid() })
        .parse(req.params);
    route('workspace.inbox');
    app.get('/v3/workspaces/:workspaceId/inbox', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const { workspaceId } = z
          .strictObject({ workspaceId: z.uuid() })
          .parse(req.params);
        const q = PageQuery.extend({
          stage: z
            .string()
            .regex(/^[A-Z_]{3,40}$/)
            .optional(),
          handling: z.enum(['AGENT', 'HUMAN', 'FROZEN']).optional(),
        }).parse(req.query);
        return leads.inbox(workspaceId, s.principalId, q);
      }),
    );
    route('workspace.lead');
    app.get('/v3/workspaces/:workspaceId/leads/:leadId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const p = leadParams(req);
        return leads.detail(
          p.workspaceId,
          s.principalId,
          p.leadId,
          offers ? (id) => offers.forLead(id) : undefined,
        );
      }),
    );
    route('workspace.leadMessage');
    app.post(
      '/v3/workspaces/:workspaceId/leads/:leadId/message',
      (req, reply) =>
        handle(reply, async () => {
          const s = await mutation(req);
          const p = leadParams(req);
          return leads.fromStaff(
            p.workspaceId,
            s.principalId,
            p.leadId,
            req.body,
            String(req.headers['idempotency-key']),
          );
        }),
    );
    route('workspace.leadTakeover');
    app.post(
      '/v3/workspaces/:workspaceId/leads/:leadId/takeover',
      (req, reply) =>
        handle(reply, async () => {
          const s = await mutation(req);
          const p = leadParams(req);
          return leads.takeover(
            p.workspaceId,
            s.principalId,
            p.leadId,
            req.body,
          );
        }),
    );
    route('workspace.leadInvite');
    app.post('/v3/workspaces/:workspaceId/lead-invites', (req, reply) =>
      handle(reply, async () => {
        const s = await mutation(req);
        const { workspaceId } = z
          .strictObject({ workspaceId: z.uuid() })
          .parse(req.params);
        await store.throttle(`lead-invite:${workspaceId}`, 30);
        return leads.invite(workspaceId, s.principalId, req.body);
      }),
    );
    route('leadInvite.redeem');
    app.post('/v3/lead-invites/redeem', (req, reply) =>
      handle(reply, async () => {
        const s = await mutation(req);
        await store.throttle(`lead-redeem:${s.principalId}`, 10);
        const body = z
          .strictObject({ token: z.string().max(64) })
          .parse(req.body);
        const r = await leads.redeem({
          token: body.token,
          channel: 'web',
          identity: s.principalId,
          deliveryRef: null,
          principalId: s.principalId,
        });
        return { leadId: r.leadId, bound: r.bound };
      }),
    );
  }
  if (leads && offers) {
    route('workspace.leadOffer');
    app.post('/v3/workspaces/:workspaceId/leads/:leadId/offers', (req, reply) =>
      handle(reply, async () => {
        const s = await mutation(req);
        const p = z
          .strictObject({ workspaceId: z.uuid(), leadId: z.uuid() })
          .parse(req.params);
        const body = z
          .strictObject({ terms: z.unknown(), offerId: z.uuid().optional() })
          .parse(req.body);
        const r = await offers.send({
          workspaceId: p.workspaceId,
          leadId: p.leadId,
          terms: body.terms,
          actor: { kind: 'STAFF', principalId: s.principalId },
          ...(body.offerId ? { offerId: body.offerId } : {}),
        });
        return {
          sent: r.sent,
          checks: r.validation.checks,
          needsOwner: r.validation.needsOwner,
          offer: r.sent ? r.offer : null,
        };
      }),
    );
    route('workspace.offerValidate');
    app.post(
      '/v3/workspaces/:workspaceId/offers/:offerId/versions/:version/validate',
      (req, reply) =>
        handle(reply, async () => {
          const s = await mutation(req);
          const p = z
            .strictObject({
              workspaceId: z.uuid(),
              offerId: z.uuid(),
              version: z.coerce.number().int().positive(),
            })
            .parse(req.params);
          return offers.revalidate(
            p.workspaceId,
            s.principalId,
            p.offerId,
            p.version,
          );
        }),
    );
    route('workspace.commercialPolicies');
    app.get('/v3/workspaces/:workspaceId/commercial-policies', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const { workspaceId } = z
          .strictObject({ workspaceId: z.uuid() })
          .parse(req.params);
        return { policies: await offers.policies(workspaceId, s.principalId) };
      }),
    );
    route('workspace.commercialPolicyPropose');
    app.post('/v3/workspaces/:workspaceId/commercial-policies', (req, reply) =>
      handle(reply, async () => {
        const s = await mutation(req);
        const { workspaceId } = z
          .strictObject({ workspaceId: z.uuid() })
          .parse(req.params);
        return offers.proposePolicy(workspaceId, s.principalId, req.body);
      }),
    );
  }

  // MARK: Agent runs and the event stream

  const events = deps.events;
  if (events) {
    route('workspace.agentRuns');
    app.get('/v3/workspaces/:workspaceId/agent-runs', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const { workspaceId } = z
          .strictObject({ workspaceId: z.uuid() })
          .parse(req.params);
        return events.runs(
          workspaceId,
          s.principalId,
          PageQuery.parse(req.query),
        );
      }),
    );
    route('workspace.agentRun');
    app.get('/v3/workspaces/:workspaceId/agent-runs/:runId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const p = z
          .strictObject({ workspaceId: z.uuid(), runId: z.uuid() })
          .parse(req.params);
        return events.detail(p.workspaceId, s.principalId, p.runId);
      }),
    );
    const Cursor = z.string().regex(/^[0-9]{1,20}$/);
    route('events.poll');
    app.get('/v3/events/since', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        const q = z
          .strictObject({ cursor: Cursor.optional() })
          .parse(req.query);
        const page = await events.since(
          s.principalId,
          q.cursor ?? (await events.head()),
        );
        return {
          items: page.items,
          nextCursor: page.more ? page.nextCursor : null,
        };
      }),
    );
    route('events.stream');
    app.get('/v3/events', async (req, reply) => {
      let session: Awaited<ReturnType<typeof auth>>;
      let start: string;
      try {
        session = await auth(req);
        const q = z
          .strictObject({ cursor: Cursor.optional() })
          .parse(req.query);
        const last = req.headers['last-event-id'];
        start =
          q.cursor ??
          (typeof last === 'string' && Cursor.safeParse(last).success
            ? last
            : await events.head());
      } catch (error) {
        return handle(reply, async () => {
          throw error;
        });
      }
      const t = token(req);
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let closed = false;
      req.raw.on('close', () => {
        closed = true;
      });
      const until = Date.now() + (deps.streamWindowMs ?? 600_000);
      const poll = deps.streamPollMs ?? 2000;
      let cursor = start;
      let beat = Date.now();
      res.write(`retry: ${poll}\n\n`);
      while (!closed && Date.now() < until) {
        try {
          // Each poll re-checks the session; membership is re-checked by the query.
          await store.session(t.value, t.audience);
        } catch {
          res.write(
            `event: CONTEXT_REVOKED\ndata: ${JSON.stringify({ type: 'CONTEXT_REVOKED' })}\n\n`,
          );
          break;
        }
        const page = await events.since(session.principalId, cursor, 100);
        for (const item of page.items) {
          res.write(
            `id: ${item.cursor}\nevent: ${item.type}\ndata: ${JSON.stringify(item)}\n\n`,
          );
          cursor = item.cursor;
        }
        if (Date.now() - beat > 15_000) {
          res.write(': keep-alive\n\n');
          beat = Date.now();
        }
        if (!page.more) await new Promise((r) => setTimeout(r, poll));
      }
      res.end();
    });
  }

  return { implemented };
}
