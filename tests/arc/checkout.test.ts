import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contract, token } from '@synq/chain-registry/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  InvoiceService,
  MEMO_ABI,
  MemoryInvoiceStore,
  draftInvoice,
  issueTypedData,
  payLinkToken,
} from '@synq/invoices';
import { invoiceRoutes } from '../../apps/api/src/invoice-routes.js';

const USDC = token('arc-testnet', 'USDC');
const MEMO = contract('arc-testnet', 'MEMO').address;
const issuer = privateKeyToAccount(`0x${'81'.repeat(32)}`);
const payer = privateKeyToAccount(`0x${'82'.repeat(32)}`).address;
const KEY = new Uint8Array(32).fill(7);
const NOW = 1_800_000_000;
const TX = `0x${'c4'.repeat(32)}` as Hex;

const receiptFor = (ref: Hex, to: Address, value: bigint) => ({
  status: 'success',
  logs: [
    {
      address: USDC.address,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: payer, to },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      logIndex: 1,
      blockNumber: 5n,
      blockHash: `0x${'bb'.repeat(32)}`,
      transactionHash: TX,
      transactionIndex: 0,
      removed: false,
    },
    {
      address: MEMO,
      topics: encodeEventTopics({
        abi: MEMO_ABI,
        eventName: 'Memo',
        args: { sender: payer, target: USDC.address, memoId: ref },
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
      logIndex: 2,
      blockNumber: 5n,
      blockHash: `0x${'bb'.repeat(32)}`,
      transactionHash: TX,
      transactionIndex: 0,
      removed: false,
    },
  ],
});

async function app(
  receipt: () => unknown,
  reconciliation?: 'REVIEW' | 'PENDING' | 'FINALIZED',
) {
  const svc = new InvoiceService(
    new MemoryInvoiceStore(),
    new Ledger(new MemoryLedgerStore()),
    () => NOW,
  );
  const d = draftInvoice({
    workspaceId: reconciliation ? '12345678-1234-4123-8123-123456789012' : 'w',
    number: 'INV-PAY-1',
    issuer: {
      principalId: 'p',
      name: 'Studio',
      wallet: issuer.address,
      payoutAddress: issuer.address,
    },
    payer: { name: 'Acme', contact: null },
    asset: USDC,
    lineItems: [{ description: 'Logo', quantity: 1, unitPrice: 250_000n }],
    dueDate: '2026-10-30',
    draftedBy: 'agent:invoice',
    now: NOW,
  });
  await svc.create(d);
  const inv = (
    await svc.issue(d.invoiceId, await issuer.signTypedData(issueTypedData(d)))
  ).invoice;
  const client = {
    getTransactionReceipt: async () => receipt(),
  } as unknown as PublicClient;
  const a = Fastify();
  await a.register(invoiceRoutes, {
    invoices: svc,
    payLinkKey: KEY,
    client,
    memoContract: MEMO,
    now: () => NOW,
    ...(reconciliation ? { reconciliation: async () => reconciliation } : {}),
  });
  return { a, inv, svc, tokenStr: payLinkToken(KEY, inv, NOW + 3600) };
}

describe('invoice checkout (P11)', () => {
  it('G8 waits for the workspace indexer and never calls reviewed or pending proof verified', async () => {
    for (const state of ['REVIEW', 'PENDING', 'FINALIZED'] as const) {
      const { a, inv, svc, tokenStr } = await app(() => {
        throw new Error(
          'Workspace checkout must never settle from an unverified hint',
        );
      }, state);
      try {
        const before = await a.inject({
          method: 'POST',
          url: `/v1/pay/${tokenStr}/verify`,
          payload: { txHash: TX },
        });
        expect(before.json().state).toBe(
          state === 'REVIEW' ? 'REVIEW' : 'PENDING',
        );
        expect((await svc.store.get(inv.invoiceId))?.invoice.paid).toBe(0n);
        await svc.settle({
          chainId: USDC.chainId,
          txHash: TX,
          logIndex: 1,
          paymentRef: inv.paymentRef!,
          payer,
          recipient: inv.issuer.payoutAddress,
          amount: 250000n,
        });
        const after = await a.inject({
          method: 'POST',
          url: `/v1/pay/${tokenStr}/verify`,
          payload: { txHash: TX },
        });
        expect(after.json().state).toBe(
          state === 'FINALIZED' ? 'VERIFIED' : state,
        );
        expect(after.statusCode).toBe(
          state === 'REVIEW' ? 409 : state === 'PENDING' ? 202 : 200,
        );
        if (state === 'REVIEW') expect(after.json().invoice.call).toBeNull();
      } finally {
        await a.close();
      }
    }
  });

  it('serves the exact Memo call for the amount due, bound to this version', async () => {
    const { a, inv, tokenStr } = await app(() => null);
    const r = await a.inject({ url: `/v1/pay/${tokenStr}` });
    expect(r.statusCode).toBe(200);
    const v = r.json();
    expect(v).toMatchObject({
      number: 'INV-PAY-1',
      amountDue: '0.25',
      status: 'ISSUED',
      paymentRef: inv.paymentRef,
    });
    expect(v.call.to.toLowerCase()).toBe(MEMO.toLowerCase());
    const call = decodeFunctionData({ abi: MEMO_ABI, data: v.call.data });
    expect(call.args[2]).toBe(inv.paymentRef);
    const inner = decodeFunctionData({ abi: erc20Abi, data: call.args[1] });
    expect(inner.args).toEqual([issuer.address, 250_000n]);
  });

  it('rejects tampered and expired links', async () => {
    const { a, inv } = await app(() => null);
    const good = payLinkToken(KEY, inv, NOW + 3600);
    const tampered = good.slice(0, -3) + (good.endsWith('AAA') ? 'BBB' : 'AAA');
    expect((await a.inject({ url: `/v1/pay/${tampered}` })).statusCode).toBe(
      403,
    );
    expect(
      (await a.inject({ url: `/v1/pay/${payLinkToken(KEY, inv, NOW - 1)}` }))
        .statusCode,
    ).toBe(403);
    expect(
      (
        await a.inject({
          url: `/v1/pay/${payLinkToken(new Uint8Array(32), inv, NOW + 60)}`,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('settles only from the receipt; a hash paying someone else or another reference applies nothing', async () => {
    let receipt: unknown = null;
    const { a, inv, tokenStr, svc } = await app(() => receipt);
    const verify = () =>
      a.inject({
        method: 'POST',
        url: `/v1/pay/${tokenStr}/verify`,
        payload: { txHash: TX },
      });
    receipt = receiptFor(`0x${'00'.repeat(32)}`, issuer.address, 250_000n);
    expect((await verify()).json().state).toBe('NO_MATCHING_PAYMENT');
    receipt = receiptFor(inv.paymentRef!, payer, 250_000n); // right ref, wrong recipient
    expect((await verify()).statusCode).toBe(409);
    receipt = receiptFor(inv.paymentRef!, issuer.address, 250_000n);
    const ok = (await verify()).json();
    expect(ok).toMatchObject({
      state: 'VERIFIED',
      invoice: { status: 'PAID', amountDue: '0', call: null },
    });
    expect((await verify()).json().state).toBe('VERIFIED'); // replay: still paid once
    expect((await svc.store.get(inv.invoiceId))!.invoice.payments).toHaveLength(
      1,
    );
  });
});
