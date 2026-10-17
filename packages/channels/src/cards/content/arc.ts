import type { ArcCard, CardOf } from '@synq/schemas';
import {
  fromHeadline,
  headlineMoney,
  row,
  route,
  stat,
  type Body,
} from './classic.js';
import type { ContentRow, Tone } from './model.js';
import {
  NONE,
  SEP,
  ageLabel,
  clip,
  dayLabel,
  moneyFit,
  plural,
  ratio,
  sentence,
  shortHex,
  when,
  words,
} from './text.js';

/*
 * Content of the Arc-era cards: deal, escrow milestone, invoice, risk hold,
 * agent council, contractor payment and flight comparison. Hashes and
 * addresses are shortened; full values stay in the caption.
 */

const SIG_TONE = { SIGNED: 'ok', PENDING: 'pending', DECLINED: 'bad' } as const;

const DEAL_TONE: Record<CardOf<'DEAL_PROPOSAL'>['status'], Tone> = {
  DRAFT: 'pending',
  NEGOTIATING: 'pending',
  ACCEPTED: 'ok',
  FUNDING: 'pending',
  FUNDED: 'ok',
  IN_PROGRESS: 'ok',
  DELIVERED: 'ok',
  DISPUTED: 'bad',
  SETTLED: 'ok',
  REFUNDED: 'pending',
  CANCELLED: 'muted',
  EXPIRED: 'muted',
  NEEDS_REVIEW: 'bad',
};

function dealContent(card: CardOf<'DEAL_PROPOSAL'>): Body {
  const s = card.signatures;
  const both = s.client === 'SIGNED' && s.freelancer === 'SIGNED';
  const active = [
    'ACCEPTED',
    'FUNDING',
    'FUNDED',
    'IN_PROGRESS',
    'DELIVERED',
  ].includes(card.status);
  const tone = DEAL_TONE[card.status];
  const party = (
    role: 'Client' | 'Freelancer',
    p: CardOf<'DEAL_PROPOSAL'>['client'],
    sig: keyof typeof SIG_TONE,
  ) =>
    row({
      icon: 'signature',
      title: p.label,
      detail: `${role}${SEP}${shortHex(p.address)}`,
      value: sig,
      tone: SIG_TONE[sig],
      badge: { label: role.toUpperCase(), tone: 'neutral' },
    });
  return {
    section: 'DEAL ROOM',
    title: card.title,
    subtitle: `Version ${card.version}${SEP}${plural(card.milestoneCount, 'milestone')}${SEP}${[s.client, s.freelancer].filter((x) => x === 'SIGNED').length} of 2 signed`,
    headline: headlineMoney('TOTAL', card.total, 14),
    status: { label: words(card.status), tone },
    rows: [
      party('Client', card.client, s.client),
      party('Freelancer', card.freelancer, s.freelancer),
      row({
        icon: 'status',
        title: 'Status',
        detail: both
          ? card.escrow
            ? `Escrow ${shortHex(card.escrow)}`
            : 'Both parties signed this exact version'
          : 'Each party signs this version in their own wallet',
        value: words(card.status),
        tone,
      }),
    ],
    note: both
      ? `${moneyFit(card.total, 22)} held in escrow across ${plural(card.milestoneCount, 'milestone')}; each release needs the client or the arbiter`
      : `Nothing is agreed until both parties sign version ${card.version}${card.expiresAt ? `; the offer lapses ${when(card.expiresAt)}` : ''}`,
    stats: [stat('VERSION', `v${card.version}`)],
    refs: [
      { label: 'TERMS', value: shortHex(card.termsHash) },
      { label: 'DEAL', value: clip(card.dealId, 18) },
    ],
    art: {
      slot: 'deal',
      count: {
        lit: [s.client, s.freelancer].filter((x) => x === 'SIGNED').length,
        total: 2,
      },
      nodes: [SIG_TONE[s.client], SIG_TONE[s.freelancer]],
      tone: both ? 'ok' : tone,
    },
    grade: card.status === 'SETTLED' ? 'HOLO_RARE' : active ? 'RARE' : 'COMMON',
  };
}

