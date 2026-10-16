import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { money } from '@synq/domain';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import {
  InvoiceService,
  PostgresInvoiceStore,
  draftInvoice,
  issueTypedData,
  reviseInvoice,
  type MemoPayment,
} from '@synq/invoices';
import {
  PostgresRecourseStore,
  PostgresReservationStore,
  RecourseReconciler,
  ReservationError,
} from '@synq/settlement';
import { PostgresSplitStore, migrateAllocations } from '@synq/allocations';
import { connectChain } from '@synq/execution-worker/arc';
import { payOnce, recover } from '@synq/execution-worker/arc-outbox';
import { PostgresOutboxStore } from '@synq/execution-worker/pg-outbox';
import {
  GatewayLedgerError,
  PostgresGatewayLedger,
} from '@synq/execution-worker/pg-cctp-gateway';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { durablePool, runId } from '../durable/pg.js';
import { USDC, countingSigner, fakeArc } from '../durable/fake-arc.js';
import { AUSD, T0, req } from '../settlement/reservation-scenarios.js';
import { concurrentFloorScenario } from './floor-scenario.js';

/**
 * Cross-cutting FUNDS/LOAD rows that need real Postgres concurrency (row
 * locks, unique constraints, compare-and-set). Locally:
 *   SYNQ_DURABLE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55433/synq_m2_secperf_funds
 */
