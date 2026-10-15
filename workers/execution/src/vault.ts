import {
  decodeErrorResult,
  encodeFunctionData,
  getAddress,
  hashTypedData,
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
  'error TransferFailed()',
  'error Reentrancy()',
]);

/** Safe v1.4.1 guard storage slot: keccak256("guard_manager.guard.address"). */
export const SAFE_GUARD_SLOT =
  0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8n;

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

/** Reads a deployed vault and checks the policy is installed as both module and guard. */
export async function readVault(chain: ArcChain, safe: Address) {
  const c = chain.client;
  const [owners, threshold, nonce, version, guardWord] = await Promise.all([
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'getOwners' }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getThreshold',
    }),
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'nonce' }),
    c.readContract({ address: safe, abi: SAFE_ABI, functionName: 'VERSION' }),
    c.readContract({
      address: safe,
      abi: SAFE_ABI,
      functionName: 'getStorageAt',
      args: [SAFE_GUARD_SLOT, 1n],
    }),
  ]);
  const guard = getAddress(`0x${guardWord.slice(-40)}`);
  const moduleEnabled = await c.readContract({
    address: safe,
    abi: SAFE_ABI,
    functionName: 'isModuleEnabled',
    args: [guard],
  });
  return { owners, threshold, nonce, version, guard, moduleEnabled };
}

/** Verifies every Safe v1.4.1 infrastructure contract the vault factory depends on. */
export async function verifySafeInfrastructure(chain: ArcChain) {
  const kinds: ContractKind[] = [
    'SAFE_L2_SINGLETON',
    'SAFE_PROXY_FACTORY',
    'SAFE_FALLBACK_HANDLER',
  ];
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