const MILESTONE_TONE: Record<CardOf<'ESCROW_MILESTONE'>['state'], Tone> = {
  PENDING: 'muted',
  FUNDED: 'info',
  DELIVERED: 'info',
  ACCEPTED: 'ok',
  RELEASED: 'ok',
  DISPUTED: 'bad',
  REFUNDING: 'pending',
  REFUNDED: 'pending',
};
const MILESTONE_DETAIL: Record<CardOf<'ESCROW_MILESTONE'>['state'], string> = {
  PENDING: 'Not funded yet',
  FUNDED: 'Funds locked in the escrow',
  DELIVERED: 'Delivered; waiting for the client to accept',
  ACCEPTED: 'Accepted; release pending on chain',
  RELEASED: 'Released to the freelancer',
  DISPUTED: 'Disputed; the arbiter decides',
  REFUNDING: 'Refund authorized; pending on chain',
  REFUNDED: 'Refunded to the client',
};

function escrowContent(card: CardOf<'ESCROW_MILESTONE'>): Body {
  const tone = MILESTONE_TONE[card.state];
  const tx = card.transactions.at(-1) ?? null;
  return {
    section: 'ESCROW MILESTONE',
    title: card.title,
    subtitle: `Milestone ${card.milestoneIndex + 1} of ${card.milestoneCount}${SEP}${card.escrowDealId === null ? 'escrow not opened' : `escrow deal #${clip(card.escrowDealId, 12)}`}`,
    headline: headlineMoney('AMOUNT', card.amount, 14),
    status: { label: card.state, tone },
    rows: [
      row({
        icon: 'status',
        title: 'State',
        detail: MILESTONE_DETAIL[card.state],
        value: card.state,
        tone,
        progress: (card.milestoneIndex + 1) / card.milestoneCount,
      }),
      row({
        icon: 'evidence',
        title: 'Evidence',
        detail: card.evidence
          ? card.evidence.label
          : 'No delivery evidence yet',
        value: card.evidence ? shortHex(card.evidence.hash) : NONE,
        badge: card.evidence
          ? { label: words(card.evidence.type), tone: 'neutral' }
          : null,
      }),
      tx
        ? row({
            icon: 'tx',
            title: tx.label,
            detail: 'Shortened; full hash in the caption',
            value: shortHex(tx.hash),
          })
        : row({
            icon: 'calendar',
            title: 'Due',
            detail: when(card.deadline),
            value: NONE,
          }),
    ],
    note:
      card.state === 'DISPUTED' && card.disputeDeadline !== null
        ? `Dispute window closes ${when(card.disputeDeadline)}; until then release and timeout refunds are frozen`
        : `Due ${when(card.deadline)}${SEP}terms ${shortHex(card.termsHash)}`,
    stats: [
      stat('MILESTONE', `${card.milestoneIndex + 1}/${card.milestoneCount}`),
    ],
    refs: [
      { label: 'TERMS', value: shortHex(card.termsHash) },
      ...(card.escrow
        ? [{ label: 'ESCROW', value: shortHex(card.escrow) }]
        : []),
    ],
    art: {
      slot: 'escrow',
      count: { lit: card.milestoneIndex, total: card.milestoneCount },
      tone,
    },
    grade:
      card.state === 'RELEASED'
        ? 'HOLO_RARE'
        : ['FUNDED', 'DELIVERED', 'ACCEPTED'].includes(card.state)
          ? 'RARE'
          : 'COMMON',
  };
}

const INVOICE_TONE: Record<CardOf<'INVOICE'>['status'], Tone> = {
  DRAFT: 'muted',
  ISSUED: 'pending',
  PARTIAL: 'pending',
  PAID: 'ok',
  OVERPAID: 'pending',
  VOID: 'muted',
};

