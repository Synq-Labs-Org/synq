import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  getAddress,
  hashTypedData,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { z } from 'zod';
import { AgreementSignatureSubmitSchema } from '@synq/contracts';
import { chainProfile } from '@synq/chain-registry/arc';
import type { AgentEvents, ProofLevel } from './agent-events.js';
import { WorkspaceError } from './contracts.js';
import {
  OfferTermsSchema,
  canonicalJson,
  offerTermsHash,
  type OfferTerms,
} from './offers.js';
import type { PostgresWorkspaceStore } from './postgres.js';

/*
 * Deal agreements with outside clients. A verified external client (the
 * lead's bound web identity, never a workspace member) links a wallet by
 * signing a statement with it. From an ACCEPTED offer version the server then
 * builds one agreement bound to the offer's terms hash, the client wallet, a
 * workspace owner's wallet, the payee, the milestones and an expiry. Both
 * wallets sign the same EIP-712 payload; a signature over any other version or
 * any altered field recovers a different signer and is refused. Signing is
 * never payment: the client funds the escrow from their own wallet, and only
 * a transaction proven on chain marks the agreement FUNDED. A chat message or
 * a Telegram identity alone is never a signature.
 */

export const AGREEMENT_MIGRATIONS = [
  {
    version: 1,
    up: `
CREATE TABLE synq_lead_wallets (lead_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, principal_id text NOT NULL, wallet text NOT NULL, signature text NOT NULL, expires_at bigint NOT NULL, linked_at bigint NOT NULL, FOREIGN KEY(workspace_id, lead_id) REFERENCES synq_leads(workspace_id, id));
CREATE TABLE synq_agreements (id uuid PRIMARY KEY, workspace_id uuid NOT NULL, lead_id uuid NOT NULL, offer_id uuid NOT NULL, offer_version int NOT NULL, terms_hash text NOT NULL, agreement_hash text NOT NULL, fields jsonb NOT NULL, status text NOT NULL CHECK(status IN ('PENDING_SIGNATURES','SIGNED','FUNDING_PENDING','FUNDED','VOID','EXPIRED')), void_reason text, created_at bigint NOT NULL, expires_at bigint NOT NULL, signed_at bigint, funding jsonb, open_tx_hash text UNIQUE, escrow_deal_id text, funded_at bigint, FOREIGN KEY(workspace_id, lead_id) REFERENCES synq_leads(workspace_id, id));
CREATE UNIQUE INDEX synq_agreements_live ON synq_agreements(lead_id) WHERE status IN ('PENDING_SIGNATURES','SIGNED','FUNDING_PENDING','FUNDED');
CREATE TABLE synq_agreement_signatures (agreement_id uuid NOT NULL REFERENCES synq_agreements(id), role text NOT NULL CHECK(role IN ('CLIENT','OWNER')), wallet text NOT NULL, signature text NOT NULL, signed_at bigint NOT NULL, PRIMARY KEY(agreement_id, role));
CREATE FUNCTION synq_agreement_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.fields<>OLD.fields OR NEW.terms_hash<>OLD.terms_hash OR NEW.agreement_hash<>OLD.agreement_hash OR NEW.offer_id<>OLD.offer_id OR NEW.offer_version<>OLD.offer_version OR NEW.lead_id<>OLD.lead_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.expires_at<>OLD.expires_at THEN RAISE EXCEPTION 'agreement terms are immutable'; END IF;
  IF OLD.status IN ('VOID','EXPIRED','FUNDED') AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'agreement is closed'; END IF;
  RETURN NEW; END $$;
CREATE TRIGGER synq_agreement_immutable BEFORE UPDATE ON synq_agreements FOR EACH ROW EXECUTE FUNCTION synq_agreement_guard();
CREATE FUNCTION synq_agreement_signature_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'agreement signatures are append only'; END $$;
CREATE TRIGGER synq_agreement_signatures_immutable BEFORE UPDATE OR DELETE ON synq_agreement_signatures FOR EACH ROW EXECUTE FUNCTION synq_agreement_signature_guard();
`,
    down: `DROP TABLE synq_agreement_signatures, synq_agreements, synq_lead_wallets; DROP FUNCTION synq_agreement_guard(); DROP FUNCTION synq_agreement_signature_guard();`,
  },
] as const;

const LIVE = ['PENDING_SIGNATURES', 'SIGNED', 'FUNDING_PENDING', 'FUNDED'];
const STAFF = ['OWNER', 'ADMIN'];
/** How long an agreement can be signed and funded after it is created. */
export const AGREEMENT_TTL_SECONDS = 7 * 86400;
const LINK_WINDOW_SECONDS = 3600;
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const iso = (s: number) => new Date(s * 1000).toISOString();
const USDC = {
  assetId: 'arc-testnet:USDC',
  symbol: 'USDC',
  chainId: 5042002,
  decimals: 6,
};
const money = (units: string) => ({ ...USDC, units });
const chainId = () => chainProfile('arc-testnet').chainId;

/** Exactly what both wallets sign. Stored as the agreement's immutable fields. */
export type AgreementFields = {
  workspaceId: string;
  leadId: string;
  offerId: string;
  offerVersion: number;
  termsHash: Hex;
  clientWallet: Address;
  ownerWallet: Address;
  payee: Address;
  /** The zero address means no arbiter. */
  arbiter: Address;
  milestones: { label: string; units: string; dueInDays: number }[];
  totalUnits: string;
  deliveryDays: number;
  expiresAt: number;
};