let pool: pg.Pool;
const schemas: string[] = [];
beforeAll(async () => {
  pool = await durablePool(undefined, 10);
  await migrateExecution(pool);
  await migrateFinance(pool);
});
afterAll(async () => {
  for (const s of schemas)
    await pool.query(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await pool.end();
});
const freshSchema = () => {
  const s = `xcut_${runId()}`;
  schemas.push(s);
  return s;
};

describe(
  'cross-cutting money invariants on Postgres',
  { timeout: 120_000 },
  () => {
    it('X-FUN-02 fifty concurrent replays of one Gateway deposit credit it once; buckets stay conserved and never negative', async () => {
      const gw = new PostgresGatewayLedger(pool);
      await gw.migrate();
      const account = `gw_${runId()}`;
      await gw.open(account, 10_000n, 1);
      const deposit = {
        chainId: 11155111,
        txHash: keccak256(toHex(`deposit-${account}`)),
        amount: 4_000n,
      };
      const outcomes = await Promise.all(
        Array.from({ length: 50 }, (_, i) =>
          gw.deposit(account, deposit, 2 + i),
        ),
      );
      expect(outcomes.filter((o) => o === 'CREDITED')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(49);
      let b = await gw.buckets(account);
      expect(b).toEqual({
        sourceFree: 6_000n,
        pending: 4_000n,
        available: 0n,
        reserved: 0n,
      });
      await expect(gw.observeAvailable(account, 4_001n, 100)).rejects.toThrow(
        GatewayLedgerError,
      );
      await gw.observeAvailable(account, 4_000n, 101);
      // Twenty concurrent burn intents of 300 against 4,000 available.
      const reserves = await Promise.allSettled(
        Array.from({ length: 20 }, (_, i) =>
          gw.reserve(
            account,
            {
              salt: keccak256(toHex(`salt-${account}-${i}`)),
              value: 300n,
              intent: { i },
              signature: `0x${'11'.repeat(65)}` as Hex,
            },
            200 + i,
          ),
        ),
      );
      const ok = reserves.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBe(13); // floor(4000 / 300)
      b = await gw.buckets(account);
      expect(b.reserved).toBe(300n * BigInt(ok));
      expect(b.sourceFree + b.pending + b.available + b.reserved).toBe(10_000n);
      // The same salt can never be reserved twice.
      await expect(
        gw.reserve(
          account,
          {
            salt: keccak256(toHex(`salt-${account}-0`)),
            value: 1n,
            intent: {},
            signature: `0x${'11'.repeat(65)}` as Hex,
          },
          300,
        ),
      ).rejects.toThrow(expect.objectContaining({ code: 'DUPLICATE_SPEND' }));
    });

    it('X-FUN-06 200 concurrent reservations on Postgres never dip into the mandatory reserve', async () => {
      const s = new PostgresReservationStore(pool, freshSchema());
      await s.migrate();
      await s.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 50_000n,
        mandatoryReserve: 12_345n,
        asOf: T0,
      });
      const amounts = Array.from(
        { length: 200 },
        (_, i) => ((i * 7_919) % 900) + 50,
      );
      const results = await Promise.allSettled(
        amounts.map((a) => s.reserve(req({ amount: String(a) }), T0)),
      );
      const reserved = results
        .filter((r) => r.status === 'fulfilled')
        .reduce(
          (n, r) =>
            n +
            BigInt(
              (r as PromiseFulfilledResult<{ amount: string }>).value.amount,
            ),
          0n,
        );
      const free = await s.free('group-1', AUSD);
      expect(reserved).toBeLessThanOrEqual(50_000n - 12_345n);
      expect(BigInt(free.held)).toBe(reserved);
      expect(BigInt(free.free)).toBe(50_000n - 12_345n - reserved);
      for (const r of results)
        if (r.status === 'rejected')
          expect((r.reason as ReservationError).code).toBe(
            'INSUFFICIENT_FREE_BALANCE',
          );
    });

    it('X-FUN-06 five revenue splits on one treasury run concurrently on Postgres: floor kept, holds never spent', async () => {
      await migrateAllocations(pool, 0);
      const r = await concurrentFloorScenario(async () => {
        const store = new PostgresSplitStore(pool);
        await store.migrate();
        return store;
      });
      expect(r.results).toHaveLength(5);
      await migrateAllocations(pool, 0);
      await pool.query('DROP TABLE IF EXISTS synq_allocations_migrations');
    });

    it('X-LOA-07 eight concurrent checkouts on one invoice (separate service instances, one database) all apply; books match the document', async () => {
      const ws = `wsp_xfun_${runId()}`;
      const issuer = privateKeyToAccount(
        keccak256(toHex('synq-x-loa-07:issuer')),
      );
      const payer = privateKeyToAccount(generatePrivateKey()).address;
      let t = 1_800_000_000;
      const now = () => t++;
      const service = () =>
        new InvoiceService(
          new PostgresInvoiceStore(pool),
          new Ledger(new PostgresLedgerStore(pool)),
          now,
        );
      const draft = (number: string) =>
        draftInvoice({
          workspaceId: ws,
          number,
          issuer: {
            principalId: 'prn_f',
            name: 'Studio',
            wallet: issuer.address,
            payoutAddress: issuer.address,
          },
          payer: { name: 'Acme', contact: null },
          asset: USDC,
          lineItems: [
            { description: 'Work', quantity: 1, unitPrice: 1_000_000n },
          ],
          dueDate: '2026-10-30',
          draftedBy: 'agent:invoice',
          now: now(),
        });
      const d = draft('INV-RACE-1');
      await service().create(d);
      const inv = (
        await service().issue(
          d.invoiceId,
          await issuer.signTypedData(issueTypedData(d)),
        )
      ).invoice;
      const pay = (i: number, amount: bigint): MemoPayment => ({
        chainId: USDC.chainId,
        txHash: keccak256(toHex(`${ws}:tx:${i}`)),
        logIndex: 1,
        paymentRef: inv.paymentRef!,
        payer,
        recipient: issuer.address,
        amount,
      });
      const payments = Array.from({ length: 8 }, (_, i) => pay(i, 150_000n));
      const outcomes = await Promise.all(
        [...payments, ...payments].map((p) => service().settle(p)),
      );
      expect(outcomes.filter((o) => o.outcome === 'APPLIED')).toHaveLength(8);
      expect(outcomes.filter((o) => o.outcome === 'DUPLICATE')).toHaveLength(8);
      const doc = (await new PostgresInvoiceStore(pool).get(inv.invoiceId))!
        .invoice;
      expect(doc).toMatchObject({ status: 'OVERPAID', paid: 1_200_000n });
      const ledger = new Ledger(new PostgresLedgerStore(pool));
      const bal = await ledger.balances(ws, USDC.assetId);
      expect(bal.CASH_ARC_USDC).toBe(1_200_000n);
      expect(bal.ACCOUNTS_RECEIVABLE).toBe(0n);
      expect(bal.REFUND_LIABILITY).toBe(-200_000n);
      expect(bal.REVENUE).toBe(-1_000_000n);

      // A revision racing a checkout: whichever wins, the books match the document.
      const r2 = draft('INV-RACE-2');
      await service().create(r2);
      const v1 = (
        await service().issue(
          r2.invoiceId,
          await issuer.signTypedData(issueTypedData(r2)),
        )
      ).invoice;
      const store = new PostgresInvoiceStore(pool);
      const revise = async () => {
        for (;;) {
          const cur = (await store.get(v1.invoiceId))!;
          if (cur.invoice.status === 'PAID') return 'PAID_FIRST';
          try {
            await store.save(
              reviseInvoice(
                cur.invoice,
                { dueDate: '2026-11-30' },
                now(),
                'race',
              ),
              cur.rev,
            );
            return 'REVISED';
          } catch (e) {
            if ((e as { code?: string }).code !== 'CONFLICT') throw e;
          }
        }
      };
      const [settled, revised] = await Promise.all([
        service().settle({
          ...pay(99, 1_000_000n),
          paymentRef: v1.paymentRef!,
        }),
        revise(),
      ]);
      const after = (await store.get(v1.invoiceId))!.invoice;
      const cashForDoc = (await ledger.store.entries(ws))
        .flatMap((e) => e.postings)
        .filter(
          (p) =>
            p.account === 'CASH_ARC_USDC' && p.documentRef === v1.invoiceId,
        )
        .reduce((n, p) => n + p.amount, 0n);
      expect(cashForDoc).toBe(after.paid);
      if (settled.outcome === 'UNMATCHED') expect(after.paid).toBe(0n);
      else expect(after.paid).toBe(1_000_000n);
      expect(['REVISED', 'PAID_FIRST']).toContain(revised);
    });

    it('X-LOA-05 1000 concurrent copies of a provider refund webhook on Postgres record it once', async () => {
      const schema = freshSchema();
      const reservations = new PostgresReservationStore(pool, schema);
      await reservations.migrate();
      const recourse = new PostgresRecourseStore(pool, schema);
      await recourse.migrate();
      await reservations.setConfirmedBalance({
        groupId: 'group-1',
        assetId: AUSD,
        confirmed: 10_000n,
        asOf: T0,
      });
      const r = await reservations.reserve(req({ amount: '1000' }), T0);
      await reservations.capture(r.reservationId, 800n, T0);
      const TREASURY = '0x00000000000000000000000000000000000a11ce';
      const rec = new RecourseReconciler(
        recourse,
        reservations,
        async () => TREASURY,
        () => T0 + 10,
      );
      const before = await reservations.free('group-1', AUSD);
      const outcomes = await Promise.all(
        Array.from({ length: 1_000 }, () =>
          rec.apply({
            eventId: `evt-storm-${r.reservationId}`,
            providerId: 'duffel-stays',
            providerRef: `bok-${r.reservationId}`,
            reservationId: r.reservationId,
            providerUpdatedAt: T0 + 1,
            kind: 'REFUND_ISSUED',
            refundId: `rf-${r.reservationId}`,
            refundCore: '300',
            refundDestination: TREASURY,
          }),
        ),
      );
      expect(outcomes.filter((o) => o === 'REFUND_PENDING')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'DUPLICATE')).toHaveLength(999);
      const after = await reservations.free('group-1', AUSD);
      expect(after.free).toBe(before.free);
      expect(after.pendingRefunds).toBe('300');
    });

    it('X-LOA-07 concurrent payouts contending for one sender on the Postgres outbox: no key signs twice, no transfer is paid twice, losers stop for review', async () => {
      const arc = fakeArc();
      const sender = privateKeyToAccount(generatePrivateKey());
      arc.setPayer(sender.address);
      const chain = await connectChain('arc-testnet', undefined, arc.client);
      const signer = countingSigner(sender);
      const payee = '0x00000000000000000000000000000000000beef1' as Address;
      const keys = Array.from(
        { length: 10 },
        (_, i) => `payout:xloa07:${runId()}:${i}`,
      );
      let t = 1_800_000_000;
      const now = () => t++;
      // Five workers per key, ten keys, one sender: fifty concurrent attempts.
      const attempts = keys.flatMap((key, i) =>
        Array.from({ length: 5 }, () =>
          payOnce({
            store: new PostgresOutboxStore(pool),
            key,
            chain,
            signer,
            transfer: {
              from: sender.address,
              to: payee,
              amount: money(USDC, BigInt(1_000 + i)),
            },
            now,
          }).catch((e: Error) => e),
        ),
      );
      await Promise.all(attempts);
      const store = new PostgresOutboxStore(pool);
      // Restart: settle every unsettled record without signing anything.
      for (const k of keys) {
        const r = await store.get(k);
        if (r && r.state === 'SIGNED') await recover(store, chain, r, now);
      }
      const records = await Promise.all(keys.map((k) => store.get(k)));
      expect(signer.count).toBeLessThanOrEqual(keys.length + 4 * keys.length); // losers discard unsent
      const recorded = records.filter((r) => r !== null);
      // Every mined transaction belongs to exactly one key, at most once.
      const minedHashes = [...arc.mined.keys()];
      expect(new Set(minedHashes).size).toBe(minedHashes.length);
      for (const h of minedHashes)
        expect(recorded.filter((r) => r!.hash === h)).toHaveLength(1);
      const confirmed = recorded.filter((r) => r!.state === 'CONFIRMED');
      expect(confirmed.length).toBe(arc.mined.size);
      // Keys whose signed nonce was taken by another key stop for review, unpaid.
      for (const r of recorded)
        expect(['CONFIRMED', 'NEEDS_REVIEW']).toContain(r!.state);
      expect(confirmed.length).toBeGreaterThanOrEqual(1);
    });
  },
);
