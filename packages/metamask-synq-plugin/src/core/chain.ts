import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseAbi,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from 'viem';
import { fail } from './errors.js';
import { NETWORK, sameAddress } from './network.js';

/** Read surface of contracts/src/MandateRegistry.sol used by the plugin. */
export const mandateRegistryAbi = parseAbi([
  'function groupOf(address account) view returns (bytes32)',
  'function accountOf(bytes32 groupId) view returns (address)',
  'function mandateState(address account, bytes32 mandateId) view returns ((uint8 status, uint256 currentVersion, uint256 minValidVersion, uint256 spentToken, uint256 spentNative))',
  'function mandateTerms(address account, bytes32 mandateId, uint256 version) view returns ((bytes32 mandateHash, address token, uint256 maxTokenPerAction, uint256 maxNativePerAction, uint256 cumulativeTokenCap, uint256 cumulativeNativeCap, uint256 validAfter, uint256 validUntil))',
]);

export const MANDATE_STATUS = { NONE: 0, ACTIVE: 1, REVOKED: 2 } as const;

export async function assertChain(client: PublicClient): Promise<void> {
  const chainId = await client.getChainId();
  if (chainId !== NETWORK.chainId)
    fail(
      'WRONG_CHAIN',
      `Agent Wallet RPC reports chain ${chainId}; Synq requires ${NETWORK.caip2}`,
    );
}

/** The group Safe is whatever MandateRegistry binds to the chain group id, both ways. */
export async function verifiedGroupSafe(
  client: PublicClient,
  chainGroupId: Hex,
  claimedSafe: string,
): Promise<Address> {
  const [account, back] = await Promise.all([
    client.readContract({
      address: NETWORK.mandateRegistry,
      abi: mandateRegistryAbi,
      functionName: 'accountOf',
      args: [chainGroupId],
    }),
    client.readContract({
      address: NETWORK.mandateRegistry,
      abi: mandateRegistryAbi,
      functionName: 'groupOf',
      args: [getAddress(claimedSafe)],
    }),
  ]);
  if (account === zeroAddress)
    fail('WRONG_SAFE', `Group ${chainGroupId} is not bound in MandateRegistry`);
  if (
    !sameAddress(account, claimedSafe) ||
    back.toLowerCase() !== chainGroupId.toLowerCase()
  )
    fail(
      'WRONG_SAFE',
      `Synq reports Safe ${claimedSafe} but MandateRegistry binds ${account} to this group`,
    );
  return getAddress(account);
}

export type MandateCheck = {
  mandateId: Hex;
  version: bigint;
  token: Address;
  validAfter: bigint;
  validUntil: bigint;
};

export async function verifiedContributionMandate(
  client: PublicClient,
  safe: Address,
  mandateId: Hex,
  nowSeconds: bigint,
): Promise<MandateCheck> {
  const state = await client.readContract({
    address: NETWORK.mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: 'mandateState',
    args: [safe, mandateId],
  });
  if (state.status !== MANDATE_STATUS.ACTIVE)
    fail(
      'MANDATE_MISMATCH',
      `Mandate ${mandateId} is not active on Safe ${safe} (status ${state.status})`,
    );
  const terms = await client.readContract({
    address: NETWORK.mandateRegistry,
    abi: mandateRegistryAbi,
    functionName: 'mandateTerms',
    args: [safe, mandateId, state.currentVersion],
  });
  if (!sameAddress(terms.token, NETWORK.ausd.address))
    fail(
      'MANDATE_MISMATCH',
      `Mandate ${mandateId} is denominated in ${terms.token}, not AUSD`,
    );
  if (nowSeconds < terms.validAfter || nowSeconds >= terms.validUntil)
    fail(
      'MANDATE_MISMATCH',
      `Mandate ${mandateId} is outside its validity window`,
    );
  return {
    mandateId,
    version: state.currentVersion,
    token: getAddress(terms.token),
    validAfter: terms.validAfter,
    validUntil: terms.validUntil,
  };
}

export const ausdBalance = (client: PublicClient, owner: Address) =>
  client.readContract({
    address: NETWORK.ausd.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });

export const transferCalldata = (to: Address, amount: bigint): Hex =>
  encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  });

/** Decode what is about to be signed and refuse anything but the exact AUSD transfer. */
export function assertExactTransfer(
  tx: { chainId: number; to: string; data: Hex; value: bigint },
  expected: { safe: Address; amount: bigint },
): void {
  if (tx.chainId !== NETWORK.chainId)
    fail('WRONG_CHAIN', 'transaction targets another chain');
  if (!sameAddress(tx.to, NETWORK.ausd.address))
    fail('INVALID_TOKEN', `transaction targets ${tx.to}, not AUSD`);
  if (tx.value !== 0n)
    fail('INTENT_MISMATCH', 'contribution must not carry native value');
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
  } catch {
    return fail('INTENT_MISMATCH', 'calldata is not an ERC-20 call');
  }
  if (decoded.functionName !== 'transfer')
    fail(
      'INTENT_MISMATCH',
      `calldata calls ${decoded.functionName}, not transfer`,
    );
  const [to, amount] = decoded.args as readonly [Address, bigint];
  if (!sameAddress(to, expected.safe))
    fail(
      'WRONG_SAFE',
      `calldata pays ${to}, not the group Safe ${expected.safe}`,
    );
  if (amount !== expected.amount)
    fail(
      'INTENT_MISMATCH',
      `calldata amount ${amount} differs from ${expected.amount}`,
    );
}

export type VerifiedTransfer = {
  blockNumber: bigint;
  logIndex: number;
  from: Address;
};

/** Exactly one AUSD Transfer(spender -> Safe, amount) in a successful receipt. */
export function verifiedTransfer(
  receipt: TransactionReceipt,
  expected: { spender: Address; safe: Address; amount: bigint },
): VerifiedTransfer {
  if (receipt.status !== 'success')
    fail(
      'SUBMISSION_FAILED',
      `transaction ${receipt.transactionHash} reverted`,
    );
  if (!sameAddress(receipt.from, expected.spender))
    fail(
      'WRONG_SPENDER',
      `transaction was sent by ${receipt.from}, expected member wallet ${expected.spender}`,
    );
  const logs = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs.filter((l) =>
      sameAddress(l.address, NETWORK.ausd.address),
    ),
  }).filter(
    (l) =>
      sameAddress(l.args.from, expected.spender) &&
      sameAddress(l.args.to, expected.safe) &&
      l.args.value === expected.amount,
  );
  if (logs.length !== 1)
    fail(
      'RECEIPT_MISMATCH',
      'receipt does not carry exactly one matching AUSD transfer',
    );
  return {
    blockNumber: receipt.blockNumber,
    logIndex: logs[0]!.logIndex,
    from: getAddress(receipt.from),
  };
}
