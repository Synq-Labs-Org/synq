import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Address, PublicClient } from 'viem';
import { moneyToDecimal, money } from '@synq/domain';
import { CHAINS } from '@synq/chain-registry/arc';
import {
  InvoiceError,
  amountDue,
  payCall,
  paymentsInTx,
  scanMemoPayments,
  verifyPayLink,
  type Invoice,
  type InvoiceService,
} from '@synq/invoices';

export type InvoiceRouteDeps = {
  invoices: InvoiceService;
  payLinkKey: Uint8Array;
  client: PublicClient;
  memoContract: Address;
  now(): number;
};

const dec = (i: Invoice, v: bigint) => moneyToDecimal(money(i.asset, v));

/** What a payer sees: terms, amount due and the exact Memo call to sign. */
export function checkoutView(i: Invoice, memoContract: Address) {
  const due = amountDue(i);
  const chain = Object.values(CHAINS).find(
    (c) => c.chainId === i.asset.chainId,
  )!;
  return {
    number: i.number,
    version: i.version,
    status: i.status,
    issuer: i.issuer.name,
    payTo: i.issuer.payoutAddress,
    payer: i.payer.name,
    dueDate: i.dueDate,
    lineItems: i.lineItems.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unitPrice: dec(i, l.unitPrice),
    })),
    asset: {
      symbol: i.asset.symbol,
      address: i.asset.address,
      decimals: i.asset.decimals,
    },
    total: dec(i, i.total),
    paid: dec(i, i.paid),
    amountDue: dec(i, due),
    termsHash: i.termsHash,
    paymentRef: i.paymentRef,
    chain: {
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpcUrls[0]!,
      explorer: chain.explorer,
      nativeSymbol: chain.nativeSymbol,
    },
    call:
      due > 0n && (i.status === 'ISSUED' || i.status === 'PARTIALLY_PAID')
        ? { to: memoContract, data: payCall(i, due).calldata, value: '0x0' }
        : null,
  };
}

/**
 * Public checkout. The pay link is an HMAC navigation token bound to one
 * invoice version, total and payout address; it is not a payment authority.
 * Settlement only happens from receipts read from Arc.
 */
