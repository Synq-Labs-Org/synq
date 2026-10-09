import type { Hex } from 'viem';
import type { SynqPlugin } from '@synq/plugin-sdk';
import type { LocalSynq } from './safe.js';
import { erc20TransferPlugin } from './transfer-plugin.js';

export function localTransferPlugin(
  client: LocalSynq['client'],
  calldataFor: (hash: Hex) => Hex | undefined,
): SynqPlugin {
  return erc20TransferPlugin({
    id: 'local-transfer',
    chainId: 31337,
    environment: 'local/anvil',
    client,
    calldataFor,
  });
}
