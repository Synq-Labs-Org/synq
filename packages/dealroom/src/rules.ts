import {
  DealRoomError,
  type AttestationKind,
  type DealStatus,
  type MilestoneState,
  type MilestoneStatus,
  type PartyRole,
  type Role,
  type Terms,
} from './schema.js';

/**
 * Deterministic rules of the Deal Room: which terms are fundable, which
 * status changes are allowed, and who may attest what. The service checks
 * these before every store write; the store additionally enforces
 * idempotency and optimistic concurrency.
 */

const lower = (a: string) => a.toLowerCase();

/** Problems that make terms impossible to fund on SynqMilestoneEscrow; empty means valid. */
export function termProblems(
  t: Terms,
  expected?: { token: string; chainId: number; escrow: string },
): string[] {
  const out: string[] = [];
  const sum = t.milestones.reduce((a, m) => a + m.amount, 0n);
  if (t.total <= 0n) out.push('total must be positive');
  if (sum !== t.total)
    out.push(`milestones add up to ${sum}, total is ${t.total}`);
  if (t.deposit !== t.total)
    out.push(
      'the escrow funds every milestone up front: deposit must equal total',
    );
  t.milestones.forEach((m, i) => {
    if (m.index !== i) out.push(`milestone ${i} has index ${m.index}`);
    if (m.amount <= 0n) out.push(`milestone ${i} amount must be positive`);
    if (lower(m.payee) !== lower(t.freelancer.wallet))
      out.push(
        `milestone ${i} pays ${m.payee}, not the freelancer's verified wallet`,
      );
  });
  const wallets = [t.client.wallet, t.freelancer.wallet, t.arbiter.wallet].map(
    lower,
  );
  if (new Set(wallets).size !== 3)
    out.push('client, freelancer and arbiter must be three different wallets');
  if (
    t.client.role !== 'CLIENT' ||
    t.freelancer.role !== 'FREELANCER' ||
    t.arbiter.role !== 'ARBITER'
  )
    out.push('party roles are mislabelled');
  const lastDeadline = Math.max(...t.milestones.map((m) => m.deadline));
  if (t.refundAfter <= lastDeadline)
    out.push('refundAfter must be after the last milestone deadline');
  if (t.expiresAt >= t.refundAfter)
    out.push('the offer must expire before refunds open');
  if (expected) {
    if (
      lower(t.asset.token) !== lower(expected.token) ||
      t.asset.chainId !== expected.chainId
    )
      out.push('asset is not the registry asset for this deployment');
    if (lower(t.escrow) !== lower(expected.escrow))
      out.push('escrow is not the registry SynqMilestoneEscrow');
  }
  return out;
}

export function assertFundable(
  t: Terms,
  expected?: Parameters<typeof termProblems>[1],
) {
  const p = termProblems(t, expected);
  if (p.length) throw new DealRoomError('INVALID_TERMS', p.join('; '));
}

/** Allowed deal-level transitions. */
export const DEAL_TRANSITIONS: Readonly<
  Record<DealStatus, readonly DealStatus[]>
> = {
  DRAFT: ['NEGOTIATING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'],
  NEGOTIATING: ['NEGOTIATING', 'ACCEPTED', 'CANCELLED', 'EXPIRED'],
  ACCEPTED: ['NEGOTIATING', 'FUNDING', 'CANCELLED', 'EXPIRED'],
  FUNDING: ['FUNDED', 'ACCEPTED'],
  FUNDED: ['IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'SETTLED', 'REFUNDED'],
  IN_PROGRESS: ['IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'SETTLED', 'REFUNDED'],
  DELIVERED: ['IN_PROGRESS', 'DELIVERED', 'DISPUTED', 'SETTLED', 'REFUNDED'],
  DISPUTED: ['DISPUTED', 'IN_PROGRESS', 'DELIVERED', 'SETTLED', 'REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
  CANCELLED: [],
  EXPIRED: [],
};

export function assertTransition(from: DealStatus, to: DealStatus) {
  if (!DEAL_TRANSITIONS[from].includes(to))
    throw new DealRoomError('WRONG_STATE', `deal cannot go ${from} -> ${to}`);
}

export const PRE_FUNDING: readonly DealStatus[] = [
  'DRAFT',
  'NEGOTIATING',
  'ACCEPTED',
];
export const POST_FUNDING: readonly DealStatus[] = [
  'FUNDED',
  'IN_PROGRESS',
  'DELIVERED',
  'DISPUTED',
];

/** Milestone transitions by attestation kind (from-states) and resulting state. */
export const ATTESTATION_RULES: Readonly<
  Record<
    AttestationKind,
    {
      by: readonly Role[];
      from: readonly MilestoneStatus[];
      to: MilestoneStatus;
    }
  >
> = {
  DELIVERED: { by: ['FREELANCER'], from: ['FUNDED'], to: 'DELIVERED' },
  ACCEPT_RELEASE: { by: ['CLIENT'], from: ['DELIVERED'], to: 'ACCEPTED' },
  DISPUTE: {
    by: ['CLIENT', 'FREELANCER'],
    from: ['FUNDED', 'DELIVERED', 'ACCEPTED'],
    to: 'DISPUTED',
  },
  // The arbiter resolves only a dispute; otherwise the parties decide.
  ARBITER_RELEASE: { by: ['ARBITER'], from: ['DISPUTED'], to: 'ACCEPTED' },
  ARBITER_REFUND: { by: ['ARBITER'], from: ['DISPUTED'], to: 'REFUNDING' },
  // The payee may give up an unreleased milestone (cancellation): funds go to the funder.
  CANCEL_REFUND: {
    by: ['FREELANCER'],
    from: ['FUNDED', 'DELIVERED', 'DISPUTED'],
    to: 'REFUNDING',
  },
};

/** Deal status implied by milestone states after funding. */
export function dealStatusFromMilestones(
  ms: readonly MilestoneState[],
): DealStatus {
  if (ms.some((m) => m.status === 'DISPUTED')) return 'DISPUTED';
  if (ms.every((m) => m.status === 'REFUNDED')) return 'REFUNDED';
  if (ms.every((m) => m.status === 'SETTLED' || m.status === 'REFUNDED'))
    return 'SETTLED';
  if (ms.every((m) => m.status !== 'FUNDED' && m.status !== 'PENDING'))
    return 'DELIVERED';
  if (ms.every((m) => m.status === 'FUNDED')) return 'FUNDED';
  return 'IN_PROGRESS';
}

export const otherParty = (r: PartyRole): PartyRole =>
  r === 'CLIENT' ? 'FREELANCER' : 'CLIENT';
