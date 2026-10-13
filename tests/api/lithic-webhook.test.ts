import { describe, expect, it } from 'vitest';
import { MemoryWebhookDeduper } from '@synq/plugin-commerce';
import { LITHIC_WEBHOOK_PATH } from '../../apps/api/src/lithic-webhook.js';
import {
  SECRET,
  T,
  event,
  signed,
  webhookApp,
} from './lithic-webhook-fixtures.js';

const post = (
  app: Awaited<ReturnType<typeof webhookApp>>,
  body: string,
  headers: Record<string, string>,
) =>
  app.inject({
    method: 'POST',
    url: LITHIC_WEBHOOK_PATH,
    payload: body,
    headers,
  });

describe('Lithic webhook route (I3)', () => {
  it('LWH-001 verifies the raw body, processes a delivery once and answers duplicates without reprocessing', async () => {
    const seen: string[] = [];
    const app = await webhookApp({
      secret: SECRET,
      deduper: new MemoryWebhookDeduper(),
      now: () => T + 5,
      onEvent: async (e) => void seen.push(`${e.webhookId}:${e.eventType}`),
    });
    const body = event('tx-1');
    const first = await post(app, body, signed('msg_1', body));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ ok: true, duplicate: false });
    const again = await post(app, body, signed('msg_1', body));
    expect(again.json()).toEqual({ ok: true, duplicate: true });
    expect(seen).toEqual(['msg_1:card_transaction.updated']);
    await app.close();
  });

  it('LWH-002 refuses bad signatures, tampered bodies, stale timestamps, other secrets and an unconfigured secret', async () => {
    const seen: string[] = [];
    const deduper = new MemoryWebhookDeduper();
    const app = await webhookApp({
      secret: SECRET,
      deduper,
      now: () => T + 5,
      onEvent: async (e) => void seen.push(e.webhookId),
    });
    const body = event('tx-2');
    const good = signed('msg_2', body);
    const cases: Record<string, string>[] = [
      { ...good, 'webhook-signature': 'v1,AAAA' },
      { ...good, 'webhook-id': 'msg_other' },
      signed('msg_2', body, T - 3_600),
      signed(
        'msg_2',
        body,
        T,
        `whsec_${Buffer.from('another-secret-another-secret!!').toString('base64')}`,
      ),
      { 'content-type': 'application/json' },
    ];
    for (const headers of cases) {
      const r = await post(app, body, headers);
      expect(r.statusCode).toBe(401);
      expect(r.json()).toEqual({ error: 'WEBHOOK_SIGNATURE_INVALID' });
    }
    expect((await post(app, `${body} `, good)).statusCode).toBe(401);
    expect(seen).toEqual([]);
    // Nothing was claimed by a rejected delivery: the genuine one still processes.
    expect((await post(app, body, good)).json()).toEqual({
      ok: true,
      duplicate: false,
    });
    await app.close();
    const closed = await webhookApp({ secret: null, deduper, now: () => T });
    expect((await post(closed, body, good)).statusCode).toBe(404);
    await closed.close();
  });

  it('LWH-003 a processing failure releases the claim so the redelivery is handled', async () => {
    let fail = true;
    const seen: string[] = [];
    const app = await webhookApp({
      secret: SECRET,
      deduper: new MemoryWebhookDeduper(),
      now: () => T,
      onEvent: async (e) => {
        if (fail) throw new Error('inbox down');
        seen.push(e.webhookId);
      },
    });
    const body = event('tx-3');
    const r = await post(app, body, signed('msg_3', body));
    expect(r.statusCode).toBe(500);
    fail = false;
    expect((await post(app, body, signed('msg_3', body))).json()).toEqual({
      ok: true,
      duplicate: false,
    });
    expect(seen).toEqual(['msg_3']);
    await app.close();
  });
});
