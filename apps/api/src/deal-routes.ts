import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHAINS } from '@synq/chain-registry/arc';
import {
  DEAL_DECISION_TYPES,
  DealRoomError,
  acceptsFor,
  decimalOf,
  dealDomain,
  verifyDealLink,
  type DealRoomService,
  type DealView,
} from '@synq/dealroom';

/**
 * Deal Room review and signing API for `/deal/[id]`. The link token is an
 * HMAC navigation token (view only). Signing is an EIP-712 signature made in
 * the party's own wallet over the exact version; the service recovers it and
 * compares it with the party's verified wallet. Nothing here signs or moves
 * funds; funding and releases go through the Kernel and the executor.
 */

export type DealRouteDeps = {
  service: DealRoomService;
  linkKey: Uint8Array;
};

const EIP712_DOMAIN = [
  { name: 'name', type: 'string' },
  { name: 'version', type: 'string' },
  { name: 'chainId', type: 'uint256' },
  { name: 'verifyingContract', type: 'address' },
];

/** bigint -> decimal string, so typed data survives JSON for eth_signTypedData_v4. */
const jsonSafe = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)),
  );

export function dealPageView(service: DealRoomService, view: DealView) {
  const v = view.current;
  const t = v.terms;
  const dec = (u: bigint) => decimalOf(u, t.asset.decimals);
  const chain = Object.values(CHAINS).find(
    (c) => c.chainId === t.asset.chainId,
  )!;
  const typed = service.typedData(v);
  const signed = acceptsFor(view.signatures, v);
  return {
    dealId: view.deal.dealId,
    status: view.deal.status,
    version: v.version,
    termsHash: v.termsHash,
    parentTermsHash: v.parentTermsHash,
    proposedBy: v.proposedBy,
    terms: {
      title: t.title,
      scope: t.scope,
      deliverables: t.deliverables,
      asset: t.asset,
      escrow: t.escrow,
      total: dec(t.total),
      deposit: dec(t.deposit),
      refundAfter: t.refundAfter,
      expiresAt: t.expiresAt,
      disputePeriodSeconds: t.dispute.periodSeconds,
      parties: (['client', 'freelancer', 'arbiter'] as const).map((k) => ({
        role: t[k].role,
        name: t[k].displayName,
        wallet: t[k].wallet,
        verifiedBy: t[k].verification.method,
      })),
      milestones: t.milestones.map((m) => ({
        index: m.index,
        title: m.title,
        amount: dec(m.amount),
        deadline: m.deadline,
        acceptanceCondition: m.acceptanceCondition,
        evidenceType: m.evidenceType,
        payee: m.payee,
        status: view.deal.milestones[m.index]?.status ?? 'PENDING',
      })),
    },
    ambiguities: v.ambiguities,
    provenance: service.provenance(view),
    signatures: view.signatures.map((s) => ({
      version: s.version,
      role: s.role,
      signer: s.signer,
      decision: s.decision,
      reason: s.reason,
      signedAt: s.signedAt,
    })),
    signedCurrent: {
      CLIENT: Boolean(signed.CLIENT),
      FREELANCER: Boolean(signed.FREELANCER),
    },
    escrowBinding: view.deal.escrow,
    chain: {
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpcUrls[0]!,
      explorer: chain.explorer,
    },
    /** Exactly what a party signs to accept this version. */
    acceptTypedData: jsonSafe({
      ...typed,
      types: { EIP712Domain: EIP712_DOMAIN, ...typed.types },
    }),
    /** Domain and types for a signed REJECT / CANCEL of this version. */
    decision: {
      domain: dealDomain(t.asset.chainId, t.escrow),
      types: { EIP712Domain: EIP712_DOMAIN, ...DEAL_DECISION_TYPES },
      primaryType: 'DealDecision',
    },
  };
}

const Id = z.string().regex(/^deal_[A-Za-z0-9_]{1,64}$/);
const Token = z.object({ t: z.string().min(10).max(64) });
const Sig = z.string().regex(/^0x[0-9a-fA-F]{130}$/);