const STATEMENT =
  'We agree to exactly these terms. Signing is not payment: the client funds the escrow separately from their own wallet, and funds release only by the milestones listed.';

export function agreementTypedData(f: AgreementFields) {
  return {
    domain: { name: 'Synq Deal Agreement', version: '1', chainId: chainId() },
    types: {
      DealAgreement: [
        { name: 'workspaceId', type: 'string' },
        { name: 'leadId', type: 'string' },
        { name: 'offerId', type: 'string' },
        { name: 'offerVersion', type: 'uint256' },
        { name: 'termsHash', type: 'bytes32' },
        { name: 'clientWallet', type: 'address' },
        { name: 'ownerWallet', type: 'address' },
        { name: 'payee', type: 'address' },
        { name: 'arbiter', type: 'address' },
        { name: 'milestones', type: 'Milestone[]' },
        { name: 'totalUnits', type: 'uint256' },
        { name: 'deliveryDays', type: 'uint256' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'statement', type: 'string' },
      ],
      Milestone: [
        { name: 'label', type: 'string' },
        { name: 'units', type: 'uint256' },
        { name: 'dueInDays', type: 'uint256' },
      ],
    },
    primaryType: 'DealAgreement' as const,
    message: {
      workspaceId: f.workspaceId,
      leadId: f.leadId,
      offerId: f.offerId,
      offerVersion: BigInt(f.offerVersion),
      termsHash: f.termsHash,
      clientWallet: f.clientWallet,
      ownerWallet: f.ownerWallet,
      payee: f.payee,
      arbiter: f.arbiter,
      milestones: f.milestones.map((m) => ({
        label: m.label,
        units: BigInt(m.units),
        dueInDays: BigInt(m.dueInDays),
      })),
      totalUnits: BigInt(f.totalUnits),
      deliveryDays: BigInt(f.deliveryDays),
      expiresAt: BigInt(f.expiresAt),
      statement: STATEMENT,
    },
  };
}
export const agreementHash = (f: AgreementFields): Hex =>
  hashTypedData(agreementTypedData(f));

/** The statement a client wallet signs to be linked to one lead. */
export function clientWalletTypedData(input: {
  workspaceId: string;
  leadId: string;
  principalId: string;
  wallet: Address;
  expiresAt: number;
}) {
  return {
    domain: {
      name: 'Synq Client Wallet',
      version: '1',
      chainId: chainId(),
    },
    types: {
      ClientWallet: [
        { name: 'workspaceId', type: 'string' },
        { name: 'leadId', type: 'string' },
        { name: 'principalId', type: 'string' },
        { name: 'wallet', type: 'address' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'statement', type: 'string' },
      ],
    },
    primaryType: 'ClientWallet' as const,
    message: {
      workspaceId: input.workspaceId,
      leadId: input.leadId,
      principalId: input.principalId,
      wallet: input.wallet,
      expiresAt: BigInt(input.expiresAt),
      statement:
        'Use this wallet to sign and pay for my deal with this business. I am not joining the business workspace.',
    },
  };
}

/** Typed data as the JSON a wallet signs (uint256 values as decimal strings). */
export const wireTypedData = (t: {
  domain: object;
  types: object;
  primaryType: string;
  message: object;
}) =>
  JSON.parse(
    JSON.stringify(t, (_k, v: unknown) =>
      typeof v === 'bigint' ? String(v) : v,
    ),
  ) as {
    domain: Record<string, unknown>;
    types: Record<string, { name: string; type: string }[]>;
    primaryType: string;
    message: Record<string, unknown>;
  };

export type FundingRecord = {
  prepared?: {
    refundAfter: number;
    escrow: Address;
    token: Address;
    chainId: number;
    openData: Hex;
    approveData: Hex;
  };
  pendingTx?: Hex;
  proofLevel?: ProofLevel;
};
export type AgreementStatus =
  | 'PENDING_SIGNATURES'
  | 'SIGNED'
  | 'FUNDING_PENDING'
  | 'FUNDED'
  | 'VOID'
  | 'EXPIRED';
export type AgreementRow = {
  id: string;
  workspaceId: string;
  leadId: string;
  offerId: string;
  offerVersion: number;
  termsHash: Hex;
  agreementHash: Hex;
  fields: AgreementFields;
  status: AgreementStatus;
  createdAt: number;
  expiresAt: number;
  signedAt: number | null;
  funding: FundingRecord | null;
  openTxHash: Hex | null;
  escrowDealId: string | null;
  signatures: { CLIENT?: Sig; OWNER?: Sig };
};
type Sig = { wallet: Address; signature: Hex; signedAt: number };

