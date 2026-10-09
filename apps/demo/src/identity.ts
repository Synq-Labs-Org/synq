import pg from 'pg';
import type { PrivateKeyAccount } from 'viem';
import type { Asset, GrantDraft, VerifiedApproval } from '@synq/schemas';
import {
  GrantApprovalGateway,
  MembershipService,
  PostgresIdentityStore,
  PrincipalService,
  StoreApprovalLedger,
  StoreDelegationEvaluator,
  StoreMembershipDirectory,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantTypedData,
  identityChallengeTypedData,
  isIdentityError,
} from '@synq/identity';

export const DEMO_DATABASE_URL =
  process.env.SYNQ_DEMO_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_demo';
const IDENTITY_TABLES =
  'identity_verified_approval,identity_grant_challenge,identity_grant_draft,identity_delegation_usage,identity_delegation_policy,identity_membership,identity_group,identity_challenge,identity_idempotency,identity_principal';

async function freshDemoDatabase(url: string): Promise<pg.Pool> {
  const name = new URL(url).pathname.slice(1);
  if (!/^[a-z_][a-z0-9_]*demo[a-z0-9_]*$/.test(name))
    throw new Error('DEMO_DATABASE_NAME_MUST_CONTAIN_DEMO');
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
  const pool = new pg.Pool({ connectionString: url, max: 4 });
  await new PostgresIdentityStore(pool).migrate();
  await pool.query(`TRUNCATE ${IDENTITY_TABLES} RESTART IDENTITY CASCADE`);
  return pool;
}

export async function startLocalIdentity(input: {
  groupId: string;
  chainGroupId: `0x${string}`;
  account: `0x${string}`;
  owners: readonly PrivateKeyAccount[];
  executor: `0x${string}`;
  executionModule: `0x${string}`;
  asset: Asset;
  threshold: number;
  now: () => number;
}) {
  const pool = await freshDemoDatabase(DEMO_DATABASE_URL);
  const store = new PostgresIdentityStore(pool);
  const config = {
    profile: 'local/anvil' as const,
    rpId: 'localhost',
    origin: 'http://localhost',
    now: input.now,
  };
  const principals = new PrincipalService(store, config);
  const membership = new MembershipService(store, config);
  const gateway = new GrantApprovalGateway(store, config, {
    executionModules: { 31337: input.executionModule },
    localAssets: [input.asset],
  });
  const principalIds: string[] = [];
  try {
    for (const owner of input.owners) {
      const challenge = await principals.issueEnrollmentChallenge({
        kind: 'LOCAL_FIXTURE',
        signer: owner.address,
        rpId: config.rpId,
        origin: config.origin,
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
      chainId: 31337,
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
  } catch (error) {
    await pool.end();
    throw error;
  }

  async function register(draft: GrantDraft): Promise<void> {
    try {
      await gateway.registerDraft({ draft, asset: input.asset });
    } catch (error) {
      const existing =
        isIdentityError(error) && error.code === 'DRAFT_EXISTS'
          ? await gateway.quorum(draft.digest).catch(() => null)
          : null;
      if (!existing || existing.draftStatus !== 'PENDING') throw error;
    }
  }

  async function approve(
    draft: GrantDraft,
    indexes: readonly number[],
  ): Promise<VerifiedApproval[]> {
    await register(draft);
    const approvals: VerifiedApproval[] = [];
    for (const i of indexes) {
      const owner = input.owners[i]!;
      const request = {
        principalId: principalIds[i]!,
        memberId: `member_${i}`,
        requestedAt: input.now(),
      };
      const challenge = await gateway.issueChallenge({
        ...request,
        draftDigest: draft.digest,
        requestSignature: await owner.signTypedData(
          challengeRequestTypedData(draft, request),
        ),
      });
      approvals.push(
        await gateway.submit({
          challengeId: challenge.challengeId,
          grantSignature: await owner.signTypedData(grantTypedData(draft)),
          attestationSignature: await owner.signTypedData(
            approvalAttestationTypedData(draft, challenge),
          ),
        }),
      );
    }
    return approvals;
  }

  return {
    store,
    gateway,
    approvalLedger: new StoreApprovalLedger(store),
    membershipDirectory: new StoreMembershipDirectory(store),
    delegations: new StoreDelegationEvaluator(store),
    approve,
    close: () => pool.end(),
  };
}
