import {
  getAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import {
  PolicyError,
  policyHash,
  verifySignedPolicy,
  type SignedRevenuePolicy,
} from './policy.js';
import type { SplitStore } from './split.js';

/**
 * Who may author a workspace's revenue policy, and which versions still count.
 *
 * A policy names its own `owner` and `treasury`, so neither can be trusted
 * from the policy itself. `WorkspaceRegistry` answers from a source the
 * policy cannot set: an explicitly configured workspace owner and treasury,
 * intersected (for a vault workspace) with the live Safe owners. A policy is
 * usable only when its signer is a registered owner, its treasury is the
 * registered treasury, it is the latest registered version, and no
 * owner-signed revocation covers it. Registrations and revocations persist
 * in the split store and are re-checked right before every signature.
 */

export interface WorkspaceRegistry {
  principals(workspaceId: string): Promise<{
    treasury: Address;
    owners: readonly Address[];
    source: string;
  }>;
}

/** The policy's signer and treasury are the workspace's registered ones. */
export async function assertPolicyPrincipal(
  signed: SignedRevenuePolicy,
  registry: WorkspaceRegistry,
): Promise<{ source: string }> {
  const p = signed.policy;
  const reg = await registry.principals(p.workspaceId);
  if (getAddress(reg.treasury) !== getAddress(p.treasury))
    throw new PolicyError(
      'TREASURY_NOT_REGISTERED',
      `policy treasury ${p.treasury} is not ${p.workspaceId}'s registered treasury ${reg.treasury}`,
    );
  if (!reg.owners.some((o) => getAddress(o) === getAddress(p.owner)))
    throw new PolicyError(
      'OWNER_NOT_REGISTERED',
      `policy owner ${p.owner} is not a registered owner of ${p.workspaceId} (${reg.source})`,
    );
  return { source: reg.source };
}

export type PolicyRegistration = Readonly<{
  policyId: string;
  version: number;
  workspaceId: string;
  owner: Address;
  policyHash: Hex;
  registeredAt: number;
}>;

export type PolicyRevocation = Readonly<{
  policyId: string;
  workspaceId: string;
  /** Every version up to and including this one is revoked. */
  throughVersion: number;
  reason: string;
  /** Unix seconds when the owner signed. */
  at: number;
}>;

export type SignedPolicyRevocation = Readonly<{
  revocation: PolicyRevocation;
  signature: Hex;
}>;

export type StoredRevocation = PolicyRevocation &
  Readonly<{ signer: Address; signature: Hex; recordedAt: number }>;

export function revocationTypedData(r: PolicyRevocation) {
  return {
    domain: { name: 'Synq Revenue Policy Revocation', version: '1' },
    types: {
      RevokeRevenuePolicy: [
        { name: 'policyId', type: 'string' },
        { name: 'workspaceId', type: 'string' },
        { name: 'throughVersion', type: 'uint256' },
        { name: 'reason', type: 'string' },
        { name: 'at', type: 'uint256' },
      ],
    },
    primaryType: 'RevokeRevenuePolicy' as const,
    message: {
      policyId: r.policyId,
      workspaceId: r.workspaceId,
      throughVersion: BigInt(r.throughVersion),
      reason: r.reason,
      at: BigInt(r.at),
    },
  };
}

/**
 * Records a signed policy version after checking its signatures and that its
 * signer is a registered owner. Registering version N supersedes every
 * version below N. Idempotent per (policyId, version); a different body
 * under an existing version is refused.
 */
export async function registerPolicy(
  store: SplitStore,
  registry: WorkspaceRegistry,
  signed: SignedRevenuePolicy,
  now: number,
): Promise<PolicyRegistration> {
  await verifySignedPolicy(signed, now);
  await assertPolicyPrincipal(signed, registry);
  const p = signed.policy;
  const row: PolicyRegistration = {
    policyId: p.policyId,
    version: p.version,
    workspaceId: p.workspaceId,
    owner: p.owner,
    policyHash: policyHash(p),
    registeredAt: now,
  };
  const stored = await store.putPolicy(row);
  if (stored.policyHash !== row.policyHash)
    throw new PolicyError(
      'POLICY_SUPERSEDED',
      `${p.policyId} v${p.version} is already registered with another body`,
    );
  return stored;
}

/** Records an owner-signed revocation; only a registered owner may revoke. */
export async function revokePolicy(
  store: SplitStore,
  registry: WorkspaceRegistry,
  signed: SignedPolicyRevocation,
  now: number,
): Promise<StoredRevocation> {
  const r = signed.revocation;
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      ...revocationTypedData(r),
      signature: signed.signature,
    });
  } catch {
    throw new PolicyError('BAD_REVOCATION', 'unrecoverable signature');
  }
  const reg = await registry.principals(r.workspaceId);
  if (!reg.owners.some((o) => getAddress(o) === signer))
    throw new PolicyError(
      'BAD_REVOCATION',
      `${signer} is not a registered owner of ${r.workspaceId}`,
    );
  const row: StoredRevocation = {
    ...r,
    signer,
    signature: signed.signature,
    recordedAt: now,
  };
  await store.putRevocation(row);
  return row;
}

/** Latest registered version and revocation reach of a policy. */
export async function policyStanding(
  store: SplitStore,
  signed: SignedRevenuePolicy,
): Promise<{
  usable: boolean;
  latestVersion: number;
  revokedThrough: number;
  reason: string | null;
}> {
  const p = signed.policy;
  const versions = await store.policyVersions(p.policyId);
  const latestVersion = Math.max(0, ...versions.map((v) => v.version));
  const revokedThrough = Math.max(
    0,
    ...(await store.revocations(p.policyId))
      .filter((r) => r.workspaceId === p.workspaceId)
      .map((r) => r.throughVersion),
  );
  const mine = versions.find((v) => v.version === p.version);
  const reason =
    revokedThrough >= p.version
      ? `policy ${p.policyId} v${p.version} is revoked (through v${revokedThrough})`
      : latestVersion > p.version
        ? `policy ${p.policyId} v${p.version} is superseded by v${latestVersion}`
        : !mine
          ? `policy ${p.policyId} v${p.version} is not registered`
          : mine.policyHash !== policyHash(p)
            ? `policy ${p.policyId} v${p.version} differs from the registered body`
            : null;
  return { usable: reason === null, latestVersion, revokedThrough, reason };
}
