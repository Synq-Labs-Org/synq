import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  PostgresIdentityStore,
  type IdentityTx,
} from '../../packages/identity/src/server.js';
import { identityContract } from './identity-contract.js';
import { testDatabaseUrl } from '../durable/pg.js';

const url = testDatabaseUrl(
  'SYNQ_IDENTITY_TEST_DATABASE_URL',
  'synq_identity_test',
);

async function ensureDatabase(): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*$/.test(name))
    throw new Error('unsafe test database name');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

const pools: pg.Pool[] = [];
const openPool = () => {
  const pool = new pg.Pool({ connectionString: url, max: 6 });
  pools.push(pool);
  return pool;
};
const TABLES =
  'identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal';

beforeAll(async () => {
  await ensureDatabase();
  await new PostgresIdentityStore(openPool()).migrate();
});
afterAll(async () => {
  await Promise.all(pools.map((p) => p.end()));
});

identityContract('identity services on real PostgreSQL (integration tier)', {
  async fresh() {
    const pool = openPool();
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    return new PostgresIdentityStore(pool);
  },
  async reopen() {
    return new PostgresIdentityStore(openPool());
  },
});

describe('PostgreSQL constraints and concurrency', () => {
  it('migrations are idempotent and unique constraints hold under concurrent writers', async () => {
    const pool = openPool();
    const store = new PostgresIdentityStore(pool);
    await store.migrate();
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    const signer = `0x${'ab'.repeat(20)}` as const;
    const attempt = (n: number) =>
      store.transaction((tx: IdentityTx) =>
        tx.insertPrincipal({
          principalId: `mera:${signer}:${n}`,
          kind: 'MERA_HUMAN',
          signer,
          rpId: 'synq.test',
          credential: { credentialId: `cred${n}` },
          providerRef: null,
          status: 'ACTIVE',
          enrolledAt: 1,
          lastRecoveredAt: null,
        }),
      );
    const results = await Promise.allSettled([1, 2, 3, 4, 5].map(attempt));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((r) => r.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toMatchObject({
        code: 'PRINCIPAL_EXISTS',
      });
    await expect(
      pool.query(
        "INSERT INTO identity_principal(principal_id,kind,signer,enrolled_at) VALUES('x','MERA_HUMAN','0x00000000000000000000000000000000000000aa',1)",
      ),
    ).rejects.toThrow(/identity_principal_mera_binding/);
  });

  it('consumes a challenge exactly once across concurrent connections', async () => {
    const pool = openPool();
    const store = new PostgresIdentityStore(pool);
    await pool.query(`TRUNCATE ${TABLES} RESTART IDENTITY CASCADE`);
    await store.transaction((tx) =>
      tx.insertChallenge({
        schemaVersion: 1,
        challengeId: 'race',
        purpose: 'ENROLL',
        principalId: 'mera:0x00000000000000000000000000000000000000aa' as never,
        principalKind: 'MERA_HUMAN',
        signer: '0x00000000000000000000000000000000000000aa',
        rpId: 'synq.test',
        origin: 'https://synq.test',
        credentialId: 'c',
        transports: [],
        groupId: '',
        memberId: '',
        membershipEpoch: 0,
        nonce: `0x${'1'.repeat(64)}`,
        issuedAt: 1,
        expiresAt: 100,
      }),
    );
    const stores = [1, 2, 3, 4].map(
      () => new PostgresIdentityStore(openPool()),
    );
    const results = await Promise.allSettled(
      stores.map((s) => s.transaction((tx) => tx.consumeChallenge('race', 50))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });
});