function invoiceContent(card: CardOf<'INVOICE'>): Body {
  const r = ratio(card.paid.amount, card.total.amount);
  const tone = INVOICE_TONE[card.status];
  const over = card.status === 'OVERPAID';
  const paid = card.status === 'PAID';
  return {
    section: 'INVOICE',
    title: `Invoice ${card.number}`,
    subtitle: `Version ${card.version}${SEP}to ${clip(card.payer, 28)}${SEP}due ${card.dueDate}`,
    headline: paid
      ? headlineMoney('PAID', card.paid, 14)
      : headlineMoney('DUE', card.due, 14),
    status: { label: card.status, tone },
    rows: [
      row({
        icon: 'doc',
        title: 'Total',
        detail: `From ${card.issuer.label}${SEP}${shortHex(card.issuer.address)}`,
        value: moneyFit(card.total, 14),
      }),
      row({
        icon: 'coin',
        title: 'Paid',
        detail: `${plural(card.paymentCount, 'payment')} matched by Memo reference`,
        value: moneyFit(card.paid, 14),
        progress: r,
      }),
      over
        ? row({
            icon: 'flag',
            title: 'Overpaid',
            detail: 'Owed back to the payer as a refund',
            value: moneyFit(card.overpaid, 14),
            tone: 'pending',
          })
        : row({
            icon: 'status',
            title: 'Amount due',
            detail: `Status ${card.status}`,
            value: moneyFit(card.due, 14),
            tone,
          }),
    ],
    note: card.paymentRef
      ? `Pay only through the Synq link; Memo reference ${shortHex(card.paymentRef, 10, 6)} binds the payment to version ${card.version}`
      : card.status === 'VOID'
        ? 'Void: this invoice can no longer be paid'
        : 'Draft: not payable until the issuer signs the exact terms',
    stats: [stat('STATUS', card.status, tone)],
    refs: [
      ...(card.paymentRef
        ? [{ label: 'MEMO', value: shortHex(card.paymentRef) }]
        : []),
      ...(card.lastPaymentTx
        ? [{ label: 'TX', value: shortHex(card.lastPaymentTx) }]
        : []),
    ],
    art: { slot: 'invoice', progress: r, tone },
    grade: paid
      ? 'HOLO_RARE'
      : card.status === 'PARTIAL' || over
        ? 'RARE'
        : 'COMMON',
  };
}

const CASE_TONE: Record<CardOf<'RISK_HOLD'>['state'], Tone> = {
  HELD: 'bad',
  IN_REVIEW: 'pending',
  APPEALED: 'pending',
  BLOCKED: 'bad',
  RELEASED: 'ok',
  RESOLVED: 'ok',
};

function riskContent(card: CardOf<'RISK_HOLD'>): Body {
  const resolved = card.state === 'RELEASED' || card.state === 'RESOLVED';
  const hard = card.flags.filter((f) => f.severity === 'HARD').length;
  const soft = card.flags.length - hard;
  const ordered = [...card.flags].sort(
    (a, b) => Number(b.severity === 'HARD') - Number(a.severity === 'HARD'),
  );
  const shown = ordered.slice(0, 2);
  const more = card.flags.length - shown.length;
  const tone = CASE_TONE[card.state];
  const flagRows: ContentRow[] = shown.map((f) =>
    row({
      icon: 'flag',
      title: sentence(f.code),
      detail: f.detail,
      badge:
        f.severity === 'HARD'
          ? { label: 'HARD', tone: 'bad' }
          : { label: 'SOFT', tone: 'pending' },
    }),
  );
  if (!flagRows.length)
    flagRows.push(
      row({
        icon: 'person',
        title: card.subject.label,
        detail: card.subject.address
          ? `${sentence(card.subject.kind)}${SEP}${shortHex(card.subject.address)}`
          : sentence(card.subject.kind),
      }),
    );
  return {
    section: resolved ? 'RISK CASE' : 'RISK HOLD',
    title: resolved
      ? `Cleared: ${card.subject.label}`
      : `Hold: ${card.subject.label}`,
    subtitle: `${hard} hard${SEP}${plural(soft, 'soft flag')}${more > 0 ? `${SEP}+${more} more` : ''}${SEP}${plural(card.alertCount, 'alert')}`,
    headline: card.amount
      ? headlineMoney(resolved ? 'AMOUNT' : 'HELD', card.amount, 14)
      : { label: 'FLAGS', value: String(card.flags.length), unit: null },
    status: { label: words(card.state), tone },
    rows: [
      ...flagRows,
      row({
        icon: 'shield',
        title: resolved ? 'Cleared by' : 'Clears with',
        detail: card.clearedBy,
        value: words(card.state),
        tone,
      }),
    ],
    note: `${sentence(card.subject.kind)} ${card.subject.address ? shortHex(card.subject.address) : card.subject.label} ${resolved ? 'released' : 'frozen'} since ${when(card.openedAt)}${resolved ? '' : '; no payout runs while the hold stands'}`,
    stats: [stat('CASE', words(card.state), tone)],
    refs: [
      { label: 'CASE', value: shortHex(card.caseId, 10, 4) },
      { label: 'REV', value: String(card.revision) },
    ],
    art: { slot: 'risk', tone: resolved ? 'ok' : hard ? 'bad' : 'pending' },
    grade: resolved ? 'COMMON' : 'WARNING',
  };
}

