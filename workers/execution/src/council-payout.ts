import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { contract, token, type ChainName } from '@synq/chain-registry/arc';
import {
  GovernanceError,
  assertExecutable,
  currentTerm,
  executeDecision,
  isOwner,
  requireBoundCustody,
  withdrawalActionHash,
  type CouncilStore,
  type GovernancePolicy,
  type SafeCustody,
} from '@synq/governance';
import {
  ArcExecutionError,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import { sendCall } from './cctp.js';
import {
  OPERATION,
  SAFE_ABI,
  SAFE_GUARD_SLOT,
  VAULT_POLICY_ABI,
  encodeExecTransaction,
  packSignatures,
  safeTxHash,
  simulate,
  type OwnerSignature,
  type SafeTx,
} from './vault.js';

/**
 * Council-gated vault withdrawals (ADR-002).
 *
 * Synq acts on a council decision only when the vault's Safe enforces that
 * council on chain: owners exactly the current term's seat holders, threshold
 * exactly the council threshold, both read live before every payout. The
 * Safe transaction must then carry signatures from owners who are ALSO among
 * the decision's recorded signers, at least the on-chain threshold of them.
 * Anything else (an unbound vault, Safe signatures from keys that did not
 * approve the decision, a forged or replayed decision) is refused before
 * anything is signed or broadcast.
 */

/** Live custody facts: Safe threshold and owners, plus the policy operator path. */
export async function readCustody(
  chain: ArcChain,
  safe: Address,
  policy: Address | null,
): Promise<SafeCustody> {
  const c = chain.client;
  const blockNumber = await c.getBlockNumber();
  const at = { blockNumber } as const;
  const sentinel = '0x0000000000000000000000000000000000000001' as Address;
  const [threshold, owners, page, guardWord] = await Promise.all([
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
      ...at,
    }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getOwners',
      ...at,
    }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getModulesPaginated',
      args: [sentinel, 100n],
      ...at,
    }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getStorageAt',
      args: [SAFE_GUARD_SLOT, 1n],
      ...at,
    }),
  ]);
  let operator: SafeCustody['operator'] = null;
  if (policy) {
    const read = <
      F extends 'operator' | 'perPaymentCap' | 'windowCap' | 'paused',
    >(
      functionName: F,
    ) =>
      c.readContract({
        address: policy,
        abi: VAULT_POLICY_ABI,
        functionName,
        ...at,
      });
    const [op, perPaymentCap, windowCap, paused] = await Promise.all([
      read('operator'),
      read('perPaymentCap'),
      read('windowCap'),
      read('paused'),
    ]);
    operator = {
      operator: getAddress(op as Address),
      perPaymentCap: perPaymentCap as bigint,
      windowCap: windowCap as bigint,
      paused: paused as boolean,
    };
  }
  return Object.freeze({
    chainId: chain.profile.chainId,
    safe: getAddress(safe),
    threshold: Number(threshold),
    owners: owners.map((o) => getAddress(o)),
    operator,
    modules: page[0].map(getAddress),
    modulesComplete: page[1].toLowerCase() === sentinel,
    guard: getAddress(`0x${guardWord.slice(-40)}`),
    expectedPolicy: policy ? getAddress(policy) : null,
    blockNumber,
  });
}

/** Reads the registry vault (Safe + policy) on `chain`. */
export const readRegistryVaultCustody = (chain: ArcChain) =>
  readCustody(
    chain,
    contract(chain.profile.name as ChainName, 'SYNQ_ARC_VAULT_SAFE').address,
    contract(chain.profile.name as ChainName, 'SYNQ_ARC_VAULT_POLICY').address,
  );

export function withdrawalSafeTx(input: {
  usdc: Address;
  recipient: Address;
  amount: bigint;
  nonce: bigint;
}): SafeTx {
  return {
    to: input.usdc,
    value: 0n,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [input.recipient, input.amount],
    }),
    operation: OPERATION.CALL,
    nonce: input.nonce,
  };
}

export async function executeCouncilWithdrawal(input: {
  chain: ArcChain;
  store: CouncilStore;
  policy: GovernancePolicy;
  digest: Hex;
  safe: Address;
  vaultPolicy: Address | null;
  recipient: Address;
  amount: bigint;
  /** Safe owner signatures over the SafeTx (from `withdrawalSafeTx` at the live nonce). */
  signatures: readonly OwnerSignature[];
  relayer: TransferSigner;
  now: number;
  /** Must record the hash durably before broadcast. */
  onHash: (h: Hex) => Promise<void> | void;
}): Promise<{ txHash: Hex; safeTxHash: Hex; custody: SafeCustody }> {
  const { chain, store, policy, now } = input;
  const custody = await readCustody(chain, input.safe, input.vaultPolicy);
  const d = await store.getDecision(input.digest);
  if (!d) throw new GovernanceError('UNKNOWN_DECISION');
  const term = await currentTerm(store, d.action.councilId, now);
  if (!term) throw new GovernanceError('TERM_INACTIVE');
  requireBoundCustody(term.term, policy, custody);
  const usdc = token(chain.profile.name as ChainName, 'USDC');
  const actionHash = withdrawalActionHash({
    chainId: chain.profile.chainId,
    token: usdc.address,
    payer: custody.safe,
    recipient: input.recipient,
    amount: input.amount,
  });
  const decision = await assertExecutable({
    store,
    decision: { digest: input.digest },
    policy,
    now,
    kind: 'WITHDRAWAL',
    actionHash,
  });
  const nonce = await chain.client.readContract({
    address: custody.safe,
    abi: SAFE_ABI,
    functionName: 'nonce',
  });
  const tx = withdrawalSafeTx({
    usdc: usdc.address,
    recipient: input.recipient,
    amount: input.amount,
    nonce,
  });
  const hash = safeTxHash(chain.profile.chainId, custody.safe, tx);
  const counted = new Map<string, OwnerSignature>();
  for (const s of input.signatures) {
    const recovered = await recoverAddress({
      hash,
      signature: s.signature,
    }).catch(() => null);
    if (!recovered || getAddress(recovered) !== getAddress(s.owner))
      throw new ArcExecutionError(
        'SIGNER_MISMATCH',
        `signature does not recover to ${s.owner}`,
      );
    if (!isOwner(custody, recovered))
      throw new ArcExecutionError(
        'SIGNER_MISMATCH',
        `${recovered} is not a Safe owner`,
      );
    if (!decision.signers.some((x) => getAddress(x) === getAddress(recovered)))
      throw new GovernanceError(
        'QUORUM_NOT_MET',
        `${recovered} did not approve council decision ${d.digest}`,
      );
    counted.set(recovered.toLowerCase(), s);
  }
  if (counted.size < custody.threshold)
    throw new GovernanceError(
      'QUORUM_NOT_MET',
      `${counted.size} council-approved owner signatures; the Safe requires ${custody.threshold}`,
    );
  const data = encodeExecTransaction(tx, packSignatures([...counted.values()]));
  const sim = await simulate(chain, input.relayer.address, custody.safe, data);
  if (!sim.ok)
    throw new ArcExecutionError(
      'SIMULATION_FAILED',
      `execTransaction reverts: ${sim.reason}`,
    );
  // Consume the decision before anything can be broadcast; the Safe nonce is
  // the on-chain replay guard for the transaction itself.
  await executeDecision({
    store,
    decision: { digest: input.digest },
    policy,
    now,
    kind: 'WITHDRAWAL',
    actionHash,
  });
  const txHash = await sendCall(
    chain,
    input.relayer,
    custody.safe,
    data,
    input.onHash,
  );
  return { txHash, safeTxHash: hash, custody };
}
