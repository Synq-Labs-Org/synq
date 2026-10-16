import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Address, PublicClient } from 'viem';
import { moneyToDecimal, money } from '@synq/domain';
import { CHAINS } from '@synq/chain-registry/arc';
import {
  InvoiceError,
  amountDue,
  issueTypedData,
  payCall,
  payLinkToken,
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
  reconciliation?: (
    invoice: Invoice,
  ) => Promise<'REVIEW' | 'PENDING' | 'FINALIZED' | 'NOT_PAID'>;
};

const dec = (i: Invoice, v: bigint) => moneyToDecimal(money(i.asset, v));

/** Lifetime of an issuer's signing link and of a checkout link. */
export const ISSUE_LINK_TTL_SECONDS = 7 * 86_400;
export const PAY_LINK_TTL_SECONDS = 30 * 86_400;

const issueMac = (key: Uint8Array, invoiceId: string, expiresAt: number) =>
  createHmac('sha256', key)
    .update(`synq-invoice-issue:${invoiceId}:${expiresAt}`)
    .digest('base64url')
    .slice(0, 32);

/**
 * HMAC navigation token for the issuer's signing page: `<expiresAt>.<mac>`.
 * It only lets the page show the draft; issuing still needs the issuer
 * wallet's EIP-712 signature over the exact terms.
 */
export function issueLinkToken(
  key: Uint8Array,
  invoiceId: string,
  expiresAt: number,
): string {
  return `${expiresAt}.${issueMac(key, invoiceId, expiresAt)}`;
}

export function verifyIssueLink(
  key: Uint8Array,
  invoiceId: string,
  token: string,
  now: number,
): boolean {
  const m = /^([0-9]{1,12})\.([A-Za-z0-9_-]{32})$/.exec(String(token));
  if (!m) return false;
  const expiresAt = Number(m[1]);
  const want = Buffer.from(issueMac(key, invoiceId, expiresAt));
  const got = Buffer.from(m[2]!);
  return (
    want.length === got.length && timingSafeEqual(want, got) && now < expiresAt
  );
}

/** Checkout path for an issued invoice; null while it is a draft or void. */
export function payPathFor(key: Uint8Array, i: Invoice): string | null {
  if (!i.paymentRef || i.status === 'DRAFT' || i.status === 'VOID') return null;
  return `/pay/${payLinkToken(key, i, (i.issuedAt ?? 0) + PAY_LINK_TTL_SECONDS)}`;
}

/** bigint -> decimal string, so typed data survives JSON for eth_signTypedData_v4. */
const jsonSafe = (v: unknown): unknown =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)),
  );

