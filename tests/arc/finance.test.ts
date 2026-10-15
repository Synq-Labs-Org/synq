import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contract, token } from '@synq/chain-registry/arc';
import {
  Ledger,
  LedgerError,
  MemoryLedgerStore,
  availableToSpend,
  type JournalEntry,
} from '@synq/ledger';
import {
  MEMO_ABI,
  amountDue,
  applyPayment,
  creditInvoice,
  draftInvoice,
  extractMemoPayments,
  issueInvoice,
  issueTypedData,
  overpaidBy,
  payLinkToken,
  reviseInvoice,
  verifyPayLink,
  type Invoice,
  type MemoPayment,
} from '@synq/invoices';

const USDC = token('arc-testnet', 'USDC');
const MEMO = contract('arc-testnet', 'MEMO').address;
const issuerWallet = privateKeyToAccount(`0x${'31'.repeat(32)}`);
const llm = privateKeyToAccount(`0x${'32'.repeat(32)}`);
const payout = issuerWallet.address;
const client = `0x${'c1'.repeat(20)}` as Address;
const NOW = 1_790_000_000;
const usdc = (d: string) => BigInt(Math.round(Number(d) * 1e6));

function draft(): Invoice {
  return draftInvoice({
    workspaceId: 'wsp_1',
    number: 'INV-0001',
    issuer: {
      principalId: 'prn_freelancer',
      name: 'Kaushikh Studio',
      wallet: issuerWallet.address,
      payoutAddress: payout,
    },
    payer: { name: 'Acme', contact: null },
    asset: USDC,
    lineItems: [
      {
        description: 'Website development',
        quantity: 1,
        unitPrice: 1_500_000_000n,
      },
    ],
    dueDate: '2026-10-23',
    draftedBy: 'agent:invoice',
    now: NOW,
  });
}
async function issued(): Promise<Invoice> {
  const d = draft();
  return (
    await issueInvoice(
      d,
      await issuerWallet.signTypedData(issueTypedData(d)),
      NOW,
    )
  ).invoice;
}
const pay = (
  i: Invoice,
  amount: bigint,
  tx = '01',
  logIndex = 3,
): MemoPayment => ({
  chainId: USDC.chainId,
  txHash: `0x${tx.repeat(32)}` as Hex,
  logIndex,
  paymentRef: i.paymentRef!,
  payer: client,
  recipient: payout,
  amount,
});

