import {
  encodeFunctionData,
  encodeAbiParameters,
  keccak256,
  hashTypedData,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
const wallet = z
  .string()
  .refine((v) => isAddress(v) && BigInt(v) > 1n)
  .transform((v) => getAddress(v));
const units = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .refine((v) => BigInt(v) < 2n ** 256n);
const actionBase = {
  id: z.string().uuid(),
  workspaceId: z.string().uuid(),
  chainId: z.literal(5042002),
  safe: wallet,
  policy: wallet,
  token: wallet,
  nonce: units,
  expiresAt: z.number().int().positive().safe(),
};
export const SafeActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...actionBase,
    kind: z.enum(['QUEUE_VENDOR', 'ALLOW_VENDOR', 'REMOVE_VENDOR']),
    vendorId: z.string().uuid(),
    vendorAddress: wallet,
    vendorChangeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  }),
  z
    .strictObject({
      ...actionBase,
      kind: z.enum(['QUEUE_CAPS', 'SET_CAPS']),
      perPaymentCap: units,
      windowCap: units,
    })
    .refine(
      (v) => BigInt(v.perPaymentCap) <= BigInt(v.windowCap),
      'per-payment cap exceeds window cap',
    ),
]);
export type SafeAction = z.output<typeof SafeActionSchema>;
export const SafeActionViewSchema = z.strictObject({
  action: SafeActionSchema,
  signedBy: z.array(wallet),
  state: z.enum(['REVIEW', 'READY', 'CONFIRMED', 'FAILED', 'NEEDS_REVIEW']),
  evidence: z.record(z.string(), z.unknown()).nullable(),
  lastError: z.string().nullable(),
});
export type SafeActionSignature = Readonly<{
  owner: Address;
  approvalSignature: Hex;
  safeSignature: Hex;
}>;
const policyAbi = parseAbi([
  'function addRecipient(address recipient)',
  'function setCaps(uint256 perPaymentCap,uint256 windowCap)',
  'function removeRecipient(address recipient)',
  'function queue(address to,uint256 value,bytes data,uint8 operation) returns(bytes32)',
]);
const safeAbi = parseAbi([
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns(bool)',
]);
export function safeActionCall(a: SafeAction) {
  const inner =
    'perPaymentCap' in a
      ? encodeFunctionData({
          abi: policyAbi,
          functionName: 'setCaps',
          args: [BigInt(a.perPaymentCap), BigInt(a.windowCap)],
        })
      : encodeFunctionData({
          abi: policyAbi,
          functionName:
            a.kind === 'REMOVE_VENDOR' ? 'removeRecipient' : 'addRecipient',
          args: [a.vendorAddress],
        });
  return {
    to: a.policy,
    value: 0n,
    data:
      a.kind === 'QUEUE_VENDOR' || a.kind === 'QUEUE_CAPS'
        ? encodeFunctionData({
            abi: policyAbi,
            functionName: 'queue',
            args: [a.policy, 0n, inner, 0],
          })
        : inner,
    operation: 0,
    nonce: BigInt(a.nonce),
  } as const;
}
export function safeActionTypedData(a: SafeAction) {
  const tx = safeActionCall(a);
  return {
    domain: { chainId: a.chainId, verifyingContract: a.safe },
    primaryType: 'SafeTx' as const,
    types: {
      SafeTx: [
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
        { name: 'operation', type: 'uint8' },
        { name: 'safeTxGas', type: 'uint256' },
        { name: 'baseGas', type: 'uint256' },
        { name: 'gasPrice', type: 'uint256' },
        { name: 'gasToken', type: 'address' },
        { name: 'refundReceiver', type: 'address' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      ...tx,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: zeroAddress,
      refundReceiver: zeroAddress,
    },
  };
}
export function safeActionApprovalTypedData(a: SafeAction) {
  return {
    domain: {
      name: 'Synq Workspace Vault Action',
      version: '1',
      chainId: a.chainId,
      verifyingContract: a.safe,
    },
    primaryType: 'WorkspaceVaultAction' as const,
    types: {
      WorkspaceVaultAction: [
        { name: 'actionId', type: 'string' },
        { name: 'workspaceId', type: 'string' },
        { name: 'safeTxHash', type: 'bytes32' },
        { name: 'vendorChangeHash', type: 'bytes32' },
        { name: 'expiresAt', type: 'uint64' },
      ],
    },
    message: {
      actionId: a.id,
      workspaceId: a.workspaceId,
      safeTxHash: hashTypedData(safeActionTypedData(a)),
      vendorChangeHash:
        'vendorChangeHash' in a
          ? (a.vendorChangeHash as Hex)
          : keccak256(
              encodeAbiParameters(
                [{ type: 'uint256' }, { type: 'uint256' }],
                [BigInt(a.perPaymentCap), BigInt(a.windowCap)],
              ),
            ),
      expiresAt: BigInt(a.expiresAt),
    },
  };
}
export function safeActionExecution(
  a: SafeAction,
  signatures: readonly SafeActionSignature[],
) {
  const tx = safeActionCall(a);
  const packed = `0x${[...signatures]
    .sort((x, y) => (BigInt(x.owner) < BigInt(y.owner) ? -1 : 1))
    .map((v) => v.safeSignature.slice(2))
    .join('')}` as Hex;
  return {
    to: a.safe,
    value: 0n,
    data: encodeFunctionData({
      abi: safeAbi,
      functionName: 'execTransaction',
      args: [
        tx.to,
        tx.value,
        tx.data,
        tx.operation,
        0n,
        0n,
        0n,
        zeroAddress,
        zeroAddress,
        packed,
      ],
    }),
  };
}
