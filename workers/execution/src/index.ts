import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { verifiedAsset } from '@synq/chain-registry';
import {
  ExecutionGrantSchema,
  type Asset,
  type BoundActionIntent,
  type ExecutionGrant,
} from '@synq/schemas';
import type { Kernel } from '@synq/kernel';
import { moduleAbi } from './abi.js';
export * from './journal.js';
export function chainGrant(
  raw: ExecutionGrant,
  localAssets: readonly Asset[] = [],
) {
  const grant = ExecutionGrantSchema.parse(raw);
  if (grant.chainId === 143) throw new Error('MAINNET_DISABLED');
  const inputAsset = verifiedAsset(grant.inputAsset, localAssets);
  return {
    intentHash: grant.intentHash,
    mandateId: keccak256(stringToHex(grant.mandateId)),
    mandateVersion: BigInt(grant.mandateVersion),
    executor: grant.operator,
    target: grant.target,
    selector: grant.selector,
    calldataHash: grant.calldataHash,
    inputToken: inputAsset.address,
    maxInputAmount: BigInt(grant.maxInputAmount),
    value: BigInt(grant.nativeValue),
    validAfter: BigInt(grant.validAfter),
    validUntil: BigInt(grant.validUntil),
    nonce: BigInt(grant.nonce),
    pluginId: keccak256(stringToHex(grant.pluginId)),
    minOutputAmount: BigInt(grant.minOutputAmount),
    chainId: BigInt(grant.chainId),
  };
}
export function prepareModuleCall(
  kernel: Kernel,
  grant: ExecutionGrant,
  intent: BoundActionIntent,
  module: Address,
  data: Hex,
  signatures: Hex,
  now: number,
  localAssets: readonly Asset[] = [],
) {
  const validated = kernel.verify(grant, intent, now);
  if (
    keccak256(data) !== validated.calldataHash ||
    data.slice(0, 10) !== validated.selector
  )
    throw new Error('PREPARED_CALL_MISMATCH');
  const calldata = encodeFunctionData({
    abi: moduleAbi,
    functionName: 'execute',
    args: [chainGrant(validated, localAssets), data, signatures],
  });
  return {
    to: module,
    data: calldata,
    value: 0n,
    chainId: validated.chainId,
  } as const;
}
