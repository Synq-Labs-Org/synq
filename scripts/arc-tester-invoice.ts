/** Issues a real signed testnet invoice; never sends a transaction or deploys. */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { token, contract } from '@synq/chain-registry/arc';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import {
  InvoiceService,
  PostgresInvoiceStore,
  draftInvoice,
  issueTypedData,
  payLinkToken,
} from '@synq/invoices';
import {
  TesterManifestSchema,
  type TesterManifest,
} from './lib/tester-traction.js';
import { controlledTesterWallets } from './lib/tester-wallets.js';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const testerId = arg('--tester');
if (!testerId || !/^[a-zA-Z0-9_-]{1,48}$/.test(testerId))
  throw new Error('--tester needs a pseudonymous id (letters/numbers/_/-)');
const base = new URL(arg('--base-url') ?? 'http://localhost:3000');
if (
  base.protocol !== 'https:' &&
  !(
    base.protocol === 'http:' &&
    ['localhost', '127.0.0.1'].includes(base.hostname)
  )
)
  throw new Error('checkout base must be HTTPS or local HTTP');
if (
  base.username ||
  base.password ||
  base.search ||
  base.hash ||
  base.pathname !== '/'
)
  throw new Error('--base-url must be an origin');
const raw = process.env.SYNQ_PAY_LINK_KEY;
if (!raw || !/^(?:[a-fA-F0-9]{2}){32,}$/.test(raw))
  throw new Error(
    'configure the SAME SYNQ_PAY_LINK_KEY hex (>=32 bytes) as the API; do not pass it on the command line',
  );
const database =
  process.env.SYNQ_DATABASE_URL ?? process.env.SYNQ_FINANCE_DATABASE_URL;
if (!database)
  throw new Error(
    'SYNQ_DATABASE_URL or SYNQ_FINANCE_DATABASE_URL must point to the deployed checkout database',
  );
const ttl = Number(arg('--ttl-seconds') ?? 21600);
if (!Number.isSafeInteger(ttl) || ttl < 60 || ttl > 86400)
  throw new Error('TTL must be 60..86400 seconds');
const amount = BigInt(arg('--amount-base-units') ?? 1000);
if (amount < 1n || amount > 10000n)
  throw new Error(
    'tester amount must be 1..10000 USDC base units (max 0.01 test USDC)',
  );
const chain = await connectChain('arc-testnet');
await verifyContract(chain, 'MEMO');
const usdc = token('arc-testnet', 'USDC'),
  memoContract = contract('arc-testnet', 'MEMO').address;
const path = arg('--manifest') ?? 'reports/testers/manifest.json';
const controlledWallets = controlledTesterWallets();
let manifest: TesterManifest = existsSync(path)
  ? TesterManifestSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
  : {
      version: 1,
      chainId: 5042002,
      token: usdc.address,
      memoContract,
      controlledWallets,
      invoices: [],
    };
if (
  manifest.token.toLowerCase() !== usdc.address.toLowerCase() ||
  manifest.memoContract.toLowerCase() !== memoContract.toLowerCase()
)
  throw new Error('manifest contract binding differs');
manifest = {
  ...manifest,
  controlledWallets: [
    ...new Set([...manifest.controlledWallets, ...controlledWallets]),
  ],
};
const secret = readFileSync(
  join(process.env.HOME!, '.synq', 'testnet.key'),
  'utf8',
).trim();
const issuer = privateKeyToAccount(
  (secret.startsWith('0x') ? secret : `0x${secret}`) as Hex,
);
const pool = new pg.Pool({ connectionString: database, max: 2 });
try {
  await migrateFinance(pool);
  const now = Math.floor(Date.now() / 1000),
    expiresAt = now + ttl;
  const service = new InvoiceService(
    new PostgresInvoiceStore(pool),
    new Ledger(new PostgresLedgerStore(pool)),
    () => now,
  );
  const draft = draftInvoice({
    workspaceId: 'wsp_external_testers',
    number: `TEST-${testerId}-${randomUUID().slice(0, 8)}`,
    issuer: {
      principalId: 'synq-test-issuer',
      name: 'Synq testnet usability session',
      wallet: issuer.address,
      payoutAddress: issuer.address,
    },
    payer: { name: `Tester ${testerId}`, contact: null },
    asset: usdc,
    lineItems: [
      {
        description:
          'Consented testnet invoice checkout exercise (no real goods or funds)',
        quantity: 1,
        unitPrice: amount,
      },
    ],
    dueDate: new Date(expiresAt * 1000).toISOString().slice(0, 10),
    draftedBy: 'owner:tester-kit',
    now,
  });
  await service.create(draft);
  const issued = (
    await service.issue(
      draft.invoiceId,
      await issuer.signTypedData(issueTypedData(draft)),
    )
  ).invoice;
  const checkoutUrl = new URL(
    `/pay/${payLinkToken(Buffer.from(raw, 'hex'), issued, expiresAt)}`,
    base,
  ).href;
  manifest.invoices.push({
    testerId,
    invoiceId: issued.invoiceId,
    paymentRef: issued.paymentRef!,
    recipient: issuer.address,
    totalBaseUnits: String(amount),
    fromBlock: String(await chain.client.getBlockNumber({ cacheTime: 0 })),
    issuedAt: now,
    expiresAt,
    checkoutUrl,
  });
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', {
    mode: 0o600,
  });
  console.log(
    JSON.stringify(
      {
        label: 'ARC_TESTNET_INVOICE_ISSUED_NOT_PAID',
        testerId,
        invoiceId: issued.invoiceId,
        amountBaseUnits: String(amount),
        chainId: usdc.chainId,
        expiresAt,
        checkoutUrl,
        publicDeployment: 'NOT_VERIFIED; owner deployment approval required',
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
