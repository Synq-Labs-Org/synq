import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { keccak256, toHex, zeroAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import {
  ArcCashIndexer,
  ArcChainIndexer,
  Ledger,
  LedgerError,
  MemoryArcIndexStore,
  MemoryLedgerStore,
  validateEntry,
  type IndexedEvent,
  type JournalEntry,
} from '@synq/ledger';
import {
  InvoiceError,
  InvoiceService,
  MemoryInvoiceStore,
  draftInvoice,
  issueTypedData,
  paymentEntry,
  reviseInvoice,
  type InvoiceStore,
  type MemoPayment,
} from '@synq/invoices';
import { GatewayAccount, GatewayError } from '@synq/plugin-circle-gateway';
import {
  CctpError,
  checkMessage,
  decodeMessage,
  maxFeeFor,
  netMinted,
  planTransfer,
} from '@synq/plugin-circle-cctp';
import {
  MemoryRecourseStore,
  MemoryReservationStore,
  RecourseReconciler,
  ReservationError,
} from '@synq/settlement';
import {
  AllocationError,
  MemorySplitStore,
  computeWaterfall,
  policyHash as revenuePolicyHash,
} from '@synq/allocations';
import { AUSD, T0, req } from '../settlement/reservation-scenarios.js';
import {
  TOKEN,
  TOKEN_CODE,
  forkableChain,
} from '../durable/fake-indexer-chain.js';
import {
  T0 as ALLOC_T0,
  bills1500,
  devInvoice,
  policy1500,
  position,
  receipt1500,
  receivables1500,
  usd,
  vendors,
} from '../allocations/harness.js';
import { concurrentFloorScenario } from './floor-scenario.js';

/**
 * Cross-cutting FUNDS rows (X-FUN-*): money conservation across the ledger,
 * invoices, CCTP/Gateway buckets, refunds, the waterfall and reservations.
 * Every test drives the real package code; property tests use fast-check
 * with fixed seeds so failures replay.
 */

const USDC = token('arc-testnet', 'USDC');
const me = '0x00000000000000000000000000000000000000a1' as Address;
const relayer = '0x00000000000000000000000000000000000000c3' as Address;

function cashIndexer(ledger: Ledger, workspaceId = 'wsp_fun') {
  return new ArcCashIndexer(ledger, {
    workspaceId,
    wallet: me,
    assetId: USDC.assetId,
    token: TOKEN,
    chainId: 5042002,
    classify: () => ({
      counterAccount: 'UNAPPLIED_RECEIPTS',
      memo: 'CCTP mint to the treasury',
    }),
  });
}
const toLog = (e: IndexedEvent) => ({
  chainId: e.chainId,
  blockNumber: e.blockNumber,
  blockHash: e.blockHash,
  txHash: e.txHash,
  logIndex: e.logIndex,
  removed: e.removed,
  token: e.emitter,
  from: e.data.from as Address,
  to: e.data.to as Address,
  value: BigInt(e.data.value!),
});
const cash = async (ledger: Ledger, ws = 'wsp_fun') =>
  (await ledger.store.entries(ws))
    .flatMap((e) => e.postings)
    .filter((p) => p.account === 'CASH_ARC_USDC')
    .reduce((n, p) => n + p.amount, 0n);

describe('X-FUN-01 same CCTP source burn indexed twice', () => {
  it('X-FUN-01 a CCTP mint indexed twice (re-scan with a lost cursor, redelivery, second indexer) credits cash once', async () => {
    const { chain, api } = forkableChain();
    // The destination mint of a CCTP burn: a token Transfer from 0x0.
    api.mine([
      { from: zeroAddress, to: me, value: 4_990_000n, sender: relayer },
    ]);
    api.mine([{ from: zeroAddress, to: me, value: 990_000n, sender: relayer }]);
    api.mineEmpty(3);
    const cfg = {
      stream: 'arc:x-fun-01',
      chainId: 5042002,
      token: { address: TOKEN, codeHash: keccak256(TOKEN_CODE) },
      memo: null,
      wallets: [me],
      startBlock: 1n,
      confirmations: 0,
      batchSize: 10n,
    };
    const ledger = new Ledger(new MemoryLedgerStore());
    const sink = (e: IndexedEvent) => cashIndexer(ledger).ingest(toLog(e));
    for (let pass = 0; pass < 3; pass++) {
      // Each pass is a fresh process with a fresh (lost) cursor store.
      const ix = new ArcChainIndexer(chain, new MemoryArcIndexStore(), cfg);
      for (let i = 0; i < 10; i++) if ((await ix.step()).idle) break;
      const done = await ix.applyEffects({ TRANSFER: sink });
      expect(done.map((d) => d.outcome)).toEqual(
        pass === 0 ? ['POSTED', 'POSTED'] : ['DUPLICATE', 'DUPLICATE'],
      );
    }
    expect(await cash(ledger)).toBe(4_990_000n + 990_000n);
  });

  it('X-FUN-01 property: any delivery order with any duplicates of N mint logs books exactly their sum', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.bigInt({ min: 1n, max: 10n ** 12n }), {
          minLength: 1,
          maxLength: 8,
        }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 40 }),
        async (amounts, picks) => {
          const ledger = new Ledger(new MemoryLedgerStore());
          const ix = cashIndexer(ledger);
          const logs = amounts.map((value, i) => ({
            chainId: 5042002,
            blockNumber: BigInt(100 + i),
            blockHash: keccak256(toHex(`b${i}`)),
            txHash: keccak256(toHex(`mint${i}`)),
            logIndex: 1,
            removed: false,
            token: TOKEN,
            from: zeroAddress,
            to: me,
            value,
          }));
          // Every log at least once, then arbitrary redeliveries.
          for (const l of logs) await ix.ingest(l);
          for (const p of picks) await ix.ingest(logs[p % logs.length]!);
          expect(await cash(ledger)).toBe(amounts.reduce((a, b) => a + b, 0n));
        },
      ),
      { numRuns: 100, seed: 2301 },
    );
  });
});

