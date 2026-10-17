import Fastify from 'fastify';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { getAddress, keccak256, toHex } from 'viem';
import {
  AgentRunDetailSchema,
  AgentRunPageSchema,
  StreamEventPageSchema,
} from '@synq/contracts';
import { PostgresWorkspaceStore } from '../../packages/workspaces/src/postgres.js';
import { loginTypedData } from '../../packages/workspaces/src/contracts.js';
import { AgentEvents } from '../../packages/workspaces/src/agent-events.js';
import { WorkspaceDeviceSessions } from '../../packages/workspaces/src/device-sessions.js';
import { registerAppRoutes } from '../../apps/demo/src/app-routes.js';
import { testDatabaseUrl } from '../durable/pg.js';
import { workspacePool } from './pg.js';

const origin = 'https://synq.test';
let pool: Pool;
let store: PostgresWorkspaceStore;
let events: AgentEvents;
const clock = 2_000_000_000;
const tx = (label: string) => keccak256(toHex(`agent-events:${label}`));

async function login() {
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
  return { a, ...(await store.login(c.id, signature)) };
}
const event = (key: string, over: Record<string, unknown> = {}) => ({
  semanticKey: key,
  kind: 'DECISION' as const,
  actor: 'DETERMINISTIC' as const,
  status: 'AUTHORIZED' as const,
  summary: 'Allowed one payment within the lease.',
  sourceKind: 'KERNEL',
  proofLevel: 'NOT_VERIFIED' as const,
  correlationId: 'corr',
  ...over,
});

beforeAll(async () => {
  pool = await workspacePool(
    testDatabaseUrl('SYNQ_WORKSPACES_TEST_DATABASE_URL', 'synq_m2_workspaces'),
  );
  store = new PostgresWorkspaceStore(pool, origin, () => clock);
  await store.migrate();
  events = new AgentEvents(store, {
    explorerTxUrl: 'https://explorer.testnet.arc.io/tx/',
  });
  await Promise.all([events.migrate(), events.migrate()]);
});
afterAll(async () => {
  await pool?.end();
});

