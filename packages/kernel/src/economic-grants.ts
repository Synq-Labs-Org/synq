import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  AmountSchema,
  HashSchema,
  IdSchema,
  MemberIdSchema,
  TimestampSchema,
} from '@synq/schemas';
import { artifactHash } from './canonical.js';

const MoneySchema = z.strictObject({
  amount: AmountSchema,
  currency: z.string().regex(/^[A-Z][A-Z0-9]{2,9}$/),
  decimals: z.number().int().min(0).max(18),
});
export type EconomicMoney = z.output<typeof MoneySchema>;
const HostSchema = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

export const ECONOMIC_DOMAINS = [
  'COMMERCE',
  'STAY',
  'FLIGHT',
  'DATA',
  'CANCEL',
] as const;

export const EconomicMandateSchema = z
  .strictObject({
    mandateId: IdSchema,
    groupId: IdSchema,
    version: z.number().int().positive(),
    status: z.enum(['ACTIVE', 'REVOKED']),
    domains: z.array(z.enum(ECONOMIC_DOMAINS)).min(1),
    providers: z.array(IdSchema).min(1),
    hosts: z.array(HostSchema).min(1),
    perActionCap: MoneySchema,
    cumulativeBudget: MoneySchema,
    autoApproveMax: MoneySchema,
    quorum: z.number().int().positive(),
    members: z.array(MemberIdSchema).min(1),
    maxQuoteAgeSeconds: z.number().int().positive().max(3_600),
    grantTtlSeconds: z.number().int().positive().max(3_600),
    environment: z.enum(['SANDBOX', 'TESTNET']),
    validUntil: TimestampSchema,
  })
  .superRefine((v, ctx) => {
    const unit = (m: EconomicMoney) => `${m.currency}/${m.decimals}`;
    if (
      unit(v.perActionCap) !== unit(v.cumulativeBudget) ||
      unit(v.autoApproveMax) !== unit(v.cumulativeBudget)
    )
      ctx.addIssue({ code: 'custom', message: 'mandate money units differ' });
    if (BigInt(v.perActionCap.amount) > BigInt(v.cumulativeBudget.amount))
      ctx.addIssue({ code: 'custom', message: 'per-action cap above budget' });
    if (v.quorum > new Set(v.members).size)
      ctx.addIssue({ code: 'custom', message: 'quorum exceeds members' });
  });
export type EconomicMandate = z.output<typeof EconomicMandateSchema>;

/** Everything the executor will do, bound before the grant is issued. */
export const EconomicExecutionSchema = z.strictObject({
  domain: z.enum(ECONOMIC_DOMAINS),
  providerId: IdSchema,
  host: HostSchema,
  offerId: z.string().min(1).max(160),
  subjectHash: HashSchema,
  quantity: z.number().int().positive(),
  maxAmount: MoneySchema,
  reservationId: z.string().min(1).max(160),
  settlementPlanHash: z.string().min(1).max(80),
  recipientRef: z.string().max(160).nullable(),
});
export type EconomicExecution = z.output<typeof EconomicExecutionSchema>;

export const EconomicAuthorizationRequestSchema = z.strictObject({
  intentId: IdSchema,
  groupId: IdSchema,
  mandateId: IdSchema,
  execution: EconomicExecutionSchema,
  quoteExpiresAt: TimestampSchema,
  revalidatedAt: TimestampSchema.nullable(),
  reservationHeld: z.boolean(),
});
export type EconomicAuthorizationRequest = z.output<
  typeof EconomicAuthorizationRequestSchema
>;

export const EconomicGrantSchema = z.strictObject({
  schemaVersion: z.literal(1),
  grantId: HashSchema,
  intentId: IdSchema,
  groupId: IdSchema,
  mandateId: IdSchema,
  mandateVersion: z.number().int().positive(),
  environment: z.enum(['SANDBOX', 'TESTNET']),
  execution: EconomicExecutionSchema,
  approvals: z.array(MemberIdSchema),
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  mac: z.string().regex(/^[0-9a-f]{64}$/),
});
export type EconomicGrant = z.output<typeof EconomicGrantSchema>;

