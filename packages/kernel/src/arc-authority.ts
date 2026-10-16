import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  encodeAbiParameters,
  keccak256,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';

/**
 * Arc payment authority: the deterministic barrier between an agent's proposal
 * and an executor's signature.
 *
 * - A `PaymentMandate` is signed by its human owner (EIP-712, Arc chain id in
 *   the domain): payer account, asset, recipient allowlist, per-action cap,
 *   rolling budget, purposes, validity window. Nothing else creates authority.
 * - `decide` evaluates one `PaymentIntent` against the mandate, its live state
 *   (spend in the period, revocation) and independent risk/simulation inputs.
 * - An ALLOW yields an `ExecutionGrant` bound to the exact call (chain, token,
 *   payer, recipient, amount), one-use nonce and short expiry, authenticated
 *   with the Kernel's key. Executors verify it and consume the nonce before
 *   signing, so a mutated recipient, replay, stale or revoked grant never runs.
 * - Chat buttons, Telegram votes and model output are not signatures: the only
 *   approval input is a recovered EIP-712 signature from the mandate owner.
 */

export const PAYMENT_PURPOSES = [
  'CONTRACTOR_PAYOUT',
  'VENDOR_INVOICE',
  'INVOICE_REFUND',
  'RECURRING_BILL',
  'GROUP_EXPENSE',
] as const;
export type PaymentPurpose = (typeof PAYMENT_PURPOSES)[number];

export type PaymentMandate = Readonly<{
  mandateId: string;
  version: number;
  workspaceId: string;
  owner: Address;
  chainId: number;
  token: Address;
  /** Account that pays (owner wallet, vault or delegated agent wallet). */
  payer: Address;
  recipients: readonly Address[];
  purposes: readonly PaymentPurpose[];
  /** Base units of `token`. Above this, a fresh owner approval is needed. */
  perActionCap: bigint;
  /** Base units allowed per rolling `periodSeconds`. */
  periodBudget: bigint;
  periodSeconds: number;
  validFrom: number;
  validUntil: number;
}>;

export type PaymentIntent = Readonly<{
  intentId: string;
  mandateId: string;
  mandateVersion: number;
  chainId: number;
  token: Address;
  payer: Address;
  recipient: Address;
  amount: bigint;
  purpose: PaymentPurpose;
  /** Invoice / payable / milestone the payment settles. */
  obligationRef: string;
  /** Hash of the evidence bundle the proposal relied on. */
  evidenceHash: Hex;
  proposedBy: string;
}>;

export type RiskInput = Readonly<{
  /** Deterministic flags from the risk engine; any HARD flag denies. */
  flags: readonly { code: string; severity: 'HARD' | 'SOFT'; detail: string }[];
  /** False when the risk service could not be reached: high-value payments fail closed. */
  available: boolean;
}>;

export type MandateState = Readonly<{
  revoked: boolean;
  /** Payments (amount, time) already executed under this mandate. */
  spends: readonly { amount: bigint; at: number }[];
  /**
   * Obligations (invoice / payable / milestone refs) already granted or paid
   * under this mandate. A second grant for the same obligation is denied.
   */
  settledObligations?: readonly string[];
  /** Owner-approval nonces already redeemed for a grant; each works once. */
  usedApprovalNonces?: readonly Hex[];
}>;

/**
 * Freshness terms of one owner approval: a one-use nonce and a deadline,
 * issued by the Kernel with the REQUIRE_OWNER_APPROVAL outcome and signed by
 * the owner inside the PaymentApproval typed data.
 */
export type ApprovalTerms = Readonly<{ nonce: Hex; deadline: number }>;
export type OwnerApproval = ApprovalTerms & Readonly<{ signature: Hex }>;
/** Default lifetime of an approval request. */
export const APPROVAL_TTL_SECONDS = 900;