describe('X-FUN-02 Gateway deposit double-counted as source cash', () => {
  type Op =
    | { k: 'deposit'; amount: bigint }
    | { k: 'observe'; total: bigint }
    | { k: 'reserve'; value: bigint }
    | { k: 'settle'; value: bigint };
  const op: fc.Arbitrary<Op> = fc.oneof(
    fc.record({
      k: fc.constant('deposit' as const),
      amount: fc.bigInt({ min: 1n, max: 2_000n }),
    }),
    fc.record({
      k: fc.constant('observe' as const),
      total: fc.bigInt({ min: 0n, max: 5_000n }),
    }),
    fc.record({
      k: fc.constant('reserve' as const),
      value: fc.bigInt({ min: 1n, max: 2_000n }),
    }),
    fc.record({
      k: fc.constant('settle' as const),
      value: fc.bigInt({ min: 1n, max: 2_000n }),
    }),
  );

  it('X-FUN-02 property: a deposit leaves source cash as it enters Gateway; buckets always sum to the start, and only "available" is spendable', () => {
    fc.assert(
      fc.property(fc.array(op, { maxLength: 60 }), (ops) => {
        const start = 5_000n;
        const a = new GatewayAccount(start);
        let settled = 0n;
        let salt = 0;
        for (const o of ops) {
          const before = { ...a };
          try {
            if (o.k === 'deposit') a.deposit(o.amount);
            else if (o.k === 'observe') a.observeAvailable(o.total);
            else if (o.k === 'reserve')
              a.reserve(keccak256(toHex(`salt${salt++}`)), o.value);
            else {
              a.settle(o.value);
              settled += o.value;
            }
          } catch (e) {
            expect(e).toBeInstanceOf(GatewayError);
            // A refused step changes nothing.
            expect({ ...a }).toEqual(before);
          }
          const sum = a.sourceFree + a.pending + a.available + a.reserved;
          expect(sum + settled).toBe(start);
          expect(a.spendable()).toBe(a.available);
          for (const b of [a.sourceFree, a.pending, a.available, a.reserved])
            expect(b >= 0n).toBe(true);
        }
      }),
      { numRuns: 300, seed: 2302 },
    );
  });

  it('X-FUN-02 Gateway reporting more than was deposited, or a reused salt, is refused', () => {
    const a = new GatewayAccount(1_000n);
    a.deposit(400n);
    expect(() => a.observeAvailable(401n)).toThrow(GatewayError);
    a.observeAvailable(400n);
    const salt = keccak256(toHex('one-salt'));
    a.reserve(salt, 100n);
    expect(() => a.reserve(salt, 100n)).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_SPEND' }),
    );
    expect(a.sourceFree + a.pending + a.available + a.reserved).toBe(1_000n);
  });
});

