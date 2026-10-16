import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { money, type AssetRef } from '@synq/domain';
import { contract } from '@synq/chain-registry/arc';
import {
  ArcExecutionError,
  transactionOf,
  verifyCode,
  type ArcChain,
  type PreparedTransfer,
  type TransferEvidence,
  type TransferSigner,
} from './arc.js';
import type { OutboxRecord, OutboxStore } from './arc-outbox.js';
import { VAULT_POLICY_ABI, simulate } from './vault.js';

/**
 * Exactly-once operator payments from the governed vault
 * (`SynqArcVaultPolicy.pay`), with the same crash rules as `payOnce`: the
 * signed bytes are recorded under the idempotency key before broadcast, and
 * any later attempt for that key recovers from the record (reads the receipt
 * or rebroadcasts the very same bytes) and never signs again.
 *
 * Records use the shared `OutboxStore` / `OutboxRecord` shape so any outbox
 * store (file, memory, Postgres) holds them. For a vault payment the
 * `prepared` fields mean: `from` = operator (transaction sender, whose nonce
 * is used), `to` = recipient, `amount` = token amount moved by the vault,
 * `token` = the policy contract the transaction calls, `data` =
 * `pay(recipient, amount, ref)`, `codeHash` = the policy's pinned code hash.
 * Use `recoverVaultPay` (not `recover`) for these records.
 *
 * The contract enforces its own per-payment and 24h caps: a payment over
 * either reverts in simulation and is never signed.
 */

export type VaultPayCall = Readonly<{
  recipient: Address;
  amount: bigint;
  /** Caller reference emitted in `OperatorPaid` (e.g. keccak256 of a leg key). */
  ref: Hex;
}>;

export type VaultPayEvidence = TransferEvidence &
  Readonly<{
    vault: Address;
    policy: Address;
    ref: Hex;
    /** Index of the token Transfer(vault → recipient) log. */
    logIndex: number;
  }>;

export const vaultPayData = (c: VaultPayCall): Hex =>
  encodeFunctionData({
    abi: VAULT_POLICY_ABI,
    functionName: 'pay',
    args: [c.recipient, c.amount, c.ref],
  });

export const isVaultPayRecord = (r: OutboxRecord) =>
  r.prepared.data.slice(0, 10) ===
  vaultPayData({
    recipient: '0x0000000000000000000000000000000000000001',
    amount: 1n,
    ref: `0x${'00'.repeat(32)}`,
  }).slice(0, 10);

/** Live caps and window of the registry vault policy. */
export async function readVaultWindow(chain: ArcChain) {
  const policy = contract(chain.profile.name, 'SYNQ_ARC_VAULT_POLICY')
    .address as Address;
  const abi = [
    ...VAULT_POLICY_ABI,
    {
      type: 'function',
      name: 'windowSpent',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'uint256' }],
    },
    {
      type: 'function',
      name: 'windowStart',
      stateMutability: 'view',
      inputs: [],
      outputs: [{ type: 'uint64' }],
    },
  ] as const;
  const read = <F extends 'perPaymentCap' | 'windowCap' | 'windowSpent'>(
    functionName: F,
  ) =>
    chain.client.readContract({
      address: policy,
      abi,
      functionName,
    }) as Promise<bigint>;
  const [perPaymentCap, windowCap, windowSpent, windowStart, block, paused] =
    await Promise.all([
      read('perPaymentCap'),
      read('windowCap'),
      read('windowSpent'),
      chain.client.readContract({
        address: policy,
        abi,
        functionName: 'windowStart',
      }) as Promise<bigint>,
      chain.client.getBlock(),
      chain.client.readContract({
        address: policy,
        abi,
        functionName: 'paused',
      }) as Promise<boolean>,
    ]);
  const resetsAt = windowStart + 86_400n;
  const rolled = block.timestamp >= resetsAt;
  const spent = rolled ? 0n : windowSpent;
  return {
    policy,
    perPaymentCap,
    windowCap,
    windowSpent: spent,
    remaining: windowCap > spent ? windowCap - spent : 0n,
    windowStart,
    resetsAt: rolled ? block.timestamp + 86_400n : resetsAt,
    blockTimestamp: block.timestamp,
    paused,
  };
}

function assertSameVaultPayment(
  r: OutboxRecord,
  operator: Address,
  policy: Address,
  c: VaultPayCall,
) {
  const p = r.prepared;
  if (
    !isVaultPayRecord(r) ||
    p.from.toLowerCase() !== operator.toLowerCase() ||
    p.token.toLowerCase() !== policy.toLowerCase() ||
    p.data !== vaultPayData(c)
  )
    throw new ArcExecutionError(
      'TX_MISMATCH',
      `idempotency key ${r.key} already used for a different payment`,
    );
}

export type VaultPayOnceResult = Readonly<{
  record: OutboxRecord;
  signedNow: boolean;
  evidence: VaultPayEvidence | null;
}>;

