import { encodeFunctionData, erc20Abi, parseEventLogs, type Hex } from 'viem';
import {
  contract,
  token,
  tokenEntry,
  type ChainName,
} from '@synq/chain-registry/arc';
import { verifyCode, type ArcChain, type TransferSigner } from './arc.js';
import { sendCall } from './cctp.js';
import { ArcExecutionError } from './arc.js';

/** Circle Gateway on-chain legs for the restricted executor. */

export const GATEWAY_WALLET_ABI = [
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'value', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const GATEWAY_MINTER_ABI = [
  {
    type: 'function',
    name: 'gatewayMint',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'attestationPayload', type: 'bytes' },
      { name: 'signature', type: 'bytes' },
    ],
    outputs: [],
  },
] as const;

/** Prefund: approve the Gateway wallet then deposit (a plain transfer is NOT credited). */
export async function depositToGateway(input: {
  chain: ArcChain;
  signer: TransferSigner;
  amount: bigint;
  onHash: (step: 'approve' | 'deposit', h: Hex) => Promise<void> | void;
}): Promise<{ approveTx: Hex | null; depositTx: Hex }> {
  const name = input.chain.profile.name as ChainName;
  const usdc = token(name, 'USDC');
  const wallet = contract(name, 'GATEWAY_WALLET');
  await verifyCode(input.chain, usdc.address, tokenEntry(usdc).codeHash);
  await verifyCode(input.chain, wallet.address, wallet.codeHash);
  const balance = await input.chain.client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [input.signer.address],
  });
  if (balance < input.amount)
    throw new ArcExecutionError(
      'INSUFFICIENT_FUNDS',
      `${balance} < ${input.amount}`,
    );
  const allowance = await input.chain.client.readContract({
    address: usdc.address,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [input.signer.address, wallet.address],
  });
  const approveTx =
    allowance < input.amount
      ? await sendCall(
          input.chain,
          input.signer,
          usdc.address,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [wallet.address, input.amount],
          }),
          (h) => input.onHash('approve', h),
        )
      : null;
  const depositTx = await sendCall(
    input.chain,
    input.signer,
    wallet.address,
    encodeFunctionData({
      abi: GATEWAY_WALLET_ABI,
      functionName: 'deposit',
      args: [usdc.address, input.amount],
    }),
    (h) => input.onHash('deposit', h),
  );
  return { approveTx, depositTx };
}

/** Destination: submit Circle's attestation to the minter and prove the mint to `recipient`. */
export async function gatewayMint(input: {
  chain: ArcChain;
  signer: TransferSigner;
  attestation: Hex;
  signature: Hex;
  recipient: `0x${string}`;
  expected: bigint;
  onHash: (h: Hex) => Promise<void> | void;
}) {
  const name = input.chain.profile.name as ChainName;
  const minter = contract(name, 'GATEWAY_MINTER');
  await verifyCode(input.chain, minter.address, minter.codeHash);
  const mintTx = await sendCall(
    input.chain,
    input.signer,
    minter.address,
    encodeFunctionData({
      abi: GATEWAY_MINTER_ABI,
      functionName: 'gatewayMint',
      args: [input.attestation, input.signature],
    }),
    input.onHash,
  );
  const r = await input.chain.client.getTransactionReceipt({ hash: mintTx });
  const usdc = token(name, 'USDC');
  const toRecipient = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r.logs,
  }).filter(
    (l) =>
      l.address.toLowerCase() === usdc.address.toLowerCase() &&
      l.args.to.toLowerCase() === input.recipient.toLowerCase(),
  );
  if (toRecipient.length !== 1 || toRecipient[0]!.args.value !== input.expected)
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `expected one mint of ${input.expected}, saw ${toRecipient.map((l) => l.args.value).join(',')}`,
    );
  return {
    mintTx,
    logIndex: toRecipient[0]!.logIndex!,
    blockNumber: r.blockNumber,
    explorer: `${input.chain.profile.explorer}/tx/${mintTx}`,
  };
}
