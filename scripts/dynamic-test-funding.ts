import { appendFileSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { chainProfile, token } from '@synq/chain-registry/arc';

/**
 * Tops up one software test wallet of a live run from the testnet deployer
 * (test funding only, never a Synq payment). Bounded to 0.05 USDC and skipped
 * when the wallet already holds the requested amount.
 */
if (process.env.SYNQ_ALLOW_MAINNET_BROADCAST === 'true')
  throw new Error('MAINNET_FORBIDDEN');
const runId = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/)
  .parse(process.env.SYNQ_DYNAMIC_RUN_ID);
const label = z
  .string()
  .regex(/^[a-z]{1,20}$/)
  .parse(process.argv[2]);
const units = z.coerce.bigint().min(1n).max(50000n).parse(process.argv[3]);
const key = (path: string) => {
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0)
    throw new Error('KEY_FILE_PERMISSIONS');
  const t = readFileSync(path, 'utf8').trim();
  return privateKeyToAccount((t.startsWith('0x') ? t : `0x${t}`) as Hex);
};
const dir = join(homedir(), '.synq');
const to = key(join(dir, `e2e-user-${runId}-${label}.key`)).address,
  from = key(join(dir, 'testnet.key'));
const profile = chainProfile('arc-testnet');
const arc = defineChain({
  id: profile.chainId,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [profile.rpcUrls[0]!] } },
});
const pub = createPublicClient({ chain: arc, transport: http() });
if ((await pub.getChainId()) !== profile.chainId)
  throw new Error('WRONG_CHAIN');
const usdc = token('arc-testnet', 'USDC').address;
const have = await pub.readContract({
  address: usdc,
  abi: erc20Abi,
  functionName: 'balanceOf',
  args: [to],
});
if (have >= units) {
  process.stdout.write(`${label} already holds ${have}\n`);
} else {
  const hash = await createWalletClient({
    chain: arc,
    account: from,
    transport: http(),
  }).writeContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, units],
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== 'success') throw new Error('FUNDING_REVERTED');
  appendFileSync(
    join('bounty-evidence', 'arc', `dynamic-test-funding-${runId}.jsonl`),
    JSON.stringify({
      label,
      to,
      units: String(units),
      hash,
      note: 'test wallet funding from the testnet deployer, not a Synq payment',
    }) + '\n',
  );
  process.stdout.write(`funded ${label} ${units} ${hash}\n`);
}
