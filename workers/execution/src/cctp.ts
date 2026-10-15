import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  pad,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { CHAINS, contract, token, tokenEntry } from '@synq/chain-registry/arc';
import {
  checkMessage,
  decodeMessage,
  netMinted,
  type CctpTransfer,
} from '@synq/plugin-circle-cctp';
import {
  ArcExecutionError,
  verifyCode,
  type ArcChain,
  type TransferSigner,
} from './arc.js';

/**
 * Restricted-executor legs of a CCTP V2 transfer. Each leg verifies the
 * contracts it touches against pinned code hashes, records the transaction hash
 * before broadcasting (so a crash reconciles instead of re-sending), and never
 * repeats a write whose outcome is unknown.
 */

export const TOKEN_MESSENGER_V2_ABI = [
  {
    type: 'function',
    name: 'depositForBurn',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'depositForBurnWithHook',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'amount', type: 'uint256' },
      { name: 'destinationDomain', type: 'uint32' },
      { name: 'mintRecipient', type: 'bytes32' },
      { name: 'burnToken', type: 'address' },
      { name: 'destinationCaller', type: 'bytes32' },
      { name: 'maxFee', type: 'uint256' },
      { name: 'minFinalityThreshold', type: 'uint32' },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

export const MESSAGE_TRANSMITTER_V2_ABI = [
  {
    type: 'function',
    name: 'receiveMessage',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'message', type: 'bytes' },
      { name: 'attestation', type: 'bytes' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'function',
    name: 'usedNonces',
    stateMutability: 'view',
    inputs: [{ name: 'nonce', type: 'bytes32' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

async function feeFields(chain: ArcChain) {
  const fees = await chain.client.estimateFeesPerGas();
  const floor = chain.profile.minMaxFeePerGasWei ?? 0n;
  const tip =
    fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
      ? fees.maxPriorityFeePerGas
      : 1_000_000_000n;
  let max = fees.maxFeePerGas ?? 0n;
  if (max < floor) max = floor;
  if (max < tip) max = tip;
  return { maxFeePerGas: max * 2n, maxPriorityFeePerGas: tip };
}

async function sendCall(
  chain: ArcChain,
  signer: TransferSigner,
  to: Address,
  data: Hex,
  onHash: (h: Hex) => Promise<void> | void,
): Promise<Hex> {
  if (!chain.profile.mutationEnabled)
    throw new ArcExecutionError('MUTATION_DISABLED', chain.profile.name);
  const gas =
    ((await chain.client.estimateGas({ account: signer.address, to, data })) *
      130n) /
    100n;
  const nonce = await chain.client.getTransactionCount({
    address: signer.address,
    blockTag: 'pending',
  });
  const tx: TransactionSerializableEIP1559 & { chainId: number } = {
    type: 'eip1559',
    chainId: chain.profile.chainId,
    to,
    data,
    value: 0n,
    gas,
    nonce,
    ...(await feeFields(chain)),
  };
  const raw = await signer.signTransaction(tx);
  const hash = keccak256(raw);
  await onHash(hash);
  await chain.client.sendRawTransaction({ serializedTransaction: raw });
  const r = await chain.client.waitForTransactionReceipt({
    hash,
    confirmations: chain.profile.confirmations,
  });
  if (r.status !== 'success')
    throw new ArcExecutionError('RECEIPT_FAILED', hash);
  return hash;
}

/** Source leg: approve (if needed) then burn. `onBurnHash` must persist before broadcast. */
export async function burnOnSource(input: {
  chain: ArcChain;
  signer: TransferSigner;
  transfer: CctpTransfer;
  onApproveHash?: (h: Hex) => Promise<void> | void;
  onBurnHash: (h: Hex) => Promise<void> | void;
}): Promise<{ approveTx: Hex | null; burnTx: Hex }> {
  const { chain, signer, transfer: t } = input;
  if (chain.profile.name !== t.source)
    throw new ArcExecutionError(
      'WRONG_CHAIN',
      `${chain.profile.name} is not ${t.source}`,
    );
  if (signer.address.toLowerCase() !== t.payer.toLowerCase())
    throw new ArcExecutionError('SIGNER_MISMATCH');
  const usdc = token(t.source, 'USDC');
  const usdcEntry = tokenEntry(usdc);
  const messenger = contract(t.source, 'CCTP_TOKEN_MESSENGER_V2');
  await verifyCode(chain, usdc.address, usdcEntry.codeHash);
  await verifyCode(chain, messenger.address, messenger.codeHash);
  const dest = CHAINS[t.destination];
  const balance = await chain.client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [t.payer],
  });
  if (balance < t.amount)
    throw new ArcExecutionError(
      'INSUFFICIENT_FUNDS',
      `${balance} < ${t.amount}`,
    );
  const allowance = await chain.client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [t.payer, messenger.address],
  });
  let approveTx: Hex | null = null;
  if (allowance < t.amount)
    approveTx = await sendCall(
      chain,
      signer,
      usdc.address,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [messenger.address, t.amount],
      }),
      input.onApproveHash ?? (() => undefined),
    );
  const common = [
    t.amount,
    dest.cctpDomain!,
    pad(t.recipient),
    usdc.address,
    pad(zeroAddress),
    t.maxFee,
    t.minFinalityThreshold,
  ] as const;
  const data = t.reference
    ? encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'depositForBurnWithHook',
        args: [...common, t.reference],
      })
    : encodeFunctionData({
        abi: TOKEN_MESSENGER_V2_ABI,
        functionName: 'depositForBurn',
        args: common,
      });
  const burnTx = await sendCall(
    chain,
    signer,
    messenger.address,
    data,
    input.onBurnHash,
  );
  return { approveTx, burnTx };
}

