/**
 * USYC entitlement gate on Arc testnet, read-only.
 *
 *   node --import tsx scripts/usyc-entitlement-proof.ts
 *
 * For the owner and agent wallets: checks the Teller/Entitlements code hashes
 * and binding, reads `canCall(wallet, Teller, deposit/redeem)`, and shows the
 * planner refusing with INELIGIBLE. A static `eth_call` of `Teller.deposit`
 * (no transaction, no state change) records how the chain itself answers.
 * Output: bounty-evidence/arc/usyc-entitlement-proof.json
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeFunctionData, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import {
  TELLER_ABI,
  UsycError,
  checkUsycEntitlement,
  planUsycSubscription,
  type UsycReader,
} from '@synq/plugin-usyc';

const address = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex)
    .address;
};
const j = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );

const arc = await connectChain('arc-testnet');
const reader = arc.client as unknown as UsycReader;
const wallets = {
  owner: address('testnet.key'),
  agent: address('arc-agent.key'),
};
const teller = contract('arc-testnet', 'USYC_TELLER').address;
const out: Record<string, unknown> = {
  label: 'LIVE_ARC_TESTNET',
  mode: 'READ_ONLY (no transactions sent)',
  teller,
  entitlements: contract('arc-testnet', 'USYC_ENTITLEMENTS').address,
  usyc: token('arc-testnet', 'USYC').address,
  checkedAt: new Date().toISOString(),
  wallets: {} as Record<string, unknown>,
};
for (const [role, wallet] of Object.entries(wallets)) {
  const now = Date.now();
  const deposit = await checkUsycEntitlement(reader, wallet, 'deposit', now);
  const redeem = await checkUsycEntitlement(reader, wallet, 'redeem', now);
  let plan: unknown;
  try {
    plan = planUsycSubscription({
      entitlement: deposit,
      wallet,
      amount: moneyFromDecimal(token('arc-testnet', 'USDC'), '0.01'),
      now: Date.now(),
    });
  } catch (e) {
    plan = { refused: (e as UsycError).code, message: (e as Error).message };
  }
  // What the chain says if this wallet tried anyway (static call only).
  let staticCall: unknown;
  try {
    await arc.client.call({
      account: wallet,
      to: teller,
      data: encodeFunctionData({
        abi: TELLER_ABI,
        functionName: 'deposit',
        args: [10_000n, wallet],
      }),
    });
    staticCall = { reverted: false };
  } catch (e) {
    staticCall = {
      reverted: true,
      reason: String((e as { shortMessage?: string }).shortMessage ?? e).slice(
        0,
        300,
      ),
    };
  }
  const maxDeposit = await arc.client.readContract({
    address: teller,
    abi: TELLER_ABI,
    functionName: 'maxDeposit',
    args: [wallet],
  });
  (out.wallets as Record<string, unknown>)[role] = {
    wallet,
    deposit,
    redeem,
    plannerResult: plan,
    staticTellerDeposit: staticCall,
    tellerMaxDepositNotAnEntitlement: maxDeposit,
  };
  console.log(role, wallet, deposit.status, j(plan));
}
const dir = join(process.cwd(), '..', 'synq-v13', 'bounty-evidence', 'arc');
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, 'usyc-entitlement-proof.json'),
  JSON.stringify(j(out), null, 2),
);