describe('X-FUN-03 refund receivable mistaken for settled cash', () => {
  const TREASURY = '0x00000000000000000000000000000000000a11ce';
  type Step =
    | { k: 'cancel'; amount: bigint }
    | { k: 'refund'; amount: bigint; id: number }
    | { k: 'observe'; id: number; exact: boolean }
    | { k: 'reserve'; amount: bigint };
  const step: fc.Arbitrary<Step> = fc.oneof(
    fc.record({
      k: fc.constant('cancel' as const),
      amount: fc.bigInt({ min: 0n, max: 900n }),
    }),
    fc.record({
      k: fc.constant('refund' as const),
      amount: fc.bigInt({ min: 1n, max: 900n }),
      id: fc.nat({ max: 4 }),
    }),
    fc.record({
      k: fc.constant('observe' as const),
      id: fc.nat({ max: 4 }),
      exact: fc.boolean(),
    }),
    fc.record({
      k: fc.constant('reserve' as const),
      amount: fc.bigInt({ min: 1n, max: 3_000n }),
    }),
  );

  it('X-FUN-03 property: promised and even observed refunds never raise free cash until the confirmed balance reflects them', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 25 }), async (steps) => {
        const reservations = new MemoryReservationStore();
        await reservations.setConfirmedBalance({
          groupId: 'group-1',
          assetId: AUSD,
          confirmed: 10_000n,
          mandatoryReserve: 1_000n,
          asOf: T0,
        });
        const booking = await reservations.reserve(req({ amount: '1000' }), T0);
        await reservations.capture(booking.reservationId, 900n, T0);
        const rec = new RecourseReconciler(
          new MemoryRecourseStore(),
          reservations,
          async () => TREASURY,
          () => T0 + 10,
        );
        const promised = new Map<number, bigint>();
        let at = T0 + 1;
        let i = 0;
        for (const s of steps) {
          const before = await reservations.free('group-1', AUSD);
          if (s.k === 'cancel')
            await rec.apply({
              eventId: `cancel-${i++}`,
              providerId: 'duffel-stays',
              providerRef: 'bok-1',
              reservationId: booking.reservationId,
              providerUpdatedAt: at++,
              kind: 'CANCELED',
              refundCore: String(s.amount),
              refundDestination: TREASURY,
            });
          else if (s.k === 'refund') {
            // Reusing a refund id with another amount is refused outright.
            const o = await rec
              .apply({
                eventId: `refund-${i++}`,
                providerId: 'duffel-stays',
                providerRef: 'bok-1',
                reservationId: booking.reservationId,
                providerUpdatedAt: at++,
                kind: 'REFUND_ISSUED',
                refundId: `rf-${s.id}`,
                refundCore: String(s.amount),
                refundDestination: TREASURY,
              })
              .catch((e: unknown) => {
                expect(e).toBeInstanceOf(ReservationError);
                expect((e as ReservationError).code).toBe(
                  'RESERVATION_CONFLICT',
                );
                return 'REFUSED' as const;
              });
            if (o === 'REFUND_PENDING' && !promised.has(s.id))
              promised.set(s.id, s.amount);
          } else if (s.k === 'observe') {
            const amount = promised.get(s.id);
            if (amount !== undefined)
              await rec
                .observeRefund(
                  `rf-${s.id}`,
                  'bok-1',
                  s.exact ? amount : amount + 1n,
                )
                .catch(() => undefined);
          } else {
            await reservations
              .reserve(req({ amount: String(s.amount) }), T0)
              .catch((e) => expect(e).toBeInstanceOf(ReservationError));
          }
          const after = await reservations.free('group-1', AUSD);
          // Free cash is only ever confirmed − held − reserve.
          expect(BigInt(after.free)).toBe(
            BigInt(after.confirmed) -
              BigInt(after.held) -
              BigInt(after.mandatoryReserve) >
              0n
              ? BigInt(after.confirmed) -
                  BigInt(after.held) -
                  BigInt(after.mandatoryReserve)
              : 0n,
          );
          expect(after.confirmed).toBe('10000');
          // A refund event alone never adds free cash.
          if (s.k !== 'reserve')
            expect(BigInt(after.free) <= BigInt(before.free)).toBe(true);
        }
      }),
      { numRuns: 60, seed: 2303 },
    );
  });
});