export async function dealRoutes(app: FastifyInstance, deps: DealRouteDeps) {
  const open = (params: unknown, query: unknown) => {
    const id = Id.parse((params as { id: string }).id);
    const { t } = Token.parse(query);
    if (!verifyDealLink(deps.linkKey, id, t))
      throw new DealRoomError('NOT_FOUND', 'unknown deal link');
    return id;
  };
  const fail = (e: unknown) => {
    if (e instanceof DealRoomError)
      return {
        status: e.code === 'NOT_FOUND' ? 404 : 409,
        body: { error: e.code, message: e.message },
      };
    if (e instanceof z.ZodError)
      return {
        status: 400,
        body: { error: 'BAD_REQUEST', message: 'invalid input' },
      };
    throw e;
  };

  app.get('/v1/deals/:id', async (req, reply) => {
    try {
      const id = open(req.params, req.query);
      return dealPageView(deps.service, await deps.service.view(id));
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });

  app.post('/v1/deals/:id/sign', async (req, reply) => {
    try {
      const id = open(req.params, req.query);
      const body = z
        .object({
          version: z.number().int().positive(),
          role: z.enum(['CLIENT', 'FREELANCER']),
          signature: Sig,
        })
        .parse(req.body);
      const view = await deps.service.sign({
        dealId: id,
        version: body.version,
        role: body.role,
        signature: body.signature as `0x${string}`,
      });
      return dealPageView(deps.service, view);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });

  app.post('/v1/deals/:id/decline', async (req, reply) => {
    try {
      const id = open(req.params, req.query);
      const body = z
        .object({
          version: z.number().int().positive(),
          role: z.enum(['CLIENT', 'FREELANCER']),
          decision: z.enum(['REJECT', 'CANCEL']),
          reason: z.string().max(500),
          signature: Sig,
        })
        .parse(req.body);
      const view = await deps.service.decline({
        dealId: id,
        ...body,
        signature: body.signature as `0x${string}`,
      });
      return dealPageView(deps.service, view);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });
}

/**
 * Production wiring: enabled only when `SYNQ_DEALROOM_LINK_KEY` (≥32 bytes,
 * hex) is set. Deal Room tables live in their own migration set on the API
 * database; the escrow and asset come from the Arc registry.
 */
export async function registerDealRoom(input: {
  app: FastifyInstance;
  pool: {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
    connect(): Promise<{
      query(
        text: string,
        values?: unknown[],
      ): Promise<{ rows: Record<string, unknown>[] }>;
      release(): void;
    }>;
  };
  env: NodeJS.ProcessEnv;
}) {
  const raw = input.env.SYNQ_DEALROOM_LINK_KEY;
  if (!raw) return null;
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw))
    throw new Error('SYNQ_DEALROOM_LINK_KEY must be at least 32 bytes of hex');
  const { contract, token } = await import('@synq/chain-registry/arc');
  const { DealRoomService } = await import('@synq/dealroom');
  const { PostgresDealRoomStore } = await import('@synq/dealroom/postgres');
  const store = new PostgresDealRoomStore(input.pool);
  await store.migrate();
  const usdc = token('arc-testnet', 'USDC');
  const service = new DealRoomService(store, {
    now: () => Math.floor(Date.now() / 1000),
    chainName: 'arc-testnet',
    asset: {
      chainId: usdc.chainId,
      network: usdc.network,
      token: usdc.address,
      symbol: 'USDC',
      decimals: usdc.decimals,
    },
    escrow: contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address,
    settings: {
      disputePeriodSeconds: 30 * 86_400,
      refundGraceSeconds: 7 * 86_400,
      offerTtlSeconds: 3 * 86_400,
    },
  });
  await input.app.register(dealRoutes, {
    service,
    linkKey: Buffer.from(raw, 'hex'),
  });
  return { service };
}
