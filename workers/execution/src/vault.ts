import {
  decodeErrorResult,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  keccak256,
  toBytes,
  parseAbi,
  recoverAddress,
  type Address,
  type Hex,
} from 'viem';
import { contract, type ContractKind } from '@synq/chain-registry/arc';
import { ArcExecutionError, verifyCode, type ArcChain } from './arc.js';

/**
 * Synq Arc group vault: a canonical Safe v1.4.1 proxy whose owners hold
 * custody (M-of-N EIP-712 signatures over a SafeTx and the Safe nonce), plus a
 * SynqArcVaultPolicy installed as both guard and module (governance timelock,
 * scoped operator, guardian pause on outflows). This module builds SafeTx
 * typed data, collects independent owner signatures, packs them in Safe order,
 * and simulates before anything is broadcast. It never holds a key: callers
 * pass `SafeTxSigner`s backed by separate key material.
 */

export const SAFE_ABI = parseAbi([
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
  'function isOwner(address owner) view returns (bool)',
  'function isModuleEnabled(address module) view returns (bool)',
  'function getStorageAt(uint256 offset, uint256 length) view returns (bytes)',
  'function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)',
  'function domainSeparator() view returns (bytes32)',
  'function isValidSignature(bytes32 hash, bytes signature) view returns (bytes4)',
  'function VERSION() view returns (string)',
  'function getTransactionHash(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function changeThreshold(uint256 _threshold)',
  'event ExecutionSuccess(bytes32 indexed txHash, uint256 payment)',
  'event ExecutionFailure(bytes32 indexed txHash, uint256 payment)',
  'error GS(string reason)',
]);

export const VAULT_FACTORY_ABI = parseAbi([
  'struct VaultParams { address[] owners; uint256 threshold; address guardian; address operator; uint256 delay; address[] recipients; uint256 perPaymentCap; uint256 windowCap; }',
  'function createVault(VaultParams p, bytes32 salt) returns (bytes32 vaultId, address safe, address policy)',
  'function GUARD_SLOT() view returns (uint256)',
  'function FALLBACK_HANDLER_SLOT() view returns (uint256)',
  'function deployReplacementPolicy(address guardian, address operator, uint256 delay, address[] recipients, uint256 perPaymentCap, uint256 windowCap, bytes32 salt) returns (address)',
  'event ReplacementPolicyDeployed(address indexed safe, address indexed policy, address guardian, address operator)',
  'function token() view returns (address)',
  'function safeSingleton() view returns (address)',
  'function safeProxyFactory() view returns (address)',
  'function fallbackHandler() view returns (address)',
  'event VaultCreated(bytes32 indexed vaultId, address indexed safe, address indexed policy, address[] owners, uint256 threshold, address guardian, address operator, uint256 delay, address creator)',
]);

export const VAULT_POLICY_ABI = parseAbi([
  'function UPGRADE_AUTHORITY() view returns (string)',
  'function delay() view returns (uint256)',
  'function safe() view returns (address)',
  'function token() view returns (address)',
  'function guardian() view returns (address)',
  'function operator() view returns (address)',
  'function paused() view returns (bool)',
  'function pausedUntil() view returns (uint64)',
  'function PAUSE_COOLDOWN() view returns (uint256)',
  'function MAX_PAUSE() view returns (uint256)',
  'function setGuardian(address guardian_)',
  'function perPaymentCap() view returns (uint256)',
  'function windowCap() view returns (uint256)',
  'function isRecipient(address) view returns (bool)',
  'function eta(bytes32) view returns (uint256)',
  'function operationId(address to, uint256 value, bytes data, uint8 operation) pure returns (bytes32)',
  'function queue(address to, uint256 value, bytes data, uint8 operation) returns (bytes32)',
  'function cancel(bytes32 id)',
  'function pause()',
  'function unpause()',
  'function revokeOperator()',
  'function setOperator(address operator_)',
  'function pay(address recipient, uint256 amount, bytes32 ref)',
  'event OperationQueued(bytes32 indexed id, address indexed to, uint256 value, uint8 operation, bytes data, uint256 eta)',
  'event OperatorPaid(bytes32 indexed ref, address indexed operator, address indexed recipient, address token, uint256 amount)',
  'event Paused(address indexed guardian, uint64 until)',
  'event Unpaused(address indexed by)',
  'error NotFactory()',
  'error AlreadyBound()',
  'error NotSafe()',
  'error NotGuardian()',
  'error NotOperator()',
  'error InvalidDelay()',
  'error InvalidAddress(address value)',
  'error AlreadyQueued(bytes32 id)',
  'error NotQueued(bytes32 id)',
  'error NotReady(bytes32 id, uint256 eta)',
  'error Expired(bytes32 id)',
  'error RefundsDisabled()',
  'error OutflowsPaused()',
  'error RecipientNotAllowed(address recipient)',
  'error CapExceeded(uint256 amount, uint256 cap)',
  'error ZeroAmount()',
  'error PaymentFailed()',
  'error Reentrancy()',
  'error PauseCooldown(uint256 availableAt)',
  'error InvalidReplacement(address guard)',
]);

