import { createHmac, timingSafeEqual } from 'node:crypto';
import { recoverTypedDataAddress } from 'viem';
import { z } from 'zod';
import {
  AddressSchema,
  AmountSchema,
  HashSchema,
  IdSchema,
  IdentityPrincipalKindSchema,
  MemberIdSchema,
  TimestampSchema,
  VerifiedApprovalSchema,
  type ApprovalLedger,
  type MembershipDirectory,
  type VerifiedApproval,
} from '@synq/schemas';
import { artifactHash } from './canonical.js';
import { canonicalSignature } from './approvals.js';

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
  'CONVERSION',
] as const;

/**
 * Mandates that move real testnet value are approved by human passkeys only:
 * no fixture, delegate or operator principal can count toward their quorum.
 */
export const PRODUCTION_APPROVER_KINDS = ['MERA_HUMAN'] as const;

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
    approverKinds: z
      .array(IdentityPrincipalKindSchema.exclude(['DYNAMIC_OPERATOR']))
      .min(1)
      .default(['MERA_HUMAN']),
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
    if (
      v.environment === 'TESTNET' &&
      (v.approverKinds.length !== PRODUCTION_APPROVER_KINDS.length ||
        !PRODUCTION_APPROVER_KINDS.every((k) => v.approverKinds.includes(k)))
    )
      ctx.addIssue({
        code: 'custom',
        path: ['approverKinds'],
        message: 'TESTNET mandates are approved by MERA_HUMAN principals only',
      });
  });
export type EconomicMandate = z.output<typeof EconomicMandateSchema>;
export type EconomicMandateInput = z.input<typeof EconomicMandateSchema>;

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
  reservedAssetId: z.string().min(1).max(160),
  reservedAmount: AmountSchema.refine(
    (v) => BigInt(v) > 0n,
    'reserved amount must be positive',
  ),
  settlementPlanHash: z.string().min(1).max(80),
  recipientRef: z.string().max(160).nullable(),
  payAsset: z
    .strictObject({
      chainId: z.number().int().positive(),
      address: AddressSchema,
      decimals: z.number().int().min(0).max(36),
    })
    .nullable(),
});
export type EconomicExecution = z.output<typeof EconomicExecutionSchema>;
export type EconomicExecutionInput = z.input<typeof EconomicExecutionSchema>;

export const EconomicAuthorizationRequestSchema = z.strictObject({
  intentId: IdSchema,
  groupId: IdSchema,
  mandateId: IdSchema,
  execution: EconomicExecutionSchema,
  quoteExpiresAt: TimestampSchema,
  revalidatedAt: TimestampSchema.nullable(),
});
export type EconomicAuthorizationRequest = z.input<
  typeof EconomicAuthorizationRequestSchema
>;

