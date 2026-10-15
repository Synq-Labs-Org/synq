import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionSerializableEIP1559,
} from 'viem';
import { money, moneyToDecimal, type Money } from '@synq/domain';
import {
  arcNativeToUsdc,
  chainProfile,
  contract,
  tokenEntry,
  usdcToArcNativeWei,
  type ChainName,
  type ChainProfile,
  type ContractKind,
} from '@synq/chain-registry/arc';

/**
 * Arc (and Circle source-chain) value transfers for the restricted executor.
 * Order of checks, all before anything is signed: the RPC is the chain we
 * think it is; the chain allows mutation; the token is a registry asset whose
 * deployed bytecode matches the pinned hash; the call simulates; and the payer
 * can cover value plus worst-case gas. On Arc the ERC-20 amount and gas come
 * from the same USDC balance, so they are checked together. Value always moves
 * through the 6-decimal ERC-20 interface; native-value sends are refused.
 */

export class ArcExecutionError extends Error {
  constructor(
    readonly code:
      | 'WRONG_CHAIN'
      | 'MUTATION_DISABLED'
      | 'CODE_HASH_MISMATCH'
      | 'NO_CODE'
      | 'UNPINNED_CODE'
      | 'ASSET_CHAIN_MISMATCH'
      | 'SIMULATION_FAILED'
      | 'INSUFFICIENT_FUNDS'
      | 'INSUFFICIENT_GAS'
      | 'FEE_BELOW_FLOOR'
      | 'FEE_ABOVE_CAP'
      | 'SIGNER_MISMATCH'
      | 'RECEIPT_FAILED'
      | 'TRANSFER_MISMATCH'
      | 'TX_MISMATCH',
    message: string = code,
  ) {
    super(message);
    this.name = 'ArcExecutionError';
  }
}

export type ArcChain = { profile: ChainProfile; client: PublicClient };

/** Connects and proves the endpoint serves the registry chain before any use. */
export async function connectChain(
  name: ChainName,
  rpcUrl?: string,
  client?: PublicClient,
): Promise<ArcChain> {
  const profile = chainProfile(name);
  const url =
    rpcUrl ?? process.env[profile.rpcEnvironment] ?? profile.rpcUrls[0]!;
  const c =
    client ??
    (createPublicClient({
      transport: http(url, { retryCount: 3, retryDelay: 400 }),
    }) as PublicClient);
  const served = await c.getChainId();
  if (served !== profile.chainId)
    throw new ArcExecutionError(
      'WRONG_CHAIN',
      `${name} expects ${profile.chainId}, endpoint serves ${served}`,
    );
  return { profile, client: c };
}

/** The deployed bytecode at `address` must hash to the registry pin. */
export async function verifyCode(
  chain: ArcChain,
  address: Address,
  pinned: Hex | null,
): Promise<Hex> {
  if (!pinned)
    throw new ArcExecutionError(
      'UNPINNED_CODE',
      `${address} has no pinned code hash on ${chain.profile.name}`,
    );
  const code = await chain.client.getCode({ address });
  if (!code || code === '0x') throw new ArcExecutionError('NO_CODE', address);
  const hash = keccak256(code);
  if (hash !== pinned)
    throw new ArcExecutionError(
      'CODE_HASH_MISMATCH',
      `${address}: ${hash} != ${pinned}`,
    );
  return hash;
}

export async function verifyContract(chain: ArcChain, kind: ContractKind) {
  const c = contract(chain.profile.name, kind);
  return verifyCode(chain, c.address, c.codeHash);
}

export type PreparedTransfer = Readonly<{
  chain: ChainName;
  chainId: number;
  from: Address;
  to: Address;
  amount: Money;
  token: Address;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  nonce: number;
  /** Worst-case gas cost in native wei (gas × maxFeePerGas). */
  maxGasCostWei: bigint;
  codeHash: Hex;
}>;

/**
 * Prepares an exact ERC-20 transfer of `amount` from `from` to `to`. The
 * result is what the executor signs: callers cannot alter fields afterwards
 * without `signPrepared` noticing (it re-encodes and compares).
 */