describe('invoices (P11)', () => {
  it('P11-01 a drafted invoice cannot be issued without the issuer wallet signature', async () => {
    const d = draft();
    expect(d.total).toBe(1_500_000_000n);
    await expect(
      issueInvoice(d, await llm.signTypedData(issueTypedData(d)), NOW),
    ).rejects.toMatchObject({ code: 'NOT_ISSUER' });
    await expect(issueInvoice(d, '0x1234', NOW)).rejects.toMatchObject({
      code: 'NOT_ISSUER',
    });
    const { invoice, entry } = await issueInvoice(
      d,
      await issuerWallet.signTypedData(issueTypedData(d)),
      NOW,
    );
    expect(invoice.status).toBe('ISSUED');
    expect(invoice.paymentRef).toMatch(/^0x[0-9a-f]{64}$/);
    expect(entry.postings.map((p) => [p.account, p.amount])).toEqual([
      ['ACCOUNTS_RECEIVABLE', 1_500_000_000n],
      ['REVENUE', -1_500_000_000n],
    ]);
  });

  it('P11-02 changing the amount invalidates the old pay link and its reference', async () => {
    const key = new Uint8Array(32).fill(1);
    const v1 = await issued();
    const link = payLinkToken(key, v1, NOW + 3600);
    verifyPayLink(key, link, v1, NOW);
    const draftV2 = reviseInvoice(
      v1,
      {
        lineItems: [
          {
            description: 'Website development',
            quantity: 1,
            unitPrice: 1_800_000_000n,
          },
        ],
      },
      NOW,
      'scope change',
    );
    const v2 = (
      await issueInvoice(
        draftV2,
        await issuerWallet.signTypedData(issueTypedData(draftV2)),
        NOW,
      )
    ).invoice;
    expect(v2.paymentRef).not.toBe(v1.paymentRef);
    expect(() => verifyPayLink(key, link, v2, NOW)).toThrow(/another version/);
    expect(() => verifyPayLink(key, link, v1, NOW + 3601)).toThrow(/expired/);
    expect(() =>
      verifyPayLink(new Uint8Array(32).fill(2), link, v1, NOW),
    ).toThrow(/signature/);
    // A payment carrying the v1 reference cannot settle v2.
    expect(() => applyPayment(v2, pay(v1, 1n), NOW)).toThrow(
      /another reference/,
    );
  });

  it('P11-04 / P11-05 / P11-06 partial, exact and overpayment with idempotent events', async () => {
    const ledger = new Ledger(new MemoryLedgerStore());
    let inv = await issued();
    const post = async (e: JournalEntry | null) => e && ledger.post(e);
    let r = applyPayment(inv, pay(inv, usdc('500')), NOW);
    inv = r.invoice;
    await post(r.entry);
    expect([inv.status, amountDue(inv)]).toEqual([
      'PARTIALLY_PAID',
      1_000_000_000n,
    ]);
    // Same chain event again: no change, no second credit.
    const again = applyPayment(inv, pay(inv, usdc('500')), NOW);
    expect(again).toMatchObject({ applied: false, entry: null });
    r = applyPayment(inv, pay(inv, usdc('1100'), '02'), NOW);
    inv = r.invoice;
    await post(r.entry);
    expect([inv.status, amountDue(inv), overpaidBy(inv)]).toEqual([
      'OVERPAID',
      0n,
      100_000_000n,
    ]);
    const b = await ledger.balances('wsp_1', USDC.assetId);
    expect(b.CASH_ARC_USDC).toBe(usdc('1600'));
    expect(b.ACCOUNTS_RECEIVABLE).toBe(-1_500_000_000n); // only the receipts posted here (issue entry not posted)
    expect(b.REFUND_LIABILITY).toBe(-100_000_000n); // owed back, not revenue
    // Posting the same receipt entry again is a no-op at the ledger too.
    expect((await ledger.post(r.entry!)).created).toBe(false);
  });

  it('P11-03 only a memo-bound transfer to the payout address settles; plain transfers stay unapplied', async () => {
    const inv = await issued();
    const transferLog = (
      from: Address,
      to: Address,
      value: bigint,
      logIndex: number,
      address: Address = USDC.address,
    ) =>
      ({
        address,
        topics: encodeEventTopics({
          abi: erc20Abi,
          eventName: 'Transfer',
          args: { from, to },
        }),
        data: encodeAbiParameters([{ type: 'uint256' }], [value]),
        logIndex,
        blockNumber: 1n,
        blockHash: `0x${'bb'.repeat(32)}`,
        transactionHash: `0x${'aa'.repeat(32)}`,
        transactionIndex: 0,
        removed: false,
      }) as unknown as Log;
    const memoLog = (
      sender: Address,
      to: Address,
      value: bigint,
      ref: Hex,
      logIndex: number,
    ) =>
      ({
        address: MEMO,
        topics: encodeEventTopics({
          abi: MEMO_ABI,
          eventName: 'Memo',
          args: { sender, target: USDC.address, memoId: ref },
        }),
        data: encodeAbiParameters(
          [{ type: 'bytes32' }, { type: 'bytes' }, { type: 'uint256' }],
          [
            keccak256(
              encodeFunctionData({
                abi: erc20Abi,
                functionName: 'transfer',
                args: [to, value],
              }),
            ),
            '0x',
            1n,
          ],
        ),
        logIndex,
        blockNumber: 1n,
        blockHash: `0x${'bb'.repeat(32)}`,
        transactionHash: `0x${'aa'.repeat(32)}`,
        transactionIndex: 0,
        removed: false,
      }) as unknown as Log;
    const native = `0x${'ff'.repeat(19)}fe` as Address;
    const { payments, unreferenced } = extractMemoPayments({
      chainId: USDC.chainId,
      txHash: `0x${'aa'.repeat(32)}`,
      token: USDC.address,
      memoContract: MEMO,
      logs: [
        transferLog(client, payout, 10n ** 15n * 500n, 0, native), // native 18-dp mirror: ignored
        transferLog(client, payout, 500_000_000n, 1),
        memoLog(client, payout, 500_000_000n, inv.paymentRef!, 2),
        transferLog(client, payout, 7_000_000n, 3), // same amount-ish payment with no memo
      ],
    });
    expect(payments).toEqual([
      expect.objectContaining({
        logIndex: 1,
        amount: 500_000_000n,
        paymentRef: inv.paymentRef,
      }),
    ]);
    expect(payments[0]!.payer.toLowerCase()).toBe(client.toLowerCase());
    expect(unreferenced).toEqual([
      expect.objectContaining({ logIndex: 3, amount: 7_000_000n }),
    ]);
    // A memo claiming the invoice but paying someone else does not settle it.
    expect(() =>
      applyPayment(inv, { ...pay(inv, 1n), recipient: client }, NOW),
    ).toThrow(/paid/);
    // A forged memo whose callDataHash does not match the transfer is not paired.
    const forged = extractMemoPayments({
      chainId: USDC.chainId,
      txHash: `0x${'aa'.repeat(32)}`,
      token: USDC.address,
      memoContract: MEMO,
      logs: [
        transferLog(client, payout, 1n, 1),
        memoLog(client, payout, 999n, inv.paymentRef!, 2),
      ],
    });
    expect(forged.payments).toEqual([]);
  });

  it('P11-07 a credit note leaves the original invoice terms immutable', async () => {
    const inv = await issued();
    const { invoice, note, entry } = creditInvoice(
      inv,
      200_000_000n,
      'Discount agreed in chat',
      NOW,
    );
    expect(invoice.lineItems).toEqual(inv.lineItems);
    expect(invoice.total).toBe(inv.total);
    expect(invoice.termsHash).toBe(inv.termsHash);
    expect(amountDue(invoice)).toBe(1_300_000_000n);
    expect(note.invoiceVersion).toBe(1);
    expect(entry.postings.every((p) => p.amount !== 0n)).toBe(true);
    expect(() =>
      creditInvoice(invoice, 2_000_000_000n, 'too much', NOW),
    ).toThrow(expect.objectContaining({ code: 'CREDIT_TOO_LARGE' }));
  });
});

