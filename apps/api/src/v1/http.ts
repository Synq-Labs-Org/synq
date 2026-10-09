import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiErrorSchema } from '@synq/schemas';
import type { TokenBucketLimiter } from './rate-limit.js';
import {
  IdentityError,
  canonicalJson,
  isIdentityError,
  type IdentityErrorCode,
  type IdentityStore,
} from '@synq/identity/server';

const STATUS: Record<IdentityErrorCode, number> = {
  INVALID_INPUT: 400,
  CHALLENGE_NOT_FOUND: 404,
  CHALLENGE_CONSUMED: 409,
  CHALLENGE_EXPIRED: 410,
  CHALLENGE_MISMATCH: 409,
  SIGNATURE_MISMATCH: 401,
  PRINCIPAL_EXISTS: 409,
  PRINCIPAL_NOT_FOUND: 404,
  PRINCIPAL_KIND_FORBIDDEN: 403,
  PRINCIPAL_NOT_ELIGIBLE: 403,
  ORIGIN_MISMATCH: 403,
  GROUP_EXISTS: 409,
  GROUP_NOT_FOUND: 404,
  NOT_SAFE_OWNER: 403,
  OPERATOR_IS_OWNER: 403,
  DUPLICATE_MEMBERSHIP: 409,
  MEMBERSHIP_NOT_FOUND: 404,
  MEMBERSHIP_CHANGED: 409,
  DRAFT_EXISTS: 409,
  MANDATE_NOT_FOUND: 404,
  READ_MODEL_UNAVAILABLE: 503,
  DRAFT_NOT_FOUND: 404,
  DRAFT_INVALID: 422,
  DRAFT_INVALIDATED: 409,
  RATE_LIMITED: 429,
  ALREADY_APPROVED: 409,
  DELEGATION_DENIED: 403,
  PROVIDER_BLOCKED: 503,
  PROVIDER_ERROR: 502,
  IDEMPOTENCY_CONFLICT: 409,
  UNAUTHORIZED: 401,
};

export type ApiError = {
  status: number;
  body: z.output<typeof ApiErrorSchema>;
};
export function toApiError(error: unknown): ApiError {
  if (isIdentityError(error))
    return {
      status: STATUS[error.code],
      body: {
        error: error.code,
        message:
          error.code === 'DELEGATION_DENIED' && error.detail
            ? `${error.message}: ${error.detail}`
            : error.message,
      },
    };
  if (error instanceof z.ZodError)
    return {
      status: 400,
      body: { error: 'INVALID_REQUEST', message: 'Request is invalid' },
    };
  if (
    error &&
    typeof error === 'object' &&
    'statusCode' in error &&
    typeof error.statusCode === 'number' &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  )
    return {
      status: error.statusCode,
      body: { error: 'INVALID_REQUEST', message: 'Request is invalid' },
    };
  return {
    status: 500,
    body: { error: 'INTERNAL', message: 'Internal error' },
  };
}

export type RouteContext = {
  store: IdentityStore;
  adminToken: string | null;
  now: () => number;
  limiter: TokenBucketLimiter;
};
export const IDEMPOTENCY_LEASE_SECONDS = 60;

const IdempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_.:-]{8,128}$/);
const digest = (value: string) => createHash('sha256').update(value).digest();

function assertAdmin(request: FastifyRequest, adminToken: string | null): void {
  if (!adminToken) throw new IdentityError('UNAUTHORIZED', 'admin disabled');
  const header = request.headers.authorization ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!timingSafeEqual(digest(presented), digest(adminToken)))
    throw new IdentityError('UNAUTHORIZED');
}

type RouteSpec<
  P extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
> = {
  method: 'GET' | 'POST';
  url: string;
  params?: P;
  body?: B;
  response: R;
  status?: number;
  admin?: boolean;
  handler: (input: {
    params: z.output<P>;
    body: z.output<B>;
  }) => Promise<z.input<R>>;
};

export function route<
  P extends z.ZodType,
  B extends z.ZodType,
  R extends z.ZodType,
>(app: FastifyInstance, ctx: RouteContext, spec: RouteSpec<P, B, R>): void {
  const success = spec.status ?? (spec.method === 'POST' ? 201 : 200);
  app.route({
    method: spec.method,
    url: spec.url,
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      if (spec.admin) assertAdmin(request, ctx.adminToken);
      else if (spec.method === 'POST') {
        const principal =
          request.body &&
          typeof request.body === 'object' &&
          'principalId' in request.body &&
          typeof request.body.principalId === 'string'
            ? request.body.principalId.slice(0, 160)
            : null;
        if (
          !ctx.limiter.take(`ip:${request.ip}`) ||
          (principal !== null && !ctx.limiter.take(`principal:${principal}`))
        )
          throw new IdentityError('RATE_LIMITED');
      }
      const params = (spec.params ?? z.object({})).parse(
        request.params,
      ) as z.output<P>;
      const body = (spec.body ?? z.undefined()).parse(
        spec.method === 'GET' ? undefined : request.body,
      ) as z.output<B>;
      const run = async () =>
        spec.response.parse(await spec.handler({ params, body }));
      if (spec.method === 'GET') return reply.code(success).send(await run());
      const key = IdempotencyKeySchema.safeParse(
        request.headers['idempotency-key'],
      );
      if (!key.success)
        throw new IdentityError('INVALID_INPUT', 'idempotency-key header');
      const caller = spec.admin ? 'admin' : `ip:${request.ip}`;
      const scope = `${caller}|${spec.method} ${spec.url}`;
      const requestHash = digest(
        canonicalJson({ params, body: request.body ?? null }),
      ).toString('hex');
      const claimed = await ctx.store.transaction((tx) =>
        tx.claimIdempotency(
          {
            scope,
            key: key.data,
            requestHash,
            state: 'PENDING',
            statusCode: null,
            response: null,
            createdAt: ctx.now(),
          },
          ctx.now() - IDEMPOTENCY_LEASE_SECONDS,
        ),
      );
      if (claimed) {
        if (claimed.requestHash !== requestHash || claimed.state !== 'DONE')
          throw new IdentityError('IDEMPOTENCY_CONFLICT');
        return reply
          .code(claimed.statusCode ?? 500)
          .header('idempotent-replay', 'true')
          .send(claimed.response);
      }
      let status = success,
        payload: unknown;
      try {
        payload = await run();
      } catch (error) {
        const mapped = toApiError(error);
        if (mapped.status >= 500) {
          await ctx.store.transaction((tx) =>
            tx.releaseIdempotency(scope, key.data),
          );
          throw error;
        }
        status = mapped.status;
        payload = mapped.body;
      }
      await ctx.store.transaction((tx) =>
        tx.completeIdempotency(scope, key.data, status, payload),
      );
      return reply.code(status).send(payload);
    },
  });
}