// ------------------------------------------------------------- invoices
const issuer = privateKeyToAccount(keccak256(toHex('synq-x-fun:issuer')));
const payerWallet = privateKeyToAccount(
  keccak256(toHex('synq-x-fun:payer')),
).address;

function invoiceWorld(store: InvoiceStore = new MemoryInvoiceStore()) {
  let t = 1_800_000_000;
  const now = () => t++;
  const ledgerStore = new MemoryLedgerStore();
  const ledger = new Ledger(ledgerStore);
  const svc = new InvoiceService(store, ledger, now);
  let seq = 0;
  const issue = async (total: bigint) => {
    const d = draftInvoice({
      workspaceId: 'wsp_xfun',
      number: `INV-X${++seq}`,
      issuer: {
        principalId: 'prn_f',
        name: 'Studio',
        wallet: issuer.address,
        payoutAddress: issuer.address,
      },
      payer: { name: 'Acme', contact: null },
      asset: USDC,
      lineItems: [{ description: 'Work', quantity: 1, unitPrice: total }],
      dueDate: '2026-10-30',
      draftedBy: 'agent:invoice',
      now: now(),
    });
    await svc.create(d);
    return (
      await svc.issue(
        d.invoiceId,
        await issuer.signTypedData(issueTypedData(d)),
      )
    ).invoice;
  };
  return { svc, store, ledger, ledgerStore, issue, now };
}
const pay = (
  ref: Hex,
  amount: bigint,
  tx: string,
  logIndex = 3,
): MemoPayment => ({
  chainId: USDC.chainId,
  txHash: keccak256(toHex(`tx:${tx}`)),
  logIndex,
  paymentRef: ref,
  payer: payerWallet,
  recipient: issuer.address,
  amount,
});
const booked = async (ledger: Ledger, invoiceId: string, account: string) =>
  (await ledger.store.entries('wsp_xfun'))
    .flatMap((e) => e.postings)
    .filter((p) => p.account === account && p.documentRef === invoiceId)
    .reduce((n, p) => n + p.amount, 0n);

