/**
 * Real Circle Gateway proof: Sepolia prefund + unified-balance spend into Arc.
 *
 *   node --import tsx scripts/arc-gateway-proof.ts [--deposit 1] [--spend 0.5]
 *
 * Signer = testnet.key (EOA depositor and burn-intent signer; recipient on Arc
 * is the same treasury wallet: moving liquidity onto Arc).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { erc20Abi, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import { depositToGateway, gatewayMint } from '@synq/execution-worker/gateway';
import {
  GatewayAccount,
  assertSigner,
  burnIntent,
  burnIntentTypedData,
  gatewayBalances,
  requestTransfer,
} from '@synq/plugin-circle-gateway';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const owner = privateKeyToAccount(key('testnet.key'));
const sepolia = await connectChain('eth-sepolia');
const arc = await connectChain('arc-testnet');
const sepUsdc = token('eth-sepolia', 'USDC');
const arcUsdc = token('arc-testnet', 'USDC');
const deposit = moneyFromDecimal(sepUsdc, arg('deposit', '1')).baseUnits;
const spend = moneyFromDecimal(arcUsdc, arg('spend', '0.5')).baseUnits;
const maxFee = 2_010_000n; // docs' direct-mint cap from an Ethereum source
const out: Record<string, unknown> = {
  environment: 'GATEWAY_TESTNET',
  route: 'eth-sepolia -> arc-testnet',
  signer: owner.address,
  signerKind: 'EOA',
};
assertSigner('EOA');

const balanceOn = async () =>
  (
    await gatewayBalances([{ chain: 'eth-sepolia', depositor: owner.address }])
  )[0]!.available;
const sourceFree = await sepolia.client.readContract({
  address: sepUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [owner.address],
});
const available0 = await balanceOn();
// Pre-existing confirmed Gateway balance (earlier deposits) enters as available.
const acct = new GatewayAccount(sourceFree + available0);
acct.deposit(available0);
acct.observeAvailable(available0);
out.before = {
  sepoliaWalletUsdc: String(sourceFree),
  gatewayAvailable: String(available0),
};

// 1. Prefund: the deposit leaves free source funds at once but is not yet available.
const dep = await depositToGateway({
  chain: sepolia,
  signer: owner,
  amount: deposit,
  onHash: (s, h) => console.log(`${s} hash recorded before broadcast`, h),
});
acct.deposit(deposit);
const availableAfterDeposit = await balanceOn();
acct.observeAvailable(availableAfterDeposit); // moves nothing until Gateway credits the deposit
out.deposit = {
  approveTx: dep.approveTx,
  depositTx: dep.depositTx,
  explorer: `${sepolia.profile.explorer}/tx/${dep.depositTx}`,
  gatewayAvailableRightAfter: String(availableAfterDeposit),
  countedAsAvailableYet: availableAfterDeposit > available0,
  ledger: {
    sourceFree: String(acct.sourceFree),
    pending: String(acct.pending),
    available: String(acct.available),
  },
};

// 2. Spend from the confirmed unified balance into Arc.
const salt = `0x${randomBytes(32).toString('hex')}` as Hex;
const intent = burnIntent({
  source: 'eth-sepolia',
  destination: 'arc-testnet',
  depositor: owner.address,
  signer: owner.address,
  recipient: owner.address,
  value: spend,
  maxFee,
  salt,
});
acct.reserve(salt, spend);
const signature = await owner.signTypedData(burnIntentTypedData(intent));
const att = await requestTransfer([{ burnIntent: intent, signature }]);
const arcBefore = await arc.client.readContract({
  address: arcUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [owner.address],
});
const minted = await gatewayMint({
  chain: arc,
  signer: owner,
  attestation: att.attestation,
  signature: att.signature,
  recipient: owner.address,
  expected: spend,
  onHash: (h) => console.log('mint hash recorded before broadcast', h),
});
acct.settle(spend);
const arcAfter = await arc.client.readContract({
  address: arcUsdc.address,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [owner.address],
});
const availableAfterSpend = await balanceOn();
out.spend = {
  salt,
  value: String(spend),
  maxFee: String(maxFee),
  burnIntentSigned: true,
  mintTx: minted.mintTx,
  explorer: minted.explorer,
  arcRecipientDeltaNetOfGas: String(arcAfter - arcBefore),
  gatewayAvailableBefore: String(availableAfterDeposit),
  gatewayAvailableAfter: String(availableAfterSpend),
  gatewayDebit: String(availableAfterDeposit - availableAfterSpend),
};

// 3. Replay the same signed intent: must not mint twice.
try {
  const again = await requestTransfer([{ burnIntent: intent, signature }]);
  try {
    await gatewayMint({
      chain: arc,
      signer: owner,
      attestation: again.attestation,
      signature: again.signature,
      recipient: owner.address,
      expected: spend,
      onHash: () => undefined,
    });
    out.duplicate = 'MINTED TWICE (unexpected)';
  } catch (e) {
    out.duplicate = {
      apiReturnedAttestation: true,
      mintRefused: String((e as Error).message).slice(0, 160),
    };
  }
} catch (e) {
  out.duplicate = { apiRefused: String((e as Error).message).slice(0, 200) };
}
try {
  acct.reserve(salt, spend);
} catch (e) {
  out.duplicateLocal = (e as { code?: string }).code;
}
const dir = join(process.cwd(), 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
const file = join(dir, `gateway-${minted.mintTx.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
console.log(`evidence -> ${file}`);