export type Decision =
  | {
      outcome: 'ALLOW';
      grant: ExecutionGrant;
      reasons: string[];
    }
  | {
      outcome: 'REQUIRE_OWNER_APPROVAL';
      reasons: string[];
      /** Terms the owner signs with `intentApprovalTypedData(intent, approval)`. */
      approval: ApprovalTerms;
    }
  | { outcome: 'DENY'; reasons: string[] };

export type ExecutionGrant = Readonly<{
  grantId: string;
  intentId: string;
  mandateId: string;
  mandateVersion: number;
  mandateHash: Hex;
  chainId: number;
  token: Address;
  payer: Address;
  recipient: Address;
  amount: string;
  /** keccak of the exact call; executors recompute it from what they will sign. */
  actionHash: Hex;
  operator: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  issuedByKernel: true;
  mac: Hex;
}>;

export class AuthorityError extends Error {
  constructor(
    readonly code:
      | 'BAD_MANDATE'
      | 'BAD_SIGNATURE'
      | 'GRANT_FORGED'
      | 'GRANT_EXPIRED'
      | 'GRANT_REPLAYED'
      | 'GRANT_MISMATCH'
      | 'GRANT_REVOKED',
    message: string = code,
  ) {
    super(message);
    this.name = 'AuthorityError';
  }
}

const lower = (a: string) => a.toLowerCase();

export function mandateTypedData(m: PaymentMandate) {
  return {
    domain: { name: 'Synq Payment Mandate', version: '1', chainId: m.chainId },
    types: {
      PaymentMandate: [
        { name: 'mandateId', type: 'string' },
        { name: 'version', type: 'uint256' },
        { name: 'workspaceId', type: 'string' },
        { name: 'owner', type: 'address' },
        { name: 'token', type: 'address' },
        { name: 'payer', type: 'address' },
        { name: 'recipients', type: 'address[]' },
        { name: 'purposes', type: 'string[]' },
        { name: 'perActionCap', type: 'uint256' },
        { name: 'periodBudget', type: 'uint256' },
        { name: 'periodSeconds', type: 'uint256' },
        { name: 'validFrom', type: 'uint256' },
        { name: 'validUntil', type: 'uint256' },
      ],
    },
    primaryType: 'PaymentMandate' as const,
    message: {
      mandateId: m.mandateId,
      version: BigInt(m.version),
      workspaceId: m.workspaceId,
      owner: m.owner,
      token: m.token,
      payer: m.payer,
      recipients: [...m.recipients],
      purposes: [...m.purposes],
      perActionCap: m.perActionCap,
      periodBudget: m.periodBudget,
      periodSeconds: BigInt(m.periodSeconds),
      validFrom: BigInt(m.validFrom),
      validUntil: BigInt(m.validUntil),
    },
  };
}

export function validateMandate(m: PaymentMandate): void {
  const bad = (why: string) => {
    throw new AuthorityError('BAD_MANDATE', why);
  };
  if (m.perActionCap <= 0n || m.periodBudget <= 0n)
    bad('caps must be positive');
  if (m.perActionCap > m.periodBudget) bad('per-action cap above budget');
  if (m.periodSeconds < 60) bad('period too short');
  if (m.validUntil <= m.validFrom) bad('empty validity window');
  if (!m.recipients.length) bad('no recipients');
  if (new Set(m.recipients.map(lower)).size !== m.recipients.length)
    bad('duplicate recipient');
  if (m.recipients.some((r) => lower(r) === lower(m.payer)))
    bad('payer cannot be its own recipient');
  if (!m.purposes.length) bad('no purposes');
}

/** The mandate's owner must have signed exactly this mandate on this chain. */
export async function verifyMandateSignature(
  m: PaymentMandate,
  signature: Hex,
): Promise<void> {
  validateMandate(m);
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({
      ...mandateTypedData(m),
      signature,
    });
  } catch {
    throw new AuthorityError('BAD_SIGNATURE', 'unrecoverable signature');
  }
  if (lower(signer) !== lower(m.owner))
    throw new AuthorityError(
      'BAD_SIGNATURE',
      `signed by ${signer}, owner ${m.owner}`,
    );
}