/** What the issuer sees before signing: the draft and the exact typed data. */
export function issueView(i: Invoice, payLinkKey: Uint8Array) {
  const chain = Object.values(CHAINS).find(
    (c) => c.chainId === i.asset.chainId,
  )!;
  return {
    invoiceId: i.invoiceId,
    number: i.number,
    version: i.version,
    status: i.status,
    issuer: i.issuer.name,
    issuerWallet: i.issuer.wallet,
    payTo: i.issuer.payoutAddress,
    payer: i.payer.name,
    dueDate: i.dueDate,
    memo: i.memo,
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
    chain: {
      chainId: chain.chainId,
      name: chain.name,
      rpcUrl: chain.rpcUrls[0]!,
      explorer: chain.explorer,
    },
    issueTypedData: i.status === 'DRAFT' ? jsonSafe(issueTypedData(i)) : null,
    payPath: payPathFor(payLinkKey, i),
  };
}

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
  const view = async (i: Invoice) => {
    const reconciliation =
      (await deps.reconciliation?.(i)) ??
      (z.uuid().safeParse(i.workspaceId).success ? 'PENDING' : 'NOT_PAID');
    return {
      ...checkoutView(i, deps.memoContract),
      reconciliation,
      ...(reconciliation === 'REVIEW' ? { call: null } : {}),
    };
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
      return view(i);
    } catch (e) {
      const f = fail(e);
      return reply.code(f.status).send(f.body);
    }
  });

  const IssueToken = z.object({ t: z.string().min(10).max(80) });
  const InvoiceId = z.string().regex(/^inv_[0-9a-f]{20}$/);
  /** Unknown, expired and forged issue links all look the same: 404. */
  const draftFor = async (params: unknown, query: unknown) => {
    const id = InvoiceId.safeParse((params as { id?: string }).id);
    const t = IssueToken.safeParse(query);
    if (!id.success || !t.success) return null;
    const cur = await deps.invoices.store.get(id.data);
    if (
      !cur ||
      !verifyIssueLink(deps.payLinkKey, id.data, t.data.t, deps.now())
    )
      return null;
    return cur.invoice;
  };

  app.get('/v1/invoices/:id/issue', async (req, reply) => {
    const i = await draftFor(req.params, req.query);
    if (!i) return reply.code(404).send({ error: 'NOT_FOUND' });
    reply.header('cache-control', 'no-store');
    return issueView(i, deps.payLinkKey);
  });

  // Issuing: the issuer wallet's EIP-712 signature over the exact terms; the
  // service recovers it and refuses any other signer.
  app.post('/v1/invoices/:id/issue', async (req, reply) => {
    const i = await draftFor(req.params, req.query);
    if (!i) return reply.code(404).send({ error: 'NOT_FOUND' });
    const body = z
      .object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) })
      .safeParse(req.body);
    if (!body.success)
      return reply
        .code(400)
        .send({ error: 'BAD_REQUEST', message: 'invalid input' });
    try {
      const issued = await deps.invoices.issue(
        i.invoiceId,
        body.data.signature as `0x${string}`,
      );
      reply.header('cache-control', 'no-store');
      return issueView(issued.invoice, deps.payLinkKey);
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
      if (z.uuid().safeParse(i.workspaceId).success) {
        const booked = i.payments.some(
          (p) => p.txHash.toLowerCase() === txHash.toLowerCase(),
        );
        const current = await view(i);
        const verified = booked && current.reconciliation === 'FINALIZED';
        return reply
          .code(
            current.reconciliation === 'REVIEW' ? 409 : verified ? 200 : 202,
          )
          .send({
            state:
              current.reconciliation === 'REVIEW'
                ? 'REVIEW'
                : verified
                  ? 'VERIFIED'
                  : 'PENDING',
            invoice: current,
          });
      }
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
        invoice: await view(now),
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
    for (const p of payments) {
      const known = await input.invoices.store.byPaymentRef(p.paymentRef);
      if (known && z.uuid().safeParse(known.invoice.workspaceId).success)
        continue;
      await input.invoices.settle(p);
    }
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
  authorizeIssue?: (invoice: Invoice) => Promise<void>;
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
    async (invoice) => {
      if (
        z.uuid().safeParse(invoice.workspaceId).success &&
        !input.authorizeIssue
      )
        throw new InvoiceError(
          'NOT_ISSUER',
          'Workspace authority service unavailable',
        );
      await input.authorizeIssue?.(invoice);
    },
  );
  const memoContract = contract('arc-testnet', 'MEMO').address;
  await input.app.register(invoiceRoutes, {
    invoices,
    payLinkKey: Buffer.from(raw, 'hex'),
    client,
    memoContract,
    now,
    reconciliation: async (i) => {
      if (!z.uuid().safeParse(i.workspaceId).success)
        return i.paid > 0n ? 'FINALIZED' : 'NOT_PAID';
      const r = await input.pool.query(
        'SELECT state FROM synq_ws_receipts WHERE workspace_id=$1 AND invoice_id=$2',
        [i.workspaceId, i.invoiceId],
      );
      if (r.rows.some((v) => v.state === 'REVIEW')) return 'REVIEW';
      if (i.paid === 0n) return 'NOT_PAID';
      return r.rows.length === i.payments.length &&
        r.rows.every((v) => v.state === 'PENDING_POLICY')
        ? 'FINALIZED'
        : 'PENDING';
    },
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