const STANCE_TONE: Record<
  CardOf<'AGENT_RECOMMENDATION'>['roles'][number]['stance'],
  Tone
> = {
  PAY: 'ok',
  CLEAR: 'ok',
  HOLD: 'pending',
  REVIEW: 'pending',
  VETO: 'bad',
  INFO: 'info',
  UNAVAILABLE: 'muted',
};
const OUTCOME: Record<
  CardOf<'AGENT_RECOMMENDATION'>['decision']['outcome'],
  { label: string; tone: Tone; detail: string }
> = {
  ALLOW: { label: 'ALLOW', tone: 'ok', detail: 'Within the signed mandate' },
  NEEDS_APPROVAL: {
    label: 'NEEDS APPROVAL',
    tone: 'pending',
    detail: 'The owner signs in their wallet',
  },
  DENY: { label: 'DENY', tone: 'bad', detail: 'Refused by policy' },
  NOT_SUBMITTED: {
    label: 'NOT SUBMITTED',
    tone: 'muted',
    detail: 'No payout was prepared',
  },
};
const PERSONA_NAME: Record<
  CardOf<'AGENT_RECOMMENDATION'>['roles'][number]['persona'],
  string
> = {
  CFO: 'CFO',
  RISK: 'Risk',
  PAYMENT: 'Payment',
  AUDIT: 'Audit',
  INVOICE: 'Invoice',
  DEAL: 'Deal',
  COMMERCE: 'Commerce',
  TRAVEL: 'Travel',
  RESEARCH: 'Research',
};

function agentContent(card: CardOf<'AGENT_RECOMMENDATION'>): Body {
  const o = OUTCOME[card.decision.outcome];
  const shown = card.roles.slice(0, 3);
  const more = card.roles.length - shown.length;
  const ev = card.evidence;
  return {
    section: 'AGENT COUNCIL',
    title: card.counterparty ? `Pay ${card.counterparty}?` : 'Team answer',
    subtitle: `${plural(card.roles.length, 'role')}${SEP}${plural(ev.facts, 'fact')}${SEP}${plural(ev.inferences, 'inference')}${more > 0 ? `${SEP}+${more} more` : ''}`,
    headline: card.amount ? headlineMoney('AMOUNT', card.amount, 14) : null,
    status: { label: o.label, tone: o.tone },
    rows: [
      ...shown.map((r) =>
        row({
          icon: 'agent',
          title: PERSONA_NAME[r.persona],
          detail: r.summary,
          value: r.stance,
          tone: STANCE_TONE[r.stance],
          badge: r.citations
            ? { label: plural(r.citations, 'cite'), tone: 'neutral' }
            : null,
        }),
      ),
      row({
        icon: 'kernel',
        title: 'Decision (Kernel)',
        detail: card.decision.reasons[0] ?? o.detail,
        value: o.label,
        tone: o.tone,
        highlight: true,
      }),
    ],
    note: 'The Kernel decides from structured data; a chat reply never approves',
    stats: [
      stat(
        'OLDEST FACT',
        ev.oldestFactSeconds === null ? NONE : ageLabel(ev.oldestFactSeconds),
      ),
    ],
    refs: [
      { label: 'RUN', value: clip(card.runId, 18) },
      ...(card.riskCaseId
        ? [{ label: 'CASE', value: shortHex(card.riskCaseId, 10, 4) }]
        : []),
    ],
    art: {
      slot: 'agent',
      nodes: card.roles.map((r) => STANCE_TONE[r.stance]),
      tone: o.tone,
    },
    grade: card.decision.outcome === 'ALLOW' ? 'RARE' : 'COMMON',
  };
}

