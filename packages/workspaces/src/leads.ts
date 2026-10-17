import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { WorkspaceError, type Role } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * Private business leads. A business owner makes a single-use invitation; a
 * prospect opens it (Telegram `/start lead_…` or the web invite page) and is
 * bound, once, to a provider-verified identity. That identity becomes an
 * external counterparty of the business, never a workspace member: it cannot
 * read books, vaults or other leads. The private transcript is visible only to
 * the workspace's owners and admins, after the prospect has been told so.
 * Handling is AGENT (the sales agent may reply), HUMAN (only staff reply) or
 * FROZEN (no new offers); every change is versioned and audited.
 */

export const LEAD_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_leads (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), source text NOT NULL CHECK(source IN ('TELEGRAM','WEB','IMESSAGE')), label text NOT NULL, stage text NOT NULL, handling text NOT NULL CHECK(handling IN ('AGENT','HUMAN','FROZEN')), handling_version int NOT NULL DEFAULT 0, needs_owner boolean NOT NULL DEFAULT false, consent_at bigint, consent_scope text NOT NULL, created_at bigint NOT NULL, last_activity_at bigint NOT NULL, owner_read_at bigint NOT NULL DEFAULT 0, UNIQUE(workspace_id, id));
CREATE INDEX synq_leads_inbox ON synq_leads(workspace_id, last_activity_at DESC, id);
CREATE TABLE synq_lead_invites (id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), token_digest text NOT NULL UNIQUE, source text NOT NULL CHECK(source IN ('TELEGRAM','WEB')), created_by text NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, lead_id uuid, redeemed_identity text, redeemed_at bigint);
CREATE TABLE synq_lead_identities (lead_id uuid NOT NULL, workspace_id uuid NOT NULL, channel text NOT NULL CHECK(channel IN ('telegram','web')), identity_digest text NOT NULL, delivery_ref text, bound_at bigint NOT NULL, PRIMARY KEY(lead_id, channel), UNIQUE(workspace_id, channel, identity_digest), FOREIGN KEY(workspace_id, lead_id) REFERENCES synq_leads(workspace_id, id));
CREATE TABLE synq_lead_focus (channel text NOT NULL, identity_digest text NOT NULL, lead_id uuid NOT NULL REFERENCES synq_leads(id), updated_at bigint NOT NULL, PRIMARY KEY(channel, identity_digest));
CREATE TABLE synq_lead_messages (seq bigserial PRIMARY KEY, id uuid NOT NULL UNIQUE, lead_id uuid NOT NULL, workspace_id uuid NOT NULL, author text NOT NULL CHECK(author IN ('LEAD','AGENT','STAFF','SYSTEM')), text text NOT NULL, offer_version int, dedupe_key text, created_at bigint NOT NULL, FOREIGN KEY(workspace_id, lead_id) REFERENCES synq_leads(workspace_id, id), UNIQUE(lead_id, dedupe_key));
CREATE INDEX synq_lead_messages_lead ON synq_lead_messages(lead_id, seq DESC);
CREATE TABLE synq_lead_audit (seq bigserial PRIMARY KEY, lead_id uuid NOT NULL, workspace_id uuid NOT NULL, action text NOT NULL, actor text NOT NULL, handling_version int NOT NULL, occurred_at bigint NOT NULL);
CREATE FUNCTION synq_lead_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lead history is append only'; END $$;
CREATE TRIGGER synq_lead_messages_immutable BEFORE UPDATE OR DELETE ON synq_lead_messages FOR EACH ROW EXECUTE FUNCTION synq_lead_append_only();
CREATE TRIGGER synq_lead_audit_immutable BEFORE UPDATE OR DELETE ON synq_lead_audit FOR EACH ROW EXECUTE FUNCTION synq_lead_append_only();
`,
    down: `DROP TABLE synq_lead_audit, synq_lead_messages, synq_lead_focus, synq_lead_identities, synq_lead_invites, synq_leads; DROP FUNCTION synq_lead_append_only();`,
  },
] as const;

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const STAFF: Role[] = ['OWNER', 'ADMIN'];
export const CONSENT_SCOPE =
  'The business you are talking to can read this private conversation. It is not shared in any group.';
/** Telegram start payloads allow [A-Za-z0-9_-], at most 64 characters. */
export const LEAD_TOKEN_PREFIX = 'lead_';
const TOKEN = /^lead_[A-Za-z0-9_-]{43}$/;

/** What the client view needs from an offer version (staff fields are dropped). */
export type ClientOfferSource = {
  status: string;
  policyVersion: number;
  previousTermsHash: string | null;
  createdBy: string;
};

export type LeadChannel = 'telegram' | 'web';
export type LeadHandling = 'AGENT' | 'HUMAN' | 'FROZEN';
export type LeadRow = {
  leadId: string;
  workspaceId: string;
  label: string;
  source: 'TELEGRAM' | 'WEB' | 'IMESSAGE';
  stage: string;
  handling: LeadHandling;
  handlingVersion: number;
  needsOwner: boolean;
  consentAt: number | null;
  lastActivityAt: number;
  ownerReadAt: number;
};
const lead = (r: Record<string, unknown>): LeadRow => ({
  leadId: String(r.id),
  workspaceId: String(r.workspace_id),
  label: String(r.label),
  source: r.source as LeadRow['source'],
  stage: String(r.stage),
  handling: r.handling as LeadHandling,
  handlingVersion: Number(r.handling_version),
  needsOwner: Boolean(r.needs_owner),
  consentAt: r.consent_at === null ? null : Number(r.consent_at),
  lastActivityAt: Number(r.last_activity_at),
  ownerReadAt: Number(r.owner_read_at),
});

const InviteRequest = z.strictObject({
  source: z.enum(['TELEGRAM', 'WEB']),
  expiresInSeconds: z.number().int().min(300).max(604800),
});
const Takeover = z.strictObject({
  action: z.enum([
    'HUMAN_TAKEOVER',
    'HAND_BACK_TO_AGENT',
    'FREEZE_OFFERS',
    'ESCALATE_TO_OWNER',
  ]),
  expectedVersion: z.number().int().min(0),
});
const Text = z.string().trim().min(1).max(4000);

export type LeadDelivery = (target: {
  leadId: string;
  channel: LeadChannel;
  deliveryRef: string;
  text: string;
}) => Promise<void>;

export class WorkspaceLeads {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: {
      /** Public web origin for invite pages. */
      webOrigin: string;
      /** Bot username for t.me links; null when no bot is connected. */
      telegramBot: () => string | null;
      /** Sends staff messages to the lead's private chat, when a channel is bound. */
      deliver?: LeadDelivery;
      /** Change markers for the live stream (ids only, after commit). */
      publish?: (
        type: 'LEAD_UPDATED' | 'LEAD_MESSAGE',
        workspaceId: string,
        leadId: string,
      ) => Promise<void>;
      /** A lead was created for the first time (after commit). */
      onCreated?: (workspaceId: string, leadId: string) => Promise<void>;
    },
  ) {}

  private now() {
    return this.store.now();
  }

  private async publish(
    type: 'LEAD_UPDATED' | 'LEAD_MESSAGE',
    workspaceId: string,
    leadId: string,
  ) {
    // The stream is a hint to refetch; a lost marker never loses data.
    await this.options
      .publish?.(type, workspaceId, leadId)
      .catch(() => undefined);
  }

  async migrate(target: number = LEAD_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_leads_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_leads_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_leads_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...LEAD_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_leads_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of LEAD_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_leads_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  private async staff(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (!STAFF.includes(m.role)) throw new WorkspaceError('NOT_FOUND', 404);
    return m;
  }

  /** A single-use private invitation link. The token is shown once. */
  async invite(workspaceId: string, principalId: string, raw: unknown) {
    const body = InviteRequest.parse(raw);
    await this.staff(workspaceId, principalId);
    const w = await this.store.pool.query(
      'SELECT kind FROM synq_workspaces WHERE id=$1',
      [workspaceId],
    );
    if (w.rows[0]?.kind !== 'BUSINESS')
      throw new WorkspaceError('BUSINESS_WORKSPACE_REQUIRED', 422);
    const bot = this.options.telegramBot();
    if (body.source === 'TELEGRAM' && !bot)
      throw new WorkspaceError('TELEGRAM_NOT_CONFIGURED', 503);
    const token = `${LEAD_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const id = randomUUID();
    const now = this.now();
    const expiresAt = now + body.expiresInSeconds;
    await this.store.pool.query(
      'INSERT INTO synq_lead_invites(id,workspace_id,token_digest,source,created_by,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        workspaceId,
        digest(token),
        body.source,
        principalId,
        now,
        expiresAt,
      ],
    );
    return {
      inviteId: id,
      telegramUrl:
        body.source === 'TELEGRAM'
          ? `https://t.me/${bot}?start=${token}`
          : null,
      webUrl: `${this.options.webOrigin}/deal-invite/${token}`,
      expiresAt: iso(expiresAt),
    };
  }

  /**
   * Binds an invitation to the identity that opened it, once. The same
   * identity opening it again gets the same lead; anyone else is refused.
   * `identity` must already be provider-verified (Telegram user id from a
   * verified update, or a signed-in Synq principal).
   */
  async redeem(input: {
    token: string;
    channel: LeadChannel;
    identity: string;
    deliveryRef: string | null;
    /** A signed-in Synq principal redeeming on the web; members are refused. */
    principalId?: string;
  }) {
    if (!TOKEN.test(input.token))
      throw new WorkspaceError('INVITE_INVALID', 404);
    const who = digest(`${input.channel}:${input.identity}`);
    const result = await this.store.transaction(async (sql) => {
      const now = this.now();
      const r = await sql.query(
        'SELECT i.*, w.display_name FROM synq_lead_invites i JOIN synq_workspaces w ON w.id=i.workspace_id WHERE i.token_digest=$1 FOR UPDATE OF i',
        [digest(input.token)],
      );
      const invite = r.rows[0];
      if (!invite) throw new WorkspaceError('INVITE_INVALID', 404);
      const workspaceName = String(invite.display_name);
      if (invite.redeemed_identity !== null) {
        if (invite.redeemed_identity !== who)
          throw new WorkspaceError('INVITE_INVALID', 404);
        await this.focus(sql, input.channel, who, String(invite.lead_id), now);
        return {
          leadId: String(invite.lead_id),
          workspaceId: String(invite.workspace_id),
          workspaceName,
          bound: true,
          created: false,
        };
      }
      if (Number(invite.expires_at) <= now)
        throw new WorkspaceError('INVITE_INVALID', 404);
      const workspaceId = String(invite.workspace_id);
      // A client is an outside counterparty; the business's own members cannot be one.
      if (input.principalId) {
        const member = await sql.query(
          'SELECT 1 FROM synq_ws_members WHERE workspace_id=$1 AND principal_id=$2',
          [workspaceId, input.principalId],
        );
        if (member.rowCount)
          throw new WorkspaceError('MEMBERS_CANNOT_BE_LEADS', 422);
      }
      // The same person enquiring again continues their existing lead.
      const existing = await sql.query(
        'SELECT lead_id FROM synq_lead_identities WHERE workspace_id=$1 AND channel=$2 AND identity_digest=$3',
        [workspaceId, input.channel, who],
      );
      let leadId: string;
      let created = false;
      if (existing.rows[0]) {
        leadId = String(existing.rows[0].lead_id);
      } else {
        leadId = randomUUID();
        created = true;
        const source = input.channel === 'telegram' ? 'TELEGRAM' : 'WEB';
        await sql.query(
          "INSERT INTO synq_leads(id,workspace_id,source,label,stage,handling,consent_at,consent_scope,created_at,last_activity_at) VALUES($1,$2,$3,$4,'LEAD_OPEN','AGENT',$5,$6,$5,$5)",
          [
            leadId,
            workspaceId,
            source,
            `${source === 'TELEGRAM' ? 'Telegram' : 'Web'} lead · ${who.slice(0, 4).toUpperCase()}`,
            now,
            CONSENT_SCOPE,
          ],
        );
        await sql.query(
          'INSERT INTO synq_lead_identities(lead_id,workspace_id,channel,identity_digest,delivery_ref,bound_at) VALUES($1,$2,$3,$4,$5,$6)',
          [leadId, workspaceId, input.channel, who, input.deliveryRef, now],
        );
        await this.audit(sql, leadId, workspaceId, 'BOUND', 'lead', 0, now);
      }
      await sql.query(
        'UPDATE synq_lead_invites SET lead_id=$2, redeemed_identity=$3, redeemed_at=$4 WHERE id=$1',
        [invite.id, leadId, who, now],
      );
      await this.focus(sql, input.channel, who, leadId, now);
      return { leadId, workspaceId, workspaceName, bound: true, created };
    });
    if (result.created) {
      await this.publish('LEAD_UPDATED', result.workspaceId, result.leadId);
      await this.options
        .onCreated?.(result.workspaceId, result.leadId)
        .catch(() => undefined);
    }
    return result;
  }

  private async focus(
    sql: PoolClient,
    channel: LeadChannel,
    who: string,
    leadId: string,
    now: number,
  ) {
    await sql.query(
      'INSERT INTO synq_lead_focus(channel,identity_digest,lead_id,updated_at) VALUES($1,$2,$3,$4) ON CONFLICT(channel,identity_digest) DO UPDATE SET lead_id=EXCLUDED.lead_id, updated_at=EXCLUDED.updated_at',
      [channel, who, leadId, now],
    );
  }

  private async audit(
    sql: PoolClient,
    leadId: string,
    workspaceId: string,
    action: string,
    actor: string,
    version: number,
    now: number,
  ) {
    await sql.query(
      'INSERT INTO synq_lead_audit(lead_id,workspace_id,action,actor,handling_version,occurred_at) VALUES($1,$2,$3,$4,$5,$6)',
      [leadId, workspaceId, action, actor, version, now],
    );
  }

  /** The lead a verified private-chat identity is currently talking to, if any. */
  async focused(channel: LeadChannel, identity: string) {
    const r = await this.store.pool.query(
      'SELECT l.* FROM synq_lead_focus f JOIN synq_leads l ON l.id=f.lead_id WHERE f.channel=$1 AND f.identity_digest=$2',
      [channel, digest(`${channel}:${identity}`)],
    );
    return r.rows[0] ? lead(r.rows[0]) : null;
  }

  /** A message from the lead. Repeated provider deliveries are stored once. */
  async fromLead(input: {
    channel: LeadChannel;
    identity: string;
    text: string;
    dedupeKey: string;
  }) {
    const current = await this.focused(input.channel, input.identity);
    if (!current) return null;
    const text = Text.parse(input.text);
    const message = await this.append(
      current.leadId,
      current.workspaceId,
      'LEAD',
      text,
      `lead:${input.dedupeKey}`,
      null,
    );
    if (!message.duplicate)
      await this.publish('LEAD_MESSAGE', current.workspaceId, current.leadId);
    return { lead: (await this.row(current.leadId))!, message };
  }

  /**
   * The web client's own leads: those bound to this principal's web identity,
   * exactly as `redeem` stored it. A business member is never a client.
   */
  private async clientRows(principalId: string, leadId?: string) {
    const r = await this.store.pool.query(
      `SELECT l.*, w.display_name FROM synq_lead_identities i
         JOIN synq_leads l ON l.id=i.lead_id AND l.workspace_id=i.workspace_id
         JOIN synq_workspaces w ON w.id=l.workspace_id
        WHERE i.channel='web' AND i.identity_digest=$1
          AND ($2::uuid IS NULL OR l.id=$2)
          AND NOT EXISTS (SELECT 1 FROM synq_ws_members m WHERE m.workspace_id=l.workspace_id AND m.principal_id=$3)
        ORDER BY l.last_activity_at DESC, l.id DESC`,
      [digest(`web:${principalId}`), leadId ?? null, principalId],
    );
    return r.rows.map((x) => ({
      row: lead(x),
      businessName: String(x.display_name),
    }));
  }

  private clientSummary(row: LeadRow, businessName: string) {
    return {
      leadId: row.leadId,
      businessName,
      stage: row.stage,
      lastActivityAt: iso(row.lastActivityAt),
    };
  }

  /** The client's own conversations, newest activity first. */
  async clientLeads(principalId: string) {
    const rows = await this.clientRows(principalId);
    return {
      leads: rows.map((x) => this.clientSummary(x.row, x.businessName)),
    };
  }

  /** One of the client's leads, or 404 for anyone else. Offers not yet sent are hidden. */
  async clientDetail<O extends ClientOfferSource = ClientOfferSource>(
    principalId: string,
    leadId: string,
    offers: (leadId: string) => Promise<O[]> = async () => [],
  ) {
    const found = (await this.clientRows(principalId, leadId))[0];
    if (!found) throw new WorkspaceError('NOT_FOUND', 404);
    const m = await this.store.pool.query(
      'SELECT * FROM synq_lead_messages WHERE lead_id=$1 ORDER BY seq DESC LIMIT 51',
      [leadId],
    );
    const visible = (await offers(leadId)).filter(
      (o) => o.status !== 'DRAFTED' && o.status !== 'VALIDATED',
    );
    return {
      lead: this.clientSummary(found.row, found.businessName),
      consent: {
        granted: found.row.consentAt !== null,
        grantedAt:
          found.row.consentAt === null ? null : iso(found.row.consentAt),
        scope: CONSENT_SCOPE,
      },
      messages: m.rows.slice(0, 50).reverse().map(messageView),
      olderMessagesCursor:
        m.rows.length > 50
          ? Buffer.from(String(m.rows[49].seq)).toString('base64url')
          : null,
      offers: visible.map(
        ({ policyVersion: _p, previousTermsHash: _h, createdBy: _c, ...o }) =>
          o,
      ),
    };
  }

  /**
   * A message from the web client on one of their own leads. Repeats with the
   * same idempotency key are stored once. The returned lead row lets the
   * caller run the sales agent, which stays silent unless handling is AGENT.
   */
  async fromClient(
    principalId: string,
    leadId: string,
    raw: unknown,
    idempotencyKey: string,
  ) {
    const found = (await this.clientRows(principalId, leadId))[0];
    if (!found) throw new WorkspaceError('NOT_FOUND', 404);
    const text = Text.parse(z.strictObject({ text: Text }).parse(raw).text);
    const message = await this.append(
      leadId,
      found.row.workspaceId,
      'LEAD',
      text,
      `lead:web:${idempotencyKey}`,
      null,
    );
    if (!message.duplicate)
      await this.publish('LEAD_MESSAGE', found.row.workspaceId, leadId);
    return { lead: (await this.row(leadId))!, message };
  }

  private async row(leadId: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_leads WHERE id=$1',
      [leadId],
    );
    return r.rows[0] ? lead(r.rows[0]) : null;
  }

  private async append(
    leadId: string,
    workspaceId: string,
    author: 'LEAD' | 'AGENT' | 'STAFF' | 'SYSTEM',
    text: string,
    dedupeKey: string | null,
    offerVersion: number | null,
    guard?: (row: LeadRow) => void,
  ) {
    return this.store.transaction(async (sql) => {
      const now = this.now();
      const r = await sql.query(
        'SELECT * FROM synq_leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [leadId, workspaceId],
      );
      if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      guard?.(lead(r.rows[0]));
      if (dedupeKey) {
        const seen = await sql.query(
          'SELECT * FROM synq_lead_messages WHERE lead_id=$1 AND dedupe_key=$2',
          [leadId, dedupeKey],
        );
        if (seen.rows[0])
          return { ...messageView(seen.rows[0]), duplicate: true };
      }
      const id = randomUUID();
      const m = await sql.query(
        'INSERT INTO synq_lead_messages(id,lead_id,workspace_id,author,text,offer_version,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id, leadId, workspaceId, author, text, offerVersion, dedupeKey, now],
      );
      await sql.query(
        `UPDATE synq_leads SET last_activity_at=$2, stage=CASE WHEN stage='LEAD_OPEN' AND $3='LEAD' THEN 'DISCOVERY' ELSE stage END WHERE id=$1`,
        [leadId, now, author],
      );
      return { ...messageView(m.rows[0]), duplicate: false };
    });
  }

  /** A sales-agent reply. Refused unless the lead is in AGENT handling at write time. */
  async fromAgent(
    leadId: string,
    workspaceId: string,
    text: string,
    dedupeKey: string,
    offerVersion: number | null = null,
  ) {
    const m = await this.append(
      leadId,
      workspaceId,
      'AGENT',
      Text.parse(text),
      `agent:${dedupeKey}`,
      offerVersion,
      (row) => {
        if (row.handling !== 'AGENT')
          throw new WorkspaceError('AGENT_NOT_HANDLING', 409);
      },
    );
    if (!m.duplicate) await this.publish('LEAD_MESSAGE', workspaceId, leadId);
    return m;
  }

  /** A staff message, only after a human takeover. Delivered to the lead's chat. */
  async fromStaff(
    workspaceId: string,
    principalId: string,
    leadId: string,
    raw: unknown,
    idempotencyKey: string,
  ) {
    await this.staff(workspaceId, principalId);
    const text = Text.parse(z.strictObject({ text: Text }).parse(raw).text);
    const m = await this.append(
      leadId,
      workspaceId,
      'STAFF',
      text,
      `staff:${idempotencyKey}`,
      null,
      (row) => {
        if (row.handling !== 'HUMAN')
          throw new WorkspaceError('TAKEOVER_REQUIRED', 409);
      },
    );
    if (!m.duplicate && this.options.deliver) {
      const target = await this.store.pool.query(
        'SELECT channel,delivery_ref FROM synq_lead_identities WHERE lead_id=$1 AND delivery_ref IS NOT NULL ORDER BY bound_at DESC LIMIT 1',
        [leadId],
      );
      if (target.rows[0])
        await this.options.deliver({
          leadId,
          channel: target.rows[0].channel as LeadChannel,
          deliveryRef: String(target.rows[0].delivery_ref),
          text,
        });
    }
    if (!m.duplicate) await this.publish('LEAD_MESSAGE', workspaceId, leadId);
    const { duplicate: _d, ...view } = m;
    return view;
  }

  async takeover(
    workspaceId: string,
    principalId: string,
    leadId: string,
    raw: unknown,
  ) {
    const body = Takeover.parse(raw);
    await this.staff(workspaceId, principalId);
    return this.store
      .transaction(async (sql) => {
        const r = await sql.query(
          'SELECT * FROM synq_leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
          [leadId, workspaceId],
        );
        if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
        const row = lead(r.rows[0]);
        if (row.handlingVersion !== body.expectedVersion)
          throw new WorkspaceError('VERSION_CONFLICT', 409);
        const handling: LeadHandling =
          body.action === 'HUMAN_TAKEOVER'
            ? 'HUMAN'
            : body.action === 'HAND_BACK_TO_AGENT'
              ? 'AGENT'
              : body.action === 'FREEZE_OFFERS'
                ? 'FROZEN'
                : row.handling;
        const version = row.handlingVersion + 1;
        await sql.query(
          'UPDATE synq_leads SET handling=$2, handling_version=$3, needs_owner=$4 WHERE id=$1',
          [
            leadId,
            handling,
            version,
            body.action === 'ESCALATE_TO_OWNER'
              ? true
              : body.action === 'HUMAN_TAKEOVER'
                ? false
                : row.needsOwner,
          ],
        );
        await this.audit(
          sql,
          leadId,
          workspaceId,
          body.action,
          principalId,
          version,
          this.now(),
        );
        return { handling, handlingVersion: version };
      })
      .then(async (r) => {
        await this.publish('LEAD_UPDATED', workspaceId, leadId);
        return r;
      });
  }

  /** Marks the lead as needing a human, from the agent side (no version needed). */
  async escalate(leadId: string, workspaceId: string, reason: string) {
    await this.store.transaction(async (sql) => {
      const r = await sql.query(
        'UPDATE synq_leads SET needs_owner=true WHERE id=$1 AND workspace_id=$2 RETURNING handling_version',
        [leadId, workspaceId],
      );
      if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      await this.audit(
        sql,
        leadId,
        workspaceId,
        `AGENT_ESCALATED:${reason.slice(0, 60)}`,
        'agent',
        Number(r.rows[0].handling_version),
        this.now(),
      );
    });
  }

  private summary(row: LeadRow, unread: number) {
    return {
      leadId: row.leadId,
      workspaceId: row.workspaceId,
      label: row.label,
      source: row.source,
      stage: row.stage,
      handling: row.handling,
      needsOwner: row.needsOwner,
      unread,
      lastActivityAt: iso(row.lastActivityAt),
    };
  }

  private async unread(leadIds: string[]) {
    if (!leadIds.length) return new Map<string, number>();
    const r = await this.store.pool.query(
      "SELECT m.lead_id, count(*)::int AS n FROM synq_lead_messages m JOIN synq_leads l ON l.id=m.lead_id WHERE m.lead_id = ANY($1::uuid[]) AND m.author='LEAD' AND m.created_at > l.owner_read_at GROUP BY m.lead_id",
      [leadIds],
    );
    return new Map(r.rows.map((x) => [String(x.lead_id), Number(x.n)]));
  }

  async inbox(
    workspaceId: string,
    principalId: string,
    query: {
      cursor?: string;
      limit?: number;
      stage?: string;
      handling?: string;
    },
  ) {
    await this.staff(workspaceId, principalId);
    const limit = query.limit ?? 20;
    let after: { at: number; id: string } | null = null;
    if (query.cursor) {
      const parsed = z
        .tuple([z.coerce.number().int(), z.uuid()])
        .safeParse(
          Buffer.from(query.cursor, 'base64url').toString().split('|'),
        );
      if (!parsed.success) throw new WorkspaceError('INVALID_CURSOR', 400);
      after = { at: parsed.data[0], id: parsed.data[1] };
    }
    const r = await this.store.pool.query(
      `SELECT * FROM synq_leads WHERE workspace_id=$1
        AND ($2::text IS NULL OR stage=$2) AND ($3::text IS NULL OR handling=$3)
        AND ($4::bigint IS NULL OR (last_activity_at, id) < ($4::bigint, $5::uuid))
       ORDER BY last_activity_at DESC, id DESC LIMIT $6`,
      [
        workspaceId,
        query.stage ?? null,
        query.handling ?? null,
        after?.at ?? null,
        after?.id ?? null,
        limit + 1,
      ],
    );
    const rows = r.rows.map(lead);
    const page = rows.slice(0, limit);
    const unread = await this.unread(page.map((x) => x.leadId));
    return {
      items: page.map((x) => this.summary(x, unread.get(x.leadId) ?? 0)),
      nextCursor:
        rows.length > limit
          ? Buffer.from(
              `${page.at(-1)!.lastActivityAt}|${page.at(-1)!.leadId}`,
            ).toString('base64url')
          : null,
    };
  }

  async counts(workspaceId: string) {
    const r = await this.store.pool.query(
      "SELECT count(*) FILTER (WHERE stage NOT IN ('RELEASED','REFUNDED','CANCELLED'))::int AS open, count(*) FILTER (WHERE needs_owner)::int AS needs FROM synq_leads WHERE workspace_id=$1",
      [workspaceId],
    );
    return {
      open: Number(r.rows[0].open),
      needsOwner: Number(r.rows[0].needs),
    };
  }

  /** Lead detail for staff. Reading it marks the lead's messages read. */
  async detail(
    workspaceId: string,
    principalId: string,
    leadId: string,
    offers: (leadId: string) => Promise<unknown[]> = async () => [],
  ) {
    await this.staff(workspaceId, principalId);
    const row = await this.row(leadId);
    if (!row || row.workspaceId !== workspaceId)
      throw new WorkspaceError('NOT_FOUND', 404);
    const m = await this.store.pool.query(
      'SELECT * FROM synq_lead_messages WHERE lead_id=$1 ORDER BY seq DESC LIMIT 51',
      [leadId],
    );
    const unread = (await this.unread([leadId])).get(leadId) ?? 0;
    await this.store.pool.query(
      'UPDATE synq_leads SET owner_read_at=GREATEST(owner_read_at,$2) WHERE id=$1',
      [leadId, this.now()],
    );
    const messages = m.rows.slice(0, 50).reverse().map(messageView);
    return {
      lead: this.summary(row, unread),
      handlingVersion: row.handlingVersion,
      consent: {
        granted: row.consentAt !== null,
        grantedAt: row.consentAt === null ? null : iso(row.consentAt),
        scope: CONSENT_SCOPE,
      },
      messages,
      olderMessagesCursor:
        m.rows.length > 50
          ? Buffer.from(String(m.rows[49].seq)).toString('base64url')
          : null,
      offers: await offers(leadId),
    };
  }

  /** Recent transcript for the sales agent (lead and replies only, oldest first). */
  async transcript(leadId: string, limit = 20) {
    const m = await this.store.pool.query(
      'SELECT * FROM synq_lead_messages WHERE lead_id=$1 ORDER BY seq DESC LIMIT $2',
      [leadId, limit],
    );
    return m.rows.reverse().map(messageView);
  }
}

function messageView(r: Record<string, unknown>) {
  return {
    messageId: String(r.id),
    author: r.author as 'LEAD' | 'AGENT' | 'STAFF' | 'SYSTEM',
    text: String(r.text),
    offerVersion: r.offer_version === null ? null : Number(r.offer_version),
    createdAt: iso(Number(r.created_at)),
  };
}
