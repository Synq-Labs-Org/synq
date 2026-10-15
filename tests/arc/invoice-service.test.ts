import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  InvoiceService,
  MemoryInvoiceStore,
  draftInvoice,
  issueTypedData,
  type Invoice,
  type MemoPayment,
} from '@synq/invoices';
import { MemoryVendorStore, VendorConflictError } from '@synq/payables';

const USDC = token('arc-testnet', 'USDC');
const issuer = privateKeyToAccount(`0x${'61'.repeat(32)}`);
const payerWallet = privateKeyToAccount(`0x${'62'.repeat(32)}`).address;
let t = 1_800_000_000;
const now = () => t++;

const draft = (number = 'INV-0100') =>
  draftInvoice({
    workspaceId: 'wsp_svc',
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
      { description: 'Design sprint', quantity: 1, unitPrice: 300_000n },
    ],
    dueDate: '2026-10-30',
    draftedBy: 'agent:invoice',
    now: now(),
  });

const pay = (i: Invoice, amount: bigint, tx = 'a1'): MemoPayment => ({
  chainId: USDC.chainId,
  txHash: `0x${tx.repeat(32)}` as Hex,
  logIndex: 3,
  paymentRef: i.paymentRef!,
  payer: payerWallet,
  recipient: issuer.address,
  amount,
});

async function setup() {
  const store = new MemoryInvoiceStore();
  const ledgerStore = new MemoryLedgerStore();
  const svc = new InvoiceService(store, new Ledger(ledgerStore), now);
  const d = draft();
  await svc.create(d);
  const issued = await svc.issue(
    d.invoiceId,
    await issuer.signTypedData(issueTypedData(d)),
  );
  return { store, ledgerStore, svc, issued: issued.invoice };
}

describe('persisted invoice lifecycle (P11)', () => {
  it('issues once, settles from a verified payment once, and emits outbox events with each posting', async () => {
    const { svc, store, ledgerStore, issued } = await setup();
    expect(issued.status).toBe('ISSUED');
    expect((await svc.issue(issued.invoiceId, '0x')).invoice.status).toBe(
      'ISSUED',
    ); // re-issue is a read
    const a = await svc.settle(pay(issued, 300_000n));
    expect(a).toMatchObject({
      outcome: 'APPLIED',
      invoice: { status: 'PAID' },
    });
    expect(await svc.settle(pay(issued, 300_000n))).toMatchObject({
      outcome: 'DUPLICATE',
    });
    expect((await store.get(issued.invoiceId))!.invoice.status).toBe('PAID');
    const topics = (await ledgerStore.pendingEvents(10)).map((e) => e.topic);
    expect(topics).toEqual(['invoice.issued', 'invoice.payment_applied']);
    expect(
      await svc.settle({
        ...pay(issued, 1n),
        paymentRef: `0x${'00'.repeat(32)}`,
      }),
    ).toMatchObject({ outcome: 'UNMATCHED' });
  });

  it('a crash between the ledger post and the document save is repaired by re-running the step', async () => {
    const { svc, store, ledgerStore, issued } = await setup();
    const realSave = store.save.bind(store);
    let fail = true;
    store.save = async (i, rev) => {
      if (fail) {
        fail = false;
        throw new Error('crash after ledger post');
      }
      return realSave(i, rev);
    };
    await expect(svc.settle(pay(issued, 100_000n))).rejects.toThrow(/crash/);
    expect((await store.get(issued.invoiceId))!.invoice.status).toBe('ISSUED');
    expect(await svc.settle(pay(issued, 100_000n))).toMatchObject({
      outcome: 'APPLIED',
      invoice: { status: 'PARTIALLY_PAID' },
    });
    const entries = await ledgerStore.entries('wsp_svc');
    expect(entries.filter((e) => e.source.kind === 'CHAIN_TX')).toHaveLength(1); // cash credited once
    expect(
      await new Ledger(ledgerStore).balance(
        'wsp_svc',
        'CASH_ARC_USDC',
        USDC.assetId,
      ),
    ).toBe(100_000n);
  });

  it('stale writes and duplicate numbers are refused', async () => {
    const { store, issued } = await setup();
    const cur = (await store.get(issued.invoiceId))!;
    await store.save({ ...cur.invoice, memo: 'edit 1' }, cur.rev);
    await expect(
      store.save({ ...cur.invoice, memo: 'stale edit' }, cur.rev),
    ).rejects.toThrow(expect.objectContaining({ code: 'CONFLICT' }));
    await expect(store.save({ ...draft('INV-0100') }, null)).rejects.toThrow(
      expect.objectContaining({ code: 'DUPLICATE_NUMBER' }),
    );
    const vendors = new MemoryVendorStore();
    const v = {
      vendorId: 'v1',
      workspaceId: 'w',
      name: 'Sarah',
      kind: 'CONTRACTOR' as const,
      addresses: [],
    };
    const r1 = await vendors.save(v, null);
    await vendors.save({ ...v, name: 'Sarah K' }, r1);
    await expect(vendors.save({ ...v, name: 'stale' }, r1)).rejects.toThrow(
      VendorConflictError,
    );
  });
});
