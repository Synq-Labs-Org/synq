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
 * Delegations may chain (A → B → C). Resolution walks at most the policy's
 * depth and stops at the first voter, at a cycle, or before a quarantined
 * wallet. A link added far downstream therefore never removes representation
 * that already resolves upstream. Records handed to a tally are re-verified:
 * the delegation and any revocation must carry the delegator's signature.
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

/** A signature must reach the registry within this many seconds of being made. */
export const DELEGATION_SIGNATURE_MAX_AGE = 600;

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
  revocation: DelegationRevocation | null;
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

const VERIFIED = new WeakSet<object>();

/**
 * Re-verifies records supplied from outside the registry: id, workspace and
 * chain, the delegator's signature, a registration time within the signature's
 * freshness window, and a delegator-signed revocation behind every revokedAt.
 */
export async function verifyDelegationRecords(
  records: readonly DelegationRecord[],
  policy: GovernancePolicy,
): Promise<void> {
  const bad = (r: DelegationRecord, why: string): never => {
    throw new GovernanceError(
      'DELEGATION_INVALID',
      `delegation ${r.id}: ${why}`,
    );
  };
  const ids = new Set<string>();
  for (const r of records) {
    if (ids.has(r.id)) bad(r, 'listed twice');
    ids.add(r.id);
    const d = r.delegation;
    if (d.workspaceId !== policy.workspaceId || d.chainId !== policy.chainId)
      bad(r, 'other workspace or chain');
    if (VERIFIED.has(r)) continue;
    if (delegationId(d) !== r.id) bad(r, 'id does not match its contents');
    if (
      r.effectiveFrom < d.issuedAt ||
      r.effectiveFrom - d.issuedAt > DELEGATION_SIGNATURE_MAX_AGE
    )
      bad(r, 'registration time outside the signature window');
    const signer = await recoverSigner(delegationTypedData(d), r.signature);
    if (!signer || !sameAddress(signer, d.delegator))
      throw new GovernanceError(
        'BAD_SIGNATURE',
        `delegation ${r.id} not signed by its delegator`,
      );
    if (r.revokedAt === null) {
      if (r.revocation || r.revocationSignature)
        bad(r, 'revocation without revokedAt');
    } else {
      const rev = r.revocation;
      if (!rev || !r.revocationSignature)
        bad(r, 'revokedAt without revocation');
      if (
        rev!.delegationId !== r.id ||
        !sameAddress(rev!.delegator, d.delegator) ||
        rev!.workspaceId !== d.workspaceId ||
        rev!.chainId !== d.chainId ||
        r.revokedAt < rev!.requestedAt ||
        r.revokedAt - rev!.requestedAt > DELEGATION_SIGNATURE_MAX_AGE
      )
        bad(r, 'revocation does not match');
      const revoker = await recoverSigner(
        revocationTypedData(rev!),
        r.revocationSignature,
      );
      if (!revoker || !sameAddress(revoker, d.delegator))
        throw new GovernanceError(
          'BAD_SIGNATURE',
          `revocation of ${r.id} not signed by its delegator`,
        );
    }
    if (Object.isFrozen(r) && Object.isFrozen(r.delegation)) VERIFIED.add(r);
  }
}

export const isActiveAt = (r: DelegationRecord, at: number) =>
  Math.max(r.delegation.issuedAt, r.effectiveFrom) <= at &&
  at < r.delegation.expiresAt &&
  (r.revokedAt === null || at < r.revokedAt);