const agreement = (
  r: Record<string, unknown>,
  sigs: Record<string, unknown>[] = [],
): AgreementRow => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  leadId: String(r.lead_id),
  offerId: String(r.offer_id),
  offerVersion: Number(r.offer_version),
  termsHash: String(r.terms_hash) as Hex,
  agreementHash: String(r.agreement_hash) as Hex,
  fields: r.fields as AgreementFields,
  status: r.status as AgreementStatus,
  createdAt: Number(r.created_at),
  expiresAt: Number(r.expires_at),
  signedAt: r.signed_at === null ? null : Number(r.signed_at),
  funding: (r.funding as FundingRecord | null) ?? null,
  openTxHash: r.open_tx_hash === null ? null : (String(r.open_tx_hash) as Hex),
  escrowDealId: r.escrow_deal_id === null ? null : String(r.escrow_deal_id),
  signatures: Object.fromEntries(
    sigs.map((s) => [
      String(s.role),
      {
        wallet: getAddress(String(s.wallet)),
        signature: String(s.signature) as Hex,
        signedAt: Number(s.signed_at),
      },
    ]),
  ),
});

type Problem = 'STALE' | 'TAMPERED';
const PROBLEM_CODE: Record<Problem, string> = {
  STALE: 'AGREEMENT_STALE',
  TAMPERED: 'AGREEMENT_TERMS_TAMPERED',
};

export type ClientLead = { leadId: string; workspaceId: string; stage: string };

export class WorkspaceAgreements {
  constructor(
    readonly store: PostgresWorkspaceStore,
    private readonly options: {
      events?: AgentEvents;
      /** Change markers for the live stream (ids only, after commit). */
      publish?: (workspaceId: string, leadId: string) => Promise<void>;
    } = {},
  ) {}

  private now() {
    return this.store.now();
  }

  async migrate(target: number = AGREEMENT_MIGRATIONS.length) {
    return this.store.transaction(async (sql) => {
      await sql.query(
        "SELECT pg_advisory_xact_lock(hashtext('synq_agreements_migrations'))",
      );
      await sql.query(
        'CREATE TABLE IF NOT EXISTS synq_agreements_migrations (version int PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
      );
      const { rows } = await sql.query(
        'SELECT version FROM synq_agreements_migrations',
      );
      const done = new Set(rows.map((r) => Number(r.version)));
      for (const m of [...AGREEMENT_MIGRATIONS].reverse())
        if (done.has(m.version) && m.version > target) {
          await sql.query(m.down);
          await sql.query(
            'DELETE FROM synq_agreements_migrations WHERE version=$1',
            [m.version],
          );
        }
      for (const m of AGREEMENT_MIGRATIONS)
        if (!done.has(m.version) && m.version <= target) {
          await sql.query(m.up);
          await sql.query(
            'INSERT INTO synq_agreements_migrations(version) VALUES($1)',
            [m.version],
          );
        }
    });
  }

  private async publish(workspaceId: string, leadId: string) {
    await this.options.publish?.(workspaceId, leadId).catch(() => undefined);
  }

  // MARK: Who may act

