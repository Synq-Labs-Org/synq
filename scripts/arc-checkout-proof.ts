/**
 * Live invoice checkout on Arc testnet through the real checkout API and a
 * persistent Postgres store.
 *
 *   SYNQ_FINANCE_DATABASE_URL=postgresql://… node --import tsx scripts/arc-checkout-proof.ts
 *
 * Issuer = testnet.key. Payer = arc-client.key, acting exactly as the checkout
 * page's wallet would: it sends the call the API returns and reports the hash.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import pg from 'pg';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal, money } from '@synq/domain';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
  verifyContract,
} from '@synq/execution-worker/arc';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import {
  InvoiceService,
  PostgresInvoiceStore,
  draftInvoice,
  issueTypedData,
  payLinkToken,
  scanMemoPayments,
} from '@synq/invoices';
import { invoiceRoutes } from '../apps/api/src/invoice-routes.js';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const issuer = privateKeyToAccount(key('testnet.key'));
const payer = privateKeyToAccount(key('arc-client.key'));
const chain = await connectChain('arc-testnet');
await verifyContract(chain, 'MEMO');
const usdc = token('arc-testnet', 'USDC');
const memo = contract('arc-testnet', 'MEMO').address;
const now = () => Math.floor(Date.now() / 1000);
const pool = new pg.Pool({
  connectionString:
    process.env.SYNQ_FINANCE_DATABASE_URL ??
    'postgresql://postgres:synq_local@127.0.0.1:55433/synq_p08_checkout',
});
await migrateFinance(pool);
const ledger = new Ledger(new PostgresLedgerStore(pool));
const invoices = new InvoiceService(
  new PostgresInvoiceStore(pool),
  ledger,
  now,
);
const payLinkKey = randomBytes(32);
const out: Record<string, unknown> = {
  environment: 'ARC_TESTNET',
  persistence: 'POSTGRES',
  issuer: issuer.address,
  payer: payer.address,
};

if ((await balanceOf(chain, usdc, payer.address)).baseUnits < 500_000n) {
  const f = await executeTransfer(chain, issuer, {
    from: issuer.address,
    to: payer.address,
    amount: moneyFromDecimal(usdc, '1'),
  });
  out.payerFunding = f.hash;
}

// 1. Invoice drafted, issued by the issuer's wallet signature, persisted.
const d = draftInvoice({
  workspaceId: 'wsp_freelancer_demo',
  number: `INV-WEB-${String(now()).slice(-6)}`,
  issuer: {
    principalId: 'prn_freelancer',
    name: 'Synq Studio (test)',
    wallet: issuer.address,
    payoutAddress: issuer.address,
  },
  payer: { name: 'Acme (test client)', contact: null },
  asset: usdc,
  lineItems: [
    {
      description: 'Brand refresh (checkout test)',
      quantity: 1,
      unitPrice: 120_000n,
    },
  ],
  dueDate: '2026-10-30',
  draftedBy: 'agent:invoice',
  now: now(),
});
await invoices.create(d);
const issued = (
  await invoices.issue(
    d.invoiceId,
    await issuer.signTypedData(issueTypedData(d)),
  )
).invoice;

// 2. Checkout API on a local port, reading Arc for settlement.
const app = Fastify();
await app.register(invoiceRoutes, {
  invoices,
  payLinkKey,
  client: chain.client,
  memoContract: memo,
  now,
});
const base = await app.listen({ port: 0, host: '127.0.0.1' });
const link = payLinkToken(payLinkKey, issued, now() + 3600);
const view = (await (await fetch(`${base}/v1/pay/${link}`)).json()) as {
  amountDue: string;
  call: { to: Hex; data: Hex };
};
out.checkout = {
  url: `/pay/${link.split('.')[0]}.…`,
  amountDue: view.amountDue,
  callTo: view.call.to,
};

// 3. The payer's wallet sends exactly the returned call.
const wallet = createWalletClient({
  account: payer,
  chain: {
    id: usdc.chainId,
    name: 'Arc Testnet',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [CHAINS['arc-testnet'].rpcUrls[0]!] } },
  },
  transport: http(CHAINS['arc-testnet'].rpcUrls[0]),
});
const hash = await wallet.sendTransaction({
  to: view.call.to,
  data: view.call.data,
});
const receipt = await chain.client.waitForTransactionReceipt({ hash });

// 4. The page reports the hash; the API verifies from the receipt.
const verified = (await (
  await fetch(`${base}/v1/pay/${link}/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ txHash: hash }),
  })
).json()) as { state: string; invoice: { status: string; amountDue: string } };

// 5. The independent watcher sees the same payment and applies nothing new.
const scanned = await scanMemoPayments({
  client: chain.client,
  chainId: usdc.chainId,
  token: usdc.address,
  memoContract: memo,
  fromBlock: receipt.blockNumber,
  toBlock: receipt.blockNumber,
});
const replays = [];
for (const p of scanned.payments.filter(
  (p) => p.paymentRef === issued.paymentRef,
))
  replays.push((await invoices.settle(p)).outcome);
await app.close();

// 6. Re-read from Postgres with fresh objects.
const reloaded = (await new PostgresInvoiceStore(pool).get(issued.invoiceId))!;
const balances = await new Ledger(new PostgresLedgerStore(pool)).balances(
  'wsp_freelancer_demo',
  usdc.assetId,
);
out.payment = {
  tx: hash,
  explorer: `${chain.profile.explorer}/tx/${hash}`,
  block: String(receipt.blockNumber),
};
out.verify = verified.state;
out.watcherReplay = replays;
out.invoice = {
  number: reloaded.invoice.number,
  status: reloaded.invoice.status,
  paid: moneyToDecimal(money(usdc, reloaded.invoice.paid)),
  payments: reloaded.invoice.payments.length,
  rev: reloaded.rev,
};
out.ledgerWorkspaceTotals = Object.fromEntries(
  Object.entries(balances)
    .filter(([, v]) => v !== 0n)
    .map(([k, v]) => [k, moneyToDecimal(money(usdc, v))]),
);
await pool.end();
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `checkout-${hash.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`evidence -> ${file}`);
