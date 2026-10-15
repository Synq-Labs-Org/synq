/**
 * Real Arc testnet invoices: partial, exact and overpaid, each paid by a
 * separate client wallet through Arc's Memo contract and reconciled from the
 * actual receipts.
 *
 *   node --import tsx scripts/arc-invoice-proof.ts
 *
 * Keys (testnet only, ~/.synq): testnet.key = issuer (freelancer wallet and
 * payout), arc-client.key = payer (created and funded with 1 USDC if empty).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createWalletClient, http, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal, money } from '@synq/domain';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
  verifyContract,
} from '@synq/execution-worker/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  amountDue,
  applyPayment,
  draftInvoice,
  extractMemoPayments,
  issueInvoice,
  issueTypedData,
  overpaidBy,
  payCall,
  type Invoice,
} from '@synq/invoices';

const home = `${process.env.HOME}/.synq`;
const key = (f: string, create = false): Hex => {
  const p = join(home, f);
  if (!existsSync(p) && create)
    writeFileSync(p, generatePrivateKey() + '\n', { mode: 0o600 });
  const k = readFileSync(p, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const issuer = privateKeyToAccount(key('testnet.key'));
const client = privateKeyToAccount(key('arc-client.key', true));
const chain = await connectChain('arc-testnet');
await verifyContract(chain, 'MEMO');
const usdc = token('arc-testnet', 'USDC');
const memo = contract('arc-testnet', 'MEMO').address;
const out: Record<string, unknown> = {
  environment: 'ARC_TESTNET',
  issuer: issuer.address,
  client: client.address,
};
const u = (d: string) => moneyFromDecimal(usdc, d).baseUnits;

if ((await balanceOf(chain, usdc, client.address)).baseUnits < u('0.6')) {
  const f = await executeTransfer(chain, issuer, {
    from: issuer.address,
    to: client.address,
    amount: moneyFromDecimal(usdc, '1'),
  });
  out.clientFunding = { hash: f.hash, explorer: f.explorer };
}

const viemChain = {
  id: usdc.chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [CHAINS['arc-testnet'].rpcUrls[0]!] } },
} as const;
const clientWallet = createWalletClient({
  account: client,
  chain: viemChain,
  transport: http(CHAINS['arc-testnet'].rpcUrls[0]),
});
const ledger = new Ledger(new MemoryLedgerStore());
const now = () => Math.floor(Date.now() / 1000);

async function run(label: string, total: string, paid: string, n: number) {
  let inv: Invoice = draftInvoice({
    workspaceId: 'wsp_freelancer_demo',
    number: `INV-ARC-${String(now()).slice(-6)}-${n}`,
    issuer: {
      principalId: 'prn_freelancer',
      name: 'Synq Studio (test)',
      wallet: issuer.address,
      payoutAddress: issuer.address,
    },
    payer: { name: 'Acme (test client)', contact: null },
    asset: usdc,
    lineItems: [
      { description: `${label} scenario`, quantity: 1, unitPrice: u(total) },
    ],
    dueDate: '2026-10-24',
    draftedBy: 'agent:invoice',
    now: now(),
  });
  const issued = await issueInvoice(
    inv,
    await issuer.signTypedData(issueTypedData(inv)),
    now(),
  );
  inv = issued.invoice;
  await ledger.post(issued.entry);
  // The client signs their own Memo call: transfer(issuer, amount) tagged with the invoice reference.
  const call = payCall(inv, u(paid));
  const hash = await clientWallet.sendTransaction({
    to: memo,
    data: call.calldata,
  });
  const receipt = await chain.client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`payment reverted ${hash}`);
  const { payments, unreferenced } = extractMemoPayments({
    chainId: usdc.chainId,
    txHash: hash,
    logs: receipt.logs,
    token: usdc.address,
    memoContract: memo,
  });
  if (payments.length !== 1 || unreferenced.length)
    throw new Error(
      `unexpected match ${payments.length}/${unreferenced.length}`,
    );
  const applied = applyPayment(inv, payments[0]!, now());
  inv = applied.invoice;
  await ledger.post(applied.entry!);
  const replay = applyPayment(inv, payments[0]!, now());
  const replayPosted = await ledger.post(applied.entry!);
  return {
    scenario: label,
    invoice: inv.number,
    invoiceId: inv.invoiceId,
    paymentRef: inv.paymentRef,
    total,
    paid,
    status: inv.status,
    amountDue: moneyToDecimal(money(usdc, amountDue(inv))),
    overpaid: moneyToDecimal(money(usdc, overpaidBy(inv))),
    tx: hash,
    block: String(receipt.blockNumber),
    explorer: `${CHAINS['arc-testnet'].explorer}/tx/${hash}`,
    matchedLogIndex: payments[0]!.logIndex,
    replayApplied: replay.applied,
    replayLedgerCreated: replayPosted.created,
  };
}

out.invoices = [
  await run('partial', '0.30', '0.10', 1),
  await run('exact', '0.20', '0.20', 2),
  await run('overpaid', '0.15', '0.20', 3),
];
const b = await ledger.balances('wsp_freelancer_demo', usdc.assetId);
out.ledger = Object.fromEntries(
  Object.entries(b)
    .filter(([, v]) => v !== 0n)
    .map(([k, v]) => [k, moneyToDecimal(money(usdc, v))]),
);
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `invoices-${Date.now()}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`evidence -> ${file}`);