export type EconomicRefusal =
  | 'MANDATE_UNKNOWN'
  | 'MANDATE_INACTIVE'
  | 'GROUP_MISMATCH'
  | 'DOMAIN_FORBIDDEN'
  | 'PROVIDER_FORBIDDEN'
  | 'HOST_FORBIDDEN'
  | 'CURRENCY_MISMATCH'
  | 'PER_ACTION_CAP'
  | 'BUDGET_EXHAUSTED'
  | 'QUOTE_NOT_REVALIDATED'
  | 'QUOTE_EXPIRED'
  | 'RESERVATION_MISSING'
  | 'APPROVER_NOT_MEMBER';

export type EconomicDecision =
  | { status: 'AUTHORIZED'; grant: EconomicGrant }
  | {
      status: 'PENDING_APPROVAL';
      requiredApprovals: number;
      approvals: string[];
      requestHash: `0x${string}`;
    }
  | { status: 'REJECTED'; code: EconomicRefusal; detail: string };

export type EconomicGrantFailure =
  | 'GRANT_INVALID'
  | 'GRANT_MAC'
  | 'GRANT_EXPIRED'
  | 'GRANT_CONSUMED'
  | 'GRANT_BINDING';
export class EconomicGrantError extends Error {
  constructor(
    readonly code: EconomicGrantFailure,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'EconomicGrantError';
  }
}

export function economicRequestHash(r: EconomicAuthorizationRequest) {
  return artifactHash({ kind: 'EconomicAuthorizationRequest', ...r });
}

/**
 * The Kernel's Web2/x402 authority: commerce, stays, flights and paid data all
 * compile to the same one-time, HMAC-bound grant the bounded executor checks.
 * Approver ids must already be verified by the identity layer.
 */
export class EconomicGrantAuthority {
  private readonly mandates = new Map<string, EconomicMandate>();
  private readonly spent = new Map<string, bigint>();
  private readonly issued = new Map<string, EconomicGrant>();
  private readonly consumed = new Set<string>();
  constructor(private readonly key: Uint8Array) {
    if (key.length < 32) throw new Error('GRANT_KEY_TOO_SHORT');
  }

  private mac(grantId: string) {
    return createHmac('sha256', this.key).update(grantId).digest('hex');
  }

  install(raw: unknown): EconomicMandate {
    const m = EconomicMandateSchema.parse(raw);
    const prior = this.mandates.get(m.mandateId);
    if (prior && prior.version >= m.version)
      throw new Error('MANDATE_VERSION_NOT_NEWER');
    this.mandates.set(m.mandateId, m);
    return m;
  }

  revoke(mandateId: string): void {
    const m = this.mandates.get(mandateId);
    if (m) this.mandates.set(mandateId, { ...m, status: 'REVOKED' });
  }

  spentFor(mandateId: string): bigint {
    return this.spent.get(mandateId) ?? 0n;
  }

