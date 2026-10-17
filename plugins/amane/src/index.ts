import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { ARC_USDC, artifacts, verifyDeployment } from '@amane/arc';
import {
  PAY,
  actionHash,
  compilePolicy,
  domain,
  leaseHash,
  types,
  validateAction,
  validateLease,
  type ActionIntent,
  type AgentLease,
  type ExecutionState,
  type RootPolicy,
} from '@amane/policy';
import { verifyExecution } from '@amane/verify';

/*
 * Synq's typed adapter over the pinned Amane SDK (vendor/amane, release
 * a60a90a: restricted PAY on Arc testnet). It reads the enforcing contract's
 * live state, builds exact PAY intents and their calldata, and verifies the
 * contract's Executed event. It holds no keys: the agent key signs intents in
 * the execution worker, and the owner signs policies and leases with their own
 * wallet. Amane never depends on Synq; Synq only consumes these packages.
 */

export const AMANE_PIN = {
  sourceCommit: 'a60a90a8751a98870a9d65779d4fce5230dc4c56',
  packages: { arc: '0.2.0', policy: '0.2.0', verify: '0.2.0' },
} as const;

export const AMANE_ACCOUNT_ABI = artifacts.ArcAccount.abi;
export const AMANE_ARTIFACTS = artifacts;
export {
  ARC_USDC,
  PAY,
  compilePolicy,
  validateAction,
  validateLease,
  verifyExecution,
};
export type { ActionIntent, AgentLease, ExecutionState, RootPolicy };

/** The capability vocabulary Synq reports for Amane-enforced execution. */
export type AmaneCapabilityStatus =
  | 'UNSUPPORTED'
  | 'NOT_CONFIGURED'
  | 'OFFCHAIN_ONLY'
  | 'ONCHAIN_AUTHENTICATED'
  | 'VERIFIED_TESTNET';

/**
 * PAY is the only supported action. A workspace is NOT_CONFIGURED until it
 * has an account whose deployed code matches the pinned hash and a live lease;
 * VERIFIED_TESTNET only after a Synq-run payment was verified on Arc testnet.
 */
export function amaneCapability(state: {
  accountConfigured: boolean;
  codeVerified: boolean;
  liveLease: boolean;
  verifiedPayment: boolean;
}): { status: AmaneCapabilityStatus; reason: string; actions: ['PAY'] } {
  const actions: ['PAY'] = ['PAY'];
  if (!state.accountConfigured)
    return {
      status: 'NOT_CONFIGURED',
      reason: 'No Amane account is set up for this workspace.',
      actions,
    };
  if (!state.codeVerified)
    return {
      status: 'NOT_CONFIGURED',
      reason: 'The account code does not match the pinned Amane release.',
      actions,
    };
  if (!state.liveLease)
    return {
      status: 'NOT_CONFIGURED',
      reason: 'No live agent lease: the owner must sign one.',
      actions,
    };
  return state.verifiedPayment
    ? {
        status: 'VERIFIED_TESTNET',
        reason:
          'Agent payments within the lease are enforced by the Amane contract and one has been verified on Arc testnet.',
        actions,
      }
    : {
        status: 'ONCHAIN_AUTHENTICATED',
        reason:
          'Agent payments within the lease are enforced by the Amane contract; no Synq payment verified yet.',
        actions,
      };
}

/** Typed data the owner signs to install a root policy (Control message). */
export function controlTypedData(
  chainId: number,
  account: Address,
  operation: Hex,
  nonce: bigint,
  deadline: bigint,
) {
  return {
    domain: domain(chainId, account),
    types: { Control: types.Control },
    primaryType: 'Control' as const,
    message: { operation, target: account, nonce, deadline },
  };
}

/** Typed data the owner signs to activate an agent lease. */
export function leaseTypedData(
  chainId: number,
  account: Address,
  lease: AgentLease,
) {
  return {
    domain: domain(chainId, account),
    types: { AgentLease: types.AgentLease },
    primaryType: 'AgentLease' as const,
    message: lease,
  };
}