export const MILESTONE_ESCROW_ABI = parseAbi([
  'function UPGRADE_AUTHORITY() view returns (string)',
  'function token() view returns (address)',
  'function dealCount() view returns (uint256)',
  'function totalLiability() view returns (uint256)',
  'function open(address payee, address arbiter, uint64 refundAfter, bytes32 termsHash, uint128[] amounts) returns (uint256)',
  'function release(uint256 dealId, uint256 index)',
  'function withdraw(uint256 dealId, uint256 index)',
  'function refund(uint256 dealId, uint256 index)',
  'function dispute(uint256 dealId)',
  'function withdrawDispute(uint256 dealId)',
  'function disputeActive(uint256 dealId) view returns (bool)',
  'function DISPUTE_PERIOD() view returns (uint256)',
  'event Disputed(uint256 indexed dealId, address indexed by, uint64 deadline)',
  'event DisputeWithdrawn(uint256 indexed dealId, address indexed by)',
  'event DealOpened(uint256 indexed dealId, address indexed payer, address indexed payee, address arbiter, bytes32 termsHash, uint256 total, uint64 refundAfter)',
  'event MilestoneReleased(uint256 indexed dealId, uint256 indexed milestone, address indexed by, uint256 amount)',
  'event MilestoneWithdrawn(uint256 indexed dealId, uint256 indexed milestone, address indexed payee, uint256 amount)',
  'event MilestoneRefunded(uint256 indexed dealId, uint256 indexed milestone, address indexed payer, uint256 amount)',
  'error InvalidDeal()',
  'error InvalidAmount()',
  'error UnknownDeal(uint256 dealId)',
  'error UnknownMilestone(uint256 dealId, uint256 milestone)',
  'error WrongStatus(uint8 status)',
  'error NotAuthorized(address caller)',
  'error RefundNotYetAllowed(uint64 refundAfter)',
  'error DealDisputed()',
  'error NoArbiter()',
  'error DisputeAlreadyUsed()',
  'error NotDisputeRaiser()',
  'error TransferFailed()',
  'error Reentrancy()',
]);

/** Safe v1.4.1 guard storage slot: keccak256("guard_manager.guard.address"). */
export const SAFE_GUARD_SLOT = BigInt(
  keccak256(toBytes('guard_manager.guard.address')),
);
/** Safe v1.4.1 fallback handler slot: keccak256("fallback_manager.handler.address"). */
export const SAFE_FALLBACK_HANDLER_SLOT = BigInt(
  keccak256(toBytes('fallback_manager.handler.address')),
);
const SENTINEL = '0x0000000000000000000000000000000000000001' as Address;

/**
 * EIP-712 hash of a SafeMessage over `message` for `safe`: what a 1271
 * validator built on Safe's message format would ask owners to sign.
 */
export function safeMessageHash(
  chainId: number,
  safe: Address,
  message: Hex,
): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe },
    types: { SafeMessage: [{ name: 'message', type: 'bytes' }] },
    primaryType: 'SafeMessage',
    message: { message },
  });
}

export const OPERATION = { CALL: 0, DELEGATECALL: 1 } as const;

/** A Safe transaction. Refund fields are fixed at zero: the policy rejects refunds. */
export type SafeTx = Readonly<{
  to: Address;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  nonce: bigint;
}>;

const SAFE_TX_TYPES = {
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
} as const;

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

/** EIP-712 typed data for a SafeTx, bound to chain id and Safe address. */
export function safeTxTypedData(chainId: number, safe: Address, tx: SafeTx) {
  return {
    domain: { chainId, verifyingContract: safe },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx' as const,
    message: {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: 0n,
      baseGas: 0n,
      gasPrice: 0n,
      gasToken: ZERO,
      refundReceiver: ZERO,
      nonce: tx.nonce,
    },
  };
}

export function safeTxHash(chainId: number, safe: Address, tx: SafeTx): Hex {
  return hashTypedData(safeTxTypedData(chainId, safe, tx));
}