describe('ledger (P08)', () => {
  const base = (over: Partial<JournalEntry> = {}): JournalEntry => ({
    entryId: 'je_1',
    workspaceId: 'wsp_1',
    occurredAt: NOW,
    memo: 'payout',
    source: { kind: 'CHAIN_TX', ref: 'pay_1' },
    evidence: {
      chainId: USDC.chainId,
      txHash: `0x${'aa'.repeat(32)}`,
      logIndex: 1,
      recipient: `0x${'5a'.repeat(20)}`,
    },
    idempotencyKey: `chain:${USDC.chainId}:0x${'aa'.repeat(32)}:1`,
    postings: [
      {
        account: 'ACCOUNTS_PAYABLE',
        assetId: USDC.assetId,
        amount: 50_000n,
        counterpartyId: 'vendor:sarah',
      },
      { account: 'CASH_ARC_USDC', assetId: USDC.assetId, amount: -50_000n },
    ],
    reversalOf: null,
    ...over,
  });
  const vendors = {
    verifiedPayout: (id: string) =>
      id === 'vendor:sarah' ? (`0x${'5a'.repeat(20)}` as Address) : null,
  };

  it('P08-03 every entry balances and chain cash moves need evidence', async () => {
    const ledger = new Ledger(new MemoryLedgerStore(), vendors);
    await expect(
      ledger.post(
        base({
          postings: [
            { account: 'CASH_ARC_USDC', assetId: USDC.assetId, amount: -1n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'UNBALANCED' });
    // Cash moved on chain with no evidence is refused before anything else.
    await expect(ledger.post(base({ evidence: null }))).rejects.toMatchObject({
      code: 'MISSING_EVIDENCE',
    });
    await expect(
      ledger.post(
        base({
          evidence: null,
          postings: [
            { account: 'CASH_ARC_USDC', assetId: USDC.assetId, amount: 1n },
            { account: 'REVENUE', assetId: USDC.assetId, amount: -1n },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' });
    expect((await ledger.post(base())).created).toBe(true);
  });

  it('P08-04 a balanced payout to the wrong wallet is flagged by counterparty checks', async () => {
    const ledger = new Ledger(new MemoryLedgerStore(), vendors);
    await expect(
      ledger.post(
        base({
          evidence: {
            chainId: USDC.chainId,
            txHash: `0x${'aa'.repeat(32)}`,
            logIndex: 1,
            recipient: `0x${'ba'.repeat(20)}`,
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'WRONG_VENDOR' });
  });

  it('P08-06 / P08-02 replayed events post once; conflicting replays are refused; reversals never delete', async () => {
    const ledger = new Ledger(new MemoryLedgerStore(), vendors);
    expect((await ledger.post(base())).created).toBe(true);
    expect((await ledger.post(base({ entryId: 'je_dup' }))).created).toBe(
      false,
    );
    await expect(
      ledger.post(
        base({
          entryId: 'je_dup2',
          postings: [
            {
              account: 'ACCOUNTS_PAYABLE',
              assetId: USDC.assetId,
              amount: 60_000n,
              counterpartyId: 'vendor:sarah',
            },
            {
              account: 'CASH_ARC_USDC',
              assetId: USDC.assetId,
              amount: -60_000n,
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(await ledger.balance('wsp_1', 'CASH_ARC_USDC', USDC.assetId)).toBe(
      -50_000n,
    );
    await ledger.reverse('je_1', 'test correction', NOW + 1);
    await expect(
      ledger.reverse('je_1', 'again', NOW + 2),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(await ledger.balance('wsp_1', 'CASH_ARC_USDC', USDC.assetId)).toBe(
      0n,
    );
    expect((await ledger.store.entries('wsp_1')).length).toBe(2);
  });

  it('P08-05 / P08-07 in-flight CCTP is not spendable and reservations never exceed confirmed cash', () => {
    expect(
      availableToSpend({
        confirmedCash: 1_000n,
        reservations: 300n,
        escrow: 200n,
        minimumReserve: 100n,
      }),
    ).toBe(400n);
    // CCTP in flight is a different account and is simply not an input here.
    expect(
      availableToSpend({
        confirmedCash: 0n,
        reservations: 0n,
        escrow: 0n,
        minimumReserve: 0n,
      }),
    ).toBe(0n);
    expect(
      availableToSpend({
        confirmedCash: 1_000n,
        reservations: 900n,
        escrow: 0n,
        minimumReserve: 500n,
      }),
    ).toBe(0n);
    expect(() =>
      availableToSpend({
        confirmedCash: 1_000n,
        reservations: 900n,
        escrow: 101n,
        minimumReserve: 0n,
      }),
    ).toThrow(LedgerError);
  });
});
