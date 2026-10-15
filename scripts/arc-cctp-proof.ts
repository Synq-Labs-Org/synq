/**
 * Real CCTP V2 invoice payment: Ethereum Sepolia → Arc testnet.
 *
 *   node --import tsx scripts/arc-cctp-proof.ts [--amount 1.00]
 *
 * issuer = testnet.key (Arc invoice + payout), client = arc-client.key (pays
 * from Sepolia; funded from the operator on Sepolia if needed).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { erc20Abi, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal, money } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import { connectChain, executeTransfer } from '@synq/execution-worker/arc';
import {
  burnOnSource,
  mintOnDestination,
  reconcileMint,
} from '@synq/execution-worker/cctp';
import {
  advance,
  decodeMessage,
  irisFees,
  irisMessage,
  maxFeeFor,
  planTransfer,
  type CctpTransfer,
} from '@synq/plugin-circle-cctp';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  amountDue,
  applyPayment,
  draftInvoice,
  issueInvoice,
  issueTypedData,
  overpaidBy,
} from '@synq/invoices';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const issuer = privateKeyToAccount(key('testnet.key'));
const client = privateKeyToAccount(key('arc-client.key'));
const sepolia = await connectChain('eth-sepolia');
const arc = await connectChain('arc-testnet');
const sepUsdc = token('eth-sepolia', 'USDC');
const arcUsdc = token('arc-testnet', 'USDC');
const due = moneyFromDecimal(arcUsdc, arg('amount', '1.00')).baseUnits;
const now = () => Math.floor(Date.now() / 1000);
const out: Record<string, unknown> = {
  environment: 'CCTP_TESTNET_ROUTE',
  route: 'eth-sepolia -> arc-testnet',
  issuer: issuer.address,
  client: client.address,
};
const journal: { at: string; event: string; data?: unknown }[] = [];
const log = (event: string, data?: unknown) => {
  journal.push({
    at: new Date().toISOString(),
    event,
    ...(data === undefined ? {} : { data }),
  });
  console.log(event, data ?? '');
};

// 0. Client wallet funding on Sepolia (the client pays its own burn and gas).
const fees = await irisFees('eth-sepolia', 'arc-testnet');
const fast = fees.find((f) => f.finalityThreshold === 1000)!;
const maxFee = maxFeeFor(due, fast.minimumFee);
const gross = due + maxFee;
const clientUsdc = await sepolia.client.readContract({
  address: sepUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [client.address],
});
if (clientUsdc < gross) {
  const f = await executeTransfer(sepolia, issuer, {
    from: issuer.address,
    to: client.address,
    amount: money(sepUsdc, gross * 2n),
  });
  log('client funded with Sepolia USDC', f.hash);
}
if (
  (await sepolia.client.getBalance({ address: client.address })) <
  parseEther('0.003')
) {
  const { createWalletClient, http } = await import('viem');
  const { sepolia: sepoliaChain } = await import('viem/chains');
  const w = createWalletClient({
    account: issuer,
    chain: sepoliaChain,
    transport: http(sepolia.profile.rpcUrls[0]),
  });
  const h = await w.sendTransaction({
    to: client.address,
    value: parseEther('0.01'),
  });
  await sepolia.client.waitForTransactionReceipt({ hash: h });
  log('client funded with Sepolia ETH for gas', h);
}

// 1. Issuer issues the Arc invoice.
const ledger = new Ledger(new MemoryLedgerStore());
const drafted = draftInvoice({
  workspaceId: 'wsp_freelancer_demo',
  number: `INV-CCTP-${String(now()).slice(-6)}`,
  issuer: {
    principalId: 'prn_freelancer',
    name: 'Synq Studio (test)',
    wallet: issuer.address,
    payoutAddress: issuer.address,
  },
  payer: { name: 'Acme (test client, pays from Sepolia)', contact: null },
  asset: arcUsdc,
  lineItems: [
    {
      description: 'Website development (CCTP test)',
      quantity: 1,
      unitPrice: due,
    },
  ],
  dueDate: '2026-10-24',
  draftedBy: 'agent:invoice',
  now: now(),
});
const issued = await issueInvoice(
  drafted,
  await issuer.signTypedData(issueTypedData(drafted)),
  now(),
);
let invoice = issued.invoice;
await ledger.post(issued.entry);
log('invoice issued', {
  number: invoice.number,
  paymentRef: invoice.paymentRef,
  due: String(due),
});

// 2. Plan + burn on Sepolia with the reference as hookData (data only).
let t: CctpTransfer = planTransfer({
  transferId: `cctp_${randomBytes(6).toString('hex')}`,
  source: 'eth-sepolia',
  destination: 'arc-testnet',
  payer: client.address,
  payerKind: 'EOA',
  recipient: issuer.address,
  amount: gross,
  maxFee,
  fast: true,
  reference: invoice.paymentRef,
  at: now(),
});
t = advance(t, 'APPROVED', now(), 'payer approved the exact plan');
const balBefore = await arc.client.readContract({
  address: arcUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [issuer.address],
});
const burn = await burnOnSource({
  chain: sepolia,
  signer: client,
  transfer: t,
  onApproveHash: (h) => log('approve hash recorded before broadcast', h),
  onBurnHash: (h) => {
    t = advance(
      t,
      'SOURCE_SUBMITTED',
      now(),
      'burn hash recorded before broadcast',
      { burnTx: h },
    );
    log('burn hash recorded before broadcast', h);
  },
});
t = advance(t, 'SOURCE_CONFIRMED', now(), 'burn receipt success');
log('burn confirmed', burn.burnTx);

// 3. Attestation: reads only.
t = advance(t, 'ATTESTATION_PENDING', now(), 'polling Iris');
let polls = 0;
let attested: { message: Hex; attestation: Hex } | null = null;
while (!attested && polls < 180) {
  polls++;
  const m = await irisMessage('eth-sepolia', burn.burnTx).catch(() => null);
  if (m?.status === 'complete' && m.message && m.attestation)
    attested = { message: m.message, attestation: m.attestation };
  else await new Promise((r) => setTimeout(r, 5_000));
}
if (!attested)
  throw new Error(
    `no attestation after ${polls} reads (burn ${burn.burnTx}); rerun recovery, do not re-burn`,
  );
const decoded = decodeMessage(attested.message);
t = advance(t, 'ATTESTED', now(), `attested after ${polls} reads`, {
  message: attested.message,
  attestation: attested.attestation,
  nonce: decoded.nonce,
});
log('attested', {
  polls,
  nonce: decoded.nonce,
  feeExecuted: String(decoded.burn.feeExecuted),
  hookData: decoded.burn.hookData,
});

// 4. Mint on Arc (issuer's operator pays Arc gas; destinationCaller is open).
const minted = await mintOnDestination({
  chain: arc,
  signer: issuer,
  transfer: t,
  message: attested.message,
  attestation: attested.attestation,
  onMintHash: (h) => {
    t = advance(
      t,
      'DEST_SUBMITTED',
      now(),
      'mint hash recorded before broadcast',
      { mintTx: h },
    );
    log('mint hash recorded before broadcast', h);
  },
});
const mintTx = minted.mintTx!;
const rec = await reconcileMint(arc, t, attested.message, mintTx);
t = advance(t, 'DEST_FINAL', now(), 'mint receipt reconciled', {
  minted: rec.minted,
  feeExecuted: rec.feeExecuted,
});
const balAfter = await arc.client.readContract({
  address: arcUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [issuer.address],
});

// 5. Invoice settlement from the destination mint only.
const payment = {
  chainId: arcUsdc.chainId,
  txHash: mintTx,
  logIndex: rec.logIndex,
  paymentRef: decoded.burn.hookData as Hex,
  payer: decoded.burn.messageSender,
  recipient: decoded.burn.mintRecipient,
  amount: rec.minted,
};
const applied = applyPayment(invoice, payment, now());
invoice = applied.invoice;
await ledger.post(applied.entry!);
t = advance(t, 'MATCHED', now(), `settled ${invoice.number}`);
t = advance(t, 'RECONCILED', now(), 'ledger posted');

// 6. Duplicates: a second mint finds the nonce used; replaying the event applies nothing.
const again = await mintOnDestination({
  chain: arc,
  signer: issuer,
  transfer: t,
  message: attested.message,
  attestation: attested.attestation,
  onMintHash: () => {
    throw new Error('must not mint twice');
  },
});
const replay = applyPayment(invoice, payment, now());

out.transfer = {
  burnTx: burn.burnTx,
  burnExplorer: `${sepolia.profile.explorer}/tx/${burn.burnTx}`,
  approveTx: burn.approveTx,
  attestationReads: polls,
  nonce: decoded.nonce,
  gross: String(gross),
  maxFee: String(maxFee),
  feeExecuted: String(rec.feeExecuted),
  mintTx,
  mintExplorer: rec.explorer,
  minted: String(rec.minted),
  issuerArcDelta: String(balAfter - balBefore - 0n),
  state: t.state,
  history: t.history,
};
out.invoice = {
  number: invoice.number,
  status: invoice.status,
  amountDue: String(amountDue(invoice)),
  overpaid: String(overpaidBy(invoice)),
};
out.duplicates = {
  secondMintAlreadyUsed: again.alreadyUsed,
  replayApplied: replay.applied,
};
out.ledger = Object.fromEntries(
  Object.entries(await ledger.balances('wsp_freelancer_demo', arcUsdc.assetId))
    .filter(([, v]) => v !== 0n)
    .map(([k, v]) => [k, moneyToDecimal(money(arcUsdc, v))]),
);
out.journal = journal;
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `cctp-${burn.burnTx.slice(0, 10)}.json`);
writeFileSync(
  file,
  JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? String(v) : v), 2) +
    '\n',
);
console.log(
  JSON.stringify(
    {
      transfer: out.transfer,
      invoice: out.invoice,
      duplicates: out.duplicates,
      ledger: out.ledger,
    },
    (_k, v) => (typeof v === 'bigint' ? String(v) : v),
    2,
  ),
);
console.log(`evidence -> ${file}`);
