import { hashTypedData, type Address, type Hex } from 'viem';
import {
  BPS,
  addr,
  deepFreeze,
  governanceDomain,
  recoverSigner,
  sameAddress,
} from './common.js';
import { GovernanceError, type GovernanceErrorCode } from './errors.js';
import type { GovernancePolicy } from './policy.js';
import type { BallotSnapshot, GovernanceFlag } from './snapshot.js';

/**
 * Revocable, expiring vote delegation signed by the delegator's wallet.
 * Delegations may chain (A → B → C) up to the policy's depth; a delegation
 * that would close a cycle is refused at registration and detected again at
 * resolution. Representation stops at the first node on the chain that votes.
 */
export type Delegation = Readonly<{
  workspaceId: string;
  chainId: number;
  delegator: Address;
  delegate: Address;
  issuedAt: number;
  expiresAt: number;
  nonce: Hex;
}>;

export type DelegationRevocation = Readonly<{
  workspaceId: string;
  chainId: number;
  delegationId: Hex;
  delegator: Address;
  requestedAt: number;
}>;

export type DelegationRecord = Readonly<{
  id: Hex;
  delegation: Delegation;
  signature: Hex;
  /**
   * Registration time. A delegation never takes effect before it was
   * registered, so a back-dated signature cannot rewrite a past tally.
   */
  effectiveFrom: number;
  revokedAt: number | null;
  revocationSignature: Hex | null;
}>;

