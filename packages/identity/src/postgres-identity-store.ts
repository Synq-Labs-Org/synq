import { readFile } from 'node:fs/promises';
import {
  DelegationPolicySchema,
  GrantApprovalChallengeSchema,
  IdentityChallengeSchema,
  VerifiedApprovalSchema,
  type DelegationPolicy,
  type MembershipView,
} from '@synq/schemas';
import { IdentityError, type IdentityErrorCode } from './errors.js';
import {
  consumable,
  type DraftRecord,
  type GroupRecord,
  type IdempotencyRecord,
  type IdentityStore,
  type IdentityTx,
  type PrincipalRecord,
} from './store.js';

type Row = Record<string, unknown>;
export interface PgClientLike {
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  release(): void;
}
export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

const UNIQUE_CODES: Record<string, IdentityErrorCode> = {
  identity_principal_pkey: 'PRINCIPAL_EXISTS',
  identity_principal_signer_key: 'PRINCIPAL_EXISTS',
  identity_principal_credential_key: 'PRINCIPAL_EXISTS',
  identity_group_pkey: 'GROUP_EXISTS',
  identity_group_account_key: 'GROUP_EXISTS',
  identity_membership_active_member: 'DUPLICATE_MEMBERSHIP',
  identity_membership_active_principal: 'DUPLICATE_MEMBERSHIP',
  identity_membership_active_signer: 'DUPLICATE_MEMBERSHIP',
  identity_grant_draft_pkey: 'DRAFT_EXISTS',
  identity_grant_draft_intent_key: 'DRAFT_EXISTS',
  identity_grant_draft_pending_intent: 'DRAFT_EXISTS',
  identity_approval_challenge_key: 'ALREADY_APPROVED',
  identity_approval_member_key: 'ALREADY_APPROVED',
  identity_approval_signer_key: 'ALREADY_APPROVED',
};
function mapError(error: unknown): unknown {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    typeof error.constraint === 'string'
  ) {
    const code = UNIQUE_CODES[error.constraint];
    if (code) return new IdentityError(code);
  }
  return error;
}

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function principalRow(r: Row): PrincipalRecord {
  return {
    principalId: String(r.principal_id),
    kind: r.kind as PrincipalRecord['kind'],
    signer: String(r.signer) as `0x${string}`,
    rpId: (r.rp_id as string | null) ?? null,
    credential: (r.credential_json as PrincipalRecord['credential']) ?? null,
    providerRef: (r.provider_ref as PrincipalRecord['providerRef']) ?? null,
    status: r.status as PrincipalRecord['status'],
    enrolledAt: Number(r.enrolled_at),
    lastRecoveredAt: num(r.last_recovered_at),
  };
}
function groupRow(r: Row): GroupRecord {
  return {
    groupId: String(r.group_id),
    chainGroupId: String(r.chain_group_id) as `0x${string}`,
    chainId: Number(r.chain_id),
    account: String(r.account) as `0x${string}`,
    owners: (r.owners as string[]).map((o) => o as `0x${string}`),
    threshold: Number(r.threshold),
    executors: ((r.executors as string[] | null) ?? []).map(
      (e) => e as `0x${string}`,
    ),
    membershipEpoch: Number(r.membership_epoch),
    createdAt: Number(r.created_at),
  };
}
function membershipRow(r: Row): MembershipView {
  return {
    groupId: String(r.group_id) as MembershipView['groupId'],
    memberId: String(r.member_id) as MembershipView['memberId'],
    principalId: String(r.principal_id) as MembershipView['principalId'],
    principalKind: r.principal_kind as MembershipView['principalKind'],
    role: r.role as MembershipView['role'],
    signer: String(r.signer) as `0x${string}`,
    status: r.status as MembershipView['status'],
    joinedEpoch: Number(r.joined_epoch),
    joinedAt: Number(r.joined_at),
    revokedAt: num(r.revoked_at),
  };
}

const MIGRATIONS = [
  '001-identity',
  '002-approval-binding',
  '003-chain-group-id',
] as const;

