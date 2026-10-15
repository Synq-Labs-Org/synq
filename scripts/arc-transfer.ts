/**
 * Real Arc testnet USDC transfer with before/after reconciliation.
 *
 *   node --import tsx scripts/arc-transfer.ts --to 0x… --amount 0.01 [--chain arc-testnet]
 *
 * Signs with SYNQ_TESTNET_KEY_FILE (a testnet-only key). Prints and writes
 * evidence (no secrets) to bounty-evidence/arc/. Refuses mainnet by registry.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  addMoney,
  moneyFromDecimal,
  moneyToDecimal,
  subMoney,
} from '@synq/domain';
import {
  arcNativeToUsdc,
  token,
  type ChainName,
} from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  executeTransfer,
} from '@synq/execution-worker/arc';

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) throw new Error(`--${name} required`);
  return v;
}

const chainName = arg('chain', 'arc-testnet') as ChainName;
const to = getAddress(arg('to'));
const keyFile =
  process.env.SYNQ_TESTNET_KEY_FILE ?? `${process.env.HOME}/.synq/testnet.key`;
const key = readFileSync(keyFile, 'utf8').trim();
const signer = privateKeyToAccount(
  (key.startsWith('0x') ? key : `0x${key}`) as Hex,
);
const chain = await connectChain(chainName);
const usdc = token(chainName, 'USDC');
const amount = moneyFromDecimal(usdc, arg('amount'));

const before = {
  payer: await balanceOf(chain, usdc, signer.address),
  payee: await balanceOf(chain, usdc, to),
  payerNativeWei: await chain.client.getBalance({ address: signer.address }),
};
let broadcastAt = '';
const evidence = await executeTransfer(
  chain,
  signer,
  { from: signer.address, to, amount },
  (hash) => {
    broadcastAt = new Date().toISOString();
    console.log(`broadcasting ${hash}`);
  },
);
const after = {
  payer: await balanceOf(chain, usdc, signer.address),
  payee: await balanceOf(chain, usdc, to),
  payerNativeWei: await chain.client.getBalance({ address: signer.address }),
};

// Ledger match: payee +amount exactly; payer −(amount + fee) in the shared Arc balance.
const payeeDelta = subMoney(after.payee, before.payee);
const payerDelta = subMoney(before.payer, after.payer);
const arc = chain.profile.nativeSymbol === 'USDC';
const nativeDelta = before.payerNativeWei - after.payerNativeWei;
const expectedNativeDelta = arc
  ? amount.baseUnits * 10n ** 12n + evidence.feeWei
  : evidence.feeWei;
const checks = {
  payeeCreditedExactly: payeeDelta.baseUnits === amount.baseUnits,
  payerNativeDebitEqualsValuePlusFee: nativeDelta === expectedNativeDelta,
  // The 6-decimal view truncates sub-micro-USDC dust, so it may differ by one unit.
  payerTokenDebitEqualsValuePlusFeeUnits: arc
    ? (() => {
        const expected = addMoney(
          amount,
          arcNativeToUsdc(chainName as 'arc-testnet', evidence.feeWei).usdc,
        ).baseUnits;
        const diff = payerDelta.baseUnits - expected;
        return diff >= 0n && diff <= 1n;
      })()
    : payerDelta.baseUnits === amount.baseUnits,
};
const record = {
  kind: 'ARC_USDC_DIRECT',
  environment: chain.profile.environment,
  chain: chainName,
  chainId: chain.profile.chainId,
  token: usdc.address,
  decimals: usdc.decimals,
  from: signer.address,
  to,
  amount: moneyToDecimal(amount),
  amountBaseUnits: String(amount.baseUnits),
  hash: evidence.hash,
  blockNumber: String(evidence.blockNumber),
  blockHash: evidence.blockHash,
  gasUsed: String(evidence.gasUsed),
  effectiveGasPrice: String(evidence.effectiveGasPrice),
  feeWei: String(evidence.feeWei),
  feeUsdc: evidence.feeUsdc ? moneyToDecimal(evidence.feeUsdc) : null,
  explorer: evidence.explorer,
  broadcastAt,
  before: {
    payer: moneyToDecimal(before.payer),
    payee: moneyToDecimal(before.payee),
    payerNativeWei: String(before.payerNativeWei),
  },
  after: {
    payer: moneyToDecimal(after.payer),
    payee: moneyToDecimal(after.payee),
    payerNativeWei: String(after.payerNativeWei),
  },
  checks,
};
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(
  dir,
  `transfer-${chainName}-${evidence.hash.slice(0, 10)}.json`,
);
writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify(record, null, 2));
console.log(`evidence -> ${file}`);
if (!checks.payeeCreditedExactly || !checks.payerNativeDebitEqualsValuePlusFee)
  process.exitCode = 1;