/** One owner's signer. Each owner signs with its own key material. */
export interface SafeTxSigner {
  address: Address;
  signTypedData(typedData: ReturnType<typeof safeTxTypedData>): Promise<Hex>;
}

export type OwnerSignature = Readonly<{ owner: Address; signature: Hex }>;

/** Collects one EIP-712 signature per owner and checks each recovers to its owner. */
export async function collectSignatures(
  chainId: number,
  safe: Address,
  tx: SafeTx,
  signers: readonly SafeTxSigner[],
): Promise<OwnerSignature[]> {
  const typed = safeTxTypedData(chainId, safe, tx);
  const hash = hashTypedData(typed);
  const out: OwnerSignature[] = [];
  for (const s of signers) {
    const signature = await s.signTypedData(typed);
    const recovered = await recoverAddress({ hash, signature });
    if (getAddress(recovered) !== getAddress(s.address))
      throw new ArcExecutionError(
        'SIGNER_MISMATCH',
        `${recovered} != ${s.address}`,
      );
    out.push({ owner: getAddress(s.address), signature });
  }
  return out;
}

/** Safe requires signatures ordered by strictly ascending owner address. */
export function packSignatures(sigs: readonly OwnerSignature[]): Hex {
  const sorted = [...sigs].sort((a, b) =>
    BigInt(a.owner) < BigInt(b.owner) ? -1 : 1,
  );
  for (let i = 1; i < sorted.length; i++)
    if (sorted[i]!.owner === sorted[i - 1]!.owner)
      throw new ArcExecutionError('SIGNER_MISMATCH', 'duplicate owner');
  return `0x${sorted.map((s) => s.signature.slice(2)).join('')}` as Hex;
}

export function encodeExecTransaction(tx: SafeTx, signatures: Hex): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [
      tx.to,
      tx.value,
      tx.data,
      tx.operation,
      0n,
      0n,
      0n,
      ZERO,
      ZERO,
      signatures,
    ],
  });
}

export type SimResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: string }>;

/** Best-effort decode of a revert into a readable reason (Safe GSxxx strings or Synq custom errors). */
export function revertReason(error: unknown): string {
  let e = error as { data?: unknown; cause?: unknown; shortMessage?: string };
  for (let depth = 0; e && depth < 6; depth++) {
    const data =
      typeof e.data === 'string'
        ? e.data
        : typeof (e.data as { data?: unknown } | undefined)?.data === 'string'
          ? ((e.data as { data: string }).data as string)
          : undefined;
    if (data && data.startsWith('0x') && data.length >= 10) {
      for (const abi of [VAULT_POLICY_ABI, MILESTONE_ESCROW_ABI]) {
        try {
          const d = decodeErrorResult({ abi, data: data as Hex });
          return `${d.errorName}(${(d.args ?? []).map(String).join(',')})`;
        } catch {
          /* try next */
        }
      }
      if (data.startsWith('0x08c379a0'))
        try {
          const d = decodeErrorResult({
            abi: parseAbi(['error Error(string)']),
            data: data as Hex,
          });
          return String(d.args[0]);
        } catch {
          /* fall through */
        }
      return data;
    }
    const msg = e.shortMessage ?? (e as { message?: string }).message;
    const m = msg?.match(/reverted with the following reason:\s*\n?(.+)/);
    if (m) return m[1]!.trim();
    const gs = msg?.match(/\bGS\d{3}\b/);
    if (gs) return gs[0];
    e = e.cause as typeof e;
  }
  return String((error as Error)?.message ?? error).slice(0, 200);
}

/** eth_call simulation of a call from `from`. Nothing is signed or broadcast. */
export async function simulate(
  chain: ArcChain,
  from: Address,
  to: Address,
  data: Hex,
): Promise<SimResult> {
  try {
    await chain.client.call({ account: from, to, data });
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: revertReason(error) };
  }
}

const word = (w: Hex) => getAddress(`0x${w.slice(-40)}`);

/**
 * Reads a deployed vault and checks its health against the registry: SafeL2
 * v1.4.1 singleton in slot 0, the policy installed as guard AND as the only
 * module, the policy bound to this Safe, and the Synq fallback handler (not
 * the stock CompatibilityFallbackHandler, whose owner-signature ERC-1271 path
 * bypasses the guard). Anything else is reported as a problem.
 */