  /**
   * The lead a signed-in web principal is bound to as its external client.
   * Anyone else, and any member of the business, gets 404.
   */
  async clientLead(principalId: string, leadId: string): Promise<ClientLead> {
    if (!z.uuid().safeParse(leadId).success)
      throw new WorkspaceError('NOT_FOUND', 404);
    const r = await this.store.pool.query(
      `SELECT l.id, l.workspace_id, l.stage FROM synq_leads l
         JOIN synq_lead_identities i ON i.lead_id=l.id AND i.channel='web' AND i.identity_digest=$2
        WHERE l.id=$1
          AND NOT EXISTS (SELECT 1 FROM synq_ws_members m WHERE m.workspace_id=l.workspace_id AND m.principal_id=$3)`,
      [leadId, digest(`web:${principalId}`), principalId],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    return {
      leadId: String(r.rows[0].id),
      workspaceId: String(r.rows[0].workspace_id),
      stage: String(r.rows[0].stage),
    };
  }

  private async staff(
    workspaceId: string,
    principalId: string,
    leadId: string,
  ) {
    const m = await this.store.membership(workspaceId, principalId);
    if (!STAFF.includes(m.role)) throw new WorkspaceError('NOT_FOUND', 404);
    if (!z.uuid().safeParse(leadId).success)
      throw new WorkspaceError('NOT_FOUND', 404);
    const r = await this.store.pool.query(
      'SELECT 1 FROM synq_leads WHERE id=$1 AND workspace_id=$2',
      [leadId, workspaceId],
    );
    if (!r.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
    return m;
  }

  // MARK: Client wallet

  async walletLinkTypedData(
    principalId: string,
    leadId: string,
    wallet: string,
  ) {
    const lead = await this.clientLead(principalId, leadId);
    const address = this.address(wallet);
    const expiresAt = this.now() + 900;
    return {
      expiresAt: iso(expiresAt),
      typedData: wireTypedData(
        clientWalletTypedData({
          workspaceId: lead.workspaceId,
          leadId,
          principalId,
          wallet: address,
          expiresAt,
        }),
      ),
    };
  }

  private address(value: string) {
    try {
      return getAddress(value);
    } catch {
      throw new WorkspaceError('INVALID_ADDRESS', 400);
    }
  }

  /** Links the wallet that signs and pays, proven by that wallet's own signature. */
  async linkWallet(
    principalId: string,
    leadId: string,
    raw: { wallet: string; expiresAt: string; signature: string },
  ) {
    const lead = await this.clientLead(principalId, leadId);
    const wallet = this.address(raw.wallet);
    const expiresAt = Math.floor(Date.parse(raw.expiresAt) / 1000);
    const now = this.now();
    if (!Number.isInteger(expiresAt) || expiresAt < now)
      throw new WorkspaceError('WALLET_LINK_EXPIRED', 409);
    if (expiresAt > now + LINK_WINDOW_SECONDS)
      throw new WorkspaceError('WALLET_LINK_WINDOW_TOO_LONG', 400);
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({
        ...clientWalletTypedData({
          workspaceId: lead.workspaceId,
          leadId,
          principalId,
          wallet,
          expiresAt,
        }),
        signature: raw.signature as Hex,
      });
    } catch {
      throw new WorkspaceError('INVALID_WALLET_SIGNATURE', 403);
    }
    if (getAddress(signer) !== wallet)
      throw new WorkspaceError('INVALID_WALLET_SIGNATURE', 403);
    const linkedAt = await this.store.transaction(async (sql) => {
      await sql.query('SELECT id FROM synq_leads WHERE id=$1 FOR UPDATE', [
        leadId,
      ]);
      // The business's own wallets cannot be the client's: that would be paying itself.
      const member = await sql.query(
        'SELECT 1 FROM synq_ws_members WHERE workspace_id=$1 AND lower(wallet)=lower($2)',
        [lead.workspaceId, wallet],
      );
      if (member.rowCount)
        throw new WorkspaceError('CLIENT_WALLET_IS_MEMBER', 422);
      const current = await sql.query(
        'SELECT wallet, linked_at FROM synq_lead_wallets WHERE lead_id=$1',
        [leadId],
      );
      if (
        current.rows[0] &&
        getAddress(String(current.rows[0].wallet)) === wallet
      )
        return Number(current.rows[0].linked_at);
      const live = await sql.query(
        'SELECT id, status FROM synq_agreements WHERE lead_id=$1 AND status = ANY($2::text[])',
        [leadId, LIVE],
      );
      if (live.rows[0] && live.rows[0].status !== 'PENDING_SIGNATURES')
        throw new WorkspaceError('CLIENT_WALLET_LOCKED', 409);
      if (live.rows[0])
        await sql.query(
          "UPDATE synq_agreements SET status='VOID', void_reason='CLIENT_WALLET_CHANGED' WHERE id=$1",
          [live.rows[0].id],
        );
      await sql.query(
        `INSERT INTO synq_lead_wallets(lead_id,workspace_id,principal_id,wallet,signature,expires_at,linked_at)
         VALUES($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT(lead_id) DO UPDATE SET wallet=EXCLUDED.wallet, principal_id=EXCLUDED.principal_id, signature=EXCLUDED.signature, expires_at=EXCLUDED.expires_at, linked_at=EXCLUDED.linked_at`,
        [
          leadId,
          lead.workspaceId,
          principalId,
          wallet,
          raw.signature,
          expiresAt,
          now,
        ],
      );
      return now;
    });
    await this.publish(lead.workspaceId, leadId);
    return { wallet, linkedAt: iso(linkedAt) };
  }

  private async linkedWallet(leadId: string, sql: PoolClient | null = null) {
    const r = await (sql ?? this.store.pool).query(
      'SELECT wallet FROM synq_lead_wallets WHERE lead_id=$1',
      [leadId],
    );
    return r.rows[0] ? getAddress(String(r.rows[0].wallet)) : null;
  }

  // MARK: Agreement lifecycle

  private async load(sql: PoolClient | null, where: string, args: unknown[]) {
    const q = sql ?? this.store.pool;
    const r = await q.query(
      `SELECT * FROM synq_agreements WHERE ${where}`,
      args,
    );
    if (!r.rows[0]) return null;
    const s = await q.query(
      'SELECT * FROM synq_agreement_signatures WHERE agreement_id=$1',
      [r.rows[0].id],
    );
    return agreement(r.rows[0], s.rows);
  }

  /**
   * Whether the agreement still says what the accepted offer says. STALE: a
   * newer offer exists or the version is not the accepted one. TAMPERED: the
   * stored fields no longer hash to the offer's terms hash or to the
   * agreement hash.
   */
  private async problem(
    sql: PoolClient,
    a: AgreementRow,
  ): Promise<Problem | null> {
    const o = await sql.query(
      'SELECT * FROM synq_offers WHERE offer_id=$1 AND version=$2 AND lead_id=$3',
      [a.offerId, a.offerVersion, a.leadId],
    );
    const row = o.rows[0];
    if (!row) return 'TAMPERED';
    let terms: OfferTerms;
    try {
      terms = OfferTermsSchema.parse(row.terms);
    } catch {
      return 'TAMPERED';
    }
    const recomputed = offerTermsHash({
      workspaceId: String(row.workspace_id),
      leadId: String(row.lead_id),
      offerId: String(row.offer_id),
      version: Number(row.version),
      policyVersion: Number(row.policy_version),
      previousTermsHash:
        row.previous_terms_hash === null
          ? null
          : String(row.previous_terms_hash),
      expiresAt: Number(row.expires_at),
      terms,
    });
    const f = a.fields;
    const total = terms.milestones.reduce((n, m) => n + BigInt(m.units), 0n);
    if (
      recomputed !== String(row.terms_hash) ||
      a.termsHash !== recomputed ||
      f.termsHash !== recomputed ||
      f.offerId !== a.offerId ||
      f.offerVersion !== a.offerVersion ||
      f.leadId !== a.leadId ||
      f.workspaceId !== a.workspaceId ||
      f.totalUnits !== String(total) ||
      f.deliveryDays !== terms.deliveryDays ||
      canonicalJson(f.milestones) !==
        canonicalJson(
          terms.milestones.map((m) => ({
            label: m.label,
            units: m.units,
            dueInDays: m.dueInDays,
          })),
        ) ||
      agreementHash(f) !== a.agreementHash
    )
      return 'TAMPERED';
    const newer = await sql.query(
      `SELECT 1 FROM synq_offers n, synq_offers c
        WHERE c.offer_id=$1 AND c.version=$2 AND n.lead_id=c.lead_id
          AND ((n.offer_id=c.offer_id AND n.version>c.version)
            OR n.created_at>c.created_at
            OR (n.offer_id<>c.offer_id AND n.status='SENT')) LIMIT 1`,
      [a.offerId, a.offerVersion],
    );
    if (String(row.status) !== 'ACCEPTED' || newer.rowCount) return 'STALE';
    return null;
  }

  /** Voids an unfunded agreement outside the failed transaction. */
  private async void(id: string, reason: string) {
    await this.store.pool.query(
      "UPDATE synq_agreements SET status='VOID', void_reason=$2 WHERE id=$1 AND status IN ('PENDING_SIGNATURES','SIGNED')",
      [id, reason],
    );
  }

  /**
   * The lead's live agreement, created from its accepted offer when none
   * exists. `owner` is the owner wallet to bind when the caller is an owner;
   * otherwise the earliest owner of the business is bound.
   */
  private async ensure(
    workspaceId: string,
    leadId: string,
    owner: { principalId: string } | null,
  ): Promise<{ agreement: AgreementRow | null; blocked: string | null }> {
    const result = await this.store.transaction(async (sql) => {
      const now = this.now();
      const lead = await sql.query(
        'SELECT stage FROM synq_leads WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
        [leadId, workspaceId],
      );
      if (!lead.rows[0]) throw new WorkspaceError('NOT_FOUND', 404);
      await sql.query(
        "UPDATE synq_agreements SET status='EXPIRED' WHERE lead_id=$1 AND status='PENDING_SIGNATURES' AND expires_at<=$2",
        [leadId, now],
      );
      const live = await this.load(
        sql,
        'lead_id=$1 AND status = ANY($2::text[])',
        [leadId, LIVE],
      );
      let voided: { id: string; reason: string } | null = null;
      if (live) {
        const p = await this.problem(sql, live);
        if (!p || live.status === 'FUNDING_PENDING' || live.status === 'FUNDED')
          return { agreement: live, blocked: null, voided };
        voided = { id: live.id, reason: p };
        if (p === 'TAMPERED')
          return { agreement: null, blocked: PROBLEM_CODE[p], voided };
      }
      if (voided) {
        await sql.query(
          "UPDATE synq_agreements SET status='VOID', void_reason=$2 WHERE id=$1",
          [voided.id, voided.reason],
        );
      }
      if (String(lead.rows[0].stage) !== 'AGREED_PENDING_SIGNATURES')
        return { agreement: null, blocked: 'NO_ACCEPTED_OFFER', voided };
      const client = await this.linkedWallet(leadId, sql);
      if (!client)
        return { agreement: null, blocked: 'CLIENT_WALLET_REQUIRED', voided };
      const latest = await sql.query(
        'SELECT * FROM synq_offers WHERE lead_id=$1 ORDER BY created_at DESC, version DESC LIMIT 1',
        [leadId],
      );
      const offer = latest.rows[0];
      if (!offer || String(offer.status) !== 'ACCEPTED')
        return { agreement: null, blocked: 'NO_ACCEPTED_OFFER', voided };
      const terms = OfferTermsSchema.parse(offer.terms);
      const members = await sql.query(
        "SELECT principal_id, wallet FROM synq_ws_members WHERE workspace_id=$1 AND role='OWNER' ORDER BY joined_at, principal_id",
        [workspaceId],
      );
      const chosen =
        members.rows.find((m) => m.principal_id === owner?.principalId) ??
        members.rows[0];
      if (!chosen) return { agreement: null, blocked: 'NO_OWNER', voided };
      const ownerWallet = getAddress(String(chosen.wallet));
      const vault = await sql.query(
        'SELECT vault FROM synq_workspaces WHERE id=$1',
        [workspaceId],
      );
      const payee = vault.rows[0]?.vault
        ? getAddress(String(vault.rows[0].vault))
        : ownerWallet;
      if (client === ownerWallet || client === payee)
        return { agreement: null, blocked: 'CLIENT_WALLET_CONFLICT', voided };
      const fields: AgreementFields = {
        workspaceId,
        leadId,
        offerId: String(offer.offer_id),
        offerVersion: Number(offer.version),
        termsHash: String(offer.terms_hash) as Hex,
        clientWallet: client,
        ownerWallet,
        payee,
        arbiter: zeroAddress,
        milestones: terms.milestones.map((m) => ({
          label: m.label,
          units: m.units,
          dueInDays: m.dueInDays,
        })),
        totalUnits: String(
          terms.milestones.reduce((n, m) => n + BigInt(m.units), 0n),
        ),
        deliveryDays: terms.deliveryDays,
        expiresAt: now + AGREEMENT_TTL_SECONDS,
      };
      const id = randomUUID();
      await sql.query(
        `INSERT INTO synq_agreements(id,workspace_id,lead_id,offer_id,offer_version,terms_hash,agreement_hash,fields,status,created_at,expires_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,'PENDING_SIGNATURES',$9,$10)`,
        [
          id,
          workspaceId,
          leadId,
          fields.offerId,
          fields.offerVersion,
          fields.termsHash,
          agreementHash(fields),
          fields,
          now,
          fields.expiresAt,
        ],
      );
      return {
        agreement: await this.load(sql, 'id=$1', [id]),
        blocked: null,
        voided,
      };
    });
    if (result.voided?.reason === 'TAMPERED')
      await this.void(result.voided.id, 'TAMPERED');
    return { agreement: result.agreement, blocked: result.blocked };
  }

  // MARK: Views

  view(a: AgreementRow) {
    const f = a.fields;
    const escrow =
      a.funding === null
        ? null
        : {
            state:
              a.status === 'FUNDED'
                ? ('FUNDED' as const)
                : a.funding.pendingTx
                  ? ('PENDING_CONFIRMATION' as const)
                  : ('PREPARED' as const),
            openTxHash: a.openTxHash ?? a.funding.pendingTx ?? null,
            escrowDealId: a.escrowDealId,
            proofLevel: a.funding.proofLevel ?? ('NOT_VERIFIED' as ProofLevel),
          };
    const sig = (s: Sig | undefined) =>
      s ? { wallet: s.wallet, signedAt: iso(s.signedAt) } : null;
    return {
      agreementId: a.id,
      workspaceId: a.workspaceId,
      leadId: a.leadId,
      offerId: a.offerId,
      offerVersion: a.offerVersion,
      termsHash: a.termsHash,
      agreementHash: a.agreementHash,
      status: a.status,
      clientWallet: f.clientWallet,
      ownerWallet: f.ownerWallet,
      payee: f.payee,
      arbiter: f.arbiter === zeroAddress ? null : f.arbiter,
      total: money(f.totalUnits),
      milestones: f.milestones.map((m) => ({
        label: m.label,
        amount: money(m.units),
        dueInDays: m.dueInDays,
      })),
      expiresAt: iso(f.expiresAt),
      signatures: {
        client: sig(a.signatures.CLIENT),
        owner: sig(a.signatures.OWNER),
      },
      typedData: wireTypedData(agreementTypedData(f)),
      escrow,
    };
  }

  private async lead(
    workspaceId: string,
    leadId: string,
    owner: { principalId: string } | null,
  ) {
    const wallet = await this.linkedWallet(leadId);
    const { agreement, blocked } = await this.ensure(
      workspaceId,
      leadId,
      owner,
    );
    return {
      clientWallet: wallet,
      agreement: agreement ? this.view(agreement) : null,
      blocked,
    };
  }

  /** The client's view of their own lead's agreement. */
  async clientView(principalId: string, leadId: string) {
    const l = await this.clientLead(principalId, leadId);
    return this.lead(l.workspaceId, leadId, null);
  }

  /** Staff view. An owner looking at an unsigned agreement binds their wallet to it. */
  async staffView(workspaceId: string, principalId: string, leadId: string) {
    const m = await this.staff(workspaceId, principalId, leadId);
    return this.lead(
      workspaceId,
      leadId,
      m.role === 'OWNER' ? { principalId } : null,
    );
  }

  // MARK: Signing

  async signAsClient(principalId: string, leadId: string, raw: unknown) {
    const l = await this.clientLead(principalId, leadId);
    return this.sign(l.workspaceId, leadId, 'CLIENT', null, raw);
  }

  async signAsOwner(
    workspaceId: string,
    principalId: string,
    leadId: string,
    raw: unknown,
  ) {
    const m = await this.staff(workspaceId, principalId, leadId);
    if (m.role !== 'OWNER') throw new WorkspaceError('OWNER_REQUIRED', 403);
    return this.sign(workspaceId, leadId, 'OWNER', m.wallet, raw);
  }

  private async sign(
    workspaceId: string,
    leadId: string,
    role: 'CLIENT' | 'OWNER',
    ownerMemberWallet: string | null,
    raw: unknown,
  ) {
    const body = AgreementSignatureSubmitSchema.parse(raw);
    const outcome = await this.store.transaction(async (sql) => {
      const now = this.now();
      await sql.query('SELECT id FROM synq_leads WHERE id=$1 FOR UPDATE', [
        leadId,
      ]);
      const a = await this.load(sql, 'id=$1 AND lead_id=$2', [
        body.agreementId,
        leadId,
      ]);
      if (!a || a.workspaceId !== workspaceId)
        throw new WorkspaceError('NOT_FOUND', 404);
      if (a.status === 'VOID') return { error: 'AGREEMENT_STALE' };
      if (
        a.offerVersion !== body.offerVersion ||
        a.termsHash !== body.termsHash
      )
        return { error: 'AGREEMENT_STALE' };
      const existing = a.signatures[role];
      if (existing && existing.signature === body.signature)
        return { agreement: a, changed: false };
      if (a.status !== 'PENDING_SIGNATURES' && a.status !== 'EXPIRED')
        return { error: 'AGREEMENT_CLOSED' };
      if (existing) return { error: 'AGREEMENT_ALREADY_SIGNED' };
      if (a.status === 'EXPIRED' || a.expiresAt <= now)
        return { error: 'AGREEMENT_EXPIRED' };
      const p = await this.problem(sql, a);
      if (p) return { error: PROBLEM_CODE[p], problem: a.id };
      // The wallet that may sign is fixed in the agreement, not chosen by the caller.
      const expected =
        role === 'CLIENT' ? a.fields.clientWallet : a.fields.ownerWallet;
      if (role === 'CLIENT') {
        if ((await this.linkedWallet(leadId, sql)) !== expected)
          return { error: 'AGREEMENT_STALE', problem: a.id };
      } else if (
        !ownerMemberWallet ||
        getAddress(ownerMemberWallet) !== expected
      )
        return { error: 'OWNER_WALLET_MISMATCH', status: 403 };
      let signer: Address;
      try {
        signer = await recoverTypedDataAddress({
          ...agreementTypedData(a.fields),
          signature: body.signature as Hex,
        });
      } catch {
        return { error: 'INVALID_AGREEMENT_SIGNATURE', status: 403 };
      }
      if (getAddress(signer) !== expected)
        return { error: 'INVALID_AGREEMENT_SIGNATURE', status: 403 };
      await sql.query(
        'INSERT INTO synq_agreement_signatures(agreement_id,role,wallet,signature,signed_at) VALUES($1,$2,$3,$4,$5)',
        [a.id, role, expected, body.signature, now],
      );
      const both = await sql.query(
        'SELECT count(*)::int AS n FROM synq_agreement_signatures WHERE agreement_id=$1',
        [a.id],
      );
      if (Number(both.rows[0].n) === 2) {
        await sql.query(
          "UPDATE synq_agreements SET status='SIGNED', signed_at=$2 WHERE id=$1 AND status='PENDING_SIGNATURES'",
          [a.id, now],
        );
        await sql.query(
          "UPDATE synq_leads SET stage='SIGNED', last_activity_at=$2 WHERE id=$1 AND stage='AGREED_PENDING_SIGNATURES'",
          [leadId, now],
        );
      }
      return {
        agreement: await this.load(sql, 'id=$1', [a.id]),
        changed: true,
      };
    });
    if ('error' in outcome) {
      if (outcome.problem) await this.void(outcome.problem, outcome.error!);
      throw new WorkspaceError(outcome.error!, outcome.status ?? 409);
    }
    const a = outcome.agreement!;
    if (outcome.changed) {
      if (a.status === 'SIGNED') await this.recordSigned(a);
      await this.publish(workspaceId, leadId);
    }
    return this.view(a);
  }

  private async recordSigned(a: AgreementRow) {
    const events = this.options.events;
    if (!events) return;
    try {
      const runId = await events.run(a.workspaceId, `agreement:${a.id}`, {
        title: `Deal agreement signed · ${a.fields.milestones.length} milestone${a.fields.milestones.length === 1 ? '' : 's'}`,
        trigger: 'OTHER',
        amountUnits: a.fields.totalUnits,
      });
      await events.record(runId, {
        semanticKey: `agreement:${a.id}:signed`,
        kind: 'DECISION',
        actor: 'HUMAN',
        status: 'AUTHORIZED',
        summary:
          'The client and the business owner each signed the exact accepted terms with their own wallets.',
        sourceKind: 'DEAL_AGREEMENT',
        // Two wallet signatures were checked here; nothing about them is on chain.
        proofLevel: 'NOT_VERIFIED',
        correlationId: a.id,
        evidenceHash: a.agreementHash,
        amountUnits: a.fields.totalUnits,
        recipientHint: `${a.fields.payee.slice(0, 6)}…${a.fields.payee.slice(-4)}`,
        chainId: chainId(),
      });
    } catch {
      // The record is a projection of a durable state change; never fail the signature on it.
    }
  }

  // MARK: Funding (the chain work lives in the execution worker)

  /**
   * The client's agreement, ready for funding steps. Signed, unexpired (unless
   * already preparing) and still matching the accepted offer.
   */
  async forFunding(principalId: string, leadId: string) {
    const l = await this.clientLead(principalId, leadId);
    const outcome = await this.store.transaction(async (sql) => {
      const a = await this.load(
        sql,
        'lead_id=$1 AND status = ANY($2::text[]) ORDER BY created_at DESC LIMIT 1',
        [leadId, ['SIGNED', 'FUNDING_PENDING', 'FUNDED']],
      );
      if (!a) return { error: 'AGREEMENT_NOT_SIGNED' };
      if (a.status === 'SIGNED') {
        const p = await this.problem(sql, a);
        if (p) return { error: PROBLEM_CODE[p], problem: a.id };
      }
      return { agreement: a };
    });
    if ('error' in outcome) {
      if (outcome.problem) await this.void(outcome.problem, outcome.error!);
      throw new WorkspaceError(outcome.error!, 409);
    }
    return { agreement: outcome.agreement!, workspaceId: l.workspaceId };
  }

  /** Stores the exact calls prepared for the client wallet; SIGNED becomes FUNDING_PENDING. */
  async savePrepared(
    id: string,
    prepared: NonNullable<FundingRecord['prepared']>,
  ) {
    const a = await this.store.transaction(async (sql) => {
      const now = this.now();
      const cur = await this.load(sql, 'id=$1 FOR UPDATE', [id]);
      if (!cur) throw new WorkspaceError('NOT_FOUND', 404);
      if (cur.status === 'FUNDED')
        throw new WorkspaceError('AGREEMENT_ALREADY_FUNDED', 409);
      if (cur.status !== 'SIGNED' && cur.status !== 'FUNDING_PENDING')
        throw new WorkspaceError('AGREEMENT_NOT_SIGNED', 409);
      if (cur.status === 'SIGNED' && cur.expiresAt <= now)
        throw new WorkspaceError('AGREEMENT_EXPIRED', 409);
      const funding: FundingRecord = {
        ...(cur.funding ?? {}),
        prepared,
      };
      await sql.query(
        "UPDATE synq_agreements SET status='FUNDING_PENDING', funding=$2 WHERE id=$1",
        [id, funding],
      );
      await sql.query(
        "UPDATE synq_leads SET stage='FUNDING_PENDING', last_activity_at=$2 WHERE id=$1 AND stage IN ('AGREED_PENDING_SIGNATURES','SIGNED')",
        [cur.leadId, now],
      );
      return this.load(sql, 'id=$1', [id]);
    });
    await this.publish(a!.workspaceId, a!.leadId);
    return a!;
  }

  /** A submitted transaction has no receipt yet. Nothing is funded. */
  async savePending(id: string, txHash: Hex) {
    await this.store.pool.query(
      "UPDATE synq_agreements SET funding=COALESCE(funding,'{}'::jsonb) || jsonb_build_object('pendingTx',$2::text) WHERE id=$1 AND status='FUNDING_PENDING'",
      [id, txHash],
    );
    return (await this.load(null, 'id=$1', [id]))!;
  }

  /**
   * The open transaction was proven on chain to match the agreement. Marks the
   * agreement and lead FUNDED once; repeats return the same record.
   */
  async markFunded(
    id: string,
    proof: {
      openTxHash: Hex;
      escrowDealId: string;
      proofLevel: ProofLevel;
    },
  ) {
    const outcome = await this.store.transaction(async (sql) => {
      const now = this.now();
      const cur = await this.load(sql, 'id=$1 FOR UPDATE', [id]);
      if (!cur) throw new WorkspaceError('NOT_FOUND', 404);
      if (cur.status === 'FUNDED') {
        if (cur.openTxHash?.toLowerCase() !== proof.openTxHash.toLowerCase())
          throw new WorkspaceError('AGREEMENT_ALREADY_FUNDED', 409);
        return { agreement: cur, changed: false };
      }
      if (cur.status !== 'FUNDING_PENDING')
        throw new WorkspaceError('AGREEMENT_NOT_SIGNED', 409);
      const funding: FundingRecord = {
        ...(cur.funding ?? {}),
        proofLevel: proof.proofLevel,
      };
      delete funding.pendingTx;
      await sql.query(
        "UPDATE synq_agreements SET status='FUNDED', funding=$2, open_tx_hash=$3, escrow_deal_id=$4, funded_at=$5 WHERE id=$1",
        [id, funding, proof.openTxHash.toLowerCase(), proof.escrowDealId, now],
      );
      await sql.query(
        "UPDATE synq_leads SET stage='FUNDED', needs_owner=false, last_activity_at=$2 WHERE id=$1 AND stage IN ('AGREED_PENDING_SIGNATURES','SIGNED','FUNDING_PENDING')",
        [cur.leadId, now],
      );
      return { agreement: await this.load(sql, 'id=$1', [id]), changed: true };
    });
    const a = outcome.agreement!;
    if (outcome.changed) {
      await this.recordFunded(a, proof.proofLevel);
      await this.publish(a.workspaceId, a.leadId);
    }
    return a;
  }

  private async recordFunded(a: AgreementRow, proofLevel: ProofLevel) {
    const events = this.options.events;
    if (!events) return;
    try {
      const runId = await events.run(a.workspaceId, `agreement:${a.id}`, {
        title: `Deal escrow funded · ${a.fields.milestones.length} milestone${a.fields.milestones.length === 1 ? '' : 's'}`,
        trigger: 'OTHER',
        amountUnits: a.fields.totalUnits,
      });
      await events.record(runId, {
        semanticKey: `agreement:${a.id}:funded`,
        kind: 'FINALIZED',
        actor: 'CHAIN',
        status: 'FINALIZED',
        summary:
          'The client funded the milestone escrow from their own wallet; the open transaction matches the signed agreement.',
        sourceKind: 'DEAL_ESCROW',
        proofLevel,
        correlationId: a.id,
        evidenceHash: a.agreementHash,
        amountUnits: a.fields.totalUnits,
        recipientHint: `${a.fields.payee.slice(0, 6)}…${a.fields.payee.slice(-4)}`,
        txHash: a.openTxHash,
        chainId: chainId(),
      });
    } catch {
      // See recordSigned.
    }
  }

  /** The client view after a funding step. */
  async clientAgreement(principalId: string, leadId: string, id: string) {
    await this.clientLead(principalId, leadId);
    const a = await this.load(null, 'id=$1 AND lead_id=$2', [id, leadId]);
    if (!a) throw new WorkspaceError('NOT_FOUND', 404);
    return this.view(a);
  }
}
