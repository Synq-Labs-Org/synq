import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import Fastify from 'fastify';
import { PostgresWebhookDeduper } from '@synq/plugin-commerce';
import {
  LITHIC_WEBHOOK_PATH,
  registerLithicWebhook,
} from '../../apps/api/src/lithic-webhook.js';
import { ensureP08Database } from '../treasury/pg.js';
import {
  SECRET,
  T,
  event,
  signed,
  webhookApp,
} from './lithic-webhook-fixtures.js';

const URL =
  process.env.SYNQ_WEBHOOK_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_webhooks';
const schema = `lwh_${process.pid}_${Date.now() % 1_000_000}`;
let pool: pg.Pool;
beforeAll(async () => {
  pool = await ensureP08Database(URL);
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

describe(
  'Lithic webhook dedupe on local Postgres (I3)',
  { timeout: 30_000 },
  () => {
    it('LWH-PG-001 a delivery is processed once across API instances and restarts, even when raced', async () => {
      const deduper = () => new PostgresWebhookDeduper(pool, 'lithic', schema);
      const d0 = deduper();
      await d0.migrate();
      await d0.migrate();
      const seen: string[] = [];
      const apps = await Promise.all(
        [0, 1].map(async () =>
          webhookApp({
            secret: SECRET,
            deduper: deduper(),
            now: () => T,
            onEvent: async (e) => void seen.push(e.webhookId),
          }),
        ),
      );
      const id = `msg_${schema}`;
      const body = event('tx-pg');
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          apps[i % 2]!.inject({
            method: 'POST',
            url: LITHIC_WEBHOOK_PATH,
            payload: body,
            headers: signed(id, body),
          }),
        ),
      );
      expect(results.map((r) => r.statusCode)).toEqual(Array(6).fill(200));
      expect(results.filter((r) => r.json().duplicate === false)).toHaveLength(
        1,
      );
      expect(seen).toEqual([id]);
      const row = await pool.query(
        `SELECT source, event_type, body_hash FROM "${schema}".synq_webhook_deliveries WHERE webhook_id=$1`,
        [id],
      );
      expect(row.rows).toEqual([
        {
          source: 'lithic',
          event_type: 'card_transaction.updated',
          body_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
        },
      ]);
      // The inbox keeps no payload, so no card data is persisted.
      expect(JSON.stringify(row.rows)).not.toContain('4111');
      await Promise.all(apps.map((a) => a.close()));
      // A restarted API (new pool) still treats it as a duplicate.
      const other = new pg.Pool({ connectionString: URL, max: 1 });
      try {
        const again = new PostgresWebhookDeduper(other, 'lithic', schema);
        expect(await again.firstSeen(id)).toBe(false);
        await again.forget(id);
        expect(await again.firstSeen(id)).toBe(true);
      } finally {
        await other.end();
      }
    });

    it('LWH-PG-002 production registration migrates the inbox and stays closed without a signing secret', async () => {
      const app = Fastify();
      const closed = await registerLithicWebhook({ app, pool, env: {} });
      await app.ready();
      expect(closed.configured).toBe(false);
      const body = event('tx-closed');
      const r = await app.inject({
        method: 'POST',
        url: LITHIC_WEBHOOK_PATH,
        payload: body,
        headers: signed('msg_closed', body),
      });
      expect(r.statusCode).toBe(404);
      await app.close();
      const open = Fastify();
      const configured = await registerLithicWebhook({
        app: open,
        pool,
        env: { LITHIC_WEBHOOK_SECRET: SECRET },
        now: () => T,
        onEvent: async () => undefined,
      });
      await open.ready();
      expect(configured.configured).toBe(true);
      const id = `msg_prod_${schema}`;
      const ok = await open.inject({
        method: 'POST',
        url: LITHIC_WEBHOOK_PATH,
        payload: body,
        headers: signed(id, body),
      });
      expect(ok.json()).toEqual({ ok: true, duplicate: false });
      await configured.deduper.forget(id);
      await open.close();
    });
  },
);