export async function prepareTransfer(
  chain: ArcChain,
  input: {
    from: Address;
    to: Address;
    amount: Money;
    /** Optional cap on worst-case gas, in native wei. */
    maxGasCostWei?: bigint;
  },
): Promise<PreparedTransfer> {
  const { profile, client } = chain;
  if (!profile.mutationEnabled)
    throw new ArcExecutionError('MUTATION_DISABLED', profile.name);
  const asset = input.amount.asset;
  if (asset.chainId !== profile.chainId)
    throw new ArcExecutionError(
      'ASSET_CHAIN_MISMATCH',
      `${asset.assetId} is not on ${profile.name}`,
    );
  const entry = tokenEntry(asset);
  if (entry.permissioned)
    throw new ArcExecutionError(
      'MUTATION_DISABLED',
      `${entry.symbol} is permissioned; transfers need an entitlement`,
    );
  if (input.amount.baseUnits <= 0n)
    throw new ArcExecutionError('SIMULATION_FAILED', 'amount must be positive');
  const codeHash = await verifyCode(chain, entry.address, entry.codeHash);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [input.to, input.amount.baseUnits],
  });
  const [tokenBalance, nativeBalance, nonce, fees] = await Promise.all([
    client.readContract({
      address: entry.address,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [input.from],
    }),
    client.getBalance({ address: input.from }),
    client.getTransactionCount({ address: input.from, blockTag: 'pending' }),
    client.estimateFeesPerGas(),
  ]);
  if (tokenBalance < input.amount.baseUnits)
    throw new ArcExecutionError(
      'INSUFFICIENT_FUNDS',
      `balance ${tokenBalance} < ${input.amount.baseUnits}`,
    );
  let gas: bigint;
  try {
    const sim = await client.call({
      account: input.from,
      to: entry.address,
      data,
    });
    if (sim.data && BigInt(sim.data) !== 1n)
      throw new Error('transfer returned false');
    gas =
      ((await client.estimateGas({
        account: input.from,
        to: entry.address,
        data,
      })) *
        130n) /
      100n;
  } catch (error) {
    throw new ArcExecutionError(
      'SIMULATION_FAILED',
      String(error instanceof Error ? error.message : error).slice(0, 200),
    );
  }
  const floor = profile.minMaxFeePerGasWei ?? 0n;
  const maxPriorityFeePerGas =
    fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
      ? fees.maxPriorityFeePerGas
      : 1_000_000_000n;
  let maxFeePerGas = fees.maxFeePerGas ?? 0n;
  if (maxFeePerGas < floor) maxFeePerGas = floor;
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas;
  if (floor && maxFeePerGas < floor)
    throw new ArcExecutionError('FEE_BELOW_FLOOR', String(maxFeePerGas));
  const maxGasCostWei = gas * maxFeePerGas;
  if (input.maxGasCostWei !== undefined && maxGasCostWei > input.maxGasCostWei)
    throw new ArcExecutionError(
      'FEE_ABOVE_CAP',
      `${maxGasCostWei} > ${input.maxGasCostWei}`,
    );
  // Arc: value and gas draw on one USDC balance. Elsewhere gas is native ETH.
  const needWei =
    profile.nativeSymbol === 'USDC' && entry.symbol === 'USDC'
      ? usdcToArcNativeWei(input.amount) + maxGasCostWei
      : maxGasCostWei;
  if (nativeBalance < needWei)
    throw new ArcExecutionError(
      'INSUFFICIENT_GAS',
      `native ${nativeBalance} < value+gas ${needWei}`,
    );
  return Object.freeze({
    chain: profile.name,
    chainId: profile.chainId,
    from: input.from,
    to: input.to,
    amount: input.amount,
    token: entry.address,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    maxGasCostWei,
    codeHash,
  });
}

export function transactionOf(
  p: PreparedTransfer,
): TransactionSerializableEIP1559 & {
  chainId: number;
} {
  return {
    type: 'eip1559',
    chainId: p.chainId,
    to: p.token,
    value: 0n,
    data: p.data,
    gas: p.gas,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
    nonce: p.nonce,
  };
}

export interface TransferSigner {
  address: Address;
  signTransaction(
    tx: TransactionSerializableEIP1559 & { chainId: number },
  ): Promise<Hex>;
}

