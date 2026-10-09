import { getAddress, keccak256, stringToHex } from 'viem';
import { officialAssets } from '@synq/chain-registry';
import {
  projectionConfig,
  type ChainEvent,
  type EventName,
  type ProjectionConfig,
} from '../../packages/read-model/src/index.js';

export const chainId = 10143;
export const ausd = getAddress(officialAssets.testnetAUSD.address);
export const ausdLower = ausd.toLowerCase() as `0x${string}`;
export const address = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}`;
export const word = (n: number | string): `0x${string}` =>
  typeof n === 'number'
    ? `0x${n.toString(16).padStart(64, '0')}`
    : keccak256(stringToHex(n));
export const factory = address(0xf1);
export const registry = address(0xf2);
export const moduleAddress = address(0xf3);
export const account = address(0xa1);
export const groupId = word('group-1');
export const owners = [address(1), address(2), address(3)];
export const executor = address(0xe1);
export const recipient = address(0xbb);
export const mandateId = word('mandate-1');
export const startBlock = 100;

export function config(
  overrides: Partial<Parameters<typeof projectionConfig>[0]> = {},
): ProjectionConfig {
  return projectionConfig({
    chainId,
    profile: 'sandbox/monad-testnet',
    startBlock,
    factory,
    registry,
    module: moduleAddress,
    treasuryAssets: [ausd],
    reorgWindowBlocks: 20,
    confirmationDepth: 2,
    ...overrides,
  });
}

export const blockHash = (n: number, branch = 'a') =>
  word(`block-${n}-${branch}`);
let txCounter = 0;
export const tx = (label: string) => word(`tx-${label}`);

export function ev<K extends EventName>(
  eventName: K,
  blockNumber: number,
  payload: Extract<ChainEvent, { eventName: K }>['payload'],
  options: {
    tx?: `0x${string}`;
    logIndex?: number;
    txIndex?: number;
    branch?: string;
    contract?: `0x${string}`;
  } = {},
): Extract<ChainEvent, { eventName: K }> {
  const contract =
    options.contract ??
    (eventName === 'Transfer'
      ? ausdLower
      : eventName === 'GroupCreated'
        ? factory
        : [
              'GroupBound',
              'GroupModuleChanged',
              'MandateConfigured',
              'MandateSuperseded',
              'MandateRevoked',
              'SpendRecorded',
            ].includes(eventName)
          ? registry
          : [
                'ExecutorSet',
                'Paused',
                'Unpaused',
                'NonceCancelled',
                'GrantExecuted',
              ].includes(eventName)
            ? moduleAddress
            : account);
  return {
    schemaVersion: 1,
    chainId,
    blockNumber,
    blockHash: blockHash(blockNumber, options.branch),
    transactionHash: options.tx ?? word(`auto-${++txCounter}`),
    transactionIndex: options.txIndex ?? 0,
    logIndex: options.logIndex ?? 0,
    contract,
    eventName,
    payload,
  } as Extract<ChainEvent, { eventName: K }>;
}

export const mandateTerms = {
  mandateHash: word('mandate-artifact-1'),
  token: ausdLower,
  maxTokenPerAction: '500000',
  maxNativePerAction: '0',
  cumulativeTokenCap: '2000000',
  cumulativeNativeCap: '0',
  validAfter: '0',
  validUntil: '4000000000',
  callTargets: [ausdLower],
  callSelectors: ['0xa9059cbb' as `0x${string}`],
  recipients: [recipient],
};

export function creation(block = 101, branch = 'a'): ChainEvent[] {
  const t = tx(`create-${block}-${branch}`);
  return [
    ev(
      'EnabledModule',
      block,
      { module: moduleAddress },
      { tx: t, logIndex: 0, branch },
    ),
    ev(
      'SafeSetup',
      block,
      {
        initiator: factory,
        owners,
        threshold: '2',
        initializer: address(0xf4),
        fallbackHandler: address(0xf5),
      },
      { tx: t, logIndex: 1, branch },
    ),
    ev(
      'GroupBound',
      block,
      { groupId, account, module: moduleAddress },
      { tx: t, logIndex: 3, branch },
    ),
    ev(
      'GroupCreated',
      block,
      {
        groupId,
        account,
        owners,
        threshold: '2',
        module: moduleAddress,
        registry,
        creator: owners[0]!,
        salt: word(1),
      },
      { tx: t, logIndex: 4, branch },
    ),
  ];
}

export function funding(
  block: number,
  value = '1000000',
  branch = 'a',
  label = 'fund',
) {
  return ev(
    'Transfer',
    block,
    { from: address(0xfa), to: account, value },
    { tx: tx(`${label}-${block}`), branch },
  );
}

export function governance(block = 103, branch = 'a'): ChainEvent[] {
  const t = tx(`gov-${block}`);
  return [
    ev(
      'ExecutorSet',
      block,
      { groupId, account, executor, allowed: true },
      { tx: t, logIndex: 0, branch },
    ),
    ev(
      'MandateConfigured',
      block,
      { groupId, account, mandateId, version: '1', ...mandateTerms },
      { tx: t, logIndex: 1, branch },
    ),
  ];
}

export function execution(
  block = 104,
  nonce = '1',
  amount = '250000',
  branch = 'a',
  spentBefore = 0n,
): ChainEvent[] {
  const t = tx(`exec-${nonce}`);
  const spent = (spentBefore + BigInt(amount)).toString();
  return [
    ev(
      'SpendRecorded',
      block,
      {
        groupId,
        account,
        mandateId,
        version: '1',
        module: moduleAddress,
        tokenAmount: amount,
        nativeAmount: '0',
        spentToken: spent,
        spentNative: '0',
      },
      { tx: t, logIndex: 0, branch },
    ),
    ev(
      'Transfer',
      block,
      { from: account, to: recipient, value: amount },
      { tx: t, logIndex: 1, branch },
    ),
    ev(
      'GrantExecuted',
      block,
      {
        groupId,
        account,
        intentHash: word(`intent-${nonce}`),
        mandateId,
        mandateVersion: '1',
        executor,
        pluginId: word('plugin'),
        chainId: String(chainId),
        nonce,
        grantHash: word(`grant-${nonce}`),
        target: ausdLower,
        selector: '0xa9059cbb',
        calldataHash: word(`calldata-${nonce}`),
        token: ausdLower,
        recipient,
        tokenAmount: amount,
        nativeValue: '0',
        outputAmount: amount,
      },
      { tx: t, logIndex: 2, branch },
    ),
  ];
}

export function lifecycle(): ChainEvent[] {
  return [
    ...creation(101),
    funding(102),
    ...governance(103),
    ...execution(104),
  ];
}