export async function invoiceRoutes(
  app: FastifyInstance,
  deps: InvoiceRouteDeps,
) {
  const Token = z
    .string()
    .min(10)
    .max(200)
    .regex(/^[A-Za-z0-9_.-]+$/);
  const load = async (token: string) => {
    const store = deps.invoices.store;
    const cur = await store.get(token.split('.')[0]!);
    if (!cur) return null;
    verifyPayLink(deps.payLinkKey, token, cur.invoice, deps.now());
    return cur.invoice;
  };
  const fail = (e: unknown) => {
    if (e instanceof InvoiceError)
      return {
        status: e.code === 'BAD_PAY_LINK' ? 403 : 409,
        body: { error: e.code, message: e.message },
      };
    throw e;
  };

  app.get('/v1/pay/:token', async (req, reply) => {
    const token = Token.parse((req.params as { token: string }).token);
    try {
      const i = await load(token);
      if (!i) return reply.code(404).send({ error: 'NOT_FOUND' });
      return checkoutView(i, deps.memoContract);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });

  app.post('/v1/pay/:token/verify', async (req, reply) => {
    const token = Token.parse((req.params as { token: string }).token);
    const { txHash } = z
      .object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
      .parse(req.body);
    try {
      const i = await load(token);
      if (!i) return reply.code(404).send({ error: 'NOT_FOUND' });
      // The payer's hash is only a hint: the receipt decides what was paid.
      const found = await paymentsInTx({
        client: deps.client,
        chainId: i.asset.chainId,
        token: i.asset.address,
        memoContract: deps.memoContract,
        txHash: txHash as `0x${string}`,
      }).catch(() => null);
      if (!found) return reply.code(202).send({ state: 'PENDING' });
      const mine = found.payments.filter(
        (p) => p.paymentRef.toLowerCase() === i.paymentRef!.toLowerCase(),
      );
      for (const p of mine) await deps.invoices.settle(p);
      const now = (await deps.invoices.store.get(i.invoiceId))!.invoice;
      return {
        state: mine.length ? 'VERIFIED' : 'NO_MATCHING_PAYMENT',
        invoice: checkoutView(now, deps.memoContract),
      };
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });
}

/** Polls Arc for Memo payments and settles matching invoices; safe to run in several replicas. */
export function startMemoWatcher(input: {
  invoices: InvoiceService;
  client: PublicClient;
  chainId: number;
  token: Address;
  memoContract: Address;
  intervalMs?: number;
  lookbackBlocks?: bigint;
  onError?: (e: unknown) => void;
}) {
  let next: bigint | null = null;
  let stopped = false;
  const tick = async () => {
    const head = await input.client.getBlockNumber();
    const from =
      next ??
      (head > (input.lookbackBlocks ?? 5_000n)
        ? head - (input.lookbackBlocks ?? 5_000n)
        : 0n);
    if (from > head) return;
    const to = head - from > 2_000n ? from + 2_000n : head;
    const { payments } = await scanMemoPayments({
      ...input,
      fromBlock: from,
      toBlock: to,
    });
    for (const p of payments) await input.invoices.settle(p);
    next = to + 1n;
  };
  const loop = async () => {
    while (!stopped) {
      await tick().catch((e) => input.onError?.(e));
      await new Promise((r) => setTimeout(r, input.intervalMs ?? 5_000));
    }
  };
  void loop();
  return { stop: () => void (stopped = true), tick };
}

/**
 * Production wiring: enabled only when `SYNQ_PAY_LINK_KEY` (≥32 bytes, hex)
 * is configured. Uses the finance tables on the API database and Arc testnet.
 */
export async function registerInvoiceCheckout(input: {
  app: FastifyInstance;
  pool: {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Record<string, unknown>[] }>;
  };
  env: NodeJS.ProcessEnv;
}) {
  const raw = input.env.SYNQ_PAY_LINK_KEY;
  if (!raw) return null;
  if (!/^(?:[0-9a-fA-F]{2}){32,}$/.test(raw))
    throw new Error('SYNQ_PAY_LINK_KEY must be at least 32 bytes of hex');
  const { createPublicClient, http } = await import('viem');
  const { contract, token } = await import('@synq/chain-registry/arc');
  const { Ledger, PostgresLedgerStore, migrateFinance } =
    await import('@synq/ledger');
  const { InvoiceService, PostgresInvoiceStore } =
    await import('@synq/invoices');
  await migrateFinance(input.pool);
  const chain = CHAINS['arc-testnet'];
  const client = createPublicClient({
    transport: http(input.env.SYNQ_ARC_RPC_URL ?? chain.rpcUrls[0]),
  }) as PublicClient;
  const now = () => Math.floor(Date.now() / 1000);
  const invoices = new InvoiceService(
    new PostgresInvoiceStore(input.pool),
    new Ledger(new PostgresLedgerStore(input.pool)),
    now,
  );
  const memoContract = contract('arc-testnet', 'MEMO').address;
  await input.app.register(invoiceRoutes, {
    invoices,
    payLinkKey: Buffer.from(raw, 'hex'),
    client,
    memoContract,
    now,
  });
  const watcher =
    input.env.SYNQ_MEMO_WATCHER === '1'
      ? startMemoWatcher({
          invoices,
          client,
          chainId: chain.chainId,
          token: token('arc-testnet', 'USDC').address,
          memoContract,
          onError: (e) =>
            input.app.log.warn({ err: String(e) }, 'memo watcher'),
        })
      : null;
  input.app.addHook('onClose', async () => watcher?.stop());
  return { invoices, watcher };
}
