import { getAddress } from 'viem';
import { officialAssets } from '@synq/chain-registry';
import {
  type ChainEvent,
  type GroupBinding,
} from '../../packages/read-model/src/index.js';
export const address = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, '0')}`;
export const treasuryToken = getAddress(officialAssets.testnetAUSD.address);
export const binding: GroupBinding = {
  groupId: hash(1),
  account: address(10),
  registry: address(11),
  module: address(12),
  members: [1, 2, 3].map((i) => ({
    memberId: `member_${i}`,
    signer: address(i),
  })),
};
export const chainId = 10143;
export function event(
  eventName: ChainEvent['eventName'],
  blockNumber: number,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): ChainEvent {
  return {
    schemaVersion: 1,
    chainId,
    blockNumber,
    blockHash: hash(blockNumber + 100),
    transactionHash: hash(blockNumber + 200),
    transactionIndex: 0,
    logIndex: 0,
    contract:
      eventName === 'Transfer'
        ? treasuryToken
        : eventName === 'MandateConfigured' || eventName === 'MandateRevoked'
          ? binding.registry
          : binding.module,
    eventName,
    payload,
    ...overrides,
  } as ChainEvent;
}
export function proof(): ChainEvent[] {
  return [
    event('Transfer', 1, {
      from: address(0),
      to: binding.account,
      value: '1000000',
    }),
    event('MandateConfigured', 2, {
      groupId: binding.groupId,
      account: binding.account,
      mandateId: hash(2),
      version: '1',
      target: treasuryToken,
      selector: '0xa9059cbb',
      inputToken: treasuryToken,
      maxPerCall: '200000',
      cumulativeCap: '500000',
      maxValue: '0',
      validUntil: '2000',
    }),
    event('Transfer', 3, {
      from: binding.account,
      to: address(20),
      value: '100000',
    }),
    event(
      'GrantExecuted',
      3,
      {
        groupId: binding.groupId,
        account: binding.account,
        intentHash: hash(3),
        mandateId: hash(2),
        mandateVersion: '1',
        executor: address(30),
        pluginId: hash(4),
        chainId: String(chainId),
        nonce: '1',
        grantHash: hash(5),
        target: treasuryToken,
        selector: '0xa9059cbb',
        calldataHash: hash(6),
        inputToken: treasuryToken,
        recipient: address(20),
        inputAmount: '100000',
        value: '0',
        outputAmount: '100000',
      },
      { logIndex: 1 },
    ),
  ];
}