export function mandateHash(m: PaymentMandate): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'uint256' }, { type: 'bytes32' }],
      [
        m.mandateId,
        BigInt(m.version),
        keccak256(
          encodeAbiParameters(
            [
              { type: 'uint256' },
              { type: 'address' },
              { type: 'address' },
              { type: 'address[]' },
              { type: 'uint256' },
              { type: 'uint256' },
              { type: 'uint256' },
              { type: 'uint256' },
            ],
            [
              BigInt(m.chainId),
              m.token,
              m.payer,
              [...m.recipients],
              m.perActionCap,
              m.periodBudget,
              BigInt(m.validFrom),
              BigInt(m.validUntil),
            ],
          ),
        ),
      ],
    ),
  );
}

/** keccak256(chainId, token, payer, recipient, amount): the exact ERC-20 transfer. */
export function transferActionHash(a: {
  chainId: number;
  token: Address;
  payer: Address;
  recipient: Address;
  amount: bigint;
}): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
      ],
      [BigInt(a.chainId), a.token, a.payer, a.recipient, a.amount],
    ),
  );
}

function macOf(key: Uint8Array, g: Omit<ExecutionGrant, 'mac'>): Hex {
  const body = JSON.stringify([
    g.grantId,
    g.intentId,
    g.mandateId,
    g.mandateVersion,
    g.mandateHash,
    g.chainId,
    lower(g.token),
    lower(g.payer),
    lower(g.recipient),
    g.amount,
    g.actionHash,
    g.operator,
    g.nonce,
    g.issuedAt,
    g.expiresAt,
  ]);
  return `0x${createHmac('sha256', key).update(body).digest('hex')}`;
}

export type AuthorityConfig = {
  /** HMAC key held by the Kernel and verified by executors; never given to agents. */
  grantKey: Uint8Array;
  operator: string;
  grantTtlSeconds: number;
  /** Payments at or above this many base units fail closed when risk is unavailable. */
  riskRequiredAbove: bigint;
};

/**
 * Decision. `ownerApproval` is the owner's EIP-712 signature over the intent
 * and the approval terms (one-use nonce, deadline) the Kernel issued with its
 * REQUIRE_OWNER_APPROVAL outcome. It is needed above the per-action cap, or
 * for every payment when `requireOwnerApproval` is set; nothing else lifts
 * that requirement. An expired or already-redeemed approval is refused.
 */