export class PostgresIdentityStore implements IdentityStore {
  constructor(readonly pool: PgPoolLike) {}
  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [
        'synq_identity_migrate',
      ]);
      await client.query(
        'CREATE TABLE IF NOT EXISTS identity_schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      for (const version of MIGRATIONS) {
        const done = await client.query(
          'SELECT 1 FROM identity_schema_migration WHERE version=$1',
          [version],
        );
        if (done.rows.length) continue;
        const sql = await readFile(
          new URL(`../sql/${version}.sql`, import.meta.url),
          'utf8',
        );
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query(
            'INSERT INTO identity_schema_migration(version) VALUES($1)',
            [version],
          );
          await client.query('COMMIT');
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [
        'synq_identity_migrate',
      ]);
      client.release();
    }
  }
  async transaction<T>(work: (tx: IdentityTx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(postgresTx(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw mapError(error);
    } finally {
      client.release();
    }
  }
}

function postgresTx(db: PgClientLike): IdentityTx {
  const q = async (sql: string, values: unknown[] = []) => {
    try {
      return (await db.query(sql, values)).rows;
    } catch (error) {
      throw mapError(error);
    }
  };
  return {
    async insertChallenge(c) {
      await q(
        'INSERT INTO identity_challenge(challenge_id,purpose,challenge_json,expires_at) VALUES($1,$2,$3,$4)',
        [c.challengeId, c.purpose, JSON.stringify(c), c.expiresAt],
      );
    },
    async getChallenge(id) {
      const [r] = await q(
        'SELECT challenge_json,consumed_at FROM identity_challenge WHERE challenge_id=$1',
        [id],
      );
      return r
        ? {
            challenge: IdentityChallengeSchema.parse(r.challenge_json),
            consumedAt: num(r.consumed_at),
          }
        : null;
    },
    async consumeChallenge(id, now) {
      const [r] = await q(
        'UPDATE identity_challenge SET consumed_at=$2 WHERE challenge_id=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING challenge_json',
        [id, now],
      );
      if (r) return IdentityChallengeSchema.parse(r.challenge_json);
      return consumable(await this.getChallenge(id), now);
    },
    async insertPrincipal(p) {
      await q(
        'INSERT INTO identity_principal(principal_id,kind,signer,rp_id,credential_id,credential_json,provider_ref,status,enrolled_at,last_recovered_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          p.principalId,
          p.kind,
          p.signer,
          p.rpId,
          p.credential?.credentialId ?? null,
          p.credential ? JSON.stringify(p.credential) : null,
          p.providerRef ? JSON.stringify(p.providerRef) : null,
          p.status,
          p.enrolledAt,
          p.lastRecoveredAt,
        ],
      );
    },
    async getPrincipal(id) {
      const [r] = await q(
        'SELECT * FROM identity_principal WHERE principal_id=$1',
        [id],
      );
      return r ? principalRow(r) : null;
    },
    async markRecovered(id, now) {
      await q(
        'UPDATE identity_principal SET last_recovered_at=$2 WHERE principal_id=$1',
        [id, now],
      );
    },
    async insertGroup(g) {
      await q(
        'INSERT INTO identity_group(group_id,chain_id,account,owners,threshold,membership_epoch,created_at,executors,chain_group_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          g.groupId,
          g.chainId,
          g.account,
          g.owners,
          g.threshold,
          g.membershipEpoch,
          g.createdAt,
          g.executors,
          g.chainGroupId,
        ],
      );
    },
    async getGroup(id, lock) {
      const suffix =
        lock === 'UPDATE'
          ? ' FOR UPDATE'
          : lock === 'SHARE'
            ? ' FOR SHARE'
            : '';
      const [r] = await q(
        `SELECT * FROM identity_group WHERE group_id=$1${suffix}`,
        [id],
      );
      return r ? groupRow(r) : null;
    },
    async setGroupEpoch(id, epoch) {
      await q(
        'UPDATE identity_group SET membership_epoch=$2 WHERE group_id=$1',
        [id, epoch],
      );
    },
    async listMemberships(groupId) {
      return (
        await q(
          'SELECT * FROM identity_membership WHERE group_id=$1 ORDER BY id',
          [groupId],
        )
      ).map(membershipRow);
    },
    async listPrincipalMemberships(principalId) {
      return (
        await q(
          'SELECT * FROM identity_membership WHERE principal_id=$1 ORDER BY id',
          [principalId],
        )
      ).map(membershipRow);
    },
    async insertMembership(m) {
      await q(
        'INSERT INTO identity_membership(group_id,member_id,principal_id,principal_kind,role,signer,status,joined_epoch,joined_at,revoked_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        [
          m.groupId,
          m.memberId,
          m.principalId,
          m.principalKind,
          m.role,
          m.signer,
          m.status,
          m.joinedEpoch,
          m.joinedAt,
          m.revokedAt,
        ],
      );
    },
    async revokeMembership(groupId, memberId, now) {
      const rows = await q(
        "UPDATE identity_membership SET status='REVOKED', revoked_at=$3 WHERE group_id=$1 AND member_id=$2 AND status='ACTIVE' RETURNING id",
        [groupId, memberId, now],
      );
      if (rows.length !== 1) throw new IdentityError('MEMBERSHIP_NOT_FOUND');
    },
    async insertDraft(r) {
      await q(
        'INSERT INTO identity_grant_draft(draft_digest,intent_hash,group_id,draft_json,asset_json,created_at,status) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [
          r.draft.digest,
          r.draft.grant.intentHash,
          r.draft.groupId,
          JSON.stringify(r.draft),
          JSON.stringify(r.asset),
          r.createdAt,
          r.status,
        ],
      );
    },
    async getDraft(digest) {
      const [r] = await q(
        'SELECT * FROM identity_grant_draft WHERE draft_digest=$1',
        [digest],
      );
      return r ? draftRow(r) : null;
    },
    async getDraftByIntent(intentHash) {
      const [r] = await q(
        "SELECT * FROM identity_grant_draft WHERE intent_hash=$1 ORDER BY (status='PENDING') DESC, created_at DESC, draft_digest LIMIT 1",
        [intentHash],
      );
      return r ? draftRow(r) : null;
    },
    async invalidatePendingDrafts(groupId) {
      return (
        await q(
          "UPDATE identity_grant_draft SET status='INVALIDATED' WHERE group_id=$1 AND status='PENDING' RETURNING draft_digest",
          [groupId],
        )
      ).length;
    },
    async insertGrantChallenge(c) {
      await q(
        'INSERT INTO identity_grant_challenge(challenge_id,draft_digest,challenge_json,expires_at) VALUES($1,$2,$3,$4)',
        [c.challengeId, c.draftDigest, JSON.stringify(c), c.expiresAt],
      );
    },
    async getGrantChallenge(id) {
      const [r] = await q(
        'SELECT challenge_json,consumed_at FROM identity_grant_challenge WHERE challenge_id=$1',
        [id],
      );
      return r
        ? {
            challenge: GrantApprovalChallengeSchema.parse(r.challenge_json),
            consumedAt: num(r.consumed_at),
          }
        : null;
    },
    async consumeGrantChallenge(id, now) {
      const [r] = await q(
        'UPDATE identity_grant_challenge SET consumed_at=$2 WHERE challenge_id=$1 AND consumed_at IS NULL AND expires_at>$2 RETURNING challenge_json',
        [id, now],
      );
      if (r) return GrantApprovalChallengeSchema.parse(r.challenge_json);
      return consumable(await this.getGrantChallenge(id), now);
    },
    async insertApproval(a, attestationSignature) {
      await q(
        'INSERT INTO identity_verified_approval(approval_id,challenge_id,draft_digest,member_id,signer,membership_epoch,approval_json,verified_at,attestation_signature) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          a.approvalId,
          a.challengeId,
          a.draftDigest,
          a.memberId,
          a.signer,
          a.membershipEpoch,
          JSON.stringify(a),
          a.verifiedAt,
          attestationSignature,
        ],
      );
    },
    async listApprovals(digest) {
      return (
        await q(
          'SELECT approval_json FROM identity_verified_approval WHERE draft_digest=$1 ORDER BY verified_at, approval_id',
          [digest],
        )
      ).map((r) => VerifiedApprovalSchema.parse(r.approval_json));
    },
    async claimIdempotency(r: IdempotencyRecord, staleBefore: number) {
      const inserted = await q(
        "INSERT INTO identity_idempotency(scope,key,request_hash,state,created_at) VALUES($1,$2,$3,'PENDING',$4) ON CONFLICT (scope,key) DO UPDATE SET created_at=EXCLUDED.created_at WHERE identity_idempotency.state='PENDING' AND identity_idempotency.created_at<$5 AND identity_idempotency.request_hash=EXCLUDED.request_hash RETURNING key",
        [r.scope, r.key, r.requestHash, r.createdAt, staleBefore],
      );
      if (inserted.length) return null;
      const [e] = await q(
        'SELECT * FROM identity_idempotency WHERE scope=$1 AND key=$2',
        [r.scope, r.key],
      );
      if (!e) throw new IdentityError('IDEMPOTENCY_CONFLICT');
      return {
        scope: String(e.scope),
        key: String(e.key),
        requestHash: String(e.request_hash),
        state: e.state as IdempotencyRecord['state'],
        statusCode: num(e.status_code),
        response: e.response_json,
        createdAt: Number(e.created_at),
      };
    },
    async completeIdempotency(scope, key, statusCode, response) {
      await q(
        "UPDATE identity_idempotency SET state='DONE', status_code=$3, response_json=$4 WHERE scope=$1 AND key=$2",
        [scope, key, statusCode, JSON.stringify(response)],
      );
    },
    async releaseIdempotency(scope, key) {
      await q(
        "DELETE FROM identity_idempotency WHERE scope=$1 AND key=$2 AND state='PENDING'",
        [scope, key],
      );
    },
    async insertDelegationPolicy(p: DelegationPolicy) {
      await q(
        'INSERT INTO identity_delegation_policy(policy_id,group_id,delegate_principal_id,policy_json,revoked_at) VALUES($1,$2,$3,$4,$5)',
        [
          p.policyId,
          p.groupId,
          p.delegatePrincipalId,
          JSON.stringify(p),
          p.revokedAt,
        ],
      );
    },
    async getDelegationPolicy(id, lock) {
      const [r] = await q(
        `SELECT policy_json,revoked_at FROM identity_delegation_policy WHERE policy_id=$1${lock ? ' FOR UPDATE' : ''}`,
        [id],
      );
      return r
        ? DelegationPolicySchema.parse({
            ...(r.policy_json as object),
            revokedAt: num(r.revoked_at),
          })
        : null;
    },
    async revokeDelegationPolicy(id, now) {
      const rows = await q(
        'UPDATE identity_delegation_policy SET revoked_at=COALESCE(revoked_at,$2) WHERE policy_id=$1 RETURNING policy_id',
        [id, now],
      );
      if (rows.length !== 1)
        throw new IdentityError('INVALID_INPUT', 'unknown policy');
    },
    async listDelegationUsage(policyId) {
      return (
        await q(
          'SELECT usage_id,policy_id,amount::text AS amount,at FROM identity_delegation_usage WHERE policy_id=$1 ORDER BY at',
          [policyId],
        )
      ).map((r) => ({
        usageId: String(r.usage_id),
        policyId: String(r.policy_id),
        amount: String(r.amount),
        at: Number(r.at),
      }));
    },
    async listDelegationPolicies(groupId, delegatePrincipalId) {
      return (
        await q(
          'SELECT policy_json,revoked_at FROM identity_delegation_policy WHERE group_id=$1 AND delegate_principal_id=$2 ORDER BY policy_id',
          [groupId, delegatePrincipalId],
        )
      ).map((r) =>
        DelegationPolicySchema.parse({
          ...(r.policy_json as object),
          revokedAt: num(r.revoked_at),
        }),
      );
    },
    async getDelegationUsage(usageId) {
      const [r] = await q(
        'SELECT usage_id,policy_id,amount::text AS amount,at FROM identity_delegation_usage WHERE usage_id=$1',
        [usageId],
      );
      return r
        ? {
            usageId: String(r.usage_id),
            policyId: String(r.policy_id),
            amount: String(r.amount),
            at: Number(r.at),
          }
        : null;
    },
    async revokeDelegationsForMember(groupId, memberId, now) {
      return (
        await q(
          "UPDATE identity_delegation_policy SET revoked_at=$3 WHERE group_id=$1 AND policy_json->>'delegatorMemberId'=$2 AND revoked_at IS NULL RETURNING policy_id",
          [groupId, memberId, now],
        )
      ).length;
    },
    async insertDelegationUsage(u) {
      const rows = await q(
        'INSERT INTO identity_delegation_usage(usage_id,policy_id,amount,at) VALUES($1,$2,$3,$4) ON CONFLICT (usage_id) DO NOTHING RETURNING usage_id',
        [u.usageId, u.policyId, u.amount, u.at],
      );
      return rows.length === 1;
    },
  };
}
function draftRow(r: Row): DraftRecord {
  return {
    draft: r.draft_json as DraftRecord['draft'],
    asset: r.asset_json as DraftRecord['asset'],
    status: r.status as DraftRecord['status'],
    createdAt: Number(r.created_at),
  };
}
