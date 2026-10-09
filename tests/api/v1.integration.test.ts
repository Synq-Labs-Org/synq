import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import { PostgresIdentityStore } from '../../packages/identity/src/server.js';
import type { GrantPreview } from '@synq/schemas';
import { addr, makeDraft, testAusd, word } from '../identity/fixtures.js';
import {
  ADMIN,
  approvalSignature,
  client,
  enrollViaApi,
  joinViaApi,
  origin,
  rpId,
} from './v1-harness.js';

const url =
  process.env.SYNQ_IDENTITY_API_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_identity_api_test';
const pools: pg.Pool[] = [];
const app = () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  pools.push(pool);
  return createV1Api({
    store: new PostgresIdentityStore(pool),
    config: { profile: 'sandbox/monad-testnet', rpId, origin },
    adminToken: ADMIN,
  });
};

beforeAll(async () => {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error('unsafe database name');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  if (
    !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rows.length
  )
    await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const pool = new pg.Pool({ connectionString: url });
  pools.push(pool);
  await new PostgresIdentityStore(pool).migrate();
  await pool.query(
    'TRUNCATE identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal RESTART IDENTITY CASCADE',
  );
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

describe('/v1 API on real PostgreSQL', () => {
  it('keeps principals, memberships, approvals and idempotent replies across an API restart', async () => {
    const first = app();
    const { call, admin } = client(first);
    const groupId = word(0xb2);
    const humans = [
      await enrollViaApi(first, 'pg-a'),
      await enrollViaApi(first, 'pg-b'),
      await enrollViaApi(first, 'pg-c'),
    ];
    const account = addr(0xacc);
    expect(
      (
        await call(
          'POST',
          '/v1/groups',
          {
            groupId,
            chainId: 10143,
            account,
            owners: humans.map((h) => h.record.signer),
            threshold: 2,
          },
          admin,
        )
      ).status,
    ).toBe(201);
    for (const [i, h] of humans.entries())
      expect((await joinViaApi(first, groupId, h, `m${i}`)).status).toBe(201);
    const draft = makeDraft(
      { groupId, account },
      { groupId: groupId as never },
    );
    const registered = await call(
      'POST',
      '/v1/intents',
      { draft, asset: testAusd },
      admin,
    );
    expect(registered.status).toBe(201);
    const preview = registered.body.preview as GrantPreview;
    const a = await approvalSignature(first, humans[0]!, 'm0', draft, preview);
    const key = randomUUID();
    const submit = (target: ReturnType<typeof app>) =>
      target.inject({
        method: 'POST',
        url: '/v1/approvals',
        payload: {
          challengeId: a.challenge!.challengeId,
          signature: a.signature,
        },
        headers: { 'idempotency-key': key },
      });
    expect((await submit(first)).statusCode).toBe(201);
    await first.close();

    const second = app();
    const replay = await submit(second);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    const b = await approvalSignature(second, humans[1]!, 'm1', draft, preview);
    const again = client(second);
    expect(
      (
        await again.call('POST', '/v1/approvals', {
          challengeId: b.challenge!.challengeId,
          signature: b.signature,
        })
      ).status,
    ).toBe(201);
    const quorum = await again.call(
      'GET',
      `/v1/approvals/${draft.digest}/quorum`,
    );
    expect(quorum.body.satisfied).toBe(true);
    expect(
      (quorum.body.counted as { signer: string }[]).map((x) => x.signer).sort(),
    ).toEqual([humans[0]!.record.signer, humans[1]!.record.signer].sort());
    const group = await again.call('GET', `/v1/groups/${groupId}`);
    expect(group.body.membershipEpoch).toBe(3);
    await second.close();
  });
});