export async function decide(input: {
  config: AuthorityConfig;
  mandate: PaymentMandate;
  mandateSignature: Hex;
  state: MandateState;
  intent: PaymentIntent;
  risk: RiskInput;
  simulationOk: boolean;
  now: number;
  ownerApproval?: OwnerApproval;
  /**
   * When true, even an in-cap intent needs `ownerApproval` (a confirmation
   * step): without it the result is REQUIRE_OWNER_APPROVAL and no grant.
   */
  requireOwnerApproval?: boolean;
}): Promise<Decision> {
  const { mandate: m, intent: i, state, risk, now } = input;
  const deny = (...reasons: string[]): Decision => ({
    outcome: 'DENY',
    reasons,
  });
  try {
    await verifyMandateSignature(m, input.mandateSignature);
  } catch (e) {
    return deny(`mandate not signed by its owner (${(e as Error).message})`);
  }
  if (state.revoked) return deny('mandate revoked');
  if (now < m.validFrom) return deny('mandate not yet valid');
  if (now >= m.validUntil) return deny('mandate expired');
  if (i.mandateId !== m.mandateId || i.mandateVersion !== m.version)
    return deny('intent references another mandate version');
  if (i.chainId !== m.chainId) return deny(`wrong chain ${i.chainId}`);
  if (lower(i.token) !== lower(m.token)) return deny('wrong asset');
  if (lower(i.payer) !== lower(m.payer)) return deny('wrong paying account');
  // Independent checks all report, so the audit trail shows every reason.
  const denials: string[] = [];
  if (!m.recipients.some((r) => lower(r) === lower(i.recipient)))
    denials.push(`recipient ${i.recipient} is not on the mandate allowlist`);
  if (!m.purposes.includes(i.purpose))
    denials.push(`purpose ${i.purpose} not allowed`);
  if (i.amount <= 0n) denials.push('amount must be positive');
  if (state.settledObligations?.includes(i.obligationRef))
    denials.push(
      `obligation ${i.obligationRef} was already granted or paid under this mandate`,
    );
  for (const f of risk.flags.filter((x) => x.severity === 'HARD'))
    denials.push(`risk ${f.code}: ${f.detail}`);
  if (!risk.available && i.amount >= input.config.riskRequiredAbove)
    denials.push('risk service unavailable: high-value payment fails closed');
  if (denials.length) return deny(...denials);
  const windowStart = now - m.periodSeconds;
  const spent = state.spends
    .filter((s) => s.at > windowStart)
    .reduce((a, s) => a + s.amount, 0n);
  if (spent + i.amount > m.periodBudget)
    return deny(`period budget exceeded (${spent} spent of ${m.periodBudget})`);
  if (!input.simulationOk) return deny('simulation failed: no grant');
  const reasons = [
    `recipient on allowlist`,
    `amount ${i.amount} within cap ${m.perActionCap}`,
    `period spend ${spent + i.amount} of ${m.periodBudget}`,
    ...risk.flags.map((f) => `soft risk ${f.code}: ${f.detail}`),
  ];
  const overCap = i.amount > m.perActionCap;
  if (overCap || input.requireOwnerApproval) {
    const a = input.ownerApproval;
    if (!a)
      return {
        outcome: 'REQUIRE_OWNER_APPROVAL',
        reasons: [
          overCap
            ? `amount ${i.amount} above per-action cap ${m.perActionCap}`
            : 'owner confirmation required for this payment',
        ],
        approval: {
          nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
          deadline: now + APPROVAL_TTL_SECONDS,
        },
      };
    if (!Number.isSafeInteger(a.deadline) || now > a.deadline)
      return deny('owner approval expired');
    if (state.usedApprovalNonces?.some((n) => lower(n) === lower(a.nonce)))
      return deny('owner approval already used');
    const signer = await recoverTypedDataAddress({
      ...intentApprovalTypedData(i, a),
      signature: a.signature,
    }).catch(() => null);
    if (!signer || lower(signer) !== lower(m.owner))
      return deny('owner approval signature does not match the mandate owner');
    reasons.push(overCap ? 'owner approved above cap' : 'owner confirmed');
  }
  return {
    outcome: 'ALLOW',
    grant: issueGrant(input.config, m, i, now),
    reasons,
  };
}

/**
 * What an owner signs to approve one specific intent: its exact terms plus
 * the Kernel-issued one-use nonce and deadline.
 */
export function intentApprovalTypedData(
  i: PaymentIntent,
  terms: ApprovalTerms,
) {
  return {
    domain: { name: 'Synq Payment Approval', version: '1', chainId: i.chainId },
    types: {
      PaymentApproval: [
        { name: 'intentId', type: 'string' },
        { name: 'mandateId', type: 'string' },
        { name: 'token', type: 'address' },
        { name: 'payer', type: 'address' },
        { name: 'recipient', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'obligationRef', type: 'string' },
        { name: 'nonce', type: 'bytes32' },
        { name: 'deadline', type: 'uint64' },
      ],
    },
    primaryType: 'PaymentApproval' as const,
    message: {
      intentId: i.intentId,
      mandateId: i.mandateId,
      token: i.token,
      payer: i.payer,
      recipient: i.recipient,
      amount: i.amount,
      obligationRef: i.obligationRef,
      nonce: terms.nonce,
      deadline: BigInt(terms.deadline),
    },
  };
}