  authorize(
    raw: EconomicAuthorizationRequest,
    approvers: readonly string[],
    now: number,
  ): EconomicDecision {
    const r = EconomicAuthorizationRequestSchema.parse(raw);
    const reject = (code: EconomicRefusal, detail = ''): EconomicDecision => ({
      status: 'REJECTED',
      code,
      detail,
    });
    const m = this.mandates.get(r.mandateId);
    if (!m) return reject('MANDATE_UNKNOWN');
    if (m.status !== 'ACTIVE' || m.validUntil <= now)
      return reject('MANDATE_INACTIVE');
    if (m.groupId !== r.groupId) return reject('GROUP_MISMATCH');
    const x = r.execution;
    if (!m.domains.includes(x.domain))
      return reject('DOMAIN_FORBIDDEN', x.domain);
    if (!m.providers.includes(x.providerId))
      return reject('PROVIDER_FORBIDDEN', x.providerId);
    if (!m.hosts.includes(x.host)) return reject('HOST_FORBIDDEN', x.host);
    if (
      x.maxAmount.currency !== m.perActionCap.currency ||
      x.maxAmount.decimals !== m.perActionCap.decimals
    )
      return reject('CURRENCY_MISMATCH');
    const amount = BigInt(x.maxAmount.amount);
    if (amount > BigInt(m.perActionCap.amount)) return reject('PER_ACTION_CAP');
    const prior = this.issued.get(r.intentId);
    const priorSameRequest =
      prior !== undefined &&
      artifactHash(prior.execution) === artifactHash(x) &&
      prior.mandateVersion === m.version;
    if (
      !priorSameRequest &&
      this.spentFor(m.mandateId) + amount > BigInt(m.cumulativeBudget.amount)
    )
      return reject('BUDGET_EXHAUSTED');
    if (
      r.revalidatedAt === null ||
      now - r.revalidatedAt > m.maxQuoteAgeSeconds
    )
      return reject('QUOTE_NOT_REVALIDATED');
    if (r.quoteExpiresAt <= now) return reject('QUOTE_EXPIRED');
    if (!r.reservationHeld) return reject('RESERVATION_MISSING');
    const members = new Set(m.members);
    const unique = [...new Set(approvers)].sort();
    const outsider = unique.find((a) => !members.has(a as never));
    if (outsider) return reject('APPROVER_NOT_MEMBER', outsider);
    const required = amount <= BigInt(m.autoApproveMax.amount) ? 0 : m.quorum;
    if (unique.length < required)
      return {
        status: 'PENDING_APPROVAL',
        requiredApprovals: required,
        approvals: unique,
        requestHash: economicRequestHash(r),
      };
    if (priorSameRequest && prior.expiresAt > now)
      return { status: 'AUTHORIZED', grant: prior };
    const body = {
      schemaVersion: 1 as const,
      intentId: r.intentId,
      groupId: r.groupId,
      mandateId: m.mandateId,
      mandateVersion: m.version,
      environment: m.environment,
      execution: x,
      approvals: unique,
      issuedAt: now,
      expiresAt: Math.min(
        now + m.grantTtlSeconds,
        r.quoteExpiresAt,
        m.validUntil,
      ),
    };
    const grantId = artifactHash(body);
    const grant = EconomicGrantSchema.parse({
      ...body,
      grantId,
      mac: this.mac(grantId),
    });
    if (!priorSameRequest)
      this.spent.set(m.mandateId, this.spentFor(m.mandateId) + amount);
    this.issued.set(r.intentId, grant);
    return { status: 'AUTHORIZED', grant };
  }

  /** Verifies an execution against its grant without consuming it. */
  verify(raw: unknown, actual: EconomicExecution, now: number): EconomicGrant {
    const parsed = EconomicGrantSchema.safeParse(raw);
    if (!parsed.success) throw new EconomicGrantError('GRANT_INVALID');
    const { grantId, mac, ...body } = parsed.data;
    if (artifactHash(body) !== grantId)
      throw new EconomicGrantError('GRANT_INVALID', 'grant id');
    if (
      !timingSafeEqual(
        Buffer.from(this.mac(grantId), 'hex'),
        Buffer.from(mac, 'hex'),
      )
    )
      throw new EconomicGrantError('GRANT_MAC');
    if (now >= body.expiresAt || now < body.issuedAt)
      throw new EconomicGrantError('GRANT_EXPIRED');
    const m = this.mandates.get(body.mandateId);
    if (!m || m.status !== 'ACTIVE' || m.version !== body.mandateVersion)
      throw new EconomicGrantError('GRANT_BINDING', 'mandate changed');
    const g = body.execution;
    const x = EconomicExecutionSchema.parse(actual);
    const bind = (ok: boolean, what: string) => {
      if (!ok) throw new EconomicGrantError('GRANT_BINDING', what);
    };
    bind(x.domain === g.domain, 'domain');
    bind(x.providerId === g.providerId, 'provider');
    bind(x.host === g.host, 'merchant host');
    bind(x.offerId === g.offerId, 'offer');
    bind(x.subjectHash === g.subjectHash, 'item');
    bind(x.quantity === g.quantity, 'quantity');
    bind(x.reservationId === g.reservationId, 'reservation');
    bind(x.settlementPlanHash === g.settlementPlanHash, 'settlement plan');
    bind(x.recipientRef === g.recipientRef, 'recipient');
    bind(
      x.maxAmount.currency === g.maxAmount.currency &&
        x.maxAmount.decimals === g.maxAmount.decimals &&
        BigInt(x.maxAmount.amount) <= BigInt(g.maxAmount.amount),
      'amount',
    );
    return parsed.data;
  }

  consume(raw: unknown, actual: EconomicExecution, now: number): EconomicGrant {
    const grant = this.verify(raw, actual, now);
    if (this.consumed.has(grant.grantId))
      throw new EconomicGrantError('GRANT_CONSUMED');
    this.consumed.add(grant.grantId);
    return grant;
  }

  isConsumed(grantId: string): boolean {
    return this.consumed.has(grantId);
  }
}
