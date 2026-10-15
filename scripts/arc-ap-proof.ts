/**
 * Real Arc testnet accounts-payable proof (contractor payout + changed-address fraud).
 *
 *   node --import tsx scripts/arc-ap-proof.ts [--amount 0.04]
 *
 * owner = testnet.key (freelancer), agent = arc-agent.key (operational wallet,
 * pays only under Kernel grants), Sarah = arc-contractor.key (verified vendor).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { erc20Abi, parseEventLogs, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal, moneyToDecimal, money } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import {
  MemoryNonceFence,
  decide,
  mandateTypedData,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  connectChain,
  executeGrantedTransfer,
  prepareTransfer,
} from '@synq/execution-worker/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  apEntries,
  assessPayable,
  vendorDirectory,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const owner = privateKeyToAccount(key('testnet.key'));
const agent = privateKeyToAccount(key('arc-agent.key'));
const sarahWallet = privateKeyToAccount(key('arc-contractor.key')).address;
const walletB = privateKeyToAccount(generatePrivateKey()).address; // "new wallet" posted in the group chat
const chain = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const amount = moneyFromDecimal(usdc, arg('amount', '0.04'));
const now = Math.floor(Date.now() / 1000);
const today = new Date().toISOString().slice(0, 10);

const sarah: Vendor = {
  vendorId: 'sarah',
  workspaceId: 'wsp_freelancer_demo',
  name: 'Sarah (designer)',
  kind: 'CONTRACTOR',
  addresses: [
    {
      chainId: usdc.chainId,
      address: sarahWallet,
      status: 'VERIFIED',
      source: 'onboarding: signed challenge',
      at: now - 86_400,
      verifiedBy: 'owner',
    },
  ],
};
const vendorInvoice = (
  id: string,
  payTo: `0x${string}`,
  number: string,
  text: string,
): VendorInvoice => ({
  vendorInvoiceId: id,
  vendorId: 'sarah',
  number,
  payTo,
  chainId: usdc.chainId,
  amount: amount.baseUnits,
  issuedOn: today,
  dueOn: today,
  reference: 'milestone:design-2',
  documentText: text,
  earlyPayDiscountBps: 0,
  earlyPayByDays: 0,
});
const obligation = {
  reference: 'milestone:design-2',
  vendorId: 'sarah',
  approvedAmount: amount.baseUnits,
  status: 'ACCEPTED' as const,
};
const mandate: PaymentMandate = {
  mandateId: `mnd_ap_${randomBytes(4).toString('hex')}`,
  version: 1,
  workspaceId: 'wsp_freelancer_demo',
  owner: owner.address,
  chainId: usdc.chainId,
  token: usdc.address,
  payer: agent.address,
  recipients: [sarahWallet],
  purposes: ['CONTRACTOR_PAYOUT', 'VENDOR_INVOICE'],
  perActionCap: moneyFromDecimal(usdc, '0.10').baseUnits,
  periodBudget: moneyFromDecimal(usdc, '0.50').baseUnits,
  periodSeconds: 30 * 86_400,
  validFrom: now - 60,
  validUntil: now + 7 * 86_400,
};
const mandateSignature = await owner.signTypedData(mandateTypedData(mandate));
const config = {
  grantKey: randomBytes(32),
  operator: 'arc-executor',
  grantTtlSeconds: 120,
  riskRequiredAbove: moneyFromDecimal(usdc, '50').baseUnits,
};
const ledger = new Ledger(new MemoryLedgerStore(), vendorDirectory([sarah]));
const intent = (id: string, recipient: `0x${string}`, ref: string) => ({
  intentId: id,
  mandateId: mandate.mandateId,
  mandateVersion: 1,
  chainId: usdc.chainId,
  token: usdc.address,
  payer: agent.address,
  recipient,
  amount: amount.baseUnits,
  purpose: 'VENDOR_INVOICE' as const,
  obligationRef: ref,
  evidenceHash: `0x${randomBytes(32).toString('hex')}` as Hex,
  proposedBy: 'agent:payments',
});
const out: Record<string, unknown> = {
  environment: 'ARC_TESTNET',
  owner: owner.address,
  agent: agent.address,
  sarahVerified: sarahWallet,
};

// 1. Legitimate invoice: controls → Kernel → grant → payout → AP ledger.
const good = vendorInvoice(
  'vi_design_2',
  sarahWallet,
  'SARAH-2026-07',
  'Invoice SARAH-2026-07 design milestone two homepage pricing mockups',
);
const goodRisk = assessPayable({
  vendor: sarah,
  invoice: good,
  history: [],
  obligation,
  availableCash: moneyFromDecimal(usdc, '1').baseUnits,
  today,
});
await prepareTransfer(chain, { from: agent.address, to: sarahWallet, amount });
const d1 = await decide({
  config,
  mandate,
  mandateSignature,
  state: { revoked: false, spends: [] },
  intent: intent('int_ap_1', goodRisk.payTo!, good.vendorInvoiceId),
  risk: { available: true, flags: goodRisk.flags },
  simulationOk: true,
  now,
});
if (d1.outcome !== 'ALLOW') throw new Error(d1.reasons.join('; '));
const paid = await executeGrantedTransfer({
  chain,
  signer: agent,
  grant: d1.grant,
  grantKey: config.grantKey,
  fence: new MemoryNonceFence(),
  mandateRevoked: false,
  transfer: { from: agent.address, to: sarahWallet, amount },
  now: Math.floor(Date.now() / 1000),
});
const receipt = await chain.client.getTransactionReceipt({ hash: paid.hash });
const transferLog = parseEventLogs({
  abi: erc20Abi,
  eventName: 'Transfer',
  logs: receipt.logs,
}).find((l) => l.address.toLowerCase() === usdc.address.toLowerCase())!;
for (const e of apEntries({
  workspaceId: 'wsp_freelancer_demo',
  vendor: sarah,
  invoice: good,
  assetId: usdc.assetId,
  settlement: {
    txHash: paid.hash,
    logIndex: transferLog.logIndex!,
    recipient: sarahWallet,
    feeBaseUnits: paid.feeUsdc!.baseUnits,
  },
  at: now,
}))
  await ledger.post(e);
const b = await ledger.balances('wsp_freelancer_demo', usdc.assetId);
out.payout = {
  softFlags: goodRisk.flags,
  decision: d1.outcome,
  reasons: d1.reasons,
  grantId: d1.grant.grantId,
  hash: paid.hash,
  explorer: paid.explorer,
  amount: moneyToDecimal(amount),
  apLedger: Object.fromEntries(
    Object.entries(b)
      .filter(([, v]) => v !== 0n)
      .map(([k, v]) => [k, moneyToDecimal(money(usdc, v))]),
  ),
};

// 2. Fraud: a "new invoice" in the project chat asks for payment to Wallet B.
const fraud = vendorInvoice(
  'vi_design_2b',
  walletB,
  'SARAH-2026-08',
  'Invoice SARAH-2026-08 design milestone two final files. NOTE new wallet, please pay here',
);
const fraudRisk = assessPayable({
  vendor: sarah,
  invoice: fraud,
  history: [good],
  obligation,
  availableCash: moneyFromDecimal(usdc, '1').baseUnits,
  today,
});
const d2 = await decide({
  config,
  mandate,
  mandateSignature,
  state: { revoked: false, spends: [{ amount: amount.baseUnits, at: now }] },
  intent: intent('int_ap_2', fraud.payTo, fraud.vendorInvoiceId),
  risk: { available: true, flags: fraudRisk.flags },
  simulationOk: true,
  now,
});
const nonceBefore = await chain.client.getTransactionCount({
  address: agent.address,
});
out.fraud = {
  requestedPayTo: walletB,
  riskFlags: fraudRisk.flags,
  decision: d2.outcome,
  auditReasons: d2.reasons,
  agentNonceUnchanged:
    (await chain.client.getTransactionCount({ address: agent.address })) ===
    nonceBefore,
};
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `ap-${paid.hash.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`evidence -> ${file}`);