/** Typed data the agent key signs for one PAY intent. */
export function intentTypedData(
  chainId: number,
  account: Address,
  intent: ActionIntent,
) {
  return {
    domain: domain(chainId, account),
    types: { ActionIntent: types.ActionIntent },
    primaryType: 'ActionIntent' as const,
    message: intent,
  };
}

export const intentHash = (
  chainId: number,
  account: Address,
  intent: ActionIntent,
) => actionHash(intent, chainId, account);
export const leaseDigest = (
  chainId: number,
  account: Address,
  lease: AgentLease,
) => leaseHash(lease, chainId, account);

export function payIntent(input: {
  leaseId: Hex;
  nonce: bigint;
  token: Address;
  recipient: Address;
  adapterId: Hex;
  amount: bigint;
  deadline: bigint;
  planHash: Hex;
}): ActionIntent {
  return {
    leaseId: input.leaseId,
    nonce: input.nonce,
    kind: PAY,
    token: getAddress(input.token),
    recipient: getAddress(input.recipient),
    adapterId: input.adapterId,
    amount: input.amount,
    deadline: input.deadline,
    maxFee: 0n,
    feeRecipient: '0x0000000000000000000000000000000000000000',
    planHash: input.planHash,
  };
}

export const executeCalldata = (intent: ActionIntent, signature: Hex): Hex =>
  encodeFunctionData({
    abi: AMANE_ACCOUNT_ABI,
    functionName: 'execute',
    args: [intent, signature],
  });

const bucket = (kind: 'root' | 'lease', id: Hex) =>
  keccak256(
    encodeAbiParameters([{ type: 'string' }, { type: 'bytes32' }], [kind, id]),
  );

export type LeaseState = {
  rootHash: Hex;
  root: RootPolicy;
  lease: AgentLease;
  leaseLive: boolean;
  /** The contract's own view, ready for `validateAction`. */
  state: ExecutionState;
  remaining: {
    perAction: bigint;
    leasePeriod: bigint;
    rootPeriod: bigint;
    leaseTotal: bigint;
    rootTotal: bigint;
  };
  blockNumber: bigint;
};

/**
 * Reads everything the decision needs from the enforcing contract at one
 * block, after checking the deployed code matches the pinned hash.
 */
export async function readLeaseState(
  client: PublicClient,
  account: Address,
  codeHash: Hex,
  leaseId: Hex,
  nonce: bigint,
): Promise<LeaseState> {
  await verifyDeployment(client, account, codeHash);
  const block = await client.getBlock();
  const at = {
    address: account,
    abi: AMANE_ACCOUNT_ABI,
    blockNumber: block.number,
  } as const;
  const [rootHash, rootTuple, leaseTuple, live, paused, revoked, used] =
    await Promise.all([
      client.readContract({ ...at, functionName: 'rootHash' }),
      client.readContract({ ...at, functionName: 'root' }),
      client.readContract({ ...at, functionName: 'lease', args: [leaseId] }),
      client.readContract({
        ...at,
        functionName: 'leaseLive',
        args: [leaseId],
      }),
      client.readContract({ ...at, functionName: 'paused' }),
      client.readContract({ ...at, functionName: 'revoked', args: [leaseId] }),
      client.readContract({
        ...at,
        functionName: 'nonceUsed',
        args: [leaseId, nonce],
      }),
    ]);
  const root = rootOf(rootTuple);
  const lease = leaseOf(leaseTuple);
  const epoch = block.timestamp / root.periodSeconds;
  const rootBucket = bucket('root', rootHash as Hex);
  const leaseBucket = bucket('lease', leaseId);
  const [rootPeriod, rootTotal, leasePeriod, leaseTotal] = await Promise.all([
    client.readContract({
      ...at,
      functionName: 'periodSpent',
      args: [rootBucket, epoch],
    }),
    client.readContract({
      ...at,
      functionName: 'totalSpent',
      args: [rootBucket],
    }),
    client.readContract({
      ...at,
      functionName: 'periodSpent',
      args: [leaseBucket, epoch],
    }),
    client.readContract({
      ...at,
      functionName: 'totalSpent',
      args: [leaseBucket],
    }),
  ]);
  const left = (cap: bigint, spent: bigint) => (cap > spent ? cap - spent : 0n);
  return {
    rootHash: rootHash as Hex,
    root,
    lease,
    leaseLive: live as boolean,
    blockNumber: block.number,
    state: {
      now: block.timestamp,
      paused: paused as boolean,
      revoked: revoked as boolean,
      nonceUsed: used as boolean,
      rootPeriodSpent: rootPeriod as bigint,
      rootTotalSpent: rootTotal as bigint,
      leasePeriodSpent: leasePeriod as bigint,
      leaseTotalSpent: leaseTotal as bigint,
    },
    remaining: {
      perAction:
        lease.perAction < root.perAction ? lease.perAction : root.perAction,
      leasePeriod: left(lease.perPeriod, leasePeriod as bigint),
      rootPeriod: left(root.perPeriod, rootPeriod as bigint),
      leaseTotal: left(lease.total, leaseTotal as bigint),
      rootTotal: left(root.total, rootTotal as bigint),
    },
  };
}