function activeFrom(
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
): DelegationRecord[] {
  return records.filter(
    (r) => sameAddress(r.delegation.delegator, wallet) && isActiveAt(r, at),
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

export type ChainStop = 'END' | 'DEPTH' | 'CYCLE' | 'BLOCKED' | 'AMBIGUOUS';

/**
 * Walks live links from `wallet` (excluded from the path) for at most
 * `maxDepth` hops. It never throws: it stops at the end of the chain, at the
 * depth limit, before revisiting a wallet, before a blocked (quarantined)
 * wallet, or when a wallet has more than one live outgoing delegation.
 */
export function walkDelegations(
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
  maxDepth: number,
  blocked: ReadonlySet<string> = new Set(),
): { path: Address[]; stop: ChainStop } {
  const path: Address[] = [];
  const seen = new Set([wallet.toLowerCase()]);
  let current = wallet;
  for (;;) {
    const links = activeFrom(records, current, at);
    if (!links.length) return { path, stop: 'END' };
    if (links.length > 1) return { path, stop: 'AMBIGUOUS' };
    if (path.length >= maxDepth) return { path, stop: 'DEPTH' };
    const next = addr(links[0]!.delegation.delegate);
    const key = next.toLowerCase();
    if (seen.has(key)) return { path, stop: 'CYCLE' };
    if (blocked.has(key)) return { path, stop: 'BLOCKED' };
    seen.add(key);
    path.push(next);
    current = next;
  }
}

export const delegationChain = (
  records: readonly DelegationRecord[],
  wallet: Address,
  at: number,
  maxDepth: number,
  blocked?: ReadonlySet<string>,
): Address[] => walkDelegations(records, wallet, at, maxDepth, blocked).path;

/**
 * Null when `voter` lies on `member`'s live chain at `at`; otherwise the
 * precise reason (revoked, expired, not delegated, cycle, quarantined).
 */
export function representationError(
  records: readonly DelegationRecord[],
  member: Address,
  voter: Address,
  at: number,
  maxDepth: number,
  blocked?: ReadonlySet<string>,
): GovernanceErrorCode | null {
  const { path, stop } = walkDelegations(
    records,
    member,
    at,
    maxDepth,
    blocked,
  );
  if (path.some((w) => sameAddress(w, voter))) return null;
  if (stop === 'CYCLE') return 'DELEGATION_CYCLE';
  if (stop === 'BLOCKED') return 'NOT_ELIGIBLE';
  if (stop === 'AMBIGUOUS') return 'DELEGATION_INVALID';
  if (stop === 'DEPTH') return 'NOT_DELEGATED';
  return lapsed(records, path.at(-1) ?? member, at);
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
    if (now - d.issuedAt > DELEGATION_SIGNATURE_MAX_AGE)
      bad('stale delegation signature');
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
    if (activeFrom(this.records, d.delegator, now).length)
      bad('delegator already has an active delegation; revoke it first');
    // Walk one hop past the limit so both a cycle and excess depth are visible.
    const onward = walkDelegations(
      this.records,
      addr(d.delegate),
      now,
      this.policy.maxDelegationDepth + 1,
    );
    if (
      onward.stop === 'CYCLE' ||
      onward.path.some((w) => sameAddress(w, d.delegator))
    )
      throw new GovernanceError(
        'DELEGATION_CYCLE',
        `${d.delegator} -> ${[d.delegate, ...onward.path].join(' -> ')}`,
      );
    if (onward.path.length + 1 > this.policy.maxDelegationDepth)
      bad(`chain deeper than ${this.policy.maxDelegationDepth}`);
    const record: DelegationRecord = deepFreeze({
      id,
      delegation: {
        ...d,
        delegator: addr(d.delegator),
        delegate: addr(d.delegate),
      },
      signature: signature as Hex,
      effectiveFrom: now,
      revokedAt: null,
      revocation: null,
      revocationSignature: null,
    });
    VERIFIED.add(record);
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
    if (
      r.requestedAt > now ||
      now - r.requestedAt > DELEGATION_SIGNATURE_MAX_AGE
    )
      throw new GovernanceError('DELEGATION_INVALID', 'stale revocation');
    const signer = await recoverSigner(revocationTypedData(r), signature);
    if (!signer || !sameAddress(signer, record.delegation.delegator))
      throw new GovernanceError(
        'BAD_SIGNATURE',
        'revocation not signed by the delegator',
      );
    if (record.revokedAt !== null) return record;
    const revoked: DelegationRecord = deepFreeze({
      ...record,
      revokedAt: now,
      revocation: { ...r, delegator: addr(r.delegator) },
      revocationSignature: signature as Hex,
    });
    VERIFIED.add(revoked);
    this.records[index] = revoked;
    return revoked;
  }
}

export const quarantinedWallets = (s: BallotSnapshot): ReadonlySet<string> =>
  new Set(s.quarantined.map((m) => m.wallet.toLowerCase()));

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
  const blocked = quarantinedWallets(snapshot);
  const held = new Map<string, { weight: bigint; memberIds: string[] }>();
  for (const m of snapshot.members) {
    const terminal =
      delegationChain(
        input.records,
        m.wallet,
        input.at,
        policy.maxDelegationDepth,
        blocked,
      ).at(-1) ?? m.wallet;
    const key = terminal.toLowerCase();
    const entry = held.get(key) ?? { weight: 0n, memberIds: [] };
    entry.weight += m.weight;
    if (!sameAddress(terminal, m.wallet)) entry.memberIds.push(m.memberId);
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
