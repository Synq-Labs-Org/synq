import type { WorkspaceTeam } from '@synq/workspaces/team';
import type { WorkspaceDeals } from '@synq/workspaces/deals';
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AcceptInviteSchema,
  CompleteLoginSchema,
  WorkspaceError,
  WorkspaceIdSchema,
  loginTypedData,
  PostgresWorkspaceStore,
  workspaceView,
  type WorkspaceVaultSetups,
  type WorkspaceChannelLinks,
} from '@synq/workspaces';
import { IdentityError } from '@synq/identity';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';
import type { WorkspaceGovernance } from '@synq/workspaces/governance';
import type { WorkspaceRevenue } from '@synq/workspaces/revenue';
import type { WorkspaceInvoices } from '@synq/workspaces/invoices';
import type { WorkspaceBooks } from '@synq/workspaces/books';
import type { WorkspaceDealEscrow } from '@synq/execution-worker/workspace-escrow';

const COOKIE = '__Host-synq_workspace';
export function workspaceCapabilities(
  vaultReady = false,
  telegramReady = false,
  financeReady = false,
  payoutReady = false,
  screening?: { status: string; providerId: string; reason: string },
) {
  const blocked = (reason: string) => ({ status: 'BLOCKED' as const, reason });
  return {
    chainId: 5042002,
    network: 'Arc testnet',
    moneyApproval: 'OWNER_EIP712_KERNEL_ONE_USE_GRANT',
    financeSettings: financeReady
      ? {
          status: 'AVAILABLE',
          reason:
            'Current Safe quorum signs vendor attestations and versioned budgets; changed destinations wait at least 24 hours.',
        }
      : blocked('Workspace finance worker is not configured.'),
    payoutRequests: payoutReady
      ? {
          status: 'AVAILABLE',
          reason:
            'Persistent proposals and separate mandate/payment signatures; chat never approves.',
        }
      : blocked('Workspace payout worker is not configured.'),
    payoutExecution:
      payoutReady && screening?.status === 'AVAILABLE'
        ? {
            status: 'AVAILABLE',
            screening: screening.providerId,
            reason: `Executes only after the owner quorum signs and the Kernel issues a one-use grant. Recipient screening: ${screening.reason}.`,
          }
        : blocked(
            `Wallet screening is unavailable${screening ? ` (${screening.reason})` : ''}. Requests can be reviewed, but execution fails closed.`,
          ),
    workspaces: {
      status: 'AVAILABLE',
      scope: vaultReady ? 'SIGNED_VAULT_SETUP' : 'IDENTITY_AND_FORMATION_ONLY',
    },
    vaultCreation: vaultReady
      ? {
          status: 'AVAILABLE',
          reason:
            'All proposed owners must sign setup; capped sponsored Arc testnet execution only.',
        }
      : blocked(
          'Owner-signed setup, Kernel admission and sponsor outbox are not connected yet.',
        ),
    circleWallets: blocked(
      'Requires Circle credentials and enrollment integration; provisioning adapter is test-proven only.',
    ),
    gasStation: blocked('Requires Circle Wallets and a sponsorship policy.'),
    usyc: blocked('Requires a per-wallet eligibility check.'),
    earn: blocked('Requires workspace reserves and owner-signed execution.'),
    swap: blocked('Requires workspace owner-signed guarded execution.'),
    duffel: blocked('Workspace booking integration is not connected.'),
    lithic: blocked('Workspace sandbox card integration is not connected.'),
    cctp: blocked('Workspace settlement integration is not connected.'),
    gateway: blocked('Workspace settlement integration is not connected.'),
    channelBinding: telegramReady
      ? {
          status: 'AVAILABLE',
          reason:
            'Telegram provider proof, privately delivered code and wallet signature required. iMessage needs a verified bridge.',
        }
      : blocked(
          'Requires authenticated channel-link proof; URL parameters are not proof.',
        ),
  };
}

