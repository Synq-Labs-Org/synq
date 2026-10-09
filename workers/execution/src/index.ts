import {
  concat,
  decodeEventLog,
  decodeFunctionData,
  encodeFunctionData,
  keccak256,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { verifiedAsset } from '@synq/chain-registry';
import {
  ExecutionError,
  ExecutionGrantSchema,
  GrantExecutionObservationSchema,
  SigningError,
  executionGrantDigest,
  type Asset,
  type ExecutionGrant,
  type GrantDraft,
  type GrantExecutionObservation,
  type OnchainGrant,
  type VerifiedApproval,
} from '@synq/domain';
import type { GrantClaim, Kernel } from '@synq/kernel';
import { moduleAbi, tokenAbi } from './abi.js';
export * from './journal.js';
export * from './deployment.js';
export * from './integrity.js';
export * from './reconciliation.js';

const ERC20_TRANSFER = '0xa9059cbb';
const NATIVE_TRANSFER = '0x00000000';
const HALF_ORDER =
  0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

export function chainGrant(
  raw: ExecutionGrant,
  localAssets: readonly Asset[] = [],
) {
  const grant = ExecutionGrantSchema.parse(raw);
  if (grant.chainId === 143) throw new ExecutionError('MAINNET_DISABLED');
  if (grant.inputAsset) {
    const asset = verifiedAsset(grant.inputAsset, localAssets);
    if (asset.address !== grant.draft.grant.token)
      throw new ExecutionError('PREPARED_CALL_MISMATCH');
  }
  if (
    executionGrantDigest(grant.draft.domain, grant.draft.grant) !==
    grant.grantId
  )
    throw new ExecutionError('PREPARED_CALL_MISMATCH');
  return onchainGrantArgs(grant.draft.grant);
}

export function onchainGrantArgs(g: OnchainGrant) {
  return {
    groupId: g.groupId,
    account: g.account,
    mandateId: g.mandateId,
    mandateVersion: BigInt(g.mandateVersion),
    executor: g.executor,
    pluginId: g.pluginId,
    chainId: BigInt(g.chainId),
    target: g.target,
    selector: g.selector,
    calldataHash: g.calldataHash,
    token: g.token,
    maxInputAmount: BigInt(g.maxInputAmount),
    nativeValue: BigInt(g.nativeValue),
    minOutputAmount: BigInt(g.minOutputAmount),
    recipient: g.recipient,
    validAfter: BigInt(g.validAfter),
    validUntil: BigInt(g.validUntil),
    nonce: BigInt(g.nonce),
    intentHash: g.intentHash,
  };
}

export function packSafeSignatures(
  approvals: readonly VerifiedApproval[],
  draft: GrantDraft,
): Hex {
  const signers = new Set(approvals.map((a) => a.signer));
  if (
    approvals.length < draft.requiredApprovals ||
    signers.size !== approvals.length ||
    approvals.some((a) => {
      const v = Number.parseInt(a.signature.slice(130, 132), 16);
      const s = BigInt(`0x${a.signature.slice(66, 130)}`);
      return (
        a.draftDigest !== draft.digest ||
        a.signature.length !== 132 ||
        (v !== 27 && v !== 28) ||
        s > HALF_ORDER
      );
    })
  )
    throw new SigningError('SIGNATURE_PACKING_INVALID');
  return concat(
    [...approvals]
      .sort((a, b) => (a.signer < b.signer ? -1 : 1))
      .map((a) => a.signature),
  );
}

function checkCalldata(grant: ExecutionGrant, data: Hex): void {
  if (keccak256(data) !== grant.calldataHash)
    throw new ExecutionError('PREPARED_CALL_MISMATCH');
  if (grant.selector === NATIVE_TRANSFER) {
    if (data !== '0x' || grant.target !== grant.recipient)
      throw new ExecutionError('PREPARED_CALL_MISMATCH');
    return;
  }
  if (data.slice(0, 10).toLowerCase() !== grant.selector)
    throw new ExecutionError('PREPARED_CALL_MISMATCH');
  if (grant.selector === ERC20_TRANSFER) {
    const { args } = decodeFunctionData({ abi: tokenAbi, data });
    const [to, amount] = args as readonly [Address, bigint];
    if (
      data.length !== 2 + 68 * 2 ||
      to.toLowerCase() !== grant.recipient ||
      amount <= 0n ||
      amount > BigInt(grant.maxInputAmount) ||
      grant.target !== grant.draft.grant.token
    )
      throw new ExecutionError('PREPARED_CALL_MISMATCH');
  }
}

export type PreparedModuleCall = Readonly<{
  grantId: `0x${string}`;
  chainId: number;
  to: Address;
  data: Hex;
  value: 0n;
}>;

export function prepareModuleCall(
  kernel: Pick<Kernel, 'grantState' | 'prepare'>,
  claim: GrantClaim,
  data: Hex,
  localAssets: readonly Asset[] = [],
): PreparedModuleCall {
  const issued = kernel.grantState(claim.grantId).grant;
  checkCalldata(issued, data);
  const calldata = encodeFunctionData({
    abi: moduleAbi,
    functionName: 'execute',
    args: [
      chainGrant(issued, localAssets),
      data,
      packSafeSignatures(issued.approvals, issued.draft),
    ],
  });
  const prepared = kernel.prepare(claim, keccak256(calldata));
  if (prepared.grantId !== issued.grantId)
    throw new ExecutionError('PREPARED_CALL_MISMATCH');
  return {
    grantId: issued.grantId,
    chainId: issued.chainId,
    to: issued.draft.domain.verifyingContract,
    data: calldata,
    value: 0n,
  };
}

export interface ExecutorSigner {
  readonly address: Address;
  signTransaction(tx: TransactionSerializableEIP1559): Promise<Hex>;
}

const refuse = (detail: string): never => {
  throw new SigningError('GRANT_SIGNING_REFUSED', detail);
};

export async function signGrantBoundTransaction(
  rawGrant: ExecutionGrant,
  prepared: TransactionSerializableEIP1559,
  executor: ExecutorSigner,
  now: number,
  localAssets: readonly Asset[] = [],
): Promise<Hex> {
  const grant = ExecutionGrantSchema.parse(rawGrant);
  const expected = chainGrant(grant, localAssets);
  if (
    prepared.chainId !== grant.chainId ||
    grant.draft.domain.chainId !== grant.chainId
  )
    refuse('chain');
  if (executor.address.toLowerCase() !== grant.operator) refuse('executor');
  if (grant.approvals.some((a) => a.signer === executor.address.toLowerCase()))
    refuse('owner key');
  if (prepared.to?.toLowerCase() !== grant.draft.domain.verifyingContract)
    refuse('module');
  if ((prepared.value ?? 0n) !== 0n) refuse('value');
  if (
    !Number.isSafeInteger(now) ||
    now < grant.validAfter ||
    now >= grant.validUntil
  )
    refuse('expiry');
  if (!prepared.data) return refuse('calldata');
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: moduleAbi, data: prepared.data });
  } catch {
    return refuse('calldata');
  }
  if (decoded.functionName !== 'execute') return refuse('function');
  const [onchain, inner, signatures] = decoded.args;
  const fields = Object.keys(expected) as (keyof typeof expected)[];
  if (
    fields.some(
      (k) =>
        String(onchain[k]).toLowerCase() !== String(expected[k]).toLowerCase(),
    )
  )
    refuse('grant fields');
  if (onchain.account.toLowerCase() !== grant.account) refuse('account');
  if (onchain.target.toLowerCase() !== grant.target) refuse('target');
  try {
    checkCalldata(grant, inner);
  } catch {
    refuse('calldata hash or amount');
  }
  if (signatures !== packSafeSignatures(grant.approvals, grant.draft))
    refuse('signatures');
  return executor.signTransaction(prepared);
}