export async function readVault(chain: ArcChain, safe: Address) {
  const c = chain.client;
  const slot = (n: bigint) =>
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getStorageAt',
      args: [n, 1n],
    });
  const [
    owners,
    threshold,
    nonce,
    version,
    guardWord,
    handlerWord,
    singletonWord,
    page,
  ] = await Promise.all([
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    }),
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }),
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'VERSION' }),
    slot(SAFE_GUARD_SLOT),
    slot(SAFE_FALLBACK_HANDLER_SLOT),
    slot(0n),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getModulesPaginated',
      args: [SENTINEL, 10n],
    }),
  ]);
  const guard = word(guardWord);
  const fallbackHandler = word(handlerWord);
  const singleton = word(singletonWord);
  const modules = page[0].map((m) => getAddress(m));
  const moduleEnabled = modules.includes(guard);
  let policySafe: Address | null = null;
  try {
    policySafe = getAddress(
      await c.readContract({
        address: guard,
        abi: VAULT_POLICY_ABI,
        functionName: 'safe',
      }),
    );
  } catch {
    policySafe = null;
  }
  const name = chain.profile.name;
  const expected = {
    singleton: contract(name, 'SAFE_L2_SINGLETON').address,
    fallbackHandler: contract(name, 'SYNQ_ARC_FALLBACK_HANDLER').address,
  };
  const problems: string[] = [];
  if (version !== '1.4.1') problems.push(`VERSION ${version}`);
  if (singleton !== getAddress(expected.singleton))
    problems.push(`singleton ${singleton}`);
  if (fallbackHandler !== getAddress(expected.fallbackHandler))
    problems.push(`fallbackHandler ${fallbackHandler}`);
  if (policySafe !== getAddress(safe))
    problems.push(`guard ${guard} not bound to this Safe`);
  if (!moduleEnabled) problems.push('policy is not an enabled module');
  if (modules.length !== 1 || page[1] !== SENTINEL)
    problems.push(`unexpected modules ${modules.join(',')}`);
  return {
    owners,
    threshold,
    nonce,
    version,
    guard,
    fallbackHandler,
    singleton,
    modules,
    moduleEnabled,
    policySafe,
    healthy: problems.length === 0,
    problems,
  };
}

/** Verifies every Safe v1.4.1 infrastructure contract the vault factory depends on. */
export async function verifySafeInfrastructure(chain: ArcChain) {
  const kinds: ContractKind[] = ['SAFE_L2_SINGLETON', 'SAFE_PROXY_FACTORY'];
  const out: Record<string, { address: Address; codeHash: Hex }> = {};
  for (const kind of kinds) {
    const entry = contract(chain.profile.name, kind);
    out[kind] = {
      address: entry.address,
      codeHash: await verifyCode(chain, entry.address, entry.codeHash),
    };
  }
  return out;
}

/** Safe self-calls and token calls that change who or what can move funds. */
const GOVERNANCE_ABI = parseAbi([
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'function approve(address spender, uint256 amount)',
  'function setOperator(address operator_)',
  'function setGuardian(address guardian_)',
]);
export type QueuedOperationRisk = Readonly<{
  risk: 'HIGH' | 'NORMAL';
  reasons: readonly string[];
}>;

/**
 * Classifies a timelocked vault operation (an `OperationQueued` event) for
 * monitoring, so owners see the residual-risk paths of the vault policy
 * register (R3 allowances, R4 modules/guard, R5 fallback handler, R6
 * SignMessageLib via DELEGATECALL) during the delay, before they can execute.
 * Pure: it never reads the chain and never blocks anything by itself.
 */
export function classifyQueuedOperation(
  op: Readonly<{ to: Address; value: bigint; operation: number; data: Hex }>,
  vault: Readonly<{ safe: Address; policy: Address }>,
): QueuedOperationRisk {
  const reasons: string[] = [];
  const to = op.to.toLowerCase();
  let call: { functionName: string; args?: readonly unknown[] } | null = null;
  try {
    call = decodeFunctionData({ abi: GOVERNANCE_ABI, data: op.data });
  } catch {
    call = null;
  }
  const name = call?.functionName;
  if (op.operation !== OPERATION.CALL)
    reasons.push(
      'DELEGATECALL runs foreign code as the Safe (e.g. SignMessageLib)',
    );
  if (to === vault.safe.toLowerCase() && name && name !== 'approve')
    reasons.push(`Safe configuration change: ${name}`);
  if (
    to === vault.policy.toLowerCase() &&
    (name === 'setOperator' || name === 'setGuardian')
  )
    reasons.push(`policy role change: ${name}`);
  if (name === 'approve' && (call!.args![1] as bigint) > 0n)
    reasons.push('non-zero ERC-20 allowance outlives a later pause');
  if (op.value > 0n) reasons.push('native value transfer');
  return { risk: reasons.length ? 'HIGH' : 'NORMAL', reasons };
}