describe('X-FUN-04 partial payment applied to wrong invoice', () => {
  it('X-FUN-04 a partial payment settles only the invoice whose reference it carries, and one chain log can never settle a second invoice', async () => {
    const w = invoiceWorld();
    const a = await w.issue(300_000n);
    const b = await w.issue(300_000n); // same payer, payout and amount
    const p = pay(a.paymentRef!, 100_000n, 'partial');
    expect(await w.svc.settle(p)).toMatchObject({
      outcome: 'APPLIED',
      invoice: {
        invoiceId: a.invoiceId,
        status: 'PARTIALLY_PAID',
        paid: 100_000n,
      },
    });
    expect((await w.store.get(b.invoiceId))!.invoice).toMatchObject({
      status: 'ISSUED',
      paid: 0n,
    });
    // The same chain log re-presented with B's reference (a forged pairing).
    await expect(
      w.svc.settle({ ...p, paymentRef: b.paymentRef! }),
    ).rejects.toThrow(
      expect.objectContaining({ code: 'IDEMPOTENCY_CONFLICT' }),
    );
    expect((await w.store.get(b.invoiceId))!.invoice).toMatchObject({
      status: 'ISSUED',
      paid: 0n,
      payments: [],
    });
    expect(await booked(w.ledger, b.invoiceId, 'CASH_ARC_USDC')).toBe(0n);
    expect(await booked(w.ledger, a.invoiceId, 'CASH_ARC_USDC')).toBe(100_000n);
    // A payment to another recipient or chain is refused, not applied.
    await expect(
      w.svc.settle({ ...pay(b.paymentRef!, 1n, 'other'), recipient: relayer }),
    ).rejects.toThrow(InvoiceError);
    // An unknown reference settles nothing.
    expect(
      await w.svc.settle(pay(keccak256(toHex('nobody')), 5n, 'unknown')),
    ).toMatchObject({ outcome: 'UNMATCHED' });
  });

  it('X-FUN-04/X-FUN-05 property: any mix of partial, over-, duplicate and stray payments over three invoices conserves money per invoice', async () => {
    const payment = fc.record({
      target: fc.nat({ max: 3 }), // 3 = an unknown reference
      amount: fc.bigInt({ min: 1n, max: 250_000n }),
      dup: fc.boolean(),
    });
    await fc.assert(
      fc.asyncProperty(
        fc.array(payment, { maxLength: 14 }),
        fc.boolean(),
        async (payments, concurrent) => {
          const w = invoiceWorld();
          const totals = [300_000n, 120_000n, 1n];
          const invs: Awaited<ReturnType<typeof w.issue>>[] = [];
          for (const t of totals) invs.push(await w.issue(t));
          const deliveries: MemoPayment[] = [];
          payments.forEach((x, i) => {
            const ref =
              x.target < 3
                ? invs[x.target]!.paymentRef!
                : keccak256(toHex(`stray-${i}`));
            const p = pay(ref, x.amount, `p${i}`);
            deliveries.push(p);
            if (x.dup) deliveries.push({ ...p });
          });
          if (concurrent)
            await Promise.all(deliveries.map((p) => w.svc.settle(p)));
          else for (const p of deliveries) await w.svc.settle(p);
          // Every entry balances.
          for (const e of await w.ledgerStore.entries('wsp_xfun'))
            validateEntry(e);
          for (let k = 0; k < 3; k++) {
            const inv = invs[k]!;
            const paid = payments
              .filter((x) => x.target === k)
              .reduce((n, x) => n + x.amount, 0n);
            const doc = (await w.store.get(inv.invoiceId))!.invoice;
            expect(doc.paid).toBe(paid);
            const total = totals[k]!;
            const over = paid > total ? paid - total : 0n;
            expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(
              paid,
            );
            expect(
              await booked(w.ledger, inv.invoiceId, 'ACCOUNTS_RECEIVABLE'),
            ).toBe(total - (paid - over));
            // X-FUN-05: overpayment is a refund liability, never revenue.
            expect(
              await booked(w.ledger, inv.invoiceId, 'REFUND_LIABILITY'),
            ).toBe(-over);
            expect(await booked(w.ledger, inv.invoiceId, 'REVENUE')).toBe(
              -total,
            );
            expect(doc.status).toBe(
              paid === 0n
                ? 'ISSUED'
                : paid < total
                  ? 'PARTIALLY_PAID'
                  : paid === total
                    ? 'PAID'
                    : 'OVERPAID',
            );
          }
          // Stray payments credit no invoice.
          const strayCash = (await w.ledgerStore.entries('wsp_xfun'))
            .flatMap((e) => e.postings)
            .filter((p) => p.account === 'CASH_ARC_USDC')
            .reduce((n, p) => n + p.amount, 0n);
          expect(strayCash).toBe(
            payments
              .filter((x) => x.target < 3)
              .reduce((n, x) => n + x.amount, 0n),
          );
        },
      ),
      { numRuns: 60, seed: 2304 },
    );
  });
});

