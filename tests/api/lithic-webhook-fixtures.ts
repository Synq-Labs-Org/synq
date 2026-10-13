import { createHmac } from 'node:crypto';
import Fastify from 'fastify';
import {
  lithicWebhookRoutes,
  type LithicWebhookDeps,
} from '../../apps/api/src/lithic-webhook.js';

export const T = 1_790_000_000;
export const SECRET = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;

/** Standard Webhooks signature as Lithic sends it: base64 HMAC-SHA256 of `id.ts.body`. */
export function signed(id: string, body: string, ts = T, secret = SECRET) {
  const sig = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(`${id}.${ts}.${body}`)
    .digest('base64');
  return {
    'content-type': 'application/json',
    'webhook-id': id,
    'webhook-timestamp': String(ts),
    'webhook-signature': `v1,${sig}`,
  };
}

export async function webhookApp(deps: LithicWebhookDeps) {
  const app = Fastify();
  await app.register(lithicWebhookRoutes, deps);
  await app.ready();
  return app;
}

export const event = (token: string) =>
  JSON.stringify({
    event_type: 'card_transaction.updated',
    token,
    payload: { token, status: 'SETTLED', pan: '4111111111111111' },
  });
