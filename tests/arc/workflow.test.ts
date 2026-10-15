import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { money } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import {
  FileOutboxStore,
  MemoryOutboxStore,
  payOnce,
} from '@synq/execution-worker/arc-outbox';
import {
  ArcCashIndexer,
  CashReservations,
  Ledger,
  LedgerError,
  MemoryConsumerInbox,
  MemoryLedgerStore,
  availableToSpend,
  consumeOnce,
  relayOutbox,
  type IndexedTransferLog,
  type JournalEntry,
  type OutboxEvent,
} from '@synq/ledger';

const USDC = token('arc-testnet', 'USDC');
const USDC_CODE = readFileSync(
  new URL('./fixtures/arc-testnet-usdc.code', import.meta.url),
  'utf8',
).trim() as Hex;
const payer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const payee = '0x00000000000000000000000000000000000beef1' as const;
const WS = 'wsp_p08';

/** A tiny chain: a mempool that mines what it receives, with a nonce per sender. */
function fakeArc(opts: { failReceiptWaits?: number } = {}) {
  const sent: Hex[] = [];
  const mined = new Map<Hex, { blockNumber: bigint }>();
  let nonce = 7;
  let failWaits = opts.failReceiptWaits ?? 0;
  const receiptOf = (hash: Hex) => {
    if (!mined.has(hash)) throw new Error('receipt not found');
    return {
      status: 'success',
      blockNumber: mined.get(hash)!.blockNumber,
      blockHash: `0x${'bb'.repeat(32)}`,
      gasUsed: 50_000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [
        {
          address: USDC.address,
          topics: encodeEventTopics({
            abi: erc20Abi,
            eventName: 'Transfer',
            args: { from: payer.address, to: payee },
          }),
          data: encodeAbiParameters([{ type: 'uint256' }], [250_000n]),
          blockNumber: mined.get(hash)!.blockNumber,
          transactionHash: hash,
          logIndex: 0,
          blockHash: `0x${'bb'.repeat(32)}`,
          transactionIndex: 0,
          removed: false,
        },
      ],
    };
  };
  const client = {
    getChainId: async () => 5042002,
    getCode: async () => USDC_CODE,
    readContract: async () => 50_000_000n,
    getBalance: async () => 50n * 10n ** 18n,
    getTransactionCount: async () => nonce,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    call: async () => ({
      data: encodeAbiParameters([{ type: 'bool' }], [true]),
    }),
    estimateGas: async () => 60_000n,
    sendRawTransaction: async ({
      serializedTransaction,
    }: {
      serializedTransaction: Hex;
    }) => {
      const hash = keccak256(serializedTransaction);
      sent.push(serializedTransaction);
      if (mined.has(hash)) throw new Error('already known');
      mined.set(hash, { blockNumber: BigInt(100 + mined.size) });
      nonce++;
      return hash;
    },
    getTransactionReceipt: async ({ hash }: { hash: Hex }) => receiptOf(hash),
    waitForTransactionReceipt: async ({ hash }: { hash: Hex }) => {
      if (failWaits-- > 0) throw new Error('worker crashed while waiting');
      return receiptOf(hash);
    },
  } as unknown as PublicClient;
  return { client, sent, mined, bumpNonce: () => nonce++ };
}

const signer = () => {
  let signatures = 0;
  return {
    address: payer.address,
    signTransaction: async (
      tx: Parameters<typeof payer.signTransaction>[0],
    ) => {
      signatures++;
      return payer.signTransaction(tx);
    },
    get count() {
      return signatures;
    },
  };
};
const transfer = {
  from: payer.address,
  to: payee,
  amount: money(USDC, 250_000n),
};
let t = 1_800_000_000;
const now = () => t++;