export function registerWorkspaceRoutes(
  app: FastifyInstance,
  store: PostgresWorkspaceStore,
  vault?: { setups: WorkspaceVaultSetups; wake(): void },
  channels?: WorkspaceChannelLinks,
  finance?: WorkspaceFinance,
  payouts?: {
    service: WorkspacePayouts;
    wake(): void;
    screening?: () => { status: string; providerId: string; reason: string };
  },
  governance?: { service: WorkspaceGovernance; wake(): void },
  invoices?: () => WorkspaceInvoices | undefined,
  revenue?: WorkspaceRevenue,
  deals?: () => WorkspaceDeals | undefined,
  team?: WorkspaceTeam,
  books?: WorkspaceBooks,
  escrow?: () => WorkspaceDealEscrow | undefined,
) {
  const handle = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    reply.header('cache-control', 'no-store');
    try {
      return reply.send(await run());
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: 'INVALID_REQUEST',
          message: 'Invalid workspace request.',
        });
      if (error instanceof WorkspaceError)
        return reply.code(error.status).send({
          error: error.code,
          message: error.code.replaceAll('_', ' ').toLowerCase(),
        });
      if (error instanceof IdentityError)
        return reply.code(403).send({
          error: error.code,
          message:
            'Channel identity proof or wallet signature was not accepted.',
        });
      // SQL errors may contain session hashes or invite digests. Never log request data.
      return reply.code(500).send({
        error: 'WORKSPACE_UNAVAILABLE',
        message: 'Workspace service unavailable.',
      });
    }
  };
  const origin = (req: FastifyRequest) => {
    if (req.headers.origin !== store.origin)
      throw new WorkspaceError('ORIGIN_MISMATCH', 403);
  };
  const token = (req: FastifyRequest) => {
    const bearer = req.headers.authorization;
    if (bearer !== undefined) {
      if (!/^Bearer [0-9a-f]{64}$/.test(bearer))
        throw new WorkspaceError('UNAUTHENTICATED', 401);
      return { value: bearer.slice(7), audience: 'native' as const };
    }
    const cookies = (req.headers.cookie ?? '').split(';').map((p) => p.trim());
    const found = cookies.filter((p) => p.startsWith(`${COOKIE}=`));
    if (found.length !== 1) throw new WorkspaceError('UNAUTHENTICATED', 401);
    return {
      value: found[0]!.slice(COOKIE.length + 1),
      audience: 'web' as const,
    };
  };
  const auth = async (req: FastifyRequest, mutation = false) => {
    const t = token(req);
    if (t.audience === 'web' && mutation) origin(req);
    const session = await store.session(t.value, t.audience);
    await store.throttle(`principal:${session.principalId}`, 120);
    return session;
  };
  const id = async (req: FastifyRequest) => {
    const workspaceId = z
      .strictObject({ workspaceId: WorkspaceIdSchema })
      .parse(req.params).workspaceId;
    await store.throttle(`workspace:${workspaceId}`, 240);
    return workspaceId;
  };
  const anonymous = async (req: FastifyRequest) => {
    const address = createHash('sha256').update(req.ip).digest('hex');
    await store.throttle(`auth:${address}`, 20);
  };
  app.get('/v2/capabilities', (_req, reply) =>
    handle(reply, async () => ({
      ...workspaceCapabilities(
        Boolean(vault),
        Boolean(channels),
        Boolean(finance),
        Boolean(payouts),
        payouts?.screening?.(),
      ),
      workspaceTeam: team
        ? {
            status: 'AVAILABLE',
            reason:
              'Workspace facts and explicit review-only payment proposals; missing sources remain unknown. Spending requires the existing owner quorum and Kernel executor.',
          }
        : { status: 'BLOCKED', reason: 'Workspace finance team unavailable.' },
      revenuePolicies: revenue
        ? {
            status: 'AVAILABLE',
            reason:
              'Current Safe quorum signs exact policy and derived mandate; workspace budgets and verified vendors apply.',
          }
        : {
            status: 'BLOCKED',
            reason: 'Workspace revenue service unavailable.',
          },
      automaticSplits:
        revenue && books && payouts?.screening?.().status === 'AVAILABLE'
          ? {
              status: 'AVAILABLE',
              reason:
                'Finalized invoice receipts split under the active quorum-signed revenue policy, after holding quorum-approved payables, milestones and recurring bills. Recipients are OFAC SDN list screened (list-only). Noninvoice receipts remain unapplied liabilities.',
            }
          : {
              status: 'BLOCKED',
              reason: `Automatic splits need ${[
                !revenue && 'the revenue service',
                !books && 'the payables and bills books',
                payouts?.screening?.().status !== 'AVAILABLE' &&
                  'available recipient screening',
              ]
                .filter(Boolean)
                .join(', ')}.`,
            },
      dealDrafts: deals?.()
        ? {
            status: 'AVAILABLE',
            reason:
              'Select three distinct signed-in workspace members; contracting parties sign their own terms.',
          }
        : { status: 'BLOCKED', reason: 'Workspace Deal Room is unavailable.' },
      dealExecution: escrow?.()
        ? {
            status: 'AVAILABLE',
            reason:
              'Each party funds, releases, refunds or disputes from its own wallet. The server prepares the exact escrow call, the party signs a bounded mandate and an approval, the Kernel grants it once, and the broadcast transaction is proven on chain before the deal records it.',
          }
        : {
            status: 'BLOCKED',
            reason:
              'Workspace escrow authorization and executor are not connected yet.',
          },
      invoices: invoices?.()
        ? {
            status: 'AVAILABLE',
            reason:
              'Workspace issuer, current-owner signature, external-wallet Memo checkout.',
          }
        : {
            status: 'BLOCKED',
            reason:
              'Requires the workspace invoice service and configured checkout links.',
          },
    })),
  );
  app.post('/v2/auth/challenge', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      // Native clients sign the same configured origin in their explicit native audience.
      if ((req.body as { audience?: unknown } | null)?.audience !== 'native')
        origin(req);
      const challenge = await store.challenge(req.body);
      return {
        challengeId: challenge.id,
        typedData: loginTypedData(challenge),
      };
    }),
  );
  app.post('/v2/auth/session', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      const body = CompleteLoginSchema.parse(req.body);
      // Web sessions can be set only by a same-origin request. Native sessions never set cookies.
      const r = await store.pool.query(
        'SELECT data FROM synq_ws_challenges WHERE id=$1',
        [body.challengeId],
      );
      if (r.rows[0]?.data?.audience !== 'native') origin(req);
      const session = await store.login(
        body.challengeId,
        body.signature as `0x${string}`,
      );
      if (session.audience === 'web') {
        reply.header(
          'set-cookie',
          `${COOKIE}=${session.token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=900`,
        );
        return {
          principalId: session.principalId,
          expiresAt: session.expiresAt,
        };
      }
      return {
        principalId: session.principalId,
        expiresAt: session.expiresAt,
        token: session.token,
      };
    }),
  );
  app.post('/v2/auth/logout', (req, reply) =>
    handle(reply, async () => {
      await auth(req, true);
      const t = token(req);
      await store.logout(t.value);
      if (t.audience === 'web')
        reply.header(
          'set-cookie',
          `${COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`,
        );
      return { ok: true };
    }),
  );
  app.get('/v2/auth/me', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return { principalId: session.principalId };
    }),
  );
  app.post('/v2/auth/native-code', (req, reply) =>
    handle(reply, async () => {
      z.strictObject({}).parse(req.body);
      const session = await auth(req, true);
      if (session.audience !== 'web')
        throw new WorkspaceError('WEB_SIGN_IN_REQUIRED', 403);
      await store.throttle(`native-code:${session.principalId}`, 5);
      return store.nativeCode(session.principalId);
    }),
  );
  app.post('/v2/auth/native-session', (req, reply) =>
    handle(reply, async () => {
      await anonymous(req);
      const body = z
        .strictObject({ code: z.string().regex(/^[0-9a-f]{48}$/) })
        .parse(req.body);
      return store.redeemNativeCode(body.code);
    }),
  );
  app.get('/v2/workspaces', (req, reply) =>
    handle(reply, async () => ({
      workspaces: await store.list((await auth(req)).principalId),
    })),
  );
  app.post('/v2/workspaces', (req, reply) =>
    handle(reply, async () =>
      workspaceView(
        await store.create((await auth(req, true)).principalId, req.body),
      ),
    ),
  );
  app.get('/v2/workspaces/:workspaceId', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return workspaceView(await store.get(await id(req), session.principalId));
    }),
  );
  if (finance) {
    app.get('/v2/workspaces/:workspaceId/finance', (req, reply) =>
      handle(reply, async () => {
        const session = await auth(req);
        return finance.list(await id(req), session.principalId);
      }),
    );
    if (books)
      app.get('/v2/workspaces/:workspaceId/books', (req, reply) =>
        handle(reply, async () => {
          const session = await auth(req);
          return books.view(await id(req), session.principalId);
        }),
      );
    app.post('/v2/workspaces/:workspaceId/finance/changes', (req, reply) =>
      handle(reply, async () => {
        const session = await auth(req, true);
        return finance.propose(await id(req), session.principalId, req.body);
      }),
    );
    const changeParams = (req: FastifyRequest) =>
      z
        .strictObject({
          workspaceId: WorkspaceIdSchema,
          hash: z.string().regex(/^0x[0-9a-f]{64}$/),
        })
        .parse(req.params);
    app.get('/v2/workspaces/:workspaceId/finance/changes/:hash', (req, reply) =>
      handle(reply, async () => {
        const session = await auth(req),
          p = changeParams(req);
        return finance.change(
          p.workspaceId,
          session.principalId,
          p.hash as `0x${string}`,
        );
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/finance/changes/:hash/approve',
      (req, reply) =>
        handle(reply, async () => {
          const session = await auth(req, true),
            p = changeParams(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const body = z
            .strictObject({
              signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            })
            .parse(req.body);
          return finance.approve(
            p.workspaceId,
            session.principalId,
            p.hash as `0x${string}`,
            body.signature as `0x${string}`,
          );
        }),
    );
  }
  if (payouts) {
    app.get('/v2/workspaces/:workspaceId/risk', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req),
          workspaceId = await id(req);
        await store.membership(workspaceId, s.principalId);
        const [cases, audit] = await Promise.all([
          store.pool.query(
            'SELECT data FROM synq_risk_cases WHERE workspace_id=$1 ORDER BY case_id LIMIT 100',
            [workspaceId],
          ),
          store.pool.query(
            'SELECT data FROM synq_risk_audit WHERE workspace_id=$1 ORDER BY seq DESC LIMIT 50',
            [workspaceId],
          ),
        ]);
        return {
          cases: cases.rows.map((r) => r.data),
          audit: audit.rows.map((r) => r.data),
        };
      }),
    );
    app.get('/v2/workspaces/:workspaceId/payouts', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return {
          payouts: await payouts.service.list(await id(req), s.principalId),
        };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/payouts', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return payouts.service.propose(await id(req), s.principalId, req.body);
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/payouts/:payoutId/cancel',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = z
              .strictObject({
                workspaceId: WorkspaceIdSchema,
                payoutId: z.string().uuid(),
              })
              .parse(req.params);
          z.strictObject({}).parse(req.body);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          return payouts.service.cancel(
            p.workspaceId,
            s.principalId,
            p.payoutId,
          );
        }),
    );
    const paymentParams = (req: FastifyRequest) =>
      z
        .strictObject({
          workspaceId: WorkspaceIdSchema,
          payoutId: z.string().uuid(),
        })
        .parse(req.params);
    app.get('/v2/workspaces/:workspaceId/payouts/:payoutId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req),
          p = paymentParams(req);
        return payouts.service.view(p.workspaceId, s.principalId, p.payoutId);
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/payouts/:payoutId/approve',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = paymentParams(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const hex = z
            .string()
            .regex(/^0x[0-9a-fA-F]{130}$/)
            .transform((v) => v as `0x${string}`);
          const body = z
            .strictObject({ signature: hex, mandateSignature: hex.optional() })
            .parse(req.body);
          const result = await payouts.service.approve(
            p.workspaceId,
            s.principalId,
            p.payoutId,
            body,
          );
          payouts.wake();
          return result;
        }),
    );
  }
  if (governance) {
    app.get('/v2/workspaces/:workspaceId/vault/actions', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return {
          actions: await governance.service.list(await id(req), s.principalId),
        };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/vault/actions', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return governance.service.propose(
          await id(req),
          s.principalId,
          req.body,
        );
      }),
    );
    const actionParams = (req: FastifyRequest) =>
      z
        .strictObject({
          workspaceId: WorkspaceIdSchema,
          actionId: z.string().uuid(),
        })
        .parse(req.params);
    app.get(
      '/v2/workspaces/:workspaceId/vault/actions/:actionId',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req),
            p = actionParams(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          return governance.service.view(
            p.workspaceId,
            s.principalId,
            p.actionId,
          );
        }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/vault/actions/:actionId/approve',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = actionParams(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const hex = z
            .string()
            .regex(/^0x[0-9a-fA-F]{130}$/)
            .transform((v) => v as `0x${string}`);
          const body = z
            .strictObject({ approvalSignature: hex, safeSignature: hex })
            .parse(req.body);
          const result = await governance.service.approve(
            p.workspaceId,
            s.principalId,
            p.actionId,
            body,
          );
          governance.wake();
          return result;
        }),
    );
  }
  if (team) {
    app.get('/v2/workspaces/:workspaceId/team/snapshot', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req),
          data = await team.snapshot(await id(req), s.principalId);
        return {
          world: data.world,
          riskCases: data.riskCases,
          deals: data.deals,
        };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/team/ask', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return team.ask(await id(req), s.principalId, req.body);
      }),
    );
  }
  if (deals) {
    const service = () => {
      const d = deals();
      if (!d) throw new WorkspaceError('WORKSPACE_DEALS_BLOCKED', 503);
      return d;
    };
    const params = (req: FastifyRequest) =>
      z
        .strictObject({
          workspaceId: WorkspaceIdSchema,
          dealId: z.string().regex(/^deal_[0-9a-f]{16,32}$/),
        })
        .parse(req.params);
    app.get('/v2/workspaces/:workspaceId/deal-contacts', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return {
          contacts: await service().contacts(await id(req), s.principalId),
        };
      }),
    );
    app.get('/v2/workspaces/:workspaceId/deals', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return { deals: await service().list(await id(req), s.principalId) };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/deals', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return service().draft(await id(req), s.principalId, req.body);
      }),
    );
    app.get('/v2/workspaces/:workspaceId/deals/:dealId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req),
          p = params(req);
        await store.throttle(`workspace:${p.workspaceId}`, 240);
        return service().get(p.workspaceId, s.principalId, p.dealId);
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/deals/:dealId/attestations/prepare',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req);
          return service().attestationRequest(
            p.workspaceId,
            s.principalId,
            p.dealId,
            req.body,
          );
        }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/deals/:dealId/attestations',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req);
          return service().attest(
            p.workspaceId,
            s.principalId,
            p.dealId,
            req.body,
          );
        }),
    );
    const escrowService = () => {
      const e = escrow?.();
      if (!e) throw new WorkspaceError('WORKSPACE_ESCROW_BLOCKED', 503);
      return e;
    };
    const Hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
    const Sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/);
    app.post(
      '/v2/workspaces/:workspaceId/deals/:dealId/escrow/prepare',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req),
            b = z
              .strictObject({
                op: z.enum(['FUND', 'RELEASE', 'REFUND', 'DISPUTE']),
                milestone: z.number().int().min(0).max(31).nullable(),
              })
              .parse(req.body);
          return escrowService().prepare(
            p.workspaceId,
            s.principalId,
            p.dealId,
            b.op,
            b.milestone,
          );
        }),
    );
    app.post('/v2/workspaces/:workspaceId/escrow/authorize', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true),
          b = z
            .strictObject({
              key: z.string().min(1).max(200),
              mandateSignature: Sig,
              approvalSignature: Sig.optional(),
            })
            .parse(req.body);
        return escrowService().authorize(await id(req), s.principalId, b.key, {
          mandateSignature: b.mandateSignature as `0x${string}`,
          ...(b.approvalSignature
            ? { approvalSignature: b.approvalSignature as `0x${string}` }
            : {}),
        });
      }),
    );
    app.post('/v2/workspaces/:workspaceId/escrow/submit', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true),
          b = z
            .strictObject({
              key: z.string().min(1).max(200),
              hashes: z
                .strictObject({
                  APPROVE: Hash.optional(),
                  OPEN: Hash.optional(),
                  RELEASE: Hash.optional(),
                  WITHDRAW: Hash.optional(),
                  REFUND: Hash.optional(),
                  DISPUTE: Hash.optional(),
                })
                .refine((v) => Object.keys(v).length > 0, 'no hashes'),
            })
            .parse(req.body);
        return escrowService().submit(
          await id(req),
          s.principalId,
          b.key,
          b.hashes as Record<string, `0x${string}`>,
        );
      }),
    );
  }
  if (revenue) {
    app.get('/v2/workspaces/:workspaceId/allocations', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return {
          allocations: await revenue.allocations(await id(req), s.principalId),
        };
      }),
    );
    const params = (req: FastifyRequest) =>
      z
        .strictObject({ workspaceId: WorkspaceIdSchema, policyId: z.uuid() })
        .parse(req.params);
    app.get('/v2/workspaces/:workspaceId/revenue-policies', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return { policies: await revenue.list(await id(req), s.principalId) };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/revenue-policies', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return revenue.propose(await id(req), s.principalId, req.body);
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/revenue-policies/:policyId/approve',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            body = z
              .strictObject({ policy: sig, mandate: sig })
              .parse(req.body);
          return revenue.approve(p.workspaceId, s.principalId, p.policyId, {
            policy: body.policy as `0x${string}`,
            mandate: body.mandate as `0x${string}`,
          });
        }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/revenue-policies/:policyId/revoke',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const body = z
            .strictObject({
              signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            })
            .parse(req.body);
          return revenue.revoke(
            p.workspaceId,
            s.principalId,
            p.policyId,
            body.signature as `0x${string}`,
          );
        }),
    );
  }
  if (invoices) {
    const service = () => {
      const s = invoices();
      if (!s) throw new WorkspaceError('WORKSPACE_INVOICES_BLOCKED', 503);
      return s;
    };
    app.get('/v2/workspaces/:workspaceId/invoices', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req);
        return { invoices: await service().list(await id(req), s.principalId) };
      }),
    );
    app.post('/v2/workspaces/:workspaceId/invoices', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req, true);
        return service().create(await id(req), s.principalId, req.body);
      }),
    );
    const params = (req: FastifyRequest) =>
      z
        .strictObject({
          workspaceId: WorkspaceIdSchema,
          invoiceId: z.string().regex(/^inv_[0-9a-f]{20}$/),
        })
        .parse(req.params);
    app.get('/v2/workspaces/:workspaceId/invoices/:invoiceId', (req, reply) =>
      handle(reply, async () => {
        const s = await auth(req),
          p = params(req);
        await store.throttle(`workspace:${p.workspaceId}`, 240);
        return service().get(p.workspaceId, s.principalId, p.invoiceId);
      }),
    );
    app.post(
      '/v2/workspaces/:workspaceId/invoices/:invoiceId/issue',
      (req, reply) =>
        handle(reply, async () => {
          const s = await auth(req, true),
            p = params(req);
          await store.throttle(`workspace:${p.workspaceId}`, 240);
          const body = z
            .strictObject({
              signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
            })
            .parse(req.body);
          return service().issue(
            p.workspaceId,
            s.principalId,
            p.invoiceId,
            body.signature as `0x${string}`,
          );
        }),
    );
  }
  app.post('/v2/workspaces/:workspaceId/invites', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return store.invite(await id(req), session.principalId, req.body);
    }),
  );
  app.post('/v2/workspace-invites/accept', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return store.accept(
        session.principalId,
        AcceptInviteSchema.parse(req.body).token,
      );
    }),
  );
  const setupPort = () => {
    if (!vault) throw new WorkspaceError('VAULT_CREATION_BLOCKED', 503);
    return vault;
  };
  const channelPort = () => {
    if (!channels) throw new WorkspaceError('CHANNEL_BINDING_BLOCKED', 503);
    return channels;
  };
  app.get('/v2/workspaces/:workspaceId/channels/config', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return channelPort().config(await id(req), session.principalId);
    }),
  );
  app.post('/v2/workspaces/:workspaceId/channels/challenge', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return channelPort().request(
        await id(req),
        session.principalId,
        req.body,
      );
    }),
  );
  app.post('/v2/workspaces/:workspaceId/channels/complete', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return channelPort().complete(
        await id(req),
        session.principalId,
        req.body,
      );
    }),
  );
  app.post('/v2/workspaces/:workspaceId/channels/bind', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return channelPort().bind(await id(req), session.principalId, req.body);
    }),
  );
  app.get('/v2/workspaces/:workspaceId/vault/setup', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req);
      return {
        proposal: await setupPort().setups.view(
          await id(req),
          session.principalId,
        ),
      };
    }),
  );
  app.post('/v2/workspaces/:workspaceId/vault/setup', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      return {
        proposal: await setupPort().setups.propose(
          await id(req),
          session.principalId,
          req.body,
        ),
      };
    }),
  );
  app.post('/v2/workspaces/:workspaceId/vault/setup/approve', (req, reply) =>
    handle(reply, async () => {
      const session = await auth(req, true);
      const body = z
        .strictObject({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
        .parse(req.body);
      const port = setupPort();
      const proposal = await port.setups.approve(
        await id(req),
        session.principalId,
        body.signature as `0x${string}`,
      );
      port.wake();
      return { proposal };
    }),
  );
}