export function observeGrantExecution(
  receipt: {
    status: 'success' | 'reverted';
    transactionHash: Hex;
    blockNumber: bigint;
    logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
  },
  module: Address,
  chainId: number,
): GrantExecutionObservation {
  if (receipt.status !== 'success')
    return GrantExecutionObservationSchema.parse({
      schemaVersion: 1,
      chainId,
      transactionHash: receipt.transactionHash,
      blockNumber: receipt.blockNumber.toString(),
      receiptStatus: 'reverted',
      emitter: null,
      event: null,
    });
  const events = receipt.logs.flatMap((log) => {
    if (log.address.toLowerCase() !== module.toLowerCase()) return [];
    try {
      const decoded = decodeEventLog({
        abi: moduleAbi,
        data: log.data,
        topics: log.topics as [Hex, ...Hex[]],
      });
      return decoded.eventName === 'GrantExecuted' ? [decoded.args] : [];
    } catch {
      return [];
    }
  });
  if (events.length !== 1) throw new ExecutionError('PREPARED_CALL_MISMATCH');
  const e = events[0]!;
  return GrantExecutionObservationSchema.parse({
    schemaVersion: 1,
    chainId,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    receiptStatus: 'success',
    emitter: module,
    event: Object.fromEntries(
      Object.entries(e).map(([k, v]) => [
        k,
        typeof v === 'bigint' ? v.toString() : v,
      ]),
    ),
  });
}
