import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import {
  GroupFundService,
  PostgresFundStore,
  contributionRef,
  memberCustody,
  migrateTreasury,
  transferKey,
} from '@synq/treasury';
import {
  NOW,
  accountFor,
  charterFor,
  expectCode,
  transfer,
  usdc,
} from './helpers.js';
import { testDatabaseUrl } from '../durable/pg.js';

const URL = testDatabaseUrl(
  'SYNQ_TREASURY_TEST_DATABASE_URL',
  'synq_m2_treasury_test',
);

let pool: pg.Pool;
beforeAll(async () => {
  const name = new globalThis.URL(URL).pathname.slice(1);
  if (!/^synq_[a-z0-9_]*treasury[a-z0-9_]*$/.test(name))
    throw new Error('treasury test database must be named synq_*treasury*');
  const admin = new pg.Client({
    connectionString: URL.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  pool = new pg.Pool({ connectionString: URL, max: 4 });
});
afterAll(async () => {
  await pool?.end();
});

describe('Postgres group fund store', () => {
  it('migrates up and down in its own table and keeps one credit per transfer across funds', async () => {
    expect(await migrateTreasury(pool, 0)).toBe(0);
    expect(await migrateTreasury(pool)).toBe(1);
    const store = new PostgresFundStore(pool);
    expect(await store.migrate()).toBe(1);
    const svc = new GroupFundService(store);
    const ana = accountFor('ana');
    const ben = accountFor('ben');
    const members = [
      { memberId: 'ana', account: ana },
      { memberId: 'ben', account: ben },
    ];
    const poolA = accountFor('pg-a').address;
    const poolB = accountFor('pg-b').address;
    await svc.open(charterFor({ fundId: 'pga', members, pool: poolA }), NOW);
    await svc.open(charterFor({ fundId: 'pgb', members, pool: poolB }), NOW);
    await expectCode(
      svc.open(charterFor({ fundId: 'pgc', members, pool: poolA }), NOW),
      'DUPLICATE_CLAIM',
    );
    const t = transfer({
      from: ana.address,
      to: poolA,
      amount: usdc(4),
      ref: contributionRef('pga', 'ana'),
    });
    await svc.run('pga', (f) => f.observeDeposit(t, NOW));
    await svc.run('pga', (f) => f.finalizeDeposit(transferKey(t), 500n, NOW));
    await expectCode(
      svc.run('pgb', (f) =>
        f.observeDeposit(
          { ...t, to: poolB, paymentRef: contributionRef('pgb', 'ana') },
          NOW,
        ),
      ),
      'DUPLICATE_CLAIM',
    );
    // Two writers from the same version: one wins, the other is fenced.
    const a = await svc.load('pgb');
    const b = await svc.load('pgb');
    const [x, y] = await Promise.allSettled([
      store.append(
        'pgb',
        a.seq,
        a.pledge({ pledgeId: 'x', memberId: 'ben', amount: 1n }, NOW),
        [],
      ),
      store.append(
        'pgb',
        b.seq,
        b.pledge({ pledgeId: 'y', memberId: 'ben', amount: 2n }, NOW),
        [],
      ),
    ]);
    expect([x.status, y.status].sort()).toEqual(['fulfilled', 'rejected']);
    const lost = [x, y].find(
      (r) => r.status === 'rejected',
    ) as PromiseRejectedResult;
    expect((lost.reason as { code: string }).code).toBe('CONFLICT');
    const reloaded = [await svc.load('pga'), await svc.load('pgb')];
    expect(reloaded[0]!.view()).toMatchObject({ custody: usdc(4) });
    expect(memberCustody(ana.address, reloaded).total).toBe(usdc(4));
    expect(await store.claimOwner(transferKey(t))).toBe('pga');
  });
});
