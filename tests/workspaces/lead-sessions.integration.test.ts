import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress } from 'viem';
import {
  ClientLeadDetailSchema,
  ClientLeadListSchema,
  DeviceSessionSchema,
  LeadInviteSchema,
  LeadMessageSchema,
} from '@synq/contracts';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import {
  WorkspaceLeads,
  type LeadRow,
} from '../../packages/workspaces/src/leads.js';
import { WorkspaceOffers } from '../../packages/workspaces/src/offers.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { registerWorkspaceRoutes } from '../../apps/demo/src/workspace-routes.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

const origin = 'https://synq.test';
let pool: Pool;
let store: PostgresWorkspaceStore;
let leads: WorkspaceLeads;
let app: FastifyInstance;
const replies: { leadId: string; turn: string }[] = [];
let ip = 0;
const from = () => `10.1.${Math.floor(++ip / 250)}.${ip % 250}`;
const key = () => ({ 'idempotency-key': randomUUID() });
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

async function person() {
  const a = privateKeyToAccount(generatePrivateKey());
  const c = await store.challenge({ wallet: a.address, audience: 'native' });
  const signature = await a.signTypedData({
    ...loginTypedData(c),
    message: {
      ...loginTypedData(c).message,
      wallet: getAddress(c.wallet),
      expiresAt: BigInt(c.expiresAt),
    },
  });
  const r = await app.inject({
    method: 'POST',
    url: '/v3/auth/device-session',
    remoteAddress: from(),
    payload: {
      challengeId: c.id,
      signature,
      device: { deviceId: randomUUID(), name: 'Test', platform: 'ios' },
    },
  });
  expect(r.statusCode).toBe(200);
  const s = DeviceSessionSchema.parse(r.json());
  return { principalId: s.principalId, h: bearer(s.accessToken) };
}

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => 2_000_000_000);
  await store.migrate();
  leads = new WorkspaceLeads(store, {
    webOrigin: origin,
    telegramBot: () => null,
  });
  await leads.migrate();
  const offers = new WorkspaceOffers(store);
  await offers.migrate();
  app = Fastify();
  registerWorkspaceRoutes(app, store);
  registerAppRoutes(app, {
    store,
    devices: new WorkspaceDeviceSessions(store),
    leads,
    offers,
    sales: {
      respond: async (lead: LeadRow, turn: string) => {
        replies.push({ leadId: lead.leadId, turn });
        return null;
      },
    },
  });
});
afterAll(async () => {
  await app?.close();
  await pool?.end();
});

async function webLead() {
  const owner = await person();
  const client = await person();
  const { workspace: w } = await store.create(owner.principalId, {
    displayName: 'Session Co',
    kind: 'BUSINESS',
  });
  const invite = LeadInviteSchema.parse(
    (
      await app.inject({
        method: 'POST',
        url: `/v3/workspaces/${w.id}/lead-invites`,
        headers: { ...owner.h, ...key() },
        payload: { source: 'WEB', expiresInSeconds: 3600 },
      })
    ).json(),
  );
  const token = invite.webUrl.split('/').pop()!;
  const redeemed = await app.inject({
    method: 'POST',
    url: '/v3/lead-invites/redeem',
    headers: { ...client.h, ...key() },
    payload: { token },
  });
  expect(redeemed.statusCode).toBe(200);
  return {
    owner,
    client,
    w,
    leadId: String(redeemed.json().leadId),
  };
}
const send = (
  h: Record<string, string>,
  leadId: string,
  text: string,
  k = key(),
) =>
  app.inject({
    method: 'POST',
    url: `/v3/lead-sessions/${leadId}/message`,
    headers: { ...h, ...k },
    payload: { text },
  });

describe('v3 lead sessions (outside client)', () => {
  it('shows the client only their own lead, without staff fields', async () => {
    const a = await webLead();
    const b = await webLead();
    const list = ClientLeadListSchema.parse(
      (
        await app.inject({ url: '/v3/lead-sessions', headers: a.client.h })
      ).json(),
    );
    expect(list.leads.map((l) => l.leadId)).toEqual([a.leadId]);
    expect(list.leads[0]!.businessName).toBe('Session Co');
    const detail = ClientLeadDetailSchema.parse(
      (
        await app.inject({
          url: `/v3/lead-sessions/${a.leadId}`,
          headers: a.client.h,
        })
      ).json(),
    );
    expect(detail.consent.granted).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(
      /handling|needsOwner|unread|workspaceId/,
    );
    // Another client, and the business's own owner, get 404 on the same lead.
    for (const who of [b.client, a.owner]) {
      for (const url of [
        `/v3/lead-sessions/${a.leadId}`,
        `/v3/lead-sessions/${randomUUID()}`,
      ])
        expect((await app.inject({ url, headers: who.h })).statusCode).toBe(
          404,
        );
      expect((await send(who.h, a.leadId, 'hello')).statusCode).toBe(404);
    }
    expect(
      ClientLeadListSchema.parse(
        (
          await app.inject({ url: '/v3/lead-sessions', headers: a.owner.h })
        ).json(),
      ).leads,
    ).toEqual([]);
    expect((await app.inject({ url: '/v3/lead-sessions' })).statusCode).toBe(
      401,
    );
  });

  it('stores a message once per idempotency key and runs the agent once', async () => {
    const a = await webLead();
    const k = key();
    const first = await send(a.client.h, a.leadId, 'Need a logo', k);
    expect(first.statusCode).toBe(200);
    const m = LeadMessageSchema.parse(first.json());
    expect(m.author).toBe('LEAD');
    const again = await send(a.client.h, a.leadId, 'Need a logo', k);
    expect(LeadMessageSchema.parse(again.json()).messageId).toBe(m.messageId);
    const detail = ClientLeadDetailSchema.parse(
      (
        await app.inject({
          url: `/v3/lead-sessions/${a.leadId}`,
          headers: a.client.h,
        })
      ).json(),
    );
    expect(detail.messages.filter((x) => x.author === 'LEAD')).toHaveLength(1);
    expect(replies.filter((r) => r.leadId === a.leadId)).toHaveLength(1);
    expect(detail.lead.stage).toBe('DISCOVERY');
    // Missing idempotency key and empty text are refused.
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/v3/lead-sessions/${a.leadId}/message`,
          headers: a.client.h,
          payload: { text: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect((await send(a.client.h, a.leadId, '   ')).statusCode).toBe(400);
  });

  it('replies only while handling is AGENT', async () => {
    const a = await webLead();
    await send(a.client.h, a.leadId, 'Hi');
    expect(replies.filter((r) => r.leadId === a.leadId)).toHaveLength(1);
    const takeover = await app.inject({
      method: 'POST',
      url: `/v3/workspaces/${a.w.id}/leads/${a.leadId}/takeover`,
      headers: { ...a.owner.h, ...key() },
      payload: { action: 'HUMAN_TAKEOVER', expectedVersion: 0 },
    });
    expect(takeover.statusCode).toBe(200);
    const stored = await send(a.client.h, a.leadId, 'Anyone there?');
    expect(stored.statusCode).toBe(200);
    expect(replies.filter((r) => r.leadId === a.leadId)).toHaveLength(1);
    const detail = ClientLeadDetailSchema.parse(
      (
        await app.inject({
          url: `/v3/lead-sessions/${a.leadId}`,
          headers: a.client.h,
        })
      ).json(),
    );
    expect(detail.messages.map((x) => x.text)).toContain('Anyone there?');
  });
});