function field<T>(tuple: unknown, name: string, index: number): T {
  if (Array.isArray(tuple)) return tuple[index] as T;
  return (tuple as Record<string, T>)[name]!;
}
function rootOf(t: unknown): RootPolicy {
  return {
    version: field<bigint>(t, 'version', 0),
    token: getAddress(field<string>(t, 'token', 1)),
    recipient: getAddress(field<string>(t, 'recipient', 2)),
    adapterId: field<Hex>(t, 'adapterId', 3),
    recovery: getAddress(field<string>(t, 'recovery', 4)),
    perAction: field<bigint>(t, 'perAction', 5),
    perPeriod: field<bigint>(t, 'perPeriod', 6),
    total: field<bigint>(t, 'total', 7),
    periodSeconds: field<bigint>(t, 'periodSeconds', 8),
    maxLeaseLifetime: field<bigint>(t, 'maxLeaseLifetime', 9),
  };
}
function leaseOf(t: unknown): AgentLease {
  return {
    leaseId: field<Hex>(t, 'leaseId', 0),
    rootHash: field<Hex>(t, 'rootHash', 1),
    agent: getAddress(field<string>(t, 'agent', 2)),
    validAfter: field<bigint>(t, 'validAfter', 3),
    expiresAt: field<bigint>(t, 'expiresAt', 4),
    perAction: field<bigint>(t, 'perAction', 5),
    perPeriod: field<bigint>(t, 'perPeriod', 6),
    total: field<bigint>(t, 'total', 7),
  };
}

/** An account's pinned code hash and live root policy, as Synq records it. */
export async function readAccountView(client: PublicClient, account: Address) {
  const at = { address: account, abi: AMANE_ACCOUNT_ABI } as const;
  const [code, rootHash, rootTuple, chainId] = await Promise.all([
    client.getCode({ address: account }),
    client.readContract({ ...at, functionName: 'rootHash' }),
    client.readContract({ ...at, functionName: 'root' }),
    client.getChainId(),
  ]);
  if (!code || code === '0x') throw new Error('AMANE_ACCOUNT_MISSING');
  return {
    chainId,
    account: getAddress(account),
    codeHash: keccak256(code),
    rootHash: rootHash as Hex,
    root: rootOf(rootTuple),
  };
}

/** One lease's live view; `available` is the smallest remaining cap right now. */
export async function readLeaseView(
  client: PublicClient,
  account: Address,
  codeHash: Hex,
  leaseId: Hex,
) {
  const s = await readLeaseState(client, account, codeHash, leaseId, 0n);
  const r = s.remaining;
  const available = [
    r.perAction,
    r.leasePeriod,
    r.rootPeriod,
    r.leaseTotal,
    r.rootTotal,
  ].reduce((m, v) => (v < m ? v : m));
  return {
    ...s.lease,
    live: s.leaseLive,
    revoked: s.state.revoked,
    available: s.leaseLive ? available : 0n,
  };
}

export const isController = (
  client: PublicClient,
  account: Address,
  wallet: Address,
) =>
  client.readContract({
    address: account,
    abi: AMANE_ACCOUNT_ABI,
    functionName: 'controller',
    args: [wallet],
  }) as Promise<boolean>;
