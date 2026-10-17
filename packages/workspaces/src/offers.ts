import { randomUUID } from 'node:crypto';
import {
  getAddress,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { CommercialPolicySchema, OfferTermsSchema } from '@synq/contracts';
import { WorkspaceError } from './contracts.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * Commercial authority for private leads. An owner signs a versioned
 * commercial policy (catalog, price floors, discount cap, deposit, capacity,
 * owner-approval threshold). Every offer is an immutable version whose terms
 * hash chains to the version it replaces. A deterministic validator decides
 * whether an offer may be sent; a language model may only propose terms.
 * Accepting an offer in chat is not a signature: it moves the lead to
 * "agreed, pending signatures" and payment stays a separate wallet action.
 */

export const OFFER_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_commercial_policies (workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), version int NOT NULL CHECK(version>0), document jsonb NOT NULL, policy_hash text NOT NULL, state text NOT NULL CHECK(state IN ('REVIEW','ACTIVE','SUPERSEDED')), proposed_by text NOT NULL, approved_by text, signature text, created_at bigint NOT NULL, approved_at bigint, PRIMARY KEY(workspace_id, version));
CREATE UNIQUE INDEX synq_commercial_policy_active ON synq_commercial_policies(workspace_id) WHERE state='ACTIVE';
CREATE TABLE synq_offers (offer_id uuid NOT NULL, version int NOT NULL CHECK(version>0), workspace_id uuid NOT NULL REFERENCES synq_workspaces(id), lead_id uuid NOT NULL, terms jsonb NOT NULL, terms_hash text NOT NULL UNIQUE, previous_terms_hash text, policy_version int NOT NULL, status text NOT NULL CHECK(status IN ('SENT','ACCEPTED','REJECTED','COUNTERED','EXPIRED','WITHDRAWN')), created_by text NOT NULL CHECK(created_by IN ('AGENT','STAFF')), validation jsonb NOT NULL, created_at bigint NOT NULL, expires_at bigint NOT NULL, PRIMARY KEY(offer_id, version));
CREATE INDEX synq_offers_lead ON synq_offers(lead_id, created_at);
CREATE FUNCTION synq_offer_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.terms<>OLD.terms OR NEW.terms_hash<>OLD.terms_hash OR NEW.offer_id<>OLD.offer_id OR NEW.version<>OLD.version OR NEW.lead_id<>OLD.lead_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.policy_version<>OLD.policy_version OR NEW.created_by<>OLD.created_by OR NEW.expires_at<>OLD.expires_at THEN RAISE EXCEPTION 'offer terms are immutable'; END IF;
  IF OLD.status<>'SENT' THEN RAISE EXCEPTION 'offer is closed'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER synq_offer_immutable BEFORE UPDATE ON synq_offers FOR EACH ROW EXECUTE FUNCTION synq_offer_guard();