describe('agent runs', () => {
  it('records each step once, in a per-workspace sequence, and keeps history append-only', async () => {
    const owner = await login();
    const { workspace: w } = await store.create(owner.principalId, {
      displayName: 'Runs',
      kind: 'BUSINESS',
    });
    const run = await events.run(w.id, 'source:1', {
      title: 'Pay contractor',
      trigger: 'DEPOSIT_FINALIZED',
      amountUnits: '40000000',
    });
    expect(
      await events.run(w.id, 'source:1', { title: 'other', trigger: 'OTHER' }),
    ).toBe(run);
    const first = await events.record(run, event('a'));
    const again = await events.record(run, event('a'));
    expect(again).toEqual({ eventId: first.eventId, duplicate: true });
    await events.record(
      run,
      event('b', {
        kind: 'BROADCAST',
        status: 'BROADCAST',
        actor: 'DETERMINISTIC',
        txHash: tx('1'),
        chainId: 5042002,
      }),
    );
    const d = AgentRunDetailSchema.parse(
      await events.detail(w.id, owner.principalId, run),
    );
    expect(d.events.map((e) => e.sequence)).toEqual(['1', '2']);
    expect(d.run.status).toBe('BROADCAST');
    // Broadcast is not final, and the receipt links to the right chain's explorer.
    expect(d.receipts).toEqual([
      expect.objectContaining({
        txHash: tx('1'),
        finality: 'PENDING',
        explorerUrl: `https://explorer.testnet.arc.io/tx/${tx('1')}`,
      }),
    ]);
    await events.record(
      run,
      event('c', {
        kind: 'FINALIZED',
        status: 'FINALIZED',
        actor: 'CHAIN',
        txHash: tx('1'),
        chainId: 5042002,
        proofLevel: 'LIVE_ARC_TESTNET',
      }),
    );
    const done = AgentRunDetailSchema.parse(
      await events.detail(w.id, owner.principalId, run),
    );
    expect(done.receipts[0]!.finality).toBe('FINALIZED');
    expect(done.run.proofLevel).toBe('LIVE_ARC_TESTNET');
    await expect(
      pool.query("UPDATE synq_agent_events SET data='{}' WHERE run_id=$1", [
        run,
      ]),
    ).rejects.toThrow(/append only/);
  });

  it('keeps runs inside their workspace and away from viewers', async () => {
    const owner = await login();
    const other = await login();
    const viewer = await login();
    const { workspace: w } = await store.create(owner.principalId, {
      displayName: 'Private',
      kind: 'BUSINESS',
    });
    await store.accept(
      viewer.principalId,
      (await store.invite(w.id, owner.principalId, { role: 'VIEWER' })).token,
    );
    const run = await events.run(w.id, 'source:x', {
      title: 'x',
      trigger: 'OTHER',
    });
    for (const p of [other.principalId, viewer.principalId]) {
      await expect(events.detail(w.id, p, run)).rejects.toMatchObject({
        status: 404,
      });
      await expect(events.runs(w.id, p)).rejects.toMatchObject({ status: 404 });
    }
    const { workspace: theirs } = await store.create(other.principalId, {
      displayName: 'Theirs',
      kind: 'BUSINESS',
    });
    await expect(
      events.detail(theirs.id, other.principalId, run),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('streams only what a principal may see and stops when they leave', async () => {
    const owner = await login();
    const member = await login();
    const { workspace: w } = await store.create(owner.principalId, {
      displayName: 'Stream',
      kind: 'BUSINESS',
    });
    await store.accept(
      member.principalId,
      (await store.invite(w.id, owner.principalId, { role: 'MEMBER' })).token,
    );
    const start = await events.head();
    const run = await events.run(w.id, 'source:s', {
      title: 's',
      trigger: 'OTHER',
    });
    await events.record(run, event('s1'));
    await events.publish(
      'NOTIFICATION',
      { principalId: owner.principalId },
      'n1',
    );
    const mine = await events.since(owner.principalId, start);
    expect(mine.items.map((i) => i.type)).toEqual([
      'AGENT_EVENT',
      'NOTIFICATION',
    ]);
    const theirs = await events.since(member.principalId, start);
    expect(theirs.items.map((i) => i.type)).toEqual(['AGENT_EVENT']);
    // Replaying from the last cursor returns nothing new and no duplicates.
    expect(
      (await events.since(owner.principalId, mine.nextCursor!)).items,
    ).toEqual([]);
    await pool.query(
      'DELETE FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
      [w.id, member.principalId],
    );
    await events.record(run, event('s2'));
    expect(
      (await events.since(member.principalId, theirs.nextCursor!)).items,
    ).toEqual([]);
  });

  it('serves runs and a replayable event stream over the API', async () => {
    const app = Fastify();
    registerAppRoutes(app, {
      store,
      devices: new WorkspaceDeviceSessions(store),
      events,
      streamWindowMs: 50,
      streamPollMs: 10,
    });
    try {
      const owner = await login();
      const { workspace: w } = await store.create(owner.principalId, {
        displayName: 'API runs',
        kind: 'BUSINESS',
      });
      const h = { authorization: `Bearer ${owner.token}` };
      const start = await events.head();
      const run = await events.run(w.id, 'source:api', {
        title: 'api',
        trigger: 'OTHER',
      });
      await events.record(run, event('api1'));
      const page = AgentRunPageSchema.parse(
        (
          await app.inject({
            url: `/v3/workspaces/${w.id}/agent-runs`,
            headers: h,
          })
        ).json(),
      );
      expect(page.items.map((r) => r.runId)).toEqual([run]);
      const poll = StreamEventPageSchema.parse(
        (
          await app.inject({
            url: `/v3/events/since?cursor=${start}`,
            headers: h,
          })
        ).json(),
      );
      expect(poll.items.map((i) => i.entityId)).toContain(run);
      const sse = await app.inject({
        url: `/v3/events?cursor=${start}`,
        headers: h,
      });
      expect(sse.headers['content-type']).toContain('text/event-stream');
      expect(sse.body).toMatch(
        new RegExp(
          `id: \\d+\\nevent: AGENT_EVENT\\ndata: .*"entityId":"${run}"`,
        ),
      );
      // Once the session ends, the stream says so and closes.
      await store.logout(owner.token);
      const revoked = await app.inject({
        url: `/v3/events?cursor=${start}`,
        headers: h,
      });
      expect(revoked.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
