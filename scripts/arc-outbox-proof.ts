/**
 * Live crash-after-broadcast proof on Arc testnet.
 *
 *   node --import tsx scripts/arc-outbox-proof.ts --key <id> --crash   # dies right after broadcast
 *   node --import tsx scripts/arc-outbox-proof.ts --key <id>           # restart: must reconcile, not re-pay
 *
 * Payer = testnet.key, payee = arc-client.key's address, amount 0.001 USDC.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import { connectChain } from '@synq/execution-worker/arc';
import { FileOutboxStore, payOnce } from '@synq/execution-worker/arc-outbox';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : null;
const crash = process.argv.includes('--crash');
const idem = arg('key') ?? 'outbox-proof';
const payer = privateKeyToAccount(key('testnet.key'));
const payee = privateKeyToAccount(key('arc-client.key')).address;
const chain = await connectChain('arc-testnet');
const dir = join(process.cwd(), 'bounty-evidence', 'arc', 'outbox');
mkdirSync(dir, { recursive: true });
const store = new FileOutboxStore(dir);
const journal = join(dir, `${idem}.log`);
const note = (m: string) => {
  appendFileSync(
    journal,
    `${new Date().toISOString()} pid=${process.pid} ${m}\n`,
  );
  console.log(m);
};
const nonceBefore = await chain.client.getTransactionCount({
  address: payer.address,
});
if (crash) {
  const send = chain.client.sendRawTransaction.bind(chain.client);
  chain.client.sendRawTransaction = (async (a: {
    serializedTransaction: Hex;
  }) => {
    const h = await send(a);
    note(`broadcast ${h}; simulating worker death before receipt`);
    process.exit(137);
  }) as typeof chain.client.sendRawTransaction;
}
const signer = {
  address: payer.address,
  signTransaction: async (tx: Parameters<typeof payer.signTransaction>[0]) => {
    note(`SIGNING nonce=${tx.nonce}`);
    return payer.signTransaction(tx);
  },
};
note(`start key=${idem} crash=${crash} payerNonce=${nonceBefore}`);
const r = await payOnce({
  store,
  key: idem,
  chain,
  signer,
  transfer: {
    from: payer.address,
    to: payee,
    amount: moneyFromDecimal(token('arc-testnet', 'USDC'), '0.001'),
  },
  now: () => Math.floor(Date.now() / 1000),
});
const nonceAfter = await chain.client.getTransactionCount({
  address: payer.address,
});
note(
  `done state=${r.record.state} signedNow=${r.signedNow} hash=${r.record.hash} block=${r.record.evidence?.blockNumber} payerNonce=${nonceBefore}->${nonceAfter} ${r.record.evidence?.explorer ?? ''}`,
);
