import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  LithicWebhookError,
  PostgresWebhookDeduper,
  verifyLithicWebhook,
  type Json,
  type WebhookDeduper,
} from '@synq/plugin-commerce';

export const LITHIC_WEBHOOK_PATH = '/v1/webhooks/lithic';

/** A verified, first-seen Lithic event. Card data in the payload is never logged. */
export type LithicWebhookEvent = {
  webhookId: string;
  timestamp: number;
  eventType: string | null;
  event: Json;
};

export type LithicWebhookDeps = {
  /** `whsec_…` signing secret from the Lithic dashboard; null leaves the route closed. */
  secret: string | null;
  deduper: WebhookDeduper;
  now: () => number;
  /**
   * Inbox only: the booking workflow reconciles against the Lithic API (the
   * source of truth), so an event never changes money or order state here.
   */
  onEvent?: (event: LithicWebhookEvent) => Promise<void>;
};

/**
 * POST /v1/webhooks/lithic. The raw body is verified (Standard Webhooks
 * HMAC-SHA256 with a timestamp tolerance) before it is parsed; a verified id
 * is claimed once in the durable deduper. A processing failure releases the
 * claim and answers 500 so Lithic redelivers.
 */
export async function lithicWebhookRoutes(
  api: FastifyInstance,
  deps: LithicWebhookDeps,
) {
  api.addContentTypeParser(
    'application/json',
    { parseAs: 'string', bodyLimit: 256 * 1024 },
    (_request, body, done) => done(null, body),
  );
  api.post(LITHIC_WEBHOOK_PATH, async (request, reply) => {
    if (!deps.secret)
      return reply.code(404).send({ error: 'WEBHOOK_NOT_CONFIGURED' });
    const rawBody = typeof request.body === 'string' ? request.body : '';
    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(request.headers))
      headers[k] = Array.isArray(v) ? v.join(' ') : v;
    let verified: ReturnType<typeof verifyLithicWebhook>;
    try {
      verified = verifyLithicWebhook({
        rawBody,
        headers,
        secret: deps.secret,
        now: deps.now(),
      });
    } catch (e) {
      if (e instanceof LithicWebhookError)
        return reply.code(401).send({ error: 'WEBHOOK_SIGNATURE_INVALID' });
      throw e;
    }
    const eventType =
      typeof verified.event.event_type === 'string'
        ? verified.event.event_type.slice(0, 120)
        : null;
    const first = await deps.deduper.firstSeen(verified.id, {
      eventType,
      bodyHash: createHash('sha256').update(rawBody).digest('hex'),
    });
    if (!first) return reply.code(200).send({ ok: true, duplicate: true });
    try {
      await deps.onEvent?.({
        webhookId: verified.id,
        timestamp: verified.timestamp,
        eventType,
        event: verified.event,
      });
    } catch {
      await deps.deduper.forget?.(verified.id);
      return reply.code(500).send({ error: 'WEBHOOK_PROCESSING_FAILED' });
    }
    return reply.code(200).send({ ok: true, duplicate: false });
  });
}

/** Production wiring: durable Postgres dedupe, migrated before the route is served. */
export async function registerLithicWebhook(input: {
  app: FastifyInstance;
  pool: ConstructorParameters<typeof PostgresWebhookDeduper>[0];
  env: Readonly<Record<string, string | undefined>>;
  now?: () => number;
  onEvent?: LithicWebhookDeps['onEvent'];
}) {
  const deduper = new PostgresWebhookDeduper(input.pool, 'lithic');
  await deduper.migrate();
  const secret = input.env.LITHIC_WEBHOOK_SECRET?.trim() || null;
  await input.app.register(lithicWebhookRoutes, {
    secret,
    deduper,
    now: input.now ?? (() => Math.floor(Date.now() / 1000)),
    onEvent:
      input.onEvent ??
      (async (e) =>
        input.app.log.info(
          { webhookId: e.webhookId, eventType: e.eventType },
          'lithic webhook',
        )),
  });
  return { deduper, configured: secret !== null };
}
