import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import {
  createV1Api,
  type IntentAuthorizer,
} from '../../apps/api/src/v1/app.js';
import {
  configureSandboxGroup,
  sandboxKernel,
  sandboxProposal,
} from './kernel-fixture.js';
import {
  PostgresIdentityStore,
  StoreApprovalLedger,
  StoreMembershipDirectory,
} from '../../packages/identity/src/server.js';
import type { GrantDraft, GrantPreview } from '@synq/schemas';
import { addr, word } from '../identity/fixtures.js';
import {
  ADMIN,
  MODULE,
  approvalSignature,
  client,
  enrollViaApi,
  joinViaApi,
  origin,
  rpId,
  submission,
} from './v1-harness.js';

const url =
  process.env.SYNQ_IDENTITY_API_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_identity_api_test';
const pools: pg.Pool[] = [];
const wallClock = () => Math.floor(Date.now() / 1000);
const app = (intents?: IntentAuthorizer) => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  pools.push(pool);
  const store = new PostgresIdentityStore(pool);
  return createV1Api({
    ...(intents ? { intents } : {}),
    store,
    config: { profile: 'sandbox/monad-testnet', rpId, origin },
    adminToken: ADMIN,
    executionModules: { 10143: MODULE },
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
    const kernelPool = new pg.Pool({ connectionString: url, max: 2 });
    pools.push(kernelPool);
    const kernelStore = new PostgresIdentityStore(kernelPool);
    const kernel = sandboxKernel({
      executionModule: MODULE,
      now: wallClock,
      approvalLedger: new StoreApprovalLedger(kernelStore),
      membershipDirectory: new StoreMembershipDirectory(kernelStore),
    });
    const first = app(kernel);
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
            chainGroupId: groupId,
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
    const group = {
      groupId,
      chainGroupId: groupId,
      account,
      executor: addr(0xe1),
      recipient: addr(0xbeef),
      members: humans.map((h, i) => ({
        memberId: `m${i}`,
        signer: h.record.signer,
      })),
    };
    configureSandboxGroup(kernel, group, wallClock());
    const registered = await call(
      'POST',
      '/v1/intents',
      sandboxProposal(kernel, group, {
        amount: 12_500_000n,
        nonce: '1',
        now: wallClock(),
      }),
      admin,
    );
    expect(registered.status).toBe(201);
    const draft = (registered.body.pending as { draft: GrantDraft }).draft;
    const preview = (registered.body.pending as { preview: GrantPreview })
      .preview;
    const a = await approvalSignature(
      first,
      humans[0]!,
      'm0',
      draft,
      preview,
      wallClock,
    );
    const key = randomUUID();
    const submit = (target: ReturnType<typeof app>) =>
      target.inject({
        method: 'POST',
        url: '/v1/approvals',
        payload: submission(a),
        headers: { 'idempotency-key': key },
      });
    expect((await submit(first)).statusCode).toBe(201);
    await first.close();

    const second = app(kernel);
    const replay = await submit(second);
    expect(replay.statusCode).toBe(201);
    expect(replay.headers['idempotent-replay']).toBe('true');
    const b = await approvalSignature(
      second,
      humans[1]!,
      'm1',
      draft,
      preview,
      wallClock,
    );
    const again = client(second);
    expect(
      (await again.call('POST', '/v1/approvals', submission(b))).status,
    ).toBe(201);
    const quorum = await again.call(
      'GET',
      `/v1/approvals/${draft.digest}/quorum`,
    );
    expect(quorum.body.satisfied).toBe(true);
    expect(
      (quorum.body.counted as { signer: string }[]).map((x) => x.signer).sort(),
    ).toEqual([humans[0]!.record.signer, humans[1]!.record.signer].sort());
    const groupView = await again.call('GET', `/v1/groups/${groupId}`);
    expect(groupView.body.membershipEpoch).toBe(3);
    await second.close();
  });
});