function issueGrant(
  config: AuthorityConfig,
  m: PaymentMandate,
  i: PaymentIntent,
  now: number,
): ExecutionGrant {
  const body = {
    grantId: `grt_${randomBytes(12).toString('hex')}`,
    intentId: i.intentId,
    mandateId: m.mandateId,
    mandateVersion: m.version,
    mandateHash: mandateHash(m),
    chainId: i.chainId,
    token: i.token,
    payer: i.payer,
    recipient: i.recipient,
    amount: String(i.amount),
    actionHash: transferActionHash(i),
    operator: config.operator,
    nonce: `0x${randomBytes(32).toString('hex')}` as Hex,
    issuedAt: now,
    expiresAt: now + config.grantTtlSeconds,
    issuedByKernel: true as const,
  };
  return Object.freeze({ ...body, mac: macOf(config.grantKey, body) });
}

export interface NonceFence {
  /** Atomically marks the nonce used; false when it already was. */
  consume(nonce: Hex): Promise<boolean>;
  /**
   * Optional durable form: atomically records the whole grant as consumed,
   * unique on both its id and its nonce. `admitGrant` prefers it when present.
   */
  consumeGrant?(grant: ExecutionGrant, at: number): Promise<boolean>;
}

export class MemoryNonceFence implements NonceFence {
  private used = new Set<string>();
  async consume(nonce: Hex) {
    if (this.used.has(nonce)) return false;
    this.used.add(nonce);
    return true;
  }
}

type GrantCheck = {
  grantKey: Uint8Array;
  grant: ExecutionGrant;
  call: {
    chainId: number;
    token: Address;
    payer: Address;
    recipient: Address;
    amount: bigint;
  };
  now: number;
  mandateRevoked: boolean;
};

/**
 * Every admission check except consumption: authentic (MAC), unexpired,
 * mandate live, and the exact call. Executors that record the grant's
 * consumption atomically with other durable state call this, then consume.
 */
export function verifyGrant(input: GrantCheck): void {
  const { grant: g } = input;
  const { mac, ...body } = g;
  const expected = macOf(input.grantKey, body);
  const a = Buffer.from(mac.slice(2), 'hex');
  const b = Buffer.from(expected.slice(2), 'hex');
  if (
    g.issuedByKernel !== true ||
    a.length !== b.length ||
    !timingSafeEqual(a, b)
  )
    throw new AuthorityError('GRANT_FORGED');
  if (input.now >= g.expiresAt) throw new AuthorityError('GRANT_EXPIRED');
  if (input.mandateRevoked) throw new AuthorityError('GRANT_REVOKED');
  if (
    transferActionHash(input.call) !== g.actionHash ||
    transferActionHash({ ...input.call, amount: BigInt(g.amount) }) !==
      g.actionHash
  )
    throw new AuthorityError(
      'GRANT_MISMATCH',
      'the call differs from the granted chain/token/payer/recipient/amount',
    );
}

/**
 * Executor-side check before signing: the grant is authentic, unexpired, its
 * mandate still live, it matches the exact call about to be signed, and its
 * nonce has never been used. Consumes the nonce (or, with a durable fence,
 * the whole grant).
 */
export async function admitGrant(input: {
  grantKey: Uint8Array;
  grant: ExecutionGrant;
  call: {
    chainId: number;
    token: Address;
    payer: Address;
    recipient: Address;
    amount: bigint;
  };
  now: number;
  mandateRevoked: boolean;
  fence: NonceFence;
}): Promise<void> {
  verifyGrant(input);
  const g = input.grant;
  const fresh = input.fence.consumeGrant
    ? await input.fence.consumeGrant(g, input.now)
    : await input.fence.consume(g.nonce);
  if (!fresh) throw new AuthorityError('GRANT_REPLAYED');
}
