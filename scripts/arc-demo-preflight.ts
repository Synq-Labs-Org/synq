/** Read-only health/balance/window check; never signs, broadcasts or changes policy. */
import { parseAbi } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  balanceOf,
  connectChain,
  verifyContract,
} from '@synq/execution-worker/arc';
import { controlledTesterWallets } from './lib/tester-wallets.js';
const chain = await connectChain('arc-testnet');
await verifyContract(chain, 'SYNQ_ARC_VAULT_POLICY');
const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY').address;
const abi = parseAbi([
  'function windowStart() view returns (uint256)',
  'function windowSpent() view returns (uint256)',
  'function windowCap() view returns (uint256)',
  'function perPaymentCap() view returns (uint256)',
]);
const [head, start, spent, cap, perPaymentCap] = await Promise.all([
  chain.client.getBlock({ blockTag: 'latest' }),
  chain.client.readContract({
    address: policy,
    abi,
    functionName: 'windowStart',
  }),
  chain.client.readContract({
    address: policy,
    abi,
    functionName: 'windowSpent',
  }),
  chain.client.readContract({
    address: policy,
    abi,
    functionName: 'windowCap',
  }),
  chain.client.readContract({
    address: policy,
    abi,
    functionName: 'perPaymentCap',
  }),
]);
const end = start + 86400n,
  activeSpent = head.timestamp >= end ? 0n : spent;
const balances = await Promise.all(
  controlledTesterWallets().map(async (address) => ({
    address,
    usdcBaseUnits: String(
      (
        await balanceOf(
          chain,
          token('arc-testnet', 'USDC'),
          address as `0x${string}`,
        )
      ).baseUnits,
    ),
  })),
);
console.log(
  JSON.stringify(
    {
      label: 'READ_ONLY_ARC_TESTNET',
      chainId: chain.profile.chainId,
      block: String(head.number),
      blockTime: new Date(Number(head.timestamp) * 1000).toISOString(),
      window: {
        start: String(start),
        endsAt: new Date(Number(end) * 1000).toISOString(),
        spentBaseUnits: String(activeSpent),
        remainingBaseUnits: String(cap - activeSpent),
        perPaymentCapBaseUnits: String(perPaymentCap),
      },
      balances,
      configuration: {
        checkoutKeyPresent: Boolean(process.env.SYNQ_PAY_LINK_KEY),
        databasePresent: Boolean(
          process.env.SYNQ_DATABASE_URL ??
          process.env.SYNQ_FINANCE_DATABASE_URL,
        ),
        modelKeyPresent: Boolean(process.env.OPENAI_API_KEY),
      },
      action: 'NO_TRANSACTION',
    },
    null,
    2,
  ),
);
