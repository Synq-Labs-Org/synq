/** Read-only chain tally. No wallet transaction or provider write. */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { contract, token } from '@synq/chain-registry/arc';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import { scanMemoPayments, type MemoPayment } from '@synq/invoices';
import {
  TesterManifestSchema,
  tallyTesterPayments,
} from './lib/tester-traction.js';
import { controlledTesterWallets } from './lib/tester-wallets.js';
const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const manifest = TesterManifestSchema.parse(
  JSON.parse(
    readFileSync(arg('--manifest') ?? 'reports/testers/manifest.json', 'utf8'),
  ),
);
const chain = await connectChain('arc-testnet');
await verifyContract(chain, 'MEMO');
const usdc = token('arc-testnet', 'USDC'),
  memoContract = contract('arc-testnet', 'MEMO').address;
if (
  manifest.token.toLowerCase() !== usdc.address.toLowerCase() ||
  manifest.memoContract.toLowerCase() !== memoContract.toLowerCase()
)
  throw new Error('manifest must bind registry USDC and Memo');
const head = await chain.client.getBlockNumber({ cacheTime: 0 });
const payments: MemoPayment[] = [];
if (manifest.invoices.length) {
  const start = manifest.invoices.reduce(
    (n, i) => (BigInt(i.fromBlock) < n ? BigInt(i.fromBlock) : n),
    head + 1n,
  );
  if (start > head)
    throw new Error(
      'RPC head predates the issued tester invoice; retry a current RPC',
    );
  for (let from = start; from <= head; from += 2000n) {
    const to = from + 1999n < head ? from + 1999n : head;
    const found = await scanMemoPayments({
      client: chain.client,
      chainId: usdc.chainId,
      token: usdc.address,
      memoContract,
      fromBlock: from,
      toBlock: to,
    });
    payments.push(...found.payments);
  }
}
const result = tallyTesterPayments(
  manifest,
  payments,
  controlledTesterWallets(),
);
const report = arg('--out') ?? 'reports/TRACTION.md';
mkdirSync(dirname(report), { recursive: true });
const snapshot = {
  generatedAt: new Date().toISOString(),
  label: 'READ_ONLY_ARC_TESTNET',
  verifiedToBlock: String(head),
  ...result,
  independentHumanUsers: 'NOT_ESTABLISHED_BY_WALLET_COUNT',
  consentedFeedback:
    'REVIEW_SEPARATELY; no personal details collected by this script',
};
writeFileSync(
  report.replace(/\.md$/, '') + '.json',
  JSON.stringify(snapshot, null, 2) + '\n',
  { mode: 0o600 },
);
const lines = [
  '# External tester activity',
  '',
  `Read-only Arc testnet tally through block ${head}. No fixture or controlled-role payment is counted. A wallet is not proof of a distinct person, business or consent.`,
  '',
  `- Distinct external payer wallets: ${result.distinctExternalPayerWallets}`,
  `- External payment transactions: ${result.externalPaymentTransactions}`,
  `- External gross received: ${result.grossExternalBaseUnits} USDC base units (6 decimals)`,
  `- Invoice amount received, capped at each invoice total: ${result.invoiceVolumeBaseUnits} base units`,
  `- Controlled-role payment events excluded: ${result.controlledPaymentsExcluded}`,
  '',
  '| Tester ID | Invoice | Payer wallet | Receipt | Base units |',
  '|---|---|---|---|---|',
  ...result.external.map(
    (p) =>
      `| ${p.testerId} | ${p.invoiceId} | ${p.payer} | [${p.hash}](https://explorer.testnet.arc.io/tx/${p.hash}) | ${p.amountBaseUnits} |`,
  ),
  '',
  'Counts derive from matching Memo/USDC receipt events for issued tester references, deduplicated by chain/tx/log. Overpayment is not extra invoice revenue. This does not establish organic customers or production use. Consented feedback must be recorded separately.',
];
writeFileSync(report, lines.join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify(snapshot, null, 2));
