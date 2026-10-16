import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { FundError, type FundService } from './fund-service.js';
import { BusinessError, type ArcBusiness } from './arc-business.js';

const FundId = z.string().regex(/^fnd_[0-9a-f]{20}$/);
const Key = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const InvoiceId = z.string().regex(/^inv_[0-9a-f]{20}$/);
const ReadQuery = z.object({ k: Key });
const TextBody = (max: number) =>
  z.strictObject({ key: Key, text: z.string().min(1).max(max) });
const InvoiceBody = z.strictObject({
  key: Key,
  payer: z.string().trim().min(1).max(80),
  amount: z.string().max(16),
  description: z.string().trim().min(1).max(200),
  dueInDays: z.number().int().min(1).max(90).optional(),
});
const SplitBody = z.strictObject({ key: Key, amount: z.string().max(16) });

const FUND_MESSAGES: Partial<Record<FundError['code'], string>> = {
  FUND_NOT_FOUND: 'This fund does not exist.',
  FORBIDDEN: 'This link is not valid for the fund.',
};

/** Per fund and hour, like the Ask route. Reads are cheap; drafts and council runs are not. */
export const BUSINESS_LIMITS = {
  read: 120,
  team: 20,
  deal: 10,
  invoice: 20,
} as const;

/**
 * Arc business routes for the Messages app, scoped by the group fund the chat
 * already uses (fund id + fund key). They read, draft or propose only:
 * deals and invoices are signed by the parties on the Synq pages, and the
 * council runs without a Kernel. No key, link secret or grant is ever in a
 * response.
 */
export function registerBusinessRoutes(
  app: FastifyInstance,
  funds: Pick<FundService, 'view'> & { ports: { now(): number } },
  business: ArcBusiness,
) {
  const hits = new Map<string, number[]>();
  const throttle = (fundId: string, bucket: keyof typeof BUSINESS_LIMITS) => {
    const now = funds.ports.now();
    const k = `${bucket}:${fundId}`;
    const recent = (hits.get(k) ?? []).filter((t) => now - t < 3_600);
    if (recent.length >= BUSINESS_LIMITS[bucket])
      throw new BusinessError(
        'RATE_LIMITED',
        429,
        'Too many requests for this fund; try again later.',
      );
    hits.set(k, [...recent, now]);
  };
  /** The fund key gates every route; a wrong key is indistinguishable from no fund. */
  const authorize = async (
    request: { params: unknown },
    key: string,
    bucket: keyof typeof BUSINESS_LIMITS,
  ) => {
    const fundId = FundId.parse((request.params as { fundId: string }).fundId);
    await funds.view(fundId, key);
    throttle(fundId, bucket);
    return fundId;
  };
  const handle = async (reply: FastifyReply, run: () => Promise<unknown>) => {
    try {
      const body = await run();
      reply.header('cache-control', 'no-store');
      return reply.send(body);
    } catch (error) {
      if (error instanceof z.ZodError)
        return reply.code(400).send({
          error: 'INVALID_REQUEST',
          message: 'That request is not valid.',
        });
      if (error instanceof FundError)
        return reply.code(error.status).send({
          error: error.code,
          message: FUND_MESSAGES[error.code] ?? 'That request is not valid.',
        });
      if (error instanceof BusinessError)
        return reply
          .code(error.status)
          .send({ error: error.code, message: error.message });
      reply.log.error({ err: error }, 'business route failed');
      return reply
        .code(500)
        .send({ error: 'INTERNAL', message: 'Something went wrong.' });
    }
  };
  const base = '/v1/funds/:fundId/business';

  app.get(`${base}/capabilities`, (request, reply) =>
    handle(reply, async () => {
      await authorize(request, ReadQuery.parse(request.query).k, 'read');
      return business.capabilities();
    }),
  );
  app.get(`${base}/vendors`, (request, reply) =>
    handle(reply, async () => {
      await authorize(request, ReadQuery.parse(request.query).k, 'read');
      return business.vendors();
    }),
  );
  app.get(`${base}/treasury`, (request, reply) =>
    handle(reply, async () => {
      await authorize(request, ReadQuery.parse(request.query).k, 'read');
      return business.treasury();
    }),
  );
  app.post(`${base}/splits/preview`, (request, reply) =>
    handle(reply, async () => {
      const body = SplitBody.parse(request.body);
      await authorize(request, body.key, 'read');
      return business.splitPreview(body.amount);
    }),
  );
  app.post(`${base}/team/ask`, (request, reply) =>
    handle(reply, async () => {
      const body = TextBody(500).parse(request.body);
      const fundId = await authorize(request, body.key, 'team');
      return business.teamAsk(
        body.text.replace(/\s+/g, ' ').trim().slice(0, 500),
        fundId,
      );
    }),
  );
  app.post(`${base}/deals`, (request, reply) =>
    handle(reply, async () => {
      const body = TextBody(1_000).parse(request.body);
      const fundId = await authorize(request, body.key, 'deal');
      return business.draftDeal(body.text.trim(), fundId);
    }),
  );
  app.post(`${base}/invoices`, (request, reply) =>
    handle(reply, async () => {
      const body = InvoiceBody.parse(request.body);
      const fundId = await authorize(request, body.key, 'invoice');
      return business.createInvoice(fundId, body);
    }),
  );
  app.get(`${base}/invoices/:invoiceId`, (request, reply) =>
    handle(reply, async () => {
      const fundId = await authorize(
        request,
        ReadQuery.parse(request.query).k,
        'read',
      );
      return business.invoice(
        fundId,
        InvoiceId.parse((request.params as { invoiceId: string }).invoiceId),
      );
    }),
  );
}