/**
 * Signs exactly the prepared transfer. Recomputes calldata from the prepared
 * recipient and amount so a tampered `data` field cannot slip through.
 */
export async function signPrepared(
  signer: TransferSigner,
  p: PreparedTransfer,
): Promise<{ raw: Hex; hash: Hex }> {
  if (signer.address.toLowerCase() !== p.from.toLowerCase())
    throw new ArcExecutionError(
      'SIGNER_MISMATCH',
      `${signer.address} != ${p.from}`,
    );
  const expected = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [p.to, p.amount.baseUnits],
  });
  if (
    expected !== p.data ||
    p.token.toLowerCase() !== p.amount.asset.address.toLowerCase()
  )
    throw new ArcExecutionError(
      'TX_MISMATCH',
      'calldata does not match recipient/amount',
    );
  const tx = transactionOf(p);
  const raw = await signer.signTransaction(tx);
  return { raw, hash: keccak256(raw) };
}

export type TransferEvidence = Readonly<{
  chain: ChainName;
  chainId: number;
  hash: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  from: Address;
  to: Address;
  amount: Money;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  feeWei: bigint;
  /** Arc only: the fee as USDC units of the same balance (dust kept separately). */
  feeUsdc: Money | null;
  explorer: string;
}>;

/**
 * Waits for the receipt and proves it: success status, and exactly one
 * Transfer(from → to, amount) emitted by the expected token. Anything else is a
 * mismatch the ledger must not record as a payment.
 */
export async function reconcileTransfer(
  chain: ArcChain,
  p: PreparedTransfer,
  hash: Hex,
): Promise<TransferEvidence> {
  const receipt = await chain.client.waitForTransactionReceipt({
    hash,
    confirmations: chain.profile.confirmations,
  });
  if (receipt.status !== 'success')
    throw new ArcExecutionError('RECEIPT_FAILED', hash);
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  }).filter((l) => l.address.toLowerCase() === p.token.toLowerCase());
  const exact = transfers.filter(
    (l) =>
      l.args.from.toLowerCase() === p.from.toLowerCase() &&
      l.args.to.toLowerCase() === p.to.toLowerCase() &&
      l.args.value === p.amount.baseUnits,
  );
  if (exact.length !== 1 || transfers.length !== 1)
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `${transfers.length} transfer logs, ${exact.length} exact`,
    );
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  const arc = chain.profile.nativeSymbol === 'USDC';
  return Object.freeze({
    chain: chain.profile.name,
    chainId: chain.profile.chainId,
    hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: p.from,
    to: p.to,
    amount: p.amount,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    feeWei,
    feeUsdc: arc
      ? arcNativeToUsdc(
          chain.profile.name as 'arc-testnet' | 'arc-mainnet',
          feeWei,
        ).usdc
      : null,
    explorer: `${chain.profile.explorer}/tx/${hash}`,
  });
}

/** Full transfer: prepare → sign → broadcast → reconcile. */
export async function executeTransfer(
  chain: ArcChain,
  signer: TransferSigner,
  input: Parameters<typeof prepareTransfer>[1],
  onBroadcast?: (hash: Hex, prepared: PreparedTransfer) => Promise<void> | void,
): Promise<TransferEvidence> {
  const prepared = await prepareTransfer(chain, input);
  const { raw, hash } = await signPrepared(signer, prepared);
  // Record the hash before the network can see it, so a crash after this line
  // reconciles by hash instead of broadcasting again.
  await onBroadcast?.(hash, prepared);
  await chain.client.sendRawTransaction({ serializedTransaction: raw });
  return reconcileTransfer(chain, prepared, hash);
}

/** Token balance as registry money. */
export async function balanceOf(
  chain: ArcChain,
  asset: Money['asset'],
  owner: Address,
): Promise<Money> {
  const entry = tokenEntry(asset);
  const units = await chain.client.readContract({
    address: entry.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  return money(asset, units);
}

export const describeTransfer = (e: TransferEvidence) =>
  `${moneyToDecimal(e.amount)} ${e.amount.asset.symbol} ${e.from} -> ${e.to} on ${e.chain} (${e.hash})`;
