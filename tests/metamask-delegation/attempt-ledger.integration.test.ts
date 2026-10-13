import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { profileConfiguration } from '@synq/chain-registry';
import {
  DelegatedContributionPlanner,
  MetaMaskDelegationAdapter,
  PostgresAttemptLedger,
  claimAttempt,
  type DelegationChainReader,
  type GroupContributionLimits,
  type RecurringContributionPolicy,
} from '@synq/metamask-delegation';
import { getAddress, keccak256, toHex, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ensureP08Database } from '../treasury/pg.js';

const URL =
  process.env.SYNQ_MM_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_mm_delegation';
const chainId = profileConfiguration('sandbox/monad-testnet').network.chainId;
const memberAccount = privateKeyToAccount(
  keccak256(toHex('synq-test-member')) as Hex,
);
const executor = getAddress(`0x${'e'.repeat(40)}`);
const safe = getAddress(`0x${'5'.repeat(40)}`);
const adapter = new MetaMaskDelegationAdapter(chainId);
const now = 1_790_000_000;
const limits: GroupContributionLimits = {
  safe,
  maxPerPeriod: 20_000_000n,
  maxCumulative: 200_000_000n,
  latestValidUntil: now + 100 * 86_400,
};
const policy: RecurringContributionPolicy = {
  chainId,
  token: adapter.token,
  delegator: memberAccount.address,
  delegate: executor,
  safe,
  perPeriodAmount: 20_000_000n,
  periodSeconds: 7 * 86_400,
  startDate: now,
  cumulativeCap: 200_000_000n,
  maxExecutions: 12,
  validAfter: now - 60,
  validUntil: now + 90 * 86_400,
  salt: keccak256(toHex(`salt-${process.pid}-${Date.now()}`)),
};
const chain: DelegationChainReader = {
  getCode: async () => '0x',
  readContract: (async (args: { functionName: string }) => {
    if (args.functionName === 'disabledDelegations') return false;
    throw new Error(`unexpected ${args.functionName}`);
  }) as DelegationChainReader['readContract'],
};

let pool: pg.Pool;
const schema = `mm_attempts_${process.pid}_${Date.now() % 1_000_000}`;
beforeAll(async () => {
  pool = await ensureP08Database(URL);
});
afterAll(async () => {
  await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await pool.end();
});

describe(
  'PostgresAttemptLedger against local Postgres',
  { timeout: 30_000 },
  () => {
    it('MM-PG-001 migrate is idempotent and a claim is exactly-once under concurrency and across pools', async () => {
      const ledger = new PostgresAttemptLedger(pool, schema);
      await ledger.migrate();
      await ledger.migrate();
      const h = keccak256(toHex(`d-${schema}`));
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => claimAttempt(ledger, h, 0)),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      expect(
        results
          .filter((r) => r.status === 'rejected')
          .map((r) => (r.reason as { code?: string }).code),
      ).toEqual(Array(7).fill('DUPLICATE_ATTEMPT'));
      // A restarted executor (fresh pool) still sees the claim.
      const other = new pg.Pool({ connectionString: URL, max: 1 });
      try {
        const again = new PostgresAttemptLedger(other, schema);
        await again.migrate();
        await expect(claimAttempt(again, h, 0)).rejects.toMatchObject({
          code: 'DUPLICATE_ATTEMPT',
        });
        await expect(claimAttempt(again, h, 1)).resolves.toBe(
          `${h.toLowerCase()}:1`,
        );
      } finally {
        await other.end();
      }
      expect(() => new PostgresAttemptLedger(pool, 'bad;schema')).toThrow();
    });

    it('MM-PG-002 the planner claims only after every off-chain check passes, then refuses the period again', async () => {
      const ledger = new PostgresAttemptLedger(pool, schema);
      await ledger.migrate();
      const planner = new DelegatedContributionPlanner(adapter, ledger, chain);
      const d = adapter.buildDelegation(policy, limits);
      const signed = {
        ...d,
        signature: await memberAccount.signTypedData(
          adapter.delegationTypedData(d),
        ),
      };
      const base = {
        signed,
        policy,
        limits,
        nowSeconds: now + 10,
        spentThisPeriod: 0n,
        spentTotal: 0n,
      };
      // Refused plans (over the period cap) never burn the period.
      await expect(
        planner.plan({ ...base, amount: 20_000_001n }),
      ).rejects.toMatchObject({ code: 'OVER_PERIOD_CAP' });
      const planned = await planner.plan({ ...base, amount: 5_000_000n });
      expect(planned.to).toBe(adapter.delegationManager);
      expect(planned.period).toBe(0);
      expect(planned.attemptKey).toBe(
        `${planned.delegationHash.toLowerCase()}:0`,
      );
      const rows = await pool.query(
        `SELECT attempt_key FROM "${schema}".synq_delegation_attempts WHERE attempt_key=$1`,
        [planned.attemptKey],
      );
      expect(rows.rows).toHaveLength(1);
      await expect(
        planner.plan({ ...base, amount: 5_000_000n }),
      ).rejects.toMatchObject({ code: 'DUPLICATE_ATTEMPT' });
      const next = await planner.plan({
        ...base,
        amount: 5_000_000n,
        nowSeconds: now + 7 * 86_400 + 10,
      });
      expect(next.period).toBe(1);
    });
  },
);
