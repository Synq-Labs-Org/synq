import pg from 'pg';
import type { PrivateKeyAccount } from 'viem/accounts';
import {
  LOCAL_CHAIN_ID,
  type Asset,
  type GrantDraft,
  type VerifiedApproval,
} from '@synq/schemas';
import {
  GrantApprovalGateway,
  MembershipService,
  PostgresIdentityStore,
  PrincipalService,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantTypedData,
  identityChallengeTypedData,
} from '@synq/identity';

const IDENTITY_TABLES =
  'identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal';

/** Local and test databases only: the name must start with synq_p07_ before anything is created or truncated. */
export function assertWorkflowDatabase(url: string): string {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_p07_[a-z0-9_]{1,40}$/.test(name))
    throw new Error('WORKFLOW_DATABASE_NAME_MUST_START_WITH_synq_p07_');
  return name;
}

export async function ensureDatabase(url: string): Promise<void> {
  const name = assertWorkflowDatabase(url);
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
}

export const LOCAL_IDENTITY_CONFIG = {
  profile: 'local/anvil' as const,
  rpId: 'localhost',
  origin: 'http://localhost',
  now: () => Math.floor(Date.now() / 1000),
};

export function localGateway(
  store: PostgresIdentityStore,
  module: `0x${string}`,
  asset: Asset,
): GrantApprovalGateway {
  return new GrantApprovalGateway(store, LOCAL_IDENTITY_CONFIG, {
    executionModules: { [LOCAL_CHAIN_ID]: module },
    localAssets: [asset],
  });
}

/** Enrols the Safe owners as LOCAL_FIXTURE principals and members of the group in a fresh identity store. */
export async function enrolLocalGroup(
  pool: pg.Pool,
  input: {
    groupId: string;
    chainGroupId: `0x${string}`;
    account: `0x${string}`;
    owners: readonly PrivateKeyAccount[];
    executor: `0x${string}`;
    threshold: number;
  },
): Promise<string[]> {
  const store = new PostgresIdentityStore(pool);
  await store.migrate();
  await pool.query(`TRUNCATE ${IDENTITY_TABLES} RESTART IDENTITY CASCADE`);
  const principals = new PrincipalService(store, LOCAL_IDENTITY_CONFIG);
  const membership = new MembershipService(store, LOCAL_IDENTITY_CONFIG);
  const principalIds: string[] = [];
  for (const owner of input.owners) {
    const challenge = await principals.issueEnrollmentChallenge({
      kind: 'LOCAL_FIXTURE',
      signer: owner.address,
      rpId: LOCAL_IDENTITY_CONFIG.rpId,
      origin: LOCAL_IDENTITY_CONFIG.origin,
    });
    const principal = await principals.enroll({
      challengeId: challenge.challengeId,
      signature: await owner.signTypedData(
        identityChallengeTypedData(challenge),
      ),
    });
    principalIds.push(principal.principalId);
  }
  await membership.createGroup({
    groupId: input.groupId,
    chainGroupId: input.chainGroupId,
    chainId: LOCAL_CHAIN_ID,
    account: input.account,
    owners: input.owners.map((o) => o.address),
    threshold: input.threshold,
    executors: [input.executor],
  });
  for (const [i, owner] of input.owners.entries()) {
    const challenge = await membership.issueJoinChallenge({
      groupId: input.groupId,
      memberId: `member_${i}`,
      principalId: principalIds[i]!,
    });
    await membership.join({
      groupId: input.groupId,
      challengeId: challenge.challengeId,
      signature: await owner.signTypedData(
        identityChallengeTypedData(challenge),
      ),
    });
  }
  return principalIds;
}

/** A member approves a registered draft through the identity challenge flow (local software keys). */
export async function approveAsMember(
  gateway: GrantApprovalGateway,
  draft: GrantDraft,
  member: { index: number; owner: PrivateKeyAccount; principalId: string },
): Promise<VerifiedApproval> {
  const request = {
    principalId: member.principalId,
    memberId: `member_${member.index}`,
    requestedAt: LOCAL_IDENTITY_CONFIG.now(),
  };
  const challenge = await gateway.issueChallenge({
    ...request,
    draftDigest: draft.digest,
    requestSignature: await member.owner.signTypedData(
      challengeRequestTypedData(draft, request),
    ),
  });
  return gateway.submit({
    challengeId: challenge.challengeId,
    grantSignature: await member.owner.signTypedData(grantTypedData(draft)),
    attestationSignature: await member.owner.signTypedData(
      approvalAttestationTypedData(draft, challenge),
    ),
  });
}