CREATE FUNCTION synq_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.document<>OLD.document OR NEW.policy_hash<>OLD.policy_hash OR NEW.version<>OLD.version OR NEW.workspace_id<>OLD.workspace_id THEN RAISE EXCEPTION 'commercial policy is immutable'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER synq_policy_immutable BEFORE UPDATE ON synq_commercial_policies FOR EACH ROW EXECUTE FUNCTION synq_policy_guard();
`,
    down: `DROP TABLE synq_offers, synq_commercial_policies; DROP FUNCTION synq_offer_guard(); DROP FUNCTION synq_policy_guard();`,
  },
] as const;

export { CommercialPolicySchema, OfferTermsSchema };
export type CommercialPolicy = z.output<typeof CommercialPolicySchema>;
export type OfferTerms = z.output<typeof OfferTermsSchema>;

/** Stable JSON (sorted keys), so a hash never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export const policyHash = (
  workspaceId: string,
  version: number,
  p: CommercialPolicy,
) =>
  keccak256(
    toHex(
      canonicalJson({
        schema: 'synq-commercial-policy-v1',
        workspaceId,
        version,
        policy: p,
      }),
    ),
  );
export function offerTermsHash(o: {
  workspaceId: string;
  leadId: string;
  offerId: string;
  version: number;
  policyVersion: number;
  previousTermsHash: string | null;
  expiresAt: number;
  terms: OfferTerms;
}) {
  return keccak256(
    toHex(
      canonicalJson({
        schema: 'synq-offer-v1',
        asset: 'arc-testnet:USDC',
        ...o,
      }),
    ),
  );
}

export function commercialPolicyTypedData(
  workspaceId: string,
  version: number,
  hash: Hex,
) {
  return {
    domain: { name: 'Synq Commercial Policy', version: '1', chainId: 5042002 },
    types: {
      CommercialPolicy: [
        { name: 'workspaceId', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'policyHash', type: 'bytes32' },
        { name: 'statement', type: 'string' },
      ],
    },
    primaryType: 'CommercialPolicy' as const,
    message: {
      workspaceId,
      version: BigInt(version),
      policyHash: hash,
      statement:
        'Let the sales agent send offers within this policy. Offers never move money; payments need separate wallet approvals.',
    },
  };
}

export type Check = { rule: string; passed: boolean; detail: string };
export type Validation = {
  allowed: boolean;
  checks: Check[];
  totalUnits: string;
  needsOwner: boolean;
};

/**
 * The deterministic commercial gate. Pure: same policy, terms, time and actor
 * always give the same answer, whatever any model said.
 */
export function validateOffer(
  policy: CommercialPolicy,
  terms: OfferTerms,
  now: number,
  actor: { kind: 'AGENT' } | { kind: 'STAFF'; owner: boolean },
): Validation {
  const checks: Check[] = [];
  const check = (rule: string, passed: boolean, detail: string) =>
    checks.push({ rule, passed, detail });
  const items = new Map(policy.catalog.map((i) => [i.sku, i]));
  let subtotal = 0n;
  let surcharge = 0n;
  for (const line of terms.lines) {
    const item = items.get(line.sku);
    if (!item) {
      check('SKU_KNOWN', false, `${line.sku} is not in the catalog`);
      continue;
    }
    const unit = BigInt(line.unitUnits);
    const list = BigInt(item.unitUnits);
    check(
      'QUANTITY_LIMIT',
      line.quantity <= item.maxQuantity,
      `${line.sku}: ${line.quantity} of at most ${item.maxQuantity}`,
    );
    check(
      'PRICE_FLOOR',
      unit >= BigInt(item.floorUnits),
      `${line.sku}: unit price ${unit} against floor ${item.floorUnits}`,
    );
    check(
      'DISCOUNT_CAP',
      unit * 10000n >= list * BigInt(10000 - policy.maxDiscountBps),
      `${line.sku}: at most ${policy.maxDiscountBps / 100}% below list ${list}`,
    );
    if (terms.rush) {
      const cap = item.capacity;
      const fresh =
        cap !== null &&
        now - Math.floor(Date.parse(cap.asOf) / 1000) <=
          policy.capacityFreshSeconds;
      check(
        'RUSH_CAPACITY',
        fresh && line.quantity <= cap!.unitsAvailable,
        cap === null
          ? `${line.sku}: delivery capacity is not declared`
          : !fresh
            ? `${line.sku}: declared capacity is out of date`
            : `${line.sku}: ${line.quantity} against ${cap.unitsAvailable} available`,
      );
    } else
      check(
        'LEAD_TIME',
        terms.deliveryDays >= item.leadTimeDays,
        `${line.sku}: ${terms.deliveryDays} days against a ${item.leadTimeDays}-day lead time`,
      );
    const lineTotal = unit * BigInt(line.quantity);
    subtotal += lineTotal;
    if (terms.rush)
      surcharge += (lineTotal * BigInt(item.rushSurchargeBps)) / 10000n;
  }
  const total = subtotal + surcharge;
  const milestones = terms.milestones.reduce((n, m) => n + BigInt(m.units), 0n);
  check(
    'MILESTONES_TOTAL',
    milestones === total,
    `milestones ${milestones} against total ${total}`,
  );
  check(
    'MILESTONE_COUNT',
    terms.milestones.length <= policy.maxMilestones,
    `${terms.milestones.length} of at most ${policy.maxMilestones}`,
  );
  check(
    'MILESTONES_BEFORE_DELIVERY',
    terms.milestones.every((m) => m.dueInDays <= terms.deliveryDays),
    'every milestone is due by the delivery date',
  );
  const deposit = BigInt(terms.depositUnits);
  check(
    'DEPOSIT',
    deposit <= total &&
      deposit * 10000n >= total * BigInt(policy.minDepositBps),
    `deposit ${deposit}, at least ${policy.minDepositBps / 100}% of ${total}`,
  );
  check('POSITIVE_TOTAL', total > 0n, `total ${total}`);
  const needsOwner = total > BigInt(policy.ownerApprovalAboveUnits);
  check(
    'OWNER_THRESHOLD',
    !needsOwner || (actor.kind === 'STAFF' && actor.owner),
    needsOwner
      ? `total ${total} is above ${policy.ownerApprovalAboveUnits}; only an owner may send it`
      : 'within the agent limit',
  );
  return {
    allowed: checks.every((c) => c.passed),
    checks,
    totalUnits: String(total),
    needsOwner,
  };
}

type OfferRow = {
  offerId: string;
  version: number;
  workspaceId: string;
  leadId: string;
  terms: OfferTerms;
  termsHash: string;
  previousTermsHash: string | null;
  policyVersion: number;
  status: string;
  createdBy: 'AGENT' | 'STAFF';
  validation: Validation;
  createdAt: number;
  expiresAt: number;
};
const offer = (r: Record<string, unknown>): OfferRow => ({
  offerId: String(r.offer_id),
  version: Number(r.version),
  workspaceId: String(r.workspace_id),
  leadId: String(r.lead_id),
  terms: OfferTermsSchema.parse(r.terms),
  termsHash: String(r.terms_hash),
  previousTermsHash:
    r.previous_terms_hash === null ? null : String(r.previous_terms_hash),
  policyVersion: Number(r.policy_version),
  status: String(r.status),
  createdBy: r.created_by as 'AGENT' | 'STAFF',
  validation: r.validation as Validation,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
});
const iso = (s: number) => new Date(s * 1000).toISOString();
const USDC = {
  assetId: 'arc-testnet:USDC',
  symbol: 'USDC',
  chainId: 5042002,
  decimals: 6,
};

export class WorkspaceOffers {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: {
      /** Change markers for the live stream (ids only, after commit). */
      publish?: (workspaceId: string, leadId: string) => Promise<void>;
    } = {},
  ) {}

  private async publish(workspaceId: string, leadId: string) {
    await this.options.publish?.(workspaceId, leadId).catch(() => undefined);
  }

  private now() {
    return this.store.now();
  }

  async migrate(target: number = OFFER_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_offers_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_offers_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_offers_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...OFFER_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_offers_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of OFFER_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_offers_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  private async role(workspaceId: string, principalId: string) {
    const m = await this.store.membership(workspaceId, principalId);
    if (m.role !== 'OWNER' && m.role !== 'ADMIN')
      throw new WorkspaceError('NOT_FOUND', 404);
    return m;
  }

  /** Proposes the next policy version; it applies only after an owner signs it. */
  async proposePolicy(workspaceId: string, principalId: string, raw: unknown) {
    const policy = CommercialPolicySchema.parse(raw);
    await this.role(workspaceId, principalId);
    const version = await this.store.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      const r = await sql.query(
        'SELECT coalesce(max(version),0)::int AS v FROM synq_commercial_policies WHERE workspace_id=$1',
        [workspaceId],
      );
      const version = Number(r.rows[0].v) + 1;
      const hash = policyHash(workspaceId, version, policy);
      await sql.query(
        "INSERT INTO synq_commercial_policies(workspace_id,version,document,policy_hash,state,proposed_by,created_at) VALUES($1,$2,$3,$4,'REVIEW',$5,$6)",
        [workspaceId, version, policy, hash, principalId, this.now()],
      );
      return version;
    });
    return this.policyView(workspaceId, version);
  }

  async policyView(workspaceId: string, version: number) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_commercial_policies WHERE workspace_id=$1 AND version=$2',
      [workspaceId, version],
    );
    const p = r.rows[0];
    if (!p) throw new WorkspaceError('NOT_FOUND', 404);
    return {
      version: Number(p.version),
      state: String(p.state) as 'REVIEW' | 'ACTIVE' | 'SUPERSEDED',
      policyHash: String(p.policy_hash) as Hex,
      policy: CommercialPolicySchema.parse(p.document),
      approvedBy: p.approved_by === null ? null : String(p.approved_by),
    };
  }

  async policies(workspaceId: string, principalId: string) {
    await this.role(workspaceId, principalId);
    const r = await this.store.pool.query(
      'SELECT version FROM synq_commercial_policies WHERE workspace_id=$1 ORDER BY version DESC LIMIT 20',
      [workspaceId],
    );
    return Promise.all(
      r.rows.map((x) => this.policyView(workspaceId, Number(x.version))),
    );
  }

  /** An owner's wallet signs the exact policy hash; the previous policy is superseded. */
  async approvePolicy(
    workspaceId: string,
    principalId: string,
    version: number,
    signature: Hex,
  ) {
    const m = await this.store.membership(workspaceId, principalId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    const view = await this.policyView(workspaceId, version);
    if (view.state !== 'REVIEW')
      throw new WorkspaceError('POLICY_NOT_IN_REVIEW', 409);
    let signer: string;
    try {
      signer = await recoverTypedDataAddress({
        ...commercialPolicyTypedData(workspaceId, version, view.policyHash),
        signature,
      });
    } catch {
      throw new WorkspaceError('INVALID_POLICY_SIGNATURE', 403);
    }
    if (getAddress(signer) !== getAddress(m.wallet))
      throw new WorkspaceError('INVALID_POLICY_SIGNATURE', 403);
    await this.store.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        workspaceId,
      ]);
      await sql.query(
        "UPDATE synq_commercial_policies SET state='SUPERSEDED' WHERE workspace_id=$1 AND state='ACTIVE'",
        [workspaceId],
      );
      const r = await sql.query(
        "UPDATE synq_commercial_policies SET state='ACTIVE', approved_by=$3, signature=$4, approved_at=$5 WHERE workspace_id=$1 AND version=$2 AND state='REVIEW'",
        [workspaceId, version, getAddress(signer), signature, this.now()],
      );
      if (!r.rowCount) throw new WorkspaceError('POLICY_NOT_IN_REVIEW', 409);
    });
    return this.policyView(workspaceId, version);
  }

  async active(workspaceId: string) {
    const r = await this.store.pool.query(
      "SELECT version FROM synq_commercial_policies WHERE workspace_id=$1 AND state='ACTIVE'",
      [workspaceId],
    );
    return r.rows[0]
      ? this.policyView(workspaceId, Number(r.rows[0].version))
      : null;
  }

  /**
   * Sends a new offer, or a new version of an existing one. Refused unless the
   * validator allows it and the lead's handling allows this actor at write
   * time (agent: AGENT handling; staff: HUMAN handling).
   */
  async send(input: {
    workspaceId: string;
    leadId: string;
    terms: unknown;
    actor: { kind: 'AGENT' } | { kind: 'STAFF'; principalId: string };
    offerId?: string;
  }) {
    const terms = OfferTermsSchema.parse(input.terms);
    const owner =
      input.actor.kind === 'STAFF'
        ? (await this.role(input.workspaceId, input.actor.principalId)).role ===
          'OWNER'
        : false;
    const result = await this.store.transaction(async (sql) => {
      const now = this.now();
      const l = await sql.query(
        'SELECT handling, stage FROM synq_leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [input.leadId, input.workspaceId],
      );
      if (!l.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      const handling = String(l.rows[0].handling);
      if (input.actor.kind === 'AGENT' && handling !== 'AGENT')
        throw new WorkspaceError('AGENT_NOT_HANDLING', 409);
      if (input.actor.kind === 'STAFF' && handling !== 'HUMAN')
        throw new WorkspaceError('TAKEOVER_REQUIRED', 409);
      const p = await sql.query(
        "SELECT version, document FROM synq_commercial_policies WHERE workspace_id=$1 AND state='ACTIVE'",
        [input.workspaceId],
      );
      if (!p.rows[0])
        throw new WorkspaceError('COMMERCIAL_POLICY_REQUIRED', 422);
      const policy = CommercialPolicySchema.parse(p.rows[0].document);
      const policyVersion = Number(p.rows[0].version);
      const validation = validateOffer(
        policy,
        terms,
        now,
        input.actor.kind === 'AGENT'
          ? { kind: 'AGENT' }
          : { kind: 'STAFF', owner },
      );
      if (!validation.allowed) return { sent: false as const, validation };
      let offerId = input.offerId ?? randomUUID();
      let version = 1;
      let previous: string | null = null;
      if (input.offerId) {
        const prior = await sql.query(
          'SELECT * FROM synq_offers WHERE offer_id=$1 AND lead_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE',
          [input.offerId, input.leadId],
        );
        if (!prior.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
        version = Number(prior.rows[0].version) + 1;
        previous = String(prior.rows[0].terms_hash);
        if (prior.rows[0].status === 'SENT')
          await sql.query(
            "UPDATE synq_offers SET status='COUNTERED' WHERE offer_id=$1 AND version=$2",
            [input.offerId, prior.rows[0].version],
          );
        else if (prior.rows[0].status === 'ACCEPTED')
          throw new WorkspaceError('OFFER_ALREADY_ACCEPTED', 409);
      } else offerId = randomUUID();
      const expiresAt = now + policy.offerTtlSeconds;
      const termsHash = offerTermsHash({
        workspaceId: input.workspaceId,
        leadId: input.leadId,
        offerId,
        version,
        policyVersion,
        previousTermsHash: previous,
        expiresAt,
        terms,
      });
      await sql.query(
        "INSERT INTO synq_offers(offer_id,version,workspace_id,lead_id,terms,terms_hash,previous_terms_hash,policy_version,status,created_by,validation,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'SENT',$9,$10,$11,$12)",
        [
          offerId,
          version,
          input.workspaceId,
          input.leadId,
          terms,
          termsHash,
          previous,
          policyVersion,
          input.actor.kind,
          validation,
          now,
          expiresAt,
        ],
      );
      await sql.query(
        "UPDATE synq_leads SET stage=CASE WHEN stage IN ('LEAD_OPEN','DISCOVERY','QUALIFIED','OFFER_DRAFTED','OFFER_VALIDATED') THEN 'OFFER_SENT' ELSE 'NEGOTIATING' END, last_activity_at=$2 WHERE id=$1",
        [input.leadId, now],
      );
      return {
        sent: true as const,
        validation,
        offer: this.view(
          (
            await sql.query(
              'SELECT * FROM synq_offers WHERE offer_id=$1 AND version=$2',
              [offerId, version],
            )
          ).rows[0],
        ),
      };
    });
    if (result.sent) await this.publish(input.workspaceId, input.leadId);
    return result;
  }

  view(r: Record<string, unknown>) {
    const o = offer(r);
    const items = o.terms.lines.map((l) => ({
      description: l.sku,
      quantity: l.quantity,
      unitUnits: l.unitUnits,
      totalUnits: String(BigInt(l.unitUnits) * BigInt(l.quantity)),
    }));
    const status =
      o.status === 'SENT' && o.expiresAt <= this.now() ? 'EXPIRED' : o.status;
    return {
      offerId: o.offerId,
      version: o.version,
      termsHash: o.termsHash,
      previousTermsHash: o.previousTermsHash,
      policyVersion: o.policyVersion,
      status: status as
        | 'SENT'
        | 'ACCEPTED'
        | 'REJECTED'
        | 'COUNTERED'
        | 'EXPIRED'
        | 'WITHDRAWN',
      createdBy: o.createdBy,
      total: { ...USDC, units: o.validation.totalUnits },
      lines: items,
      milestones: o.terms.milestones.map((m) => ({
        label: m.label,
        units: m.units,
        dueAt: iso(o.createdAt + m.dueInDays * 86400),
      })),
      expiresAt: iso(o.expiresAt),
      createdAt: iso(o.createdAt),
    };
  }

  async forLead(leadId: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_offers WHERE lead_id=$1 ORDER BY created_at, version',
      [leadId],
    );
    return r.rows.map((x) => this.view(x));
  }

  /** The newest offer version for a lead, with its stored terms. */
  async latest(leadId: string) {
    const r = await this.store.pool.query(
      'SELECT * FROM synq_offers WHERE lead_id=$1 ORDER BY created_at DESC, version DESC LIMIT 1',
      [leadId],
    );
    return r.rows[0] ? offer(r.rows[0]) : null;
  }

  /** Re-runs the validator now, against the policy the offer was made under. */
  async revalidate(
    workspaceId: string,
    principalId: string,
    offerId: string,
    version: number,
  ) {
    const m = await this.role(workspaceId, principalId);
    const r = await this.store.pool.query(
      'SELECT * FROM synq_offers WHERE offer_id=$1 AND version=$2 AND workspace_id=$3',
      [offerId, version, workspaceId],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    const o = offer(r.rows[0]);
    const p = await this.policyView(workspaceId, o.policyVersion);
    const result = validateOffer(p.policy, o.terms, this.now(), {
      kind: o.createdBy === 'AGENT' ? 'AGENT' : 'STAFF',
      owner: m.role === 'OWNER',
    } as { kind: 'STAFF'; owner: boolean });
    const expired = o.expiresAt <= this.now();
    return {
      allowed: result.allowed && !expired && p.state === 'ACTIVE',
      policyVersion: o.policyVersion,
      checks: [
        ...result.checks,
        {
          rule: 'NOT_EXPIRED',
          passed: !expired,
          detail: `expires ${iso(o.expiresAt)}`,
        },
        {
          rule: 'POLICY_CURRENT',
          passed: p.state === 'ACTIVE',
          detail: `policy version ${o.policyVersion} is ${p.state}`,
        },
      ],
    };
  }

  /**
   * The lead accepts in chat. Only the newest, unexpired, sent version can be
   * accepted, and only by quoting its exact version. This is not a signature.
   */
  async accept(leadId: string, offerId: string, version: number) {
    const accepted = await this.store.transaction(async (sql) => {
      const now = this.now();
      const r = await sql.query(
        'SELECT * FROM synq_offers WHERE offer_id=$1 AND lead_id=$2 ORDER BY version DESC LIMIT 1 FOR UPDATE',
        [offerId, leadId],
      );
      const latest = r.rows[0] ? offer(r.rows[0]) : null;
      if (
        !latest ||
        latest.version !== version ||
        latest.status !== 'SENT' ||
        latest.expiresAt <= now
      )
        throw new WorkspaceError('OFFER_STALE', 409);
      await sql.query(
        "UPDATE synq_offers SET status='ACCEPTED' WHERE offer_id=$1 AND version=$2",
        [offerId, version],
      );
      await sql.query(
        "UPDATE synq_leads SET stage='AGREED_PENDING_SIGNATURES', needs_owner=true, last_activity_at=$2 WHERE id=$1",
        [leadId, now],
      );
      return this.view(
        (
          await sql.query(
            'SELECT * FROM synq_offers WHERE offer_id=$1 AND version=$2',
            [offerId, version],
          )
        ).rows[0],
      );
    });
    const owner = await this.store.pool.query(
      'SELECT workspace_id FROM synq_leads WHERE id=$1',
      [leadId],
    );
    if (owner.rows[0])
      await this.publish(String(owner.rows[0].workspace_id), leadId);
    return accepted;
  }
}