export async function vaultPayOnce(input: {
  store: OutboxStore;
  key: string;
  chain: ArcChain;
  /** The vault operator's signer (transaction sender). */
  signer: TransferSigner;
  asset: AssetRef;
  call: VaultPayCall;
  /**
   * Runs only for a NEW transaction, after every chain read and gas check
   * and immediately before signing and recording (e.g. the caller's
   * re-check under lock and the Kernel grant admission, which consumes the
   * grant). Nothing but signing and the record write follows it, so a
   * transient RPC error never burns a grant.
   */
  authorize: () => Promise<void>;
  now: () => number;
  /** Runs after the record is durable and before broadcast. */
  afterRecord?: (r: OutboxRecord) => Promise<void> | void;
}): Promise<VaultPayOnceResult> {
  const { chain, store, signer, call } = input;
  const policyEntry = contract(chain.profile.name, 'SYNQ_ARC_VAULT_POLICY');
  const policy = policyEntry.address as Address;
  const vault = contract(chain.profile.name, 'SYNQ_ARC_VAULT_SAFE')
    .address as Address;
  const existing = await store.get(input.key);
  if (existing) {
    assertSameVaultPayment(existing, signer.address, policy, call);
    return recoverVaultPay(store, chain, existing, input.asset, input.now);
  }
  if (!chain.profile.mutationEnabled)
    throw new ArcExecutionError('MUTATION_DISABLED', chain.profile.name);
  const codeHash = await verifyCode(chain, policy, policyEntry.codeHash);
  const [boundSafe, operator] = await Promise.all([
    chain.client.readContract({
      address: policy,
      abi: VAULT_POLICY_ABI,
      functionName: 'safe',
    }),
    chain.client.readContract({
      address: policy,
      abi: VAULT_POLICY_ABI,
      functionName: 'operator',
    }),
  ]);
  if (boundSafe.toLowerCase() !== vault.toLowerCase())
    throw new ArcExecutionError('TX_MISMATCH', `policy bound to ${boundSafe}`);
  if (operator.toLowerCase() !== signer.address.toLowerCase())
    throw new ArcExecutionError(
      'SIGNER_MISMATCH',
      'signer is not the vault operator',
    );
  const data = vaultPayData(call);
  const sim = await simulate(chain, signer.address, policy, data);
  if (!sim.ok)
    throw new ArcExecutionError(
      'SIMULATION_FAILED',
      `vault pay reverted in simulation: ${sim.reason}`,
    );
  const [gasEstimate, nonce, fees, nativeBalance] = await Promise.all([
    chain.client.estimateGas({ account: signer.address, to: policy, data }),
    chain.client.getTransactionCount({
      address: signer.address,
      blockTag: 'pending',
    }),
    chain.client.estimateFeesPerGas(),
    chain.client.getBalance({ address: signer.address }),
  ]);
  const gas = (gasEstimate * 130n) / 100n;
  const floor = chain.profile.minMaxFeePerGasWei ?? 0n;
  const tip =
    fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
      ? fees.maxPriorityFeePerGas
      : 1_000_000_000n;
  let maxFeePerGas = fees.maxFeePerGas ?? 0n;
  if (maxFeePerGas < floor) maxFeePerGas = floor;
  if (maxFeePerGas < tip) maxFeePerGas = tip;
  const maxGasCostWei = gas * maxFeePerGas;
  if (nativeBalance < maxGasCostWei)
    throw new ArcExecutionError(
      'INSUFFICIENT_GAS',
      `operator native ${nativeBalance} < gas ${maxGasCostWei}`,
    );
  const prepared: PreparedTransfer = Object.freeze({
    chain: chain.profile.name,
    chainId: chain.profile.chainId,
    from: signer.address,
    to: call.recipient,
    amount: money(input.asset, call.amount),
    token: policy,
    data,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
    nonce,
    maxGasCostWei,
    codeHash,
  });
  if (vaultPayData(call) !== prepared.data)
    throw new ArcExecutionError('TX_MISMATCH', 'calldata changed');
  await input.authorize();
  const raw = await signer.signTransaction(transactionOf(prepared));
  const hash = keccak256(raw);
  const record: OutboxRecord = {
    key: input.key,
    state: 'SIGNED',
    prepared,
    raw,
    hash,
    evidence: null,
    note: `vault-pay policy=${policy} vault=${vault}`,
    updatedAt: input.now(),
  };
  if (!(await store.create(record))) {
    const winner = (await store.get(input.key))!;
    assertSameVaultPayment(winner, signer.address, policy, call);
    return recoverVaultPay(store, chain, winner, input.asset, input.now);
  }
  await input.afterRecord?.(record);
  await chain.client.sendRawTransaction({ serializedTransaction: raw });
  const evidence = await reconcileVaultPay(chain, record, input.asset);
  const done: OutboxRecord = {
    ...record,
    state: 'CONFIRMED',
    evidence,
    updatedAt: input.now(),
  };
  await store.update(done);
  return { record: done, signedNow: true, evidence };
}

