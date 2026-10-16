import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import type { Address } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { money } from '@synq/domain';
import {
  decide,
  mandateTypedData,
  type AuthorityConfig,
  type PaymentMandate,
} from '@synq/kernel/arc';
import { connectChain } from '@synq/execution-worker/arc';
import { payGrantOnce } from '@synq/execution-worker/arc-outbox';
import {
  PostgresGrantFence,
  PostgresOutboxStore,
} from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { DURABLE_DATABASE_URL, durablePool, runId } from '../durable/pg.js';
import { USDC, countingSigner, fakeArc } from '../durable/fake-arc.js';

/**
 * X-KER-03 on Postgres: two executor processes (separate connection pools,
 * separate outbox keys, so the outbox key cannot serialize them) present the
 * same Kernel grant concurrently. Only the durable grant fence stands between
 * them and a double payment. LOCAL_FIXTURE chain; real Postgres.
 *   SYNQ_DURABLE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/synq_m2_secperf_kernel
 */

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const payee = '0x00000000000000000000000000000000000beef3' as Address;
const config: AuthorityConfig = {
  grantKey: new Uint8Array(32).fill(13),
  operator: 'arc-executor-xker03',
  grantTtlSeconds: 600,
  riskRequiredAbove: 50_000_000n,
};
let workerA: pg.Pool;
let workerB: pg.Pool;
const T = Math.floor(Date.now() / 1000);

beforeAll(async () => {
  workerA = await durablePool(DURABLE_DATABASE_URL, 4);
  workerB = await durablePool(DURABLE_DATABASE_URL, 4);
  await migrateExecution(workerA);
});
afterAll(async () => {
  await workerA.end();
  await workerB.end();
});

describe(
  'X-KER-03 grant used twice in two workers (Postgres)',
  { timeout: 60_000 },
  () => {
    it('X-KER-03 two executor processes with different outbox keys race one grant: one signature broadcast, the other refused before broadcast', async () => {
      const payer = privateKeyToAccount(generatePrivateKey());
      const arc = fakeArc();
      arc.setPayer(payer.address);
      const chain = await connectChain('arc-testnet', undefined, arc.client);
      const signer = countingSigner(payer);
      const mandate: PaymentMandate = {
        mandateId: `mnd_xker03_${runId()}`,
        version: 1,
        workspaceId: 'wsp_xker03',
        owner: owner.address,
        chainId: USDC.chainId,
        token: USDC.address,
        payer: payer.address,
        recipients: [payee],
        purposes: ['CONTRACTOR_PAYOUT'],
        perActionCap: 1_000_000n,
        periodBudget: 5_000_000n,
        periodSeconds: 86_400,
        validFrom: T - 100,
        validUntil: T + 86_400,
      };
      const d = await decide({
        config,
        mandate,
        mandateSignature: await owner.signTypedData(mandateTypedData(mandate)),
        state: { revoked: false, spends: [] },
        intent: {
          intentId: `int_${runId()}`,
          mandateId: mandate.mandateId,
          mandateVersion: 1,
          chainId: USDC.chainId,
          token: USDC.address,
          payer: payer.address,
          recipient: payee,
          amount: 300_000n,
          purpose: 'CONTRACTOR_PAYOUT',
          obligationRef: `obl_${runId()}`,
          evidenceHash: `0x${'e3'.repeat(32)}`,
          proposedBy: 'agent:payments',
        },
        risk: { flags: [], available: true },
        simulationOk: true,
        now: T,
      });
      if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
      const worker = (pool: pg.Pool, key: string) =>
        payGrantOnce({
          key,
          store: new PostgresOutboxStore(pool),
          fence: new PostgresGrantFence(pool),
          grant: d.grant,
          grantKey: config.grantKey,
          mandateRevoked: false,
          chain,
          signer,
          transfer: {
            from: payer.address,
            to: payee,
            amount: money(USDC, 300_000n),
          },
          now: () => T + 1,
        });
      const results = await Promise.allSettled([
        worker(workerA, `worker-a:${runId()}`),
        worker(workerB, `worker-b:${runId()}`),
        worker(workerA, `worker-a2:${runId()}`),
        worker(workerB, `worker-b2:${runId()}`),
      ]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected'))
        expect((r as PromiseRejectedResult).reason).toMatchObject({
          code: 'GRANT_REPLAYED',
        });
      expect(arc.sent).toHaveLength(1);
      expect(arc.mined.size).toBe(1);
      // Exactly one consumption row, visible to both workers.
      const rows = await workerB.query(
        'SELECT count(*)::int AS n FROM synq_consumed_grants WHERE grant_id=$1',
        [d.grant.grantId],
      );
      expect(rows.rows[0]!.n).toBe(1);
    });
  },
);
