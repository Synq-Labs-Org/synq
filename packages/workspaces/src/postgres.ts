import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { getAddress, recoverTypedDataAddress, type Hex } from 'viem';
import {
  ARC_WORKSPACE_CHAIN,
  CreateWorkspaceSchema,
  InviteSchema,
  LoginSchema,
  WalletSchema,
  WorkspaceError,
  loginTypedData,
  type LoginChallenge,
  type Member,
  type Role,
  type Workspace,
} from './contracts.js';
import { WORKSPACE_MIGRATIONS } from './migrations.js';

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
type Session = {
  principalId: string;
  wallet: string;
  audience: 'web' | 'native';
};
const workspace = (r: Record<string, unknown>): Workspace => ({
  id: String(r.id),
  displayName: String(r.display_name),
  kind: r.kind as Workspace['kind'],
  createdBy: String(r.created_by),
  chainId: ARC_WORKSPACE_CHAIN,
  status: r.status as Workspace['status'],
  vault: r.vault === null ? null : String(r.vault),
  threshold: r.threshold === null ? null : Number(r.threshold),
});

export class PostgresWorkspaceStore {
  constructor(
    readonly pool: Pool,
    readonly origin: string,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {
    if (new URL(origin).origin !== origin)
      throw new Error('workspace origin must be canonical');
  }
  async transaction<T>(run: (sql: PoolClient) => Promise<T>): Promise<T> {
    const sql = await this.pool.connect();
    try {
      await sql.query('BEGIN');
      const result = await run(sql);
      await sql.query('COMMIT');
      return result;
    } catch (error) {
      await sql.query('ROLLBACK');
      throw error;
    } finally {
      sql.release();
    }
  }
  async migrate(target: number = WORKSPACE_MIGRATIONS.length) {
    if (
      !Number.isInteger(target) ||
      target < 0 ||
      target > WORKSPACE_MIGRATIONS.length
    )
      throw new Error('invalid migration target');
    return this.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_workspaces_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_workspaces_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_workspaces_migrations ORDER BY version',
      );
      const versions = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...WORKSPACE_MIGRATIONS].reverse())
        if (versions.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_workspaces_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of WORKSPACE_MIGRATIONS)
        if (!versions.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_workspaces_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }
  async throttle(bucket: string, limit: number, seconds = 60) {
    const window = Math.floor(this.now() / seconds);
    const r = await this.pool.query(
      `INSERT INTO synq_ws_rate_limits(bucket,window_id,hits) VALUES($1,$2,1)
ON CONFLICT(bucket) DO UPDATE SET window_id=EXCLUDED.window_id, hits=CASE WHEN synq_ws_rate_limits.window_id=EXCLUDED.window_id THEN synq_ws_rate_limits.hits+1 ELSE 1 END
WHERE synq_ws_rate_limits.window_id<>EXCLUDED.window_id OR synq_ws_rate_limits.hits<$3 RETURNING hits`,
      [digest(bucket), window, limit],
    );
    if (!r.rowCount) throw new WorkspaceError('RATE_LIMITED', 429);
  }
  async challenge(raw: unknown): Promise<LoginChallenge> {
    const { wallet, audience } = LoginSchema.parse(raw);
    const c: LoginChallenge = {
      id: randomUUID(),
      wallet,
      audience,
      origin: this.origin,
      nonce: randomBytes(32).toString('hex'),
      expiresAt: this.now() + 300,
    };
    await this.pool.query(
      'INSERT INTO synq_ws_challenges(id,data,expires_at) VALUES($1,$2,$3)',
      [c.id, c, c.expiresAt],
    );
    return c;
  }
  async login(id: string, signature: Hex) {
    const r = await this.pool.query(
      'SELECT data FROM synq_ws_challenges WHERE id=$1 AND NOT consumed AND expires_at>$2',
      [id, this.now()],
    );
    const c = r.rows[0]?.data as LoginChallenge | undefined;
    if (!c || c.origin !== this.origin)
      throw new WorkspaceError('INVALID_LOGIN', 401);
    let signer: string;
    try {
      signer = await recoverTypedDataAddress({
        ...loginTypedData(c),
        message: {
          ...loginTypedData(c).message,
          wallet: getAddress(c.wallet),
          expiresAt: BigInt(c.expiresAt),
        },
        signature,
      });
    } catch {
      throw new WorkspaceError('INVALID_LOGIN', 401);
    }
    if (signer.toLowerCase() !== c.wallet.toLowerCase())
      throw new WorkspaceError('INVALID_LOGIN', 401);
    const token = randomBytes(32).toString('hex');
    const principalId = `wallet:${digest(c.wallet.toLowerCase())}`;
    const expiresAt = this.now() + 900;
    await this.transaction(async (sql) => {
      const used = await sql.query(
        'UPDATE synq_ws_challenges SET consumed=true WHERE id=$1 AND NOT consumed AND expires_at>$2 RETURNING id',
        [id, this.now()],
      );
      if (!used.rowCount) throw new WorkspaceError('INVALID_LOGIN', 401);
      await sql.query(
        'INSERT INTO synq_ws_principals(id,wallet) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [principalId, c.wallet.toLowerCase()],
      );
      await sql.query(
        'INSERT INTO synq_ws_sessions(digest,principal_id,audience,expires_at) VALUES($1,$2,$3,$4)',
        [digest(token), principalId, c.audience, expiresAt],
      );
    });
    return { token, principalId, audience: c.audience, expiresAt };
  }
  async session(
    token: string,
    audience: Session['audience'],
  ): Promise<Session> {
    if (!/^[0-9a-f]{64}$/.test(token))
      throw new WorkspaceError('UNAUTHENTICATED', 401);
    const r = await this.pool.query(
      'SELECT p.id,p.wallet,s.audience FROM synq_ws_sessions s JOIN synq_ws_principals p ON p.id=s.principal_id WHERE s.digest=$1 AND s.audience=$2 AND s.expires_at>$3',
      [digest(token), audience, this.now()],
    );
    const p = r.rows[0];
    if (!p) throw new WorkspaceError('UNAUTHENTICATED', 401);
    return { principalId: p.id, wallet: p.wallet, audience: p.audience };
  }
  async logout(token: string) {
    await this.pool.query('DELETE FROM synq_ws_sessions WHERE digest=$1', [
      digest(token),
    ]);
  }
  private async member(
    sql: Pool | PoolClient,
    id: string,
    principal: string,
    roles?: Role[],
  ): Promise<Member> {
    const r = await sql.query(
      'SELECT * FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
      [id, principal],
    );
    const m = r.rows[0];
    if (!m || (roles && !roles.includes(m.role)))
      throw new WorkspaceError('WORKSPACE_NOT_FOUND', 404);
    return {
      principalId: m.principal_id,
      wallet: m.wallet,
      role: m.role,
      joinedAt: Number(m.joined_at),
    };
  }
  async create(principal: string, input: unknown) {
    const body = CreateWorkspaceSchema.parse(input);
    const id = randomUUID();
    await this.transaction(async (sql) => {
      const r = await sql.query(
        'SELECT wallet FROM synq_ws_principals WHERE id=$1 FOR UPDATE',
        [principal],
      );
      if (!r.rows[0]) throw new WorkspaceError('UNAUTHENTICATED', 401);
      const count = await sql.query(
        'SELECT count(*) AS n FROM synq_workspaces WHERE created_by=$1',
        [principal],
      );
      if (Number(count.rows[0].n) >= 10)
        throw new WorkspaceError('WORKSPACE_LIMIT', 429);
      await sql.query(
        "INSERT INTO synq_workspaces(id,display_name,kind,created_by,chain_id,status) VALUES($1,$2,$3,$4,$5,'FORMING')",
        [id, body.displayName, body.kind, principal, ARC_WORKSPACE_CHAIN],
      );
      await this.addMember(
        sql,
        id,
        principal,
        r.rows[0].wallet,
        'OWNER',
        principal,
      );
    });
    return this.get(id, principal);
  }
  private async addMember(
    sql: PoolClient,
    id: string,
    principal: string,
    wallet: string,
    role: Role,
    actor: string,
  ) {
    await sql.query(
      'INSERT INTO synq_ws_members(workspace_id,principal_id,wallet,role,joined_at) VALUES($1,$2,$3,$4,$5)',
      [id, principal, wallet.toLowerCase(), role, this.now()],
    );
    await sql.query(
      "INSERT INTO synq_ws_membership_log(workspace_id,principal_id,action,role,actor,occurred_at) VALUES($1,$2,'JOIN',$3,$4,$5)",
      [id, principal, role, actor, this.now()],
    );
  }
  async list(principal: string) {
    const r = await this.pool.query(
      'SELECT w.* FROM synq_workspaces w JOIN synq_ws_members m ON m.workspace_id=w.id WHERE m.principal_id=$1 ORDER BY w.id',
      [principal],
    );
    return r.rows.map(workspace);
  }
  async get(id: string, principal: string) {
    return this.transaction(async (sql) => {
      await this.member(sql, id, principal);
      const r = await sql.query('SELECT * FROM synq_workspaces WHERE id=$1', [
        id,
      ]);
      const members = await sql.query(
        'SELECT principal_id,wallet,role,joined_at FROM synq_ws_members WHERE workspace_id=$1 ORDER BY joined_at,principal_id',
        [id],
      );
      return {
        workspace: workspace(r.rows[0]!),
        members: members.rows.map((m) => ({
          principalId: m.principal_id as string,
          wallet: m.wallet as string,
          role: m.role as Role,
          joinedAt: Number(m.joined_at),
        })),
      };
    });
  }
  async invite(id: string, principal: string, raw: unknown) {
    const body = InviteSchema.parse(raw);
    const token = randomBytes(32).toString('hex');
    const expiresAt = this.now() + body.expiresIn;
    await this.transaction(async (sql) => {
      await this.member(sql, id, principal, ['OWNER']);
      const r = await sql.query(
        'SELECT status,kind FROM synq_workspaces WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (
        body.role === 'OWNER' &&
        (r.rows[0]?.status !== 'FORMING' || r.rows[0]?.kind === 'PERSONAL')
      )
        throw new WorkspaceError('OWNER_SETUP_REQUIRED');
      await sql.query(
        'INSERT INTO synq_ws_invites(digest,workspace_id,role,issued_by,expires_at) VALUES($1,$2,$3,$4,$5)',
        [digest(token), id, body.role, principal, expiresAt],
      );
    });
    return { token, expiresAt };
  }
  async accept(principal: string, token: string) {
    return this.transaction(async (sql) => {
      const found = await sql.query(
        'SELECT workspace_id FROM synq_ws_invites WHERE digest=$1',
        [digest(token)],
      );
      const id = found.rows[0]?.workspace_id as string | undefined;
      if (!id) throw new WorkspaceError('INVALID_INVITE', 404);
      const w = await sql.query(
        'SELECT status FROM synq_workspaces WHERE id=$1 FOR UPDATE',
        [id],
      );
      const r = await sql.query(
        'SELECT * FROM synq_ws_invites WHERE digest=$1 AND consumed_by IS NULL AND expires_at>$2 FOR UPDATE',
        [digest(token), this.now()],
      );
      const invite = r.rows[0];
      if (!invite) throw new WorkspaceError('INVALID_INVITE', 404);
      if (invite.role === 'OWNER' && w.rows[0]?.status !== 'FORMING')
        throw new WorkspaceError('OWNER_SETUP_REQUIRED');
      if (invite.role === 'OWNER') {
        const count = await sql.query(
          "SELECT count(*) AS n FROM synq_ws_members WHERE workspace_id=$1 AND role='OWNER'",
          [id],
        );
        if (Number(count.rows[0].n) >= 20)
          throw new WorkspaceError('OWNER_LIMIT');
      }
      const p = await sql.query(
        'SELECT wallet FROM synq_ws_principals WHERE id=$1',
        [principal],
      );
      if (!p.rows[0]) throw new WorkspaceError('UNAUTHENTICATED', 401);
      const exists = await sql.query(
        'SELECT 1 FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
        [id, principal],
      );
      if (exists.rowCount) throw new WorkspaceError('ALREADY_MEMBER');
      await this.addMember(
        sql,
        id,
        principal,
        WalletSchema.parse(p.rows[0].wallet),
        invite.role,
        invite.issued_by,
      );
      await sql.query(
        'UPDATE synq_ws_invites SET consumed_by=$1 WHERE digest=$2',
        [principal, digest(token)],
      );
      return { workspaceId: id };
    });
  }
}