describe('Workflow runtime and ledger (P08)', () => {
  it('P08-01 crash after broadcast reconciles from the record and never signs or pays twice', async () => {
    const arc = fakeArc({ failReceiptWaits: 1 });
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const store = new FileOutboxStore(
      mkdtempSync(join(tmpdir(), 'synq-outbox-')),
    );
    const s = signer();
    await expect(
      payOnce({ store, key: 'payout:inv-7', chain, signer: s, transfer, now }),
    ).rejects.toThrow(/crashed/);
    // "Restart": a new store instance over the same durable directory.
    const restarted = new FileOutboxStore(store.dir);
    const r = await payOnce({
      store: restarted,
      key: 'payout:inv-7',
      chain,
      signer: s,
      transfer,
      now,
    });
    expect([r.record.state, r.signedNow, s.count, arc.mined.size]).toEqual([
      'CONFIRMED',
      false,
      1,
      1,
    ]);
    expect(r.record.evidence!.amount.baseUnits).toBe(250_000n);
    // A third delivery of the same request is a pure read.
    const again = await payOnce({
      store: restarted,
      key: 'payout:inv-7',
      chain,
      signer: s,
      transfer,
      now,
    });
    expect([again.record.hash, s.count, arc.sent.length]).toEqual([
      r.record.hash,
      1,
      1,
    ]);
    // The same key cannot be reused for a different payment.
    await expect(
      payOnce({
        store: restarted,
        key: 'payout:inv-7',
        chain,
        signer: s,
        transfer: { ...transfer, amount: money(USDC, 1n) },
        now,
      }),
    ).rejects.toThrow(/different payment/);
  });

  it('P08-01 crash after recording but before broadcast resends the same signed bytes; a consumed nonce stops for review', async () => {
    const arc = fakeArc();
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const store = new MemoryOutboxStore();
    const s = signer();
    await expect(
      payOnce({
        store,
        key: 'k1',
        chain,
        signer: s,
        transfer,
        now,
        afterRecord: () => {
          throw new Error('crash before send');
        },
      }),
    ).rejects.toThrow(/crash before send/);
    expect(arc.sent.length).toBe(0);
    const r = await payOnce({
      store,
      key: 'k1',
      chain,
      signer: s,
      transfer,
      now,
    });
    expect([r.record.state, s.count, arc.mined.size]).toEqual([
      'CONFIRMED',
      1,
      1,
    ]);
    expect(keccak256(arc.sent[0]!)).toBe(r.record.hash);

    const arc2 = fakeArc();
    const chain2 = await connectChain('arc-testnet', undefined, arc2.client);
    const store2 = new MemoryOutboxStore();
    await expect(
      payOnce({
        store: store2,
        key: 'k2',
        chain: chain2,
        signer: s,
        transfer,
        now,
        afterRecord: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow();
    arc2.bumpNonce(); // something else used nonce 7 meanwhile
    const review = await payOnce({
      store: store2,
      key: 'k2',
      chain: chain2,
      signer: s,
      transfer,
      now,
    });
    expect(review.record.state).toBe('NEEDS_REVIEW');
    expect(arc2.sent.length).toBe(0);
  });

  const log = (
    o: Partial<IndexedTransferLog> & { tx: string; block: string },
  ): IndexedTransferLog => ({
    chainId: USDC.chainId,
    blockNumber: 10n,
    blockHash: `0x${o.block.repeat(32)}` as Hex,
    txHash: `0x${o.tx.repeat(32)}` as Hex,
    logIndex: 0,
    removed: false,
    token: USDC.address,
    from: payee,
    to: payer.address,
    value: 1_000_000n,
    ...o,
  });
  const indexer = (ledger: Ledger) =>
    new ArcCashIndexer(ledger, {
      workspaceId: WS,
      wallet: payer.address,
      assetId: USDC.assetId,
      token: USDC.address,
      chainId: USDC.chainId,
      classify: (_l, d) => ({
        counterAccount:
          d === 'IN' ? 'UNAPPLIED_RECEIPTS' : 'CONTRACTOR_EXPENSE',
        memo: d,
      }),
    });

  it('P08-02 reorged and duplicated logs rebuild to identical balances; native mirror logs never count', async () => {
    const A1 = log({ tx: 'a1', block: 'b1' });
    const A2 = log({ tx: 'a1', block: 'c2', blockNumber: 11n }); // same tx re-included after reorg
    const B = log({
      tx: 'b2',
      block: 'c2',
      blockNumber: 11n,
      from: payer.address,
      to: payee,
      value: 300_000n,
      logIndex: 1,
    });
    const mirror = log({
      tx: 'a1',
      block: 'c2',
      token: `0x${'ff'.repeat(19)}fe` as Hex,
      value: 10n ** 18n,
    });
    const messy = new Ledger(new MemoryLedgerStore());
    const ix = indexer(messy);
    const outcomes = [];
    for (const l of [
      A1,
      A1,
      B,
      { ...A1, removed: true },
      { ...A1, removed: true },
      mirror,
      A2,
      B,
      A1,
    ])
      outcomes.push(await ix.ingest(l));
    expect(outcomes).toEqual([
      'POSTED',
      'DUPLICATE',
      'POSTED',
      'REVERSED',
      'IGNORED',
      'IGNORED',
      'POSTED',
      'DUPLICATE',
      'IGNORED',
    ]);
    const clean = new Ledger(new MemoryLedgerStore());
    for (const l of [A2, B]) await indexer(clean).ingest(l);
    expect(await messy.balances(WS, USDC.assetId)).toEqual(
      await clean.balances(WS, USDC.assetId),
    );
    expect(await clean.balance(WS, 'CASH_ARC_USDC', USDC.assetId)).toBe(
      700_000n,
    );
  });

  it('P08-03 every posting is balanced and chain cash carries receipt evidence', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    await indexer(ledger).ingest(log({ tx: 'd4', block: 'e5' }));
    const entries = await ledger.store.entries(WS);
    for (const e of entries) {
      expect(e.postings.reduce((s, p) => s + p.amount, 0n)).toBe(0n);
      expect(e.evidence).toMatchObject({ chainId: USDC.chainId, logIndex: 0 });
    }
    const base: JournalEntry = {
      ...entries[0]!,
      entryId: 'x',
      idempotencyKey: 'x',
    };
    await expect(ledger.post({ ...base, evidence: null })).rejects.toThrow(
      expect.objectContaining({ code: 'MISSING_EVIDENCE' }),
    );
    await expect(
      ledger.post({
        ...base,
        postings: [base.postings[0]!, { ...base.postings[1]!, amount: -1n }],
      }),
    ).rejects.toThrow(expect.objectContaining({ code: 'UNBALANCED' }));
  });

  it('P08-04 a balanced journal paying the wrong vendor is flagged', async () => {
    const ledger = new Ledger(new MemoryLedgerStore(), {
      verifiedPayout: () => payee,
    });
    const entry = (recipient: Hex): JournalEntry => ({
      entryId: `ap-${recipient}`,
      workspaceId: WS,
      occurredAt: 1,
      memo: 'pay Sarah',
      source: { kind: 'CHAIN_TX', ref: 'bill-1' },
      evidence: {
        chainId: USDC.chainId,
        txHash: `0x${'ab'.repeat(32)}`,
        logIndex: 0,
        recipient,
      },
      idempotencyKey: `ap-${recipient}`,
      postings: [
        {
          account: 'ACCOUNTS_PAYABLE',
          assetId: USDC.assetId,
          amount: 40_000n,
          counterpartyId: 'vendor:sarah',
        },
        { account: 'CASH_ARC_USDC', assetId: USDC.assetId, amount: -40_000n },
      ],
      reversalOf: null,
    });
    await expect(ledger.post(entry(payer.address))).rejects.toThrow(
      expect.objectContaining({ code: 'WRONG_VENDOR' }),
    );
    await expect(ledger.post(entry(payee))).resolves.toMatchObject({
      created: true,
    });
  });

  it('P08-05 in-flight CCTP value is not spendable Arc cash until the mint lands', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    const ev = (tx: string) => ({
      chainId: USDC.chainId,
      txHash: `0x${tx.repeat(32)}` as Hex,
      logIndex: 0,
    });
    const post = (
      id: string,
      tx: string,
      lines: [JournalEntry['postings'][number]['account'], bigint][],
    ) =>
      ledger.post({
        entryId: id,
        workspaceId: WS,
        occurredAt: 1,
        memo: id,
        source: { kind: 'CHAIN_TX', ref: id },
        evidence: ev(tx),
        idempotencyKey: id,
        reversalOf: null,
        postings: lines.map(([account, amount]) => ({
          account,
          assetId: USDC.assetId,
          amount,
        })),
      });
    await post('opening', '01', [
      ['CASH_ARC_USDC', 2_000_000n],
      ['OWNER_EQUITY', -2_000_000n],
    ]);
    await post('burn', '02', [
      ['CCTP_IN_FLIGHT', 1_000_000n],
      ['ACCOUNTS_RECEIVABLE', -1_000_000n],
    ]);
    const spendable = async () =>
      availableToSpend({
        confirmedCash: await ledger.balance(WS, 'CASH_ARC_USDC', USDC.assetId),
        reservations: 0n,
        escrow: 0n,
        minimumReserve: 0n,
      });
    expect(await spendable()).toBe(2_000_000n);
    await post('mint', '03', [
      ['CASH_ARC_USDC', 999_900n],
      ['NETWORK_FEES', 100n],
      ['CCTP_IN_FLIGHT', -1_000_000n],
    ]);
    expect(await spendable()).toBe(2_999_900n);
    expect(await ledger.balance(WS, 'CCTP_IN_FLIGHT', USDC.assetId)).toBe(0n);
  });

  it('P08-06 events commit with their entry once, and a duplicate consumer delivery is handled once', async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger(store);
    const e: JournalEntry = {
      entryId: 'inv-paid',
      workspaceId: WS,
      occurredAt: 1,
      memo: 'paid',
      source: { kind: 'INVOICE', ref: 'inv-1' },
      evidence: null,
      idempotencyKey: 'inv-paid',
      reversalOf: null,
      postings: [
        { account: 'UNAPPLIED_RECEIPTS', assetId: USDC.assetId, amount: 5n },
        { account: 'ACCOUNTS_RECEIVABLE', assetId: USDC.assetId, amount: -5n },
      ],
    };
    const event: OutboxEvent = {
      eventId: 'evt-inv-1-paid',
      topic: 'invoice.paid',
      payload: { invoice: 'inv-1' },
    };
    await ledger.post(e, [event]);
    await ledger.post(e, [event]); // duplicate request: no second event
    expect(await store.pendingEvents(10)).toEqual([event]);
    const inbox = new MemoryConsumerInbox();
    const handled: string[] = [];
    const deliver = (x: OutboxEvent) =>
      consumeOnce(
        inbox,
        'audit-agent',
        x,
        async (y) => void handled.push(y.eventId),
      );
    // A relay that crashes before marking published re-publishes the batch.
    await expect(
      relayOutbox(store, async (x) => {
        await deliver(x);
        throw new Error('relay crash');
      }),
    ).rejects.toThrow();
    expect(await relayOutbox(store, async (x) => void (await deliver(x)))).toBe(
      1,
    );
    expect(await relayOutbox(store, async (x) => void (await deliver(x)))).toBe(
      0,
    );
    expect(handled).toEqual(['evt-inv-1-paid']);
    // A failed handler releases its claim so redelivery can finish the work.
    const flaky = { eventId: 'evt-2', topic: 't', payload: null };
    await expect(
      consumeOnce(inbox, 'c', flaky, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow();
    expect(
      (await consumeOnce(inbox, 'c', flaky, async () => 'ok')).handled,
    ).toBe(true);
    expect(
      (await consumeOnce(inbox, 'c', flaky, async () => 'ok')).handled,
    ).toBe(false);
  });

  it('P08-07 total reserved never exceeds confirmed available cash (property)', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000n }),
        fc.array(
          fc.tuple(
            fc.boolean(),
            fc.integer({ min: 0, max: 5 }),
            fc.bigInt({ min: 1n, max: 4_000_000n }),
          ),
          { maxLength: 40 },
        ),
        (cash, ops) => {
          const book = new CashReservations();
          const view = {
            confirmedCash: cash,
            escrow: 0n,
            minimumReserve: 100_000n,
          };
          for (const [isReserve, id, amount] of ops) {
            if (isReserve) {
              try {
                book.reserve(`r${id}`, amount, view);
              } catch (e) {
                expect(e).toBeInstanceOf(LedgerError);
              }
            } else book.release(`r${id}`);
            expect(book.total() <= cash).toBe(true);
            expect(
              book.total() + view.minimumReserve <= cash || book.total() === 0n,
            ).toBe(true);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