describe('X-FUN-05 overpayment treated as profit', () => {
  it('X-FUN-05 a 150 payment on a 100 invoice books 50 as a refund liability; the waterfall never distributes it', async () => {
    const w = invoiceWorld();
    const inv = await w.issue(usd('100'));
    const r = await w.svc.settle(pay(inv.paymentRef!, usd('150'), 'over'));
    expect(r).toMatchObject({
      outcome: 'APPLIED',
      invoice: { status: 'OVERPAID' },
    });
    expect(await booked(w.ledger, inv.invoiceId, 'REVENUE')).toBe(-usd('100'));
    expect(await booked(w.ledger, inv.invoiceId, 'REFUND_LIABILITY')).toBe(
      -usd('50'),
    );
    // The waterfall over the whole transfer, with the refund owed restricted,
    // refuses: the 50 is not free to allocate.
    const policy = policy1500();
    const base = {
      policy,
      policyHash: revenuePolicyHash(policy),
      asOf: ALLOC_T0,
      vendors: vendors(),
      payables: [devInvoice(usd('30'), 5)],
      payableHistory: [devInvoice(usd('30'), 5)],
      obligations: [],
      bills: bills1500(),
      receivables: receivables1500(),
    };
    expect(() =>
      computeWaterfall({
        ...base,
        receipt: receipt1500(usd('150')),
        position: position(usd('150'), { refundLiabilities: usd('50') }),
      }),
    ).toThrow(expect.objectContaining({ code: 'OVER_COMMITTED' }));
    // Planning only the receivable part conserves it exactly; the refund is untouched.
    const plan = computeWaterfall({
      ...base,
      receipt: receipt1500(usd('100')),
      position: position(usd('150'), { refundLiabilities: usd('50') }),
    });
    expect(plan.legs.reduce((a, l) => a + l.amount, 0n)).toBe(usd('100'));
    expect(plan.position.refundLiabilities).toBe(usd('50'));
    expect(AllocationError).toBeDefined();
  });
});

