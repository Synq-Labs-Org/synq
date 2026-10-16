import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex } from 'viem';
import { contract } from '@synq/chain-registry/arc';

/** Address-only inventory. Keys never leave this script boundary. */
export function controlledTesterWallets() {
  const required = [
    'testnet.key',
    'arc-agent.key',
    'arc-client.key',
    'arc-contractor.key',
  ];
  const optional = ['paymaster-test.key', 'group-pool.key', 'trip-pool.key'];
  const addresses = [...required, ...optional].flatMap((file) => {
    const path = join(process.env.HOME!, '.synq', file);
    if (!existsSync(path)) {
      if (required.includes(file))
        throw new Error(`controlled wallet inventory missing ${file}`);
      return [];
    }
    const text = readFileSync(path, 'utf8').trim();
    return [
      privateKeyToAccount((text.startsWith('0x') ? text : `0x${text}`) as Hex)
        .address,
    ];
  });
  addresses.push(contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address);
  return [...new Set(addresses.map((a) => a.toLowerCase()))];
}