/** Recovery read: did a recorded burn land? Never re-sends. */
export async function burnStatus(
  chain: ArcChain,
  burnTx: Hex,
): Promise<'SUCCESS' | 'REVERTED' | 'UNKNOWN'> {
  try {
    const r = await chain.client.getTransactionReceipt({ hash: burnTx });
    return r.status === 'success' ? 'SUCCESS' : 'REVERTED';
  } catch {
    return 'UNKNOWN';
  }
}

/**
 * Destination leg. Checks the attested message against the planned transfer,
 * then mints unless the nonce is already used on chain (someone, possibly us
 * before a crash, already minted: reconcile instead of minting twice).
 */
export async function mintOnDestination(input: {
  chain: ArcChain;
  signer: TransferSigner;
  transfer: CctpTransfer;
  message: Hex;
  attestation: Hex;
  onMintHash: (h: Hex) => Promise<void> | void;
}): Promise<{ mintTx: Hex | null; alreadyUsed: boolean }> {
  const { chain, transfer: t } = input;
  if (chain.profile.name !== t.destination)
    throw new ArcExecutionError(
      'WRONG_CHAIN',
      `${chain.profile.name} is not ${t.destination}`,
    );
  const decoded = decodeMessage(input.message);
  checkMessage(t, decoded);
  const transmitter = contract(t.destination, 'CCTP_MESSAGE_TRANSMITTER_V2');
  await verifyCode(chain, transmitter.address, transmitter.codeHash);
  const used = await chain.client.readContract({
    address: transmitter.address,
    abi: MESSAGE_TRANSMITTER_V2_ABI,
    functionName: 'usedNonces',
    args: [decoded.nonce],
  });
  if (used !== 0n) return { mintTx: null, alreadyUsed: true };
  const mintTx = await sendCall(
    chain,
    input.signer,
    transmitter.address,
    encodeFunctionData({
      abi: MESSAGE_TRANSMITTER_V2_ABI,
      functionName: 'receiveMessage',
      args: [input.message, input.attestation],
    }),
    input.onMintHash,
  );
  return { mintTx, alreadyUsed: false };
}

/** The destination receipt must show registry USDC minted to the recipient: amount − feeExecuted. */
export async function reconcileMint(
  chain: ArcChain,
  t: CctpTransfer,
  message: Hex,
  mintTx: Hex,
) {
  const decoded = decodeMessage(message);
  checkMessage(t, decoded);
  const r = await chain.client.getTransactionReceipt({ hash: mintTx });
  if (r.status !== 'success')
    throw new ArcExecutionError('RECEIPT_FAILED', mintTx);
  const usdc = token(t.destination, 'USDC');
  const toRecipient = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r.logs,
  }).filter(
    (l) =>
      l.address.toLowerCase() === usdc.address.toLowerCase() &&
      l.args.to.toLowerCase() === t.recipient.toLowerCase(),
  );
  const expected = netMinted(decoded);
  const hit = toRecipient.find((l) => l.args.value === expected);
  if (!hit || toRecipient.length !== 1)
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `expected one mint of ${expected} to ${t.recipient}, saw ${toRecipient.length}`,
    );
  return {
    minted: expected,
    feeExecuted: decoded.burn.feeExecuted,
    logIndex: hit.logIndex!,
    nonce: decoded.nonce,
    blockNumber: r.blockNumber,
    explorer: `${chain.profile.explorer}/tx/${mintTx}`,
  };
}