const PAYMENT_TONE: Record<CardOf<'CONTRACTOR_PAYMENT'>['status'], Tone> = {
  PROPOSED: 'pending',
  AWAITING_APPROVAL: 'pending',
  APPROVED: 'ok',
  SUBMITTED: 'pending',
  CONFIRMED: 'ok',
  FAILED: 'bad',
  DENIED: 'bad',
};
const ROUTE = {
  VAULT_POLICY_PAY: {
    label: 'Vault policy',
    note: 'Paid from the vault through policy.pay; the policy re-checks recipient, mandate and limits on chain',
  },
  SAFE_QUORUM_TRANSFER: {
    label: 'Full owner quorum',
    note: 'Above the operator budget: every Safe owner signed this exact transfer from the vault',
  },
  AGENT_WALLET: {
    label: 'Agent wallet',
    note: 'Paid from the agent wallet inside its delegated mandate; the Kernel grant names this exact recipient and amount',
  },
};

function contractorContent(card: CardOf<'CONTRACTOR_PAYMENT'>): Body {
  const q = card.approvals;
  const tone = PAYMENT_TONE[card.status];
  return {
    section: 'CONTRACTOR PAYMENT',
    title: `Pay ${card.recipient.label}`,
    subtitle: `${ROUTE[card.route].label}${card.obligationRef ? `${SEP}${clip(card.obligationRef, 26)}` : ''}`,
    headline: headlineMoney('AMOUNT', card.amount, 14),
    status: { label: words(card.status), tone },
    rows: [
      row({
        icon: 'person',
        title: `To ${card.recipient.label}`,
        detail: `${shortHex(card.recipient.address)}${SEP}${card.recipient.verified ? 'vendor master' : 'not in the vendor master'}`,
        value: moneyFit(card.amount, 14),
        badge: card.recipient.verified
          ? { label: 'VERIFIED', tone: 'ok' }
          : { label: 'UNVERIFIED', tone: 'bad' },
      }),
      row({
        icon: 'approvals',
        title: 'Approvals',
        detail: q.required
          ? 'Owner signatures (EIP-712), never chat'
          : 'Within the mandate; no extra signature needed',
        value: q.required ? `${q.counted} of ${q.required}` : 'none',
        progress: q.required ? Math.min(1, q.counted / q.required) : null,
      }),
      row({
        icon: 'tx',
        title: card.transactionHash ? 'Transaction' : 'Status',
        detail: card.transactionHash
          ? shortHex(card.transactionHash, 10, 8)
          : 'No transaction yet',
        value: words(card.status),
        tone,
      }),
    ],
    note: ROUTE[card.route].note,
    stats: [stat('ROUTE', ROUTE[card.route].label)],
    refs: [
      { label: 'INTENT', value: clip(card.paymentId, 18) },
      ...(card.transactionHash
        ? [{ label: 'TX', value: shortHex(card.transactionHash) }]
        : []),
    ],
    art: {
      slot: 'contractor',
      count: { lit: q.counted, total: q.required },
      tone,
    },
    grade:
      card.status === 'CONFIRMED'
        ? 'HOLO_RARE'
        : card.status === 'APPROVED' || card.status === 'SUBMITTED'
          ? 'RARE'
          : 'COMMON',
  };
}