/**
 * Proves a vault payment from its receipt: success, exactly one token
 * Transfer(vault → recipient, amount) and the policy's OperatorPaid event
 * with the same reference, recipient and amount.
 */
export async function reconcileVaultPay(
  chain: ArcChain,
  r: OutboxRecord,
  asset: AssetRef,
): Promise<VaultPayEvidence> {
  const vault = contract(chain.profile.name, 'SYNQ_ARC_VAULT_SAFE')
    .address as Address;
  const p = r.prepared;
  const receipt = await chain.client.waitForTransactionReceipt({
    hash: r.hash,
    confirmations: chain.profile.confirmations,
  });
  if (receipt.status !== 'success')
    throw new ArcExecutionError('RECEIPT_FAILED', r.hash);
  const transfers = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  }).filter((l) => l.address.toLowerCase() === asset.address.toLowerCase());
  const exact = transfers.filter(
    (l) =>
      l.args.from.toLowerCase() === vault.toLowerCase() &&
      l.args.to.toLowerCase() === p.to.toLowerCase() &&
      l.args.value === p.amount.baseUnits,
  );
  const paid = parseEventLogs({
    abi: VAULT_POLICY_ABI,
    eventName: 'OperatorPaid',
    logs: receipt.logs,
  }).filter((l) => l.address.toLowerCase() === p.token.toLowerCase());
  const ref = `0x${p.data.slice(-64)}` as Hex;
  if (
    exact.length !== 1 ||
    transfers.length !== 1 ||
    paid.length !== 1 ||
    paid[0]!.args.ref !== ref ||
    paid[0]!.args.recipient.toLowerCase() !== p.to.toLowerCase() ||
    paid[0]!.args.amount !== p.amount.baseUnits
  )
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `${transfers.length} transfer logs, ${exact.length} exact, ${paid.length} OperatorPaid`,
    );
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  return Object.freeze({
    chain: chain.profile.name,
    chainId: chain.profile.chainId,
    hash: r.hash,
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash,
    from: vault,
    to: p.to,
    amount: p.amount,
    gasUsed: receipt.gasUsed,
    effectiveGasPrice: receipt.effectiveGasPrice,
    feeWei,
    feeUsdc: null,
    explorer: `${chain.profile.explorer}/tx/${r.hash}`,
    vault,
    policy: p.token,
    ref,
    logIndex: exact[0]!.logIndex!,
  });
}

/** Settles a recorded vault payment from the chain. Never signs. */
export async function recoverVaultPay(
  store: OutboxStore,
  chain: ArcChain,
  r: OutboxRecord,
  asset: AssetRef,
  now: () => number,
): Promise<VaultPayOnceResult> {
  if (r.state === 'CONFIRMED')
    return {
      record: r,
      signedNow: false,
      evidence: await reconcileVaultPay(chain, r, asset),
    };
  if (r.state !== 'SIGNED')
    return { record: r, signedNow: false, evidence: null };
  const readReceipt = async () => {
    for (let i = 0; i < 3; i++) {
      const got = await chain.client
        .getTransactionReceipt({ hash: r.hash })
        .catch(() => null);
      if (got) return got;
      if (i < 2) await new Promise((ok) => setTimeout(ok, 50 * (i + 1)));
    }
    return null;
  };
  let receipt = await readReceipt();
  if (!receipt) {
    const mined = await chain.client.getTransactionCount({
      address: r.prepared.from,
      blockTag: 'latest',
    });
    // The nonce moved: before blaming another transaction, look for ours again
    // (it may have been mined between the reads, or a read may have failed).
    if (mined > r.prepared.nonce) receipt = await readReceipt();
  }
  let next: OutboxRecord;
  let evidence: VaultPayEvidence | null = null;
  if (receipt) {
    if (receipt.status === 'success') {
      evidence = await reconcileVaultPay(chain, r, asset);
      next = { ...r, state: 'CONFIRMED', evidence, updatedAt: now() };
    } else
      next = {
        ...r,
        state: 'FAILED',
        note: 'receipt reverted',
        updatedAt: now(),
      };
  } else {
    const mined = await chain.client.getTransactionCount({
      address: r.prepared.from,
      blockTag: 'latest',
    });
    if (mined > r.prepared.nonce)
      next = {
        ...r,
        state: 'NEEDS_REVIEW',
        note: `nonce ${r.prepared.nonce} consumed by another transaction; not re-paying`,
        updatedAt: now(),
      };
    else {
      // The very same signed bytes: a no-op if the first broadcast landed.
      await chain.client
        .sendRawTransaction({ serializedTransaction: r.raw })
        .catch((e: Error) => {
          if (!/known|already|underpriced|nonce too low/i.test(e.message))
            throw e;
        });
      evidence = await reconcileVaultPay(chain, r, asset);
      next = { ...r, state: 'CONFIRMED', evidence, updatedAt: now() };
    }
  }
  await store.update(next);
  return { record: next, signedNow: false, evidence };
}