export const EconomicGrantSchema = z.strictObject({
  schemaVersion: z.literal(2),
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
  | 'RESERVATION_MISMATCH'
  | 'INTENT_ALREADY_EXECUTED'
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

export function economicRequestHash(raw: EconomicAuthorizationRequest) {
  const r = EconomicAuthorizationRequestSchema.parse(raw);
  return artifactHash({ kind: 'EconomicAuthorizationRequest', ...r });
}
/** What an approving member signs (EIP-712) for an economic request. */
export function economicApprovalTypedData(input: {
  groupId: string;
  mandateId: string;
  requestHash: `0x${string}`;
}) {
  return {
    domain: { name: 'Synq Economic Approval', version: '1' },
    types: {
      EconomicApproval: [
        { name: 'groupId', type: 'string' },
        { name: 'mandateId', type: 'string' },
        { name: 'requestHash', type: 'bytes32' },
      ],
    },
    primaryType: 'EconomicApproval' as const,
    message: input,
  };
}

export const executionHash = (x: EconomicExecution) =>
  artifactHash({ kind: 'EconomicExecution', ...x });

/** Reservation view the Kernel reads itself; callers cannot assert a reservation is held. */
export type EconomicReservationView = {
  state: string;
  groupId: string;
  assetId: string;
  amount: string;
  settlementPlanHash: string | null;
  expiresAt: number;
};
export interface EconomicReservationReader {
  get(reservationId: string): Promise<EconomicReservationView | null>;
}

/**
 * Durable grant state. `issue` charges the budget atomically for every issued
 * grant; `consume` is a single atomic insert unique on grant and intent.
 */
export interface EconomicGrantLedger {
  installMandate(m: EconomicMandate): Promise<void>;
  mandate(mandateId: string): Promise<EconomicMandate | null>;
  revoke(mandateId: string): Promise<void>;
  latestGrant(intentId: string): Promise<EconomicGrant | null>;
  intentConsumed(intentId: string): Promise<boolean>;
  issue(
    grant: EconomicGrant,
    amount: bigint,
    budget: bigint,
  ): Promise<'ISSUED' | 'BUDGET_EXHAUSTED' | 'INTENT_CONSUMED'>;
  consume(
    grant: EconomicGrant,
    executionHash: string,
    at: number,
  ): Promise<boolean>;
  spent(mandateId: string): Promise<bigint>;
  isConsumed(grantId: string): Promise<boolean>;
}

export class MandateVersionError extends Error {
  constructor(id: string) {
    super(`MANDATE_VERSION_NOT_NEWER: ${id}`);
    this.name = 'MandateVersionError';
  }
}

export class MemoryEconomicGrantLedger implements EconomicGrantLedger {
  private readonly mandates = new Map<string, EconomicMandate>();
  private readonly spentBy = new Map<string, bigint>();
  private readonly latest = new Map<string, EconomicGrant>();
  private readonly consumedGrants = new Set<string>();
  private readonly consumedIntents = new Set<string>();
  async installMandate(m: EconomicMandate) {
    const prior = this.mandates.get(m.mandateId);
    if (prior && prior.version >= m.version)
      throw new MandateVersionError(m.mandateId);
    this.mandates.set(m.mandateId, m);
  }
  async mandate(id: string) {
    return this.mandates.get(id) ?? null;
  }
  async revoke(id: string) {
    const m = this.mandates.get(id);
    if (m) this.mandates.set(id, { ...m, status: 'REVOKED' });
  }
  async latestGrant(intentId: string) {
    return this.latest.get(intentId) ?? null;
  }
  async intentConsumed(intentId: string) {
    return this.consumedIntents.has(intentId);
  }
  async issue(grant: EconomicGrant, amount: bigint, budget: bigint) {
    if (this.consumedIntents.has(grant.intentId))
      return 'INTENT_CONSUMED' as const;
    const spent = this.spentBy.get(grant.mandateId) ?? 0n;
    if (spent + amount > budget) return 'BUDGET_EXHAUSTED' as const;
    this.spentBy.set(grant.mandateId, spent + amount);
    this.latest.set(grant.intentId, grant);
    return 'ISSUED' as const;
  }
  async consume(grant: EconomicGrant) {
    if (
      this.consumedGrants.has(grant.grantId) ||
      this.consumedIntents.has(grant.intentId)
    )
      return false;
    this.consumedGrants.add(grant.grantId);
    this.consumedIntents.add(grant.intentId);
    return true;
  }
  async spent(id: string) {
    return this.spentBy.get(id) ?? 0n;
  }
  async isConsumed(grantId: string) {
    return this.consumedGrants.has(grantId);
  }
}

const MATCHING_KINDS = new Set([
  'MERA_HUMAN',
  'PRIVY_DELEGATE',
  'LOCAL_FIXTURE',
]);

/**
 * The Kernel's Web2/x402 authority: commerce, stays, flights, paid data and
 * conversions compile to the same one-time, HMAC-bound grant. Approvals must
 * be identity-verified records bound to the exact request hash; the
 * reservation is read by the Kernel itself.
 */
export class EconomicGrantAuthority {
  private readonly key: Uint8Array;
  private readonly ledger: EconomicGrantLedger;
  private readonly reservations: EconomicReservationReader;
  private readonly approvalPorts: {
    ledger: ApprovalLedger;
    directory: MembershipDirectory;
  };
  constructor(input: {
    key: Uint8Array;
    reservations: EconomicReservationReader;
    ledger: EconomicGrantLedger;
    approvals: { ledger: ApprovalLedger; directory: MembershipDirectory };
  }) {
    if (input.key.length < 32) throw new Error('GRANT_KEY_TOO_SHORT');
    if (!input.ledger || !input.approvals || !input.reservations)
      throw new Error('ECONOMIC_AUTHORITY_PORTS_REQUIRED');
    this.key = input.key;
    this.reservations = input.reservations;
    this.ledger = input.ledger;
    this.approvalPorts = input.approvals;
  }

  /**
   * Mirrors ApprovalCalculator: request binding, eligible kind, mandate
   * member, canonical signature recovered to the member signer, identity
   * ledger consumption, active directory member and current epoch, no reuse.
   */
  private async verifiedApprovers(
    m: EconomicMandate,
    groupId: string,
    requestHash: `0x${string}`,
    approvals: readonly unknown[],
  ): Promise<{ approvers: string[]; outsider: string | null }> {
    const members = new Set<string>(m.members);
    const kinds = new Set<string>(m.approverKinds);
    const typed = economicApprovalTypedData({
      groupId,
      mandateId: m.mandateId,
      requestHash,
    });
    const seen = new Set<string>();
    const approvers = new Set<string>();
    for (const raw of approvals) {
      const parsed = VerifiedApprovalSchema.safeParse(raw);
      if (!parsed.success) continue;
      const a: VerifiedApproval = parsed.data;
      if (a.draftDigest !== requestHash || a.groupId !== groupId) continue;
      if (!MATCHING_KINDS.has(a.principalKind) || !kinds.has(a.principalKind))
        continue;
      if (!members.has(a.memberId))
        return { approvers: [], outsider: a.memberId };
      if (!canonicalSignature(a.signature)) continue;
      let recovered: string;
      try {
        recovered = (
          await recoverTypedDataAddress({ ...typed, signature: a.signature })
        ).toLowerCase();
      } catch {
        continue;
      }
      if (recovered !== a.signer) continue;
      const keys = [
        `member:${a.memberId}`,
        `signer:${a.signer}`,
        `principal:${a.principalId}`,
        `challenge:${a.challengeId}`,
        `approval:${a.approvalId}`,
      ];
      if (keys.some((k) => seen.has(k))) continue;
      const consumed = await this.approvalPorts.ledger
        .isConsumed(a)
        .catch(() => false);
      if (consumed !== true) continue;
      const member = await this.approvalPorts.directory
        .activeMember(groupId, a.memberId)
        .catch(() => null);
      if (
        !member ||
        member.role !== 'APPROVER' ||
        member.principalId !== a.principalId ||
        member.principalKind !== a.principalKind ||
        member.signer.toLowerCase() !== a.signer ||
        member.membershipEpoch !== a.membershipEpoch
      )
        continue;
      const epoch = await this.approvalPorts.directory
        .membershipEpoch(groupId)
        .catch(() => null);
      if (epoch !== a.membershipEpoch) continue;
      keys.forEach((k) => seen.add(k));
      approvers.add(a.memberId);
    }
    return { approvers: [...approvers].sort(), outsider: null };
  }

  private mac(grantId: string) {
    return createHmac('sha256', this.key).update(grantId).digest('hex');
  }

  async install(raw: EconomicMandateInput): Promise<EconomicMandate> {
    const m = EconomicMandateSchema.parse(raw);
    await this.ledger.installMandate(m);
    return m;
  }

  revoke(mandateId: string): Promise<void> {
    return this.ledger.revoke(mandateId);
  }

  spentFor(mandateId: string): Promise<bigint> {
    return this.ledger.spent(mandateId);
  }

  isConsumed(grantId: string): Promise<boolean> {
    return this.ledger.isConsumed(grantId);
  }

  async authorize(
    raw: EconomicAuthorizationRequest,
    approvals: readonly unknown[],
    now: number,
  ): Promise<EconomicDecision> {
    const r = EconomicAuthorizationRequestSchema.parse(raw);
    const reject = (code: EconomicRefusal, detail = ''): EconomicDecision => ({
      status: 'REJECTED',
      code,
      detail,
    });
    const m = await this.ledger.mandate(r.mandateId);
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
    if (
      r.revalidatedAt === null ||
      now - r.revalidatedAt > m.maxQuoteAgeSeconds
    )
      return reject('QUOTE_NOT_REVALIDATED');
    if (r.quoteExpiresAt <= now) return reject('QUOTE_EXPIRED');
    if (await this.ledger.intentConsumed(r.intentId))
      return reject('INTENT_ALREADY_EXECUTED');
    const res = await this.reservations.get(x.reservationId);
    if (!res) return reject('RESERVATION_MISSING');
    if (
      res.state !== 'ACTIVE' ||
      res.expiresAt <= now ||
      res.groupId !== r.groupId ||
      res.assetId !== x.reservedAssetId ||
      BigInt(res.amount) < BigInt(x.reservedAmount) ||
      res.settlementPlanHash !== x.settlementPlanHash
    )
      return reject('RESERVATION_MISMATCH', `reservation ${res.state}`);

    const requestHash = economicRequestHash(r);
    const verified = await this.verifiedApprovers(
      m,
      r.groupId,
      requestHash,
      approvals,
    );
    if (verified.outsider)
      return reject('APPROVER_NOT_MEMBER', verified.outsider);
    const unique = verified.approvers;
    const required = amount <= BigInt(m.autoApproveMax.amount) ? 0 : m.quorum;
    if (unique.length < required)
      return {
        status: 'PENDING_APPROVAL',
        requiredApprovals: required,
        approvals: unique,
        requestHash,
      };

    const prior = await this.ledger.latestGrant(r.intentId);
    if (
      prior &&
      prior.expiresAt > now &&
      prior.mandateVersion === m.version &&
      executionHash(prior.execution) === executionHash(x) &&
      !(await this.ledger.isConsumed(prior.grantId))
    )
      return { status: 'AUTHORIZED', grant: prior };
    const body = {
      schemaVersion: 2 as const,
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
        res.expiresAt,
      ),
    };
    const grantId = artifactHash(body);
    const grant = EconomicGrantSchema.parse({
      ...body,
      grantId,
      mac: this.mac(grantId),
    });
    const issued = await this.ledger.issue(
      grant,
      amount,
      BigInt(m.cumulativeBudget.amount),
    );
    if (issued === 'BUDGET_EXHAUSTED') return reject('BUDGET_EXHAUSTED');
    if (issued === 'INTENT_CONSUMED') return reject('INTENT_ALREADY_EXECUTED');
    return { status: 'AUTHORIZED', grant };
  }

  /** Verifies an execution against its grant without consuming it. */
  async verify(
    raw: unknown,
    actual: EconomicExecutionInput,
    now: number,
  ): Promise<EconomicGrant> {
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
    const m = await this.ledger.mandate(body.mandateId);
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
    bind(
      x.reservedAssetId === g.reservedAssetId &&
        x.reservedAmount === g.reservedAmount,
      'reserved amount',
    );
    bind(x.settlementPlanHash === g.settlementPlanHash, 'settlement plan');
    bind(x.recipientRef === g.recipientRef, 'recipient');
    bind(
      (x.payAsset === null && g.payAsset === null) ||
        (x.payAsset !== null &&
          g.payAsset !== null &&
          x.payAsset.chainId === g.payAsset.chainId &&
          x.payAsset.address === g.payAsset.address &&
          x.payAsset.decimals === g.payAsset.decimals),
      'pay asset',
    );
    bind(
      x.maxAmount.currency === g.maxAmount.currency &&
        x.maxAmount.decimals === g.maxAmount.decimals &&
        BigInt(x.maxAmount.amount) <= BigInt(g.maxAmount.amount),
      'amount',
    );
    return parsed.data;
  }

  async consume(
    raw: unknown,
    actual: EconomicExecutionInput,
    now: number,
  ): Promise<EconomicGrant> {
    const grant = await this.verify(raw, actual, now);
    if (
      !(await this.ledger.consume(
        grant,
        executionHash(EconomicExecutionSchema.parse(actual)),
        now,
      ))
    )
      throw new EconomicGrantError('GRANT_CONSUMED');
    return grant;
  }
}