function flightContent(card: CardOf<'FLIGHT_COMPARISON'>): Body {
  const ordered = [...card.options].sort(
    (a, b) =>
      Number(b.optionId === card.preferredOptionId) -
        Number(a.optionId === card.preferredOptionId) || b.votes - a.votes,
  );
  const shown = ordered.slice(0, 3);
  const more = card.options.length - shown.length;
  const preferred =
    card.options.find((o) => o.optionId === card.preferredOptionId) ?? null;
  const round = card.returnDate !== null;
  return {
    section: 'FLIGHTS',
    title: round
      ? route(card.origin, card.destination, card.origin)
      : route(card.origin, card.destination),
    subtitle: `${dayLabel(card.departureDate)}${round ? ` – ${dayLabel(card.returnDate!)}` : ' one way'}${SEP}${plural(card.travelers, 'traveller')}${SEP}${card.cabin}`,
    headline: preferred
      ? headlineMoney('PICK', preferred.price, 14)
      : fromHeadline(card.options.map((o) => o.price)),
    status: preferred ? { label: 'Preferred', tone: 'ok' } : null,
    rows: shown.map((o) => {
      const pick = o.optionId === card.preferredOptionId;
      return row({
        icon: 'flight',
        title: o.carrier,
        detail: [
          o.flights,
          o.stops ? plural(o.stops, 'stop') : 'nonstop',
          o.baggage,
          plural(o.votes, 'vote'),
        ]
          .filter(Boolean)
          .join(SEP),
        value: moneyFit(o.price, 10),
        highlight: pick,
        badge: pick
          ? { label: 'PREFERRED', tone: 'ok' }
          : o.refundable
            ? null
            : { label: 'Non-refundable', tone: 'bad' },
      });
    }),
    note:
      more > 0
        ? `+${more} more option${more === 1 ? '' : 's'}${SEP}compare and vote; the group approves the fare with passkeys`
        : 'Duffel test mode: no real ticket; vote, then the group approves the fare with passkeys',
    stats: [stat('OPTIONS', String(card.options.length))],
    refs: [
      { label: 'TRIP', value: clip(card.tripId, 20) },
      { label: 'VIA', value: clip(card.provider, 20) },
    ],
    art: { slot: 'flight', count: { lit: 1, total: round ? 2 : 1 } },
    grade: preferred ? 'RARE' : 'COMMON',
  };
}

export function arcContent(card: ArcCard): Body {
  switch (card.type) {
    case 'DEAL_PROPOSAL':
      return dealContent(card);
    case 'ESCROW_MILESTONE':
      return escrowContent(card);
    case 'ALLOCATION':
      return {
        section: 'REVENUE ALLOCATION',
        title: 'Incoming payment allocation',
        subtitle: `Policy version ${card.policyVersion}`,
        headline: headlineMoney('RECEIVED', card.received, 14),
        status: {
          label: card.status,
          tone:
            card.status === 'COMPLETED'
              ? 'ok'
              : card.status === 'NEEDS_REVIEW'
                ? 'bad'
                : 'pending',
        },
        rows: [
          row({
            icon: 'settlement',
            title: 'Paid through vault',
            value: moneyFit(card.paid, 14),
          }),
          row({
            icon: 'reserve',
            title: 'Held in vault',
            value: moneyFit(card.held, 14),
          }),
          row({
            icon: 'balance',
            title: 'Unallocated',
            value: moneyFit(card.free, 14),
          }),
        ],
        note: card.note,
        stats: [stat('LEGS', String(card.legs.length))],
        refs: [{ label: 'RECEIPT', value: shortHex(card.receiptTx) }],
        art: {
          slot: 'treasury',
          tone: card.status === 'COMPLETED' ? 'ok' : 'pending',
        },
        grade: card.status === 'COMPLETED' ? 'HOLO_RARE' : 'COMMON',
      };
    case 'INVOICE':
      return invoiceContent(card);
    case 'RISK_HOLD':
      return riskContent(card);
    case 'AGENT_RECOMMENDATION':
      return agentContent(card);
    case 'CONTRACTOR_PAYMENT':
      return contractorContent(card);
    case 'FLIGHT_COMPARISON':
      return flightContent(card);
  }
}
