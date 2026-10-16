import { describe, expect, it } from 'vitest';
import { keccak256, stringToHex } from 'viem';
import {
  explainAllocation,
  legRef,
  receiptKey,
  treasuryScope,
  type SplitStore,
} from '@synq/allocations';
import { walletCashWei, walletTag } from '@synq/ledger';
import {
  DEV,
  SAVINGS,
  TX,
  USDC,
  VAULT,
  devInvoice,
  intruder,
  policy1500,
  receipt1500,
  signPolicy,
  usd,
  world,
  type World,
} from './harness.js';

const transferLegs = async (w: World, splitId: string) =>
  (await w.store.legs(splitId)).filter((l) => l.kind === 'TRANSFER');

/** The same scenarios against any SplitStore (memory and Postgres). */
export function splitScenarios(
  name: string,
  makeStore: () => Promise<SplitStore>,
) {
  describe(`Revenue split workflow (${name})`, () => {
    it('runs the $1,500 split end to end and books each leg against its chain receipt', async () => {
      const w = await world({ store: await makeStore() });
      const { split, duplicate } = await w.runner.trigger(w.receipt);
      expect(duplicate).toBe(false);
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('COMPLETED');
      expect((await w.store.events(split.splitId)).map((e) => e.to)).toEqual([
        'RECEIPT_FINAL',
        'LIABILITIES_RECONCILED',
        'RESERVATIONS_CREATED',
        'POLICY_VALIDATED',
        'SPLIT_AUTHORIZED',
        'EXECUTING',
        'EACH_LEG_RECONCILED',
        'COMPLETED',
      ]);
      expect(w.fake.paid.map((p) => [p.recipient, p.amount])).toEqual([
        [DEV, usd('300')],
        [SAVINGS, usd('18')],
      ]);
      const legs = await w.store.legs(split.splitId);
      expect(legs.map((l) => l.state)).toEqual([
        'RESERVED',
        'RECONCILED',
        'RESERVED',
        'RESERVED',
        'RESERVED',
        'RECONCILED',
        'FREE',
      ]);
      // Books: vault cash = receipt - transfers; AP for the invoice settled.
      const entries = await w.ledger.store.entries(w.policy.workspaceId);
      const cash = walletCashWei(entries, USDC.assetId);
      expect(cash.get(walletTag(VAULT))).toBe(
        (usd('1500') - usd('318')) * 10n ** 12n,
      );
      const bal = await w.ledger.balances(w.policy.workspaceId, USDC.assetId);
      expect(bal.ACCOUNTS_PAYABLE).toBe(0n);
      expect(bal.CONTRACTOR_EXPENSE).toBe(usd('300'));
      expect(bal.OWNER_EQUITY).toBe(usd('18'));
      const res = await w.store.reservations(treasuryScope(w.policy));
      expect(
        res
          .filter((r) => r.status === 'ACTIVE')
          .reduce((a, r) => a + r.amount, 0n),
      ).toBe(usd('225') + usd('295') + usd('500'));
      expect(
        res.filter((r) => r.status === 'CONSUMED').map((r) => r.amount),
      ).toEqual([usd('300'), usd('18')]);
      const ex = explainAllocation({
        split: done,
        legs,
        reservations: res,
        decimals: 6,
        symbol: 'USDC',
        explorer: 'https://explorer.testnet.arc.io',
      });
      expect(ex.headline).toMatch(
        /1500\.00 USDC received: 225\.00 USDC tax estimate reserved, 300\.00 USDC contractor payables/,
      );
      expect(ex.summary.freeCash).toBe('162.00');
      expect(ex.lines.join('\n')).toMatch(/not a tax payment/);
      expect(ex.citations).toHaveLength(3);
    });

    it('P14-01 the tax reserve holds cash and moves nothing', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId);
      const tax = (await w.store.legs(split.splitId)).find(
        (l) => l.purpose === 'TAX_ESTIMATE',
      )!;
      expect(tax).toMatchObject({
        kind: 'RESERVE',
        state: 'RESERVED',
        payTo: null,
        txHash: null,
        grant: null,
      });
      expect(await w.outbox.get(tax.legKey)).toBeNull();
      expect(w.fake.paid.some((p) => p.amount === tax.amount)).toBe(false);
      const r = (await w.store.reservations(treasuryScope(w.policy))).find(
        (x) => x.reservationId === tax.legKey,
      )!;
      expect(r).toMatchObject({
        purpose: 'TAX_ESTIMATE',
        status: 'ACTIVE',
        remitted: false,
        amount: usd('225'),
      });
      const entries = await w.ledger.store.entries(w.policy.workspaceId);
      expect(
        entries.some((e) =>
          e.postings.some((p) => p.documentRef === tax.legKey),
        ),
      ).toBe(false);
    });

    it('P14-06 every leg is linked to the one invoice receipt, on chain and in the books', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      await w.runner.run(split.splitId);
      const legs = await w.store.legs(split.splitId);
      for (const l of legs) {
        expect(l.receiptId).toBe(w.receipt.receiptId);
        expect(l.legKey).toBe(`${w.receipt.receiptId}#${l.legIndex}`);
      }
      for (const l of legs.filter((x) => x.kind === 'TRANSFER')) {
        expect(l.evidence!.ref).toBe(keccak256(stringToHex(l.legKey)));
        expect(w.fake.paid.find((p) => p.amount === l.amount)!.ref).toBe(
          legRef(l.legKey),
        );
      }
      const entries = await w.ledger.store.entries(w.policy.workspaceId);
      const legCash = entries.flatMap((e) =>
        e.postings.filter(
          (p) =>
            p.account === 'CASH_ARC_USDC' &&
            p.documentRef?.startsWith(w.receipt.receiptId),
        ),
      );
      expect(legCash.map((p) => p.amount)).toEqual([-usd('300'), -usd('18')]);
      expect((await w.store.get(split.splitId))!.plan!.invoiceId).toBe(
        'inv_acme',
      );
    });

    it('P14-04 a crash after leg 1 is paid and leg 2 is signed resumes without paying leg 1 again', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      const legs = await w.store.legs(split.splitId).catch(() => []);
      expect(legs).toEqual([]);
      w.crash.at = `${w.receipt.receiptId}#5`;
      const first = await w.runner.run(split.splitId);
      expect(first.state).toBe('FAILED');
      expect(w.fake.paid).toHaveLength(1);
      const mid = await transferLegs(w, split.splitId);
      expect(mid.map((l) => l.state)).toEqual(['CONFIRMED', 'SUBMITTED']);
      expect((await w.outbox.get(mid[1]!.legKey))!.state).toBe('SIGNED');
      // Restart: a new runner over the same durable stores.
      const restarted = w.makeRunner();
      const [after] = await restarted.resume();
      expect(after!.state).toBe('COMPLETED');
      expect(w.fake.paid.map((p) => p.recipient)).toEqual([DEV, SAVINGS]);
      expect(w.signer.total).toBe(2); // one signature per leg, ever
      expect(new Set(w.fake.broadcasts).size).toBe(2);
      // Running again changes nothing.
      expect((await restarted.run(split.splitId)).state).toBe('COMPLETED');
      expect(w.fake.paid).toHaveLength(2);
      expect(w.signer.total).toBe(2);
    });

    it('P14-04 a hard crash (process gone mid-leg) is recovered by a fresh runner from the record', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      w.crash.at = `${w.receipt.receiptId}#5`;
      w.crash.mode = 'hang';
      void w.runner.run(split.splitId); // never completes: the "dead" process
      for (
        let i = 0;
        i < 200 && !(await w.outbox.get(`${w.receipt.receiptId}#5`));
        i++
      )
        await new Promise((r) => setTimeout(r, 5));
      expect((await w.store.get(split.splitId))!.state).toBe('EXECUTING');
      expect(w.fake.paid).toHaveLength(1);
      const [after] = await w.makeRunner().resume();
      expect(after!.state).toBe('COMPLETED');
      expect(w.fake.paid.map((p) => p.amount)).toEqual([usd('300'), usd('18')]);
      expect(w.signer.total).toBe(2);
    });

    it('P14-04 a leg the vault refuses fails the split; retries never repay the settled leg', async () => {
      const w = await world({
        store: await makeStore(),
        chainCaps: { windowCap: usd('310') },
      });
      const { split } = await w.runner.trigger(w.receipt);
      const r1 = await w.runner.run(split.splitId);
      expect(r1.state).toBe('FAILED');
      expect(r1.note).toMatch(/CapExceeded/);
      const r2 = await w.makeRunner().run(split.splitId);
      expect(r2.state).toBe('FAILED');
      expect(w.fake.paid).toEqual([
        expect.objectContaining({ recipient: DEV, amount: usd('300') }),
      ]);
      expect(w.signer.total).toBe(1);
      const legs = await transferLegs(w, split.splitId);
      expect(legs.map((l) => l.state)).toEqual(['CONFIRMED', 'AUTHORIZED']);
    });

    it('P14-05 a leg over the autonomous limit is refused in TS and never signed', async () => {
      const w = await world({
        store: await makeStore(),
        payables: [devInvoice(usd('450'), 5)],
      });
      const { split } = await w.runner.trigger(w.receipt);
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/fresh owner approval/);
      const over = (await w.store.legs(split.splitId)).find(
        (l) => l.documentRef === 'vin_dev_1',
      )!;
      expect(over).toMatchObject({
        state: 'AWAITING_APPROVAL',
        grant: null,
        txHash: null,
      });
      expect(over.reasons.join()).toMatch(/above the autonomous per-leg limit/);
      expect(w.fake.paid.some((p) => p.recipient === DEV)).toBe(false);
    });

    it('P14-05 when TS limits would allow it, the vault contract still refuses an over-cap leg', async () => {
      const w = await world({
        store: await makeStore(),
        chainCaps: { perPaymentCap: usd('200') },
      });
      const { split } = await w.runner.trigger(w.receipt);
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(
        /simulation: CapExceeded\(300000000,200000000\)/,
      );
      expect(w.signer.total).toBe(0);
      expect(w.fake.paid).toEqual([]);
    });

    it('a duplicate trigger for the same receipt returns the same split and pays nothing more', async () => {
      const w = await world({ store: await makeStore() });
      const a = await w.runner.trigger(w.receipt);
      await w.runner.run(a.split.splitId);
      const b = await w.runner.trigger(w.receipt);
      expect(b.duplicate).toBe(true);
      expect(b.split.splitId).toBe(a.split.splitId);
      await w.runner.run(b.split.splitId);
      expect(w.fake.paid).toHaveLength(2);
    });

    it('a receipt that is not final on chain starts nothing', async () => {
      const w = await world({ store: await makeStore() });
      const pending = { ...w.receipt, finality: 'PENDING' as const };
      const runner = w.makeRunner();
      (
        runner.deps as {
          receipts: { verify: (r: typeof pending) => Promise<typeof pending> };
        }
      ).receipts = {
        verify: async (r) => r,
      };
      await expect(runner.trigger(pending)).rejects.toMatchObject({
        code: 'RECEIPT_NOT_FINAL',
      });
      expect(await w.store.byReceipt(pending.receiptId)).toBeNull();
    });

    it('a receipt missing from the books goes to review, not to payment', async () => {
      const w = await world({ store: await makeStore() });
      const other = receipt1500(usd('1500'), {
        txHash: TX(9),
        receiptId: receiptKey(USDC.chainId, TX(9), 3),
      });
      const { split } = await w.runner.trigger(other);
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/not booked/);
      expect(w.fake.paid).toEqual([]);
    });

    it('a policy not signed by the owner stops at validation; reservations hold, nothing is paid', async () => {
      const store = await makeStore();
      const policy = policy1500();
      const w = await world({
        store,
        policy,
        signed: await signPolicy(policy, intruder),
      });
      const { split } = await w.runner.trigger(w.receipt);
      const done = await w.runner.run(split.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/NOT_SIGNED_BY_OWNER/);
      expect(w.fake.paid).toEqual([]);
      expect(w.signer.total).toBe(0);
    });

    it('a stale balance blocks planning and leaves the split where it was', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      const runner = w.makeRunner();
      const books = runner.deps.books;
      (runner.deps as { books: typeof books }).books = {
        ...books,
        position: async () => ({ ...(await books.position()), observedAt: 0 }),
      };
      await expect(runner.run(split.splitId)).rejects.toMatchObject({
        code: 'STALE_BALANCE',
      });
      expect((await w.store.get(split.splitId))!.state).toBe('RECEIPT_FINAL');
    });

    it('cancellation releases reservations before execution and is refused after', async () => {
      const w = await world({ store: await makeStore() });
      const { split } = await w.runner.trigger(w.receipt);
      expect(
        (await w.runner.run(split.splitId, { stopAt: 'SPLIT_AUTHORIZED' }))
          .state,
      ).toBe('SPLIT_AUTHORIZED');
      const held = await w.store.reservations(treasuryScope(w.policy));
      expect(held.filter((r) => r.status === 'ACTIVE')).toHaveLength(6);
      const cancelled = await w.runner.cancel(split.splitId, 'owner cancelled');
      expect(cancelled.state).toBe('CANCELLED');
      expect(
        (await w.store.reservations(treasuryScope(w.policy))).every(
          (r) => r.status === 'RELEASED',
        ),
      ).toBe(true);
      expect(
        (await w.store.legs(split.splitId)).every(
          (l) => l.state === 'CANCELLED',
        ),
      ).toBe(true);
      expect(w.fake.paid).toEqual([]);
      const w3 = await world({ store: await makeStore() });
      const s3 = (await w3.runner.trigger(w3.receipt)).split;
      w3.crash.at = `${w3.receipt.receiptId}#5`;
      await w3.runner.run(s3.splitId);
      await expect(
        w3.runner.cancel(s3.splitId, 'too late'),
      ).rejects.toMatchObject({ code: 'WRONG_STATE' });
    });

    it('the frequency limit sends an extra split to review', async () => {
      const store = await makeStore();
      const policy = policy1500({
        limits: { ...policy1500().limits, maxSplitsPerWindow: 1 },
      });
      const w = await world({ store, policy });
      await w.runner.run((await w.runner.trigger(w.receipt)).split.splitId);
      const second = receipt1500(usd('100'), {
        txHash: TX(2),
        receiptId: receiptKey(USDC.chainId, TX(2), 3),
      });
      await w.addReceipt(second);
      const s = (await w.runner.trigger(second)).split;
      const done = await w.runner.run(s.splitId);
      expect(done.state).toBe('NEEDS_REVIEW');
      expect(done.note).toMatch(/frequency limit/);
    });

    it('a vendor invoice paid from one receipt is not planned again from the next', async () => {
      const store = await makeStore();
      const w = await world({ store });
      await w.runner.run((await w.runner.trigger(w.receipt)).split.splitId);
      const second = receipt1500(usd('1500'), {
        txHash: TX(3),
        receiptId: receiptKey(USDC.chainId, TX(3), 3),
      });
      await w.addReceipt(second);
      const s = (await w.runner.trigger(second)).split;
      await w.runner.run(s.splitId);
      const plan = (await store.get(s.splitId))!.plan!;
      expect(plan.legs.some((l) => l.documentRef === 'vin_dev_1')).toBe(false);
    });
  });
}