describe('X-FUN-06 reserve floor violated after concurrent approvals', () => {
  it('X-FUN-06 300 concurrent reservations never dip into the mandatory reserve', async () => {
    const s = new MemoryReservationStore();
    await s.setConfirmedBalance({
      groupId: 'group-1',
      assetId: AUSD,
      confirmed: 50_000n,
      mandatoryReserve: 12_345n,
      asOf: T0,
    });
    const amounts = Array.from(
      { length: 300 },
      (_, i) => ((i * 7_919) % 900) + 50,
    );
    const results = await Promise.allSettled(
      amounts.map((a) => s.reserve(req({ amount: String(a) }), T0)),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const reserved = ok.reduce(
      (n, r) =>
        n +
        BigInt((r as PromiseFulfilledResult<{ amount: string }>).value.amount),
      0n,
    );
    const free = await s.free('group-1', AUSD);
    expect(reserved).toBeLessThanOrEqual(50_000n - 12_345n);
    expect(BigInt(free.held)).toBe(reserved);
    expect(results.some((r) => r.status === 'rejected')).toBe(true);
    for (const r of results)
      if (r.status === 'rejected')
        expect((r.reason as ReservationError).code).toBe(
          'INSUFFICIENT_FREE_BALANCE',
        );
  });

  it('X-FUN-06 five revenue splits on one treasury run concurrently: floor held once, holds never spent (memory store)', async () => {
    const r = await concurrentFloorScenario(async () => new MemorySplitStore());
    expect(
      r.results
        .map((x) => x.state)
        .every((s) => s === 'COMPLETED' || s === 'NEEDS_REVIEW'),
    ).toBe(true);
  });
});

describe('X-FUN-07 Circle fee changes after payer signed max amount', () => {
  const fixture = JSON.parse(
    readFileSync(
      new URL('../arc/fixtures/cctp-sepolia-arc-message.json', import.meta.url),
      'utf8',
    ),
  ) as { message: Hex };
  const m = decodeMessage(fixture.message);
  const planned = planTransfer({
    transferId: 'cctp_fee',
    source: 'eth-sepolia',
    destination: 'arc-testnet',
    payer: m.burn.messageSender,
    payerKind: 'EOA',
    recipient: m.burn.mintRecipient,
    amount: m.burn.amount,
    maxFee: m.burn.maxFee,
    fast: true,
    reference: m.burn.hookData,
    at: 1,
  });
  /** Overwrites one 32-byte word of the burn body (offset in body bytes). */
  const withWord = (msg: Hex, bodyOffset: number, value: bigint): Hex => {
    const at = 2 + (148 + bodyOffset) * 2;
    return `${msg.slice(0, at)}${value.toString(16).padStart(64, '0')}${msg.slice(at + 64)}` as Hex;
  };

  it('X-FUN-07 an attested message whose fee exceeds the max fee the payer signed, or names another cap, is refused before any mint or credit', () => {
    expect(() => checkMessage(planned, m)).not.toThrow();
    const overFee = decodeMessage(
      withWord(fixture.message, 164, m.burn.maxFee + 1n),
    );
    expect(() => checkMessage(planned, overFee)).toThrow(CctpError);
    expect(() => checkMessage(planned, overFee)).toThrow(
      /FEE_TOO_HIGH|fee executed/,
    );
    const otherCap = decodeMessage(
      withWord(fixture.message, 132, m.burn.maxFee + 10n),
    );
    expect(() => checkMessage(planned, otherCap)).toThrow(/max fee/);
    // The payee is credited what was minted: the burn less the fee executed.
    expect(netMinted(m)).toBe(m.burn.amount - m.burn.feeExecuted);
    expect(m.burn.feeExecuted <= planned.maxFee).toBe(true);
  });

  it('X-FUN-07 property: the quoted max fee always covers the published minimum (rounded up), and a fee at or above the amount is refused', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 13n }),
        fc.integer({ min: 0, max: 1_000 }),
        (amount, tenthBps) => {
          const bps = tenthBps / 10;
          const fee = maxFeeFor(amount, bps);
          // ceil(amount * bps / 10_000) computed independently in rationals.
          const num = amount * BigInt(Math.round(bps * 100));
          const exact = num / 1_000_000n + (num % 1_000_000n ? 1n : 0n);
          expect(fee).toBe(exact);
        },
      ),
      { numRuns: 300, seed: 2307 },
    );
    expect(() =>
      planTransfer({
        ...planned,
        maxFee: planned.amount,
        payerKind: 'EOA',
        fast: true,
        at: 1,
        transferId: 'x',
      } as never),
    ).toThrow(expect.objectContaining({ code: 'FEE_TOO_HIGH' }));
  });

  it('X-FUN-07 Gateway: a settlement above the value plus the signed max fee is refused by the reservation', () => {
    const a = new GatewayAccount(10_000n);
    a.deposit(5_000n);
    a.observeAvailable(5_000n);
    const value = 1_000n;
    const maxFee = 30n;
    a.reserve(keccak256(toHex('gw-fee')), value + maxFee);
    expect(() => a.settle(value + maxFee + 1n)).toThrow(GatewayError);
    a.settle(value + 25n); // the fee actually charged, within the cap
    expect(a.reserved).toBe(5n);
  });
});