export function delegationTypedData(d: Delegation) {
  return {
    domain: governanceDomain(d.chainId),
    types: {
      Delegation: [
        { name: 'workspaceId', type: 'string' },
        { name: 'delegator', type: 'address' },
        { name: 'delegate', type: 'address' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'expiresAt', type: 'uint64' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'Delegation' as const,
    message: {
      workspaceId: d.workspaceId,
      delegator: d.delegator,
      delegate: d.delegate,
      issuedAt: BigInt(d.issuedAt),
      expiresAt: BigInt(d.expiresAt),
      nonce: d.nonce,
    },
  };
}
export const delegationId = (d: Delegation): Hex =>
  hashTypedData(delegationTypedData(d));

export function revocationTypedData(r: DelegationRevocation) {
  return {
    domain: governanceDomain(r.chainId),
    types: {
      DelegationRevocation: [
        { name: 'workspaceId', type: 'string' },
        { name: 'delegationId', type: 'bytes32' },
        { name: 'delegator', type: 'address' },
        { name: 'requestedAt', type: 'uint64' },
      ],
    },
    primaryType: 'DelegationRevocation' as const,
    message: {
      workspaceId: r.workspaceId,
      delegationId: r.delegationId,
      delegator: r.delegator,
      requestedAt: BigInt(r.requestedAt),
    },
  };
}

export const isActiveAt = (r: DelegationRecord, at: number) =>
  Math.max(r.delegation.issuedAt, r.effectiveFrom) <= at &&
  at < r.delegation.expiresAt &&
  (r.revokedAt === null || at < r.revokedAt);

function activeFrom(
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
): DelegationRecord | null {
  return (
    records.find(
      (r) => sameAddress(r.delegation.delegator, wallet) && isActiveAt(r, at),
    ) ?? null
  );
}

/** Why a wallet has no active outgoing delegation at `at`. */
function lapsed(
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
): GovernanceErrorCode {
  const latest = records
    .filter(
      (r) =>
        sameAddress(r.delegation.delegator, wallet) && r.effectiveFrom <= at,
    )
    .sort((a, b) => b.effectiveFrom - a.effectiveFrom)[0];
  if (!latest) return 'NOT_DELEGATED';
  if (latest.revokedAt !== null && latest.revokedAt <= at)
    return 'DELEGATION_REVOKED';
  if (at >= latest.delegation.expiresAt) return 'DELEGATION_EXPIRED';
  return 'NOT_DELEGATED';
}

/**
 * The active delegation chain starting at `wallet` (excluding it), following
 * only links live at `at`. Throws DELEGATION_CYCLE if the chain revisits a
 * wallet and DELEGATION_INVALID beyond `maxDepth`.
 */
export function delegationChain(
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
  maxDepth: number,
): Address[] {
  const path: Address[] = [];
  const seen = new Set([wallet.toLowerCase()]);
  let current = wallet;
  for (;;) {
    const link = activeFrom(records, current, at);
    if (!link) return path;
    const next = addr(link.delegation.delegate);
    if (seen.has(next.toLowerCase()))
      throw new GovernanceError(
        'DELEGATION_CYCLE',
        `delegation cycle through ${[wallet, ...path, next].join(' -> ')}`,
      );
    if (path.length >= maxDepth)
      throw new GovernanceError(
        'DELEGATION_INVALID',
        `delegation chain from ${wallet} deeper than ${maxDepth}`,
      );
    seen.add(next.toLowerCase());
    path.push(next);
    current = next;
  }
}

/**
 * Null when `voter` lies on `member`'s active chain at `at`; otherwise the
 * precise reason (revoked, expired, not delegated, cycle).
 */
export function representationError(
  records: readonly DelegationRecord[],
  member: Address,
  voter: Address,
  at: number,
  maxDepth: number,
): GovernanceErrorCode | null {
  let chain: Address[];
  try {
    chain = delegationChain(records, member, at, maxDepth);
  } catch (e) {
    return e instanceof GovernanceError ? e.code : 'DELEGATION_INVALID';
  }
  if (chain.some((w) => sameAddress(w, voter))) return null;
  // Report the link that broke: the last wallet the chain reached.
  return lapsed(records, chain.at(-1) ?? member, at);
}

export class DelegationRegistry {
  private records: DelegationRecord[];
  constructor(
    readonly policy: GovernancePolicy,
    records: readonly DelegationRecord[] = [],
  ) {
    this.records = [...records];
  }

  list(): readonly DelegationRecord[] {
    return this.records;
  }

  async register(
    d: Delegation,
    signature: unknown,
    now: number,
  ): Promise<DelegationRecord> {
    const bad = (why: string) => {
      throw new GovernanceError('DELEGATION_INVALID', why);
    };
    if (d.workspaceId !== this.policy.workspaceId) bad('wrong workspace');
    if (d.chainId !== this.policy.chainId) bad('wrong chain');
    if (sameAddress(d.delegator, d.delegate)) bad('self-delegation');
    if (!(d.issuedAt <= now && now < d.expiresAt)) bad('not live now');
    if (now - d.issuedAt > 600) bad('stale delegation signature');
    if (d.expiresAt - d.issuedAt > this.policy.termSeconds)
      bad('delegations expire within one council term');
    const signer = await recoverSigner(delegationTypedData(d), signature);
    if (!signer || !sameAddress(signer, d.delegator))
      throw new GovernanceError(
        'BAD_SIGNATURE',
        'delegation not signed by the delegator',
      );
    const id = delegationId(d);
    if (this.records.some((r) => r.id === id)) bad('already registered');
    if (activeFrom(this.records, d.delegator, now))
      bad('delegator already has an active delegation; revoke it first');
    const onward = delegationChain(
      this.records,
      addr(d.delegate),
      now,
      this.policy.maxDelegationDepth,
    );
    if (onward.some((w) => sameAddress(w, d.delegator)))
      throw new GovernanceError(
        'DELEGATION_CYCLE',
        `${d.delegator} -> ${[d.delegate, ...onward].join(' -> ')}`,
      );
    if (onward.length + 1 > this.policy.maxDelegationDepth)
      bad(`chain deeper than ${this.policy.maxDelegationDepth}`);
    const record = deepFreeze({
      id,
      delegation: {
        ...d,
        delegator: addr(d.delegator),
        delegate: addr(d.delegate),
      },
      signature: signature as Hex,
      effectiveFrom: now,
      revokedAt: null,
      revocationSignature: null,
    });
    this.records.push(record);
    return record;
  }

  /** Effective immediately; only the delegator's own signature revokes. */
  async revoke(
    r: DelegationRevocation,
    signature: unknown,
    now: number,
  ): Promise<DelegationRecord> {
    const index = this.records.findIndex((x) => x.id === r.delegationId);
    const record = this.records[index];
    if (!record)
      throw new GovernanceError('DELEGATION_INVALID', 'unknown delegation');
    if (
      r.workspaceId !== this.policy.workspaceId ||
      r.chainId !== this.policy.chainId ||
      !sameAddress(r.delegator, record.delegation.delegator)
    )
      throw new GovernanceError('DELEGATION_INVALID', 'revocation mismatch');
    if (r.requestedAt > now || now - r.requestedAt > 600)
      throw new GovernanceError('DELEGATION_INVALID', 'stale revocation');
    const signer = await recoverSigner(revocationTypedData(r), signature);
    if (!signer || !sameAddress(signer, record.delegation.delegator))
      throw new GovernanceError(
        'BAD_SIGNATURE',
        'revocation not signed by the delegator',
      );
    if (record.revokedAt !== null) return record;
    const revoked = deepFreeze({
      ...record,
      revokedAt: now,
      revocationSignature: signature as Hex,
    });
    this.records[index] = revoked;
    return revoked;
  }
}

/**
 * Weight each final delegate would control if every live delegation were used,
 * flagged when above the policy's concentration share.
 */
export function delegationConcentration(input: {
  snapshot: BallotSnapshot;
  records: readonly DelegationRecord[];
  policy: GovernancePolicy;
  at: number;
}): GovernanceFlag[] {
  const { snapshot, policy } = input;
  const held = new Map<string, { weight: bigint; memberIds: string[] }>();
  for (const m of snapshot.members) {
    let terminal: Address = m.wallet;
    try {
      terminal =
        delegationChain(
          input.records,
          m.wallet,
          input.at,
          policy.maxDelegationDepth,
        ).at(-1) ?? m.wallet;
    } catch {
      continue; // a broken chain delegates nothing
    }
    const key = terminal.toLowerCase();
    const entry = held.get(key) ?? { weight: 0n, memberIds: [] };
    entry.weight += m.weight;
    if (terminal !== m.wallet) entry.memberIds.push(m.memberId);
    held.set(key, entry);
  }
  const flags: GovernanceFlag[] = [];
  for (const [delegate, { weight, memberIds }] of held)
    if (
      memberIds.length &&
      weight * BPS >
        BigInt(policy.concentrationFlagBps) * snapshot.eligibleWeight
    )
      flags.push({
        code: 'DELEGATE_CONCENTRATION',
        severity: 'SOFT',
        subject: addr(delegate),
        memberIds: [...memberIds].sort(),
        detail: `delegate controls ${(weight * BPS) / snapshot.eligibleWeight} bps of eligible weight (flag above ${policy.concentrationFlagBps})`,
      });
  return flags;
}
