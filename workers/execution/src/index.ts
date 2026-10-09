import {
  encodeFunctionData,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  ExecutionGrantSchema,
  type ActionIntent,
  type ExecutionGrant,
} from '../../../packages/schemas/src/index.js';
import type { Kernel } from '../../../packages/kernel/src/index.js';
import { moduleAbi } from './abi.js';
export * from './journal.js';
export function chainGrant(raw: ExecutionGrant) {
  const grant = ExecutionGrantSchema.parse(raw);
  if (grant.chainId === 143) throw new Error('MAINNET_DISABLED');
  return {
    intentHash: grant.intentHash,
    mandateId: keccak256(stringToHex(grant.mandateId)),
    mandateVersion: BigInt(grant.mandateVersion),
    executor: grant.operator,
    target: grant.target,
    selector: grant.selector,
    calldataHash: grant.calldataHash,
    inputToken: grant.inputAsset.address,
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
  intent: ActionIntent,
  module: Address,
  data: Hex,
  signatures: Hex,
  now: number,
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
    args: [chainGrant(validated), data, signatures],
  });
  return {
    to: module,
    data: calldata,
    value: 0n,
    chainId: validated.chainId,
  } as const;
}