describe('X-LOA-07 concurrent invoice revision and payer checkout race', () => {
  it('X-LOA-07 two payers checking out at once on one invoice are both applied; the overpayment is a refund liability (regression: second payment stuck and misbooked)', async () => {
    const w = invoiceWorld();
    const inv = await w.issue(300_000n);
    const [r1, r2] = await Promise.all([
      w.svc.settle(pay(inv.paymentRef!, 200_000n, 'payer-1')),
      w.svc.settle(pay(inv.paymentRef!, 200_000n, 'payer-2')),
    ]);
    expect([r1.outcome, r2.outcome]).toEqual(['APPLIED', 'APPLIED']);
    const doc = (await w.store.get(inv.invoiceId))!.invoice;
    expect(doc).toMatchObject({ status: 'OVERPAID', paid: 400_000n });
    expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(
      400_000n,
    );
    expect(await booked(w.ledger, inv.invoiceId, 'ACCOUNTS_RECEIVABLE')).toBe(
      0n,
    );
    expect(await booked(w.ledger, inv.invoiceId, 'REFUND_LIABILITY')).toBe(
      -100_000n,
    );
    // Redelivery of either payment is a no-op.
    expect(
      await w.svc.settle(pay(inv.paymentRef!, 200_000n, 'payer-2')),
    ).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(
      400_000n,
    );
  });

  it('X-LOA-07 a revision that lands while a checkout is settling: the payment is never booked against terms it did not pay (regression: entry posted, document not updated)', async () => {
    const store = new MemoryInvoiceStore();
    const w = invoiceWorld(store);
    const inv = await w.issue(300_000n);
    // The payer's settle reads the issued v1, then the issuer's revision saves first.
    const realRead = store.byPaymentRef.bind(store);
    let raced = false;
    store.byPaymentRef = async (ref) => {
      const cur = await realRead(ref);
      if (cur && !raced) {
        raced = true;
        const fresh = (await store.get(inv.invoiceId))!;
        await store.save(
          reviseInvoice(
            fresh.invoice,
            { dueDate: '2026-11-30' },
            w.now(),
            'new terms',
          ),
          fresh.rev,
        );
      }
      return cur;
    };
    const r = await w.svc.settle(pay(inv.paymentRef!, 300_000n, 'checkout'));
    expect(r).toMatchObject({ outcome: 'UNMATCHED' });
    const doc = (await store.get(inv.invoiceId))!.invoice;
    expect(doc).toMatchObject({ status: 'DRAFT', version: 2, paid: 0n });
    // Nothing was booked for a payment the document does not hold.
    expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(0n);
    expect(await booked(w.ledger, inv.invoiceId, 'ACCOUNTS_RECEIVABLE')).toBe(
      300_000n,
    );
  });

  it('X-LOA-07 a stale revision after a checkout settled is refused; a crash between save and post is repaired by redelivery', async () => {
    const w = invoiceWorld();
    const inv = await w.issue(300_000n);
    const stale = (await w.store.get(inv.invoiceId))!;
    // Crash after the document save, before the ledger post.
    const realPost = w.ledger.post.bind(w.ledger);
    let crash = true;
    w.ledger.post = async (e: JournalEntry, ev) => {
      if (crash && e.source.kind === 'CHAIN_TX') {
        crash = false;
        throw new Error('process killed before the ledger post');
      }
      return realPost(e, ev);
    };
    const p = pay(inv.paymentRef!, 120_000n, 'crashy');
    await expect(w.svc.settle(p)).rejects.toThrow(/killed/);
    expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(0n);
    // Redelivery repairs the entry from the recorded payment, exactly once.
    expect(await w.svc.settle(p)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await w.svc.settle(p)).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await booked(w.ledger, inv.invoiceId, 'CASH_ARC_USDC')).toBe(
      120_000n,
    );
    const doc = (await w.store.get(inv.invoiceId))!.invoice;
    expect(paymentEntry(doc, doc.payments[0]!)!.postings).toHaveLength(2);
    // The issuer's revision built on the pre-payment read is refused.
    await expect(
      w.store.save(
        reviseInvoice(
          stale.invoice,
          { dueDate: '2026-12-01' },
          w.now(),
          'stale',
        ),
        stale.rev,
      ),
    ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    expect(LedgerError).toBeDefined();
  });
});
