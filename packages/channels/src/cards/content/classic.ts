import type { CardMoney, CardOf } from '@synq/schemas';
import type { ContentRow, ContentStat, Tone } from './model.js';
import {
  ARROW,
  NONE,
  SEP,
  clip,
  displayAmount,
  moneyAmount,
  moneyFit,
  plural,
  ratio,
  scaled,
  shortHex,
  when,
  words,
} from './text.js';

/*
 * Content of the original six card types (treasury, approval, gift, hotel,
 * DCA mandate, execution receipt).
 */

export type Body = Omit<
  import('./model.js').CardContent,
  | 'type'
  | 'cardId'
  | 'typeLabel'
  | 'network'
  | 'mode'
  | 'actions'
  | 'issuedAt'
  | 'observedAt'
>;

export const row = (
  r: Pick<ContentRow, 'icon' | 'title'> & Partial<ContentRow>,
): ContentRow => ({
  detail: null,
  value: null,
  tone: 'neutral',
  badge: null,
  progress: null,
  highlight: false,
  ...r,
});
export const stat = (
  label: string,
  value: string,
  tone: Tone = 'neutral',
): ContentStat => ({ label, value, tone });

export const headlineMoney = (label: string, m: CardMoney, maxChars = 9) => ({
  label,
  value: displayAmount(moneyAmount(m), maxChars),
  unit: m.symbol,
});
/** Lowest of several prices when they share one currency, else null. */
export function lowest(prices: CardMoney[]): CardMoney | null {
  const first = prices[0];
  if (!first || prices.some((p) => p.symbol !== first.symbol)) return null;
  return prices.reduce((min, p) =>
    scaled(p.amount) < scaled(min.amount) ? p : min,
  );
}
export const fromHeadline = (prices: CardMoney[]) => {
  const min = lowest(prices);
  return min ? headlineMoney('FROM', min) : null;
};
const nonRefundable = (text: string) =>
  /non[- ]?refundable|no refund/i.test(text);

/** Fills option cards up to three rows with the vote tally and the provider. */
export function summaryRows(
  shown: number,
  votes: number,
  provider: string,
  decided: boolean,
): ContentRow[] {
  return [
    row({
      icon: 'vote',
      title: 'Group vote',
      detail: decided ? 'Final pick chosen' : 'Vote for a favourite',
      value: plural(votes, 'vote'),
    }),
    row({
      icon: 'provider',
      title: 'Provider',
      detail: 'Quotes and fulfilment',
      value: clip(provider, 16),
    }),
  ].slice(0, Math.max(0, 3 - shown));
}

const STATUS_TONE: Record<string, Tone> = {
  PENDING: 'pending',
  SATISFIED: 'ok',
  INVALIDATED: 'bad',
  ACTIVE: 'ok',
  PROPOSED: 'pending',
  PAUSED: 'pending',
  REVOKED: 'bad',
  EXPIRED: 'muted',
};

export function treasuryContent(card: CardOf<'GROUP_TREASURY'>): Body {
  const total = card.balance.amount;
  const latest = card.activity[0];
  const members =
    card.memberCount === null
      ? 'members unknown'
      : plural(card.memberCount, 'member');
  return {
    section: 'GROUP FUND',
    title: card.groupLabel,
    subtitle: `${members}${SEP}${card.asOf}`,
    headline: headlineMoney('BALANCE', card.balance, 14),
    status: null,
    rows: [
      row({
        icon: 'balance',
        title: 'Available',
        detail: 'Free to spend with approvals',
        value: moneyFit(card.available, 14),
        progress: ratio(card.available.amount, total),
      }),
      row({
        icon: 'reserve',
        title: 'Reserved',
        detail: 'Held for approved plans',
        value: moneyFit(card.reserved, 14),
        progress: ratio(card.reserved.amount, total),
      }),
      row({
        icon: 'pending',
        title: 'Pending',
        detail: 'Waiting to settle',
        value: moneyFit(card.pending, 14),
        progress: ratio(card.pending.amount, total),
      }),
    ],
    note: latest
      ? `${latest.label}${latest.at ? `${SEP}${latest.at}` : ''}`
      : 'No recent activity',
    stats: [
      stat(
        'MEMBERS',
        card.memberCount === null ? NONE : String(card.memberCount),
      ),
    ],
    refs: [{ label: 'SAFE', value: shortHex(card.account) }],
    art: { slot: 'treasury' },
    grade: 'HOLO_RARE',
  };
}

export function proposalContent(card: CardOf<'APPROVAL_PROPOSAL'>): Body {
  const q = card.quorum;
  const tone = STATUS_TONE[card.status] ?? 'neutral';
  const kind =
    card.proposalKind === 'SEND'
      ? 'Send'
      : card.proposalKind === 'MANDATE'
        ? 'Mandate change'
        : 'Action';
  const first = card.recipient
    ? row({
        icon: 'person',
        title: `To ${card.recipient.label}`,
        detail: card.recipient.address
          ? shortHex(card.recipient.address)
          : 'Recipient',
        value: card.amount ? moneyFit(card.amount, 14) : null,
      })
    : row({
        icon: 'doc',
        title: kind,
        detail: card.amount
          ? 'Amount to authorize'
          : 'No single amount moves with this proposal',
        value: card.amount ? moneyFit(card.amount, 14) : null,
      });
  return {
    section: 'APPROVAL',
    title: `${kind}${card.recipient ? ` to ${card.recipient.label}` : ''}`,
    subtitle: `${kind} proposal${SEP}${plural(q.required, 'signature')} needed${SEP}passkey only`,
    headline: card.amount ? headlineMoney('AMOUNT', card.amount, 14) : null,
    status: { label: `${q.counted} of ${q.required}`, tone },
    rows: [
      first,
      row({
        icon: 'approvals',
        title: 'Approvals',
        detail:
          card.status === 'PENDING'
            ? 'Approve on Synq with your passkey'
            : card.status === 'SATISFIED'
              ? 'Quorum reached'
              : 'Closed before quorum',
        value: `${q.counted} of ${q.required}`,
        progress: Math.min(1, q.counted / q.required),
      }),
      row({
        icon: 'status',
        title: 'Status',
        detail:
          card.statusReason ??
          (card.status === 'PENDING'
            ? 'Waiting for signatures'
            : card.status === 'SATISFIED'
              ? 'Quorum reached'
              : `${kind} proposal`),
        value: card.status,
        tone,
      }),
    ],
    note: card.reason,
    stats: [stat('QUORUM', `${q.counted}/${q.required}`)],
    refs: [{ label: 'PROPOSAL', value: shortHex(card.proposalId, 8, 4) }],
    art: {
      slot: 'approval',
      count: { lit: q.counted, total: q.required },
      tone: card.status === 'INVALIDATED' ? 'bad' : tone,
    },
    grade: card.status === 'SATISFIED' ? 'RARE' : 'COMMON',
  };
}

export function giftContent(card: CardOf<'GROUP_GIFT'>): Body {
  const ordered = [...card.options].sort(
    (a, b) =>
      Number(b.optionId === card.finalOptionId) -
        Number(a.optionId === card.finalOptionId) || b.votes - a.votes,
  );
  const shown = ordered.slice(0, 3);
  const more = card.options.length - shown.length;
  const pick =
    card.options.find((o) => o.optionId === card.finalOptionId) ?? null;
  const totalVotes = card.options.reduce((s, o) => s + o.votes, 0);
  return {
    section: 'GROUP GIFT',
    title: card.occasion,
    subtitle: `${plural(card.options.length, 'option')}${SEP}via ${card.provider}`,
    headline: pick
      ? headlineMoney('PICK', pick.price, 14)
      : fromHeadline(card.options.map((o) => o.price)),
    status: pick ? { label: 'Final pick', tone: 'ok' } : null,
    rows: [
      ...shown.map((o) =>
        row({
          icon: 'gift',
          title: o.product,
          detail: `${o.delivery}${SEP}${plural(o.votes, 'vote')}`,
          value: moneyFit(o.price, 10),
          highlight: o.optionId === card.finalOptionId,
          badge:
            o.optionId === card.finalOptionId
              ? { label: 'FINAL PICK', tone: 'ok' }
              : null,
        }),
      ),
      ...summaryRows(shown.length, totalVotes, card.provider, !!pick),
    ],
    note:
      more > 0
        ? `+${more} more option${more === 1 ? '' : 's'} to compare${SEP}vote in the group`
        : pick
          ? 'Final pick chosen; the group approves the purchase with passkeys'
          : 'Vote for a favourite; the group approves the purchase with passkeys',
    stats: [stat('OPTIONS', String(card.options.length))],
    refs: card.proposalId
      ? [{ label: 'PROPOSAL', value: shortHex(card.proposalId, 8, 4) }]
      : [],
    art: { slot: 'gift', tone: pick ? 'ok' : 'neutral' },
    grade: pick ? 'RARE' : 'COMMON',
  };
}

export function hotelContent(card: CardOf<'HOTEL_COMPARISON'>): Body {
  const ordered = [...card.options].sort(
    (a, b) =>
      Number(b.optionId === card.preferredOptionId) -
        Number(a.optionId === card.preferredOptionId) ||
      b.preferenceVotes - a.preferenceVotes,
  );
  const shown = ordered.slice(0, 3);
  const more = card.options.length - shown.length;
  const preferred =
    card.options.find((o) => o.optionId === card.preferredOptionId) ?? null;
  return {
    section: 'STAYS',
    title: card.stay,
    subtitle: `Hotel comparison${SEP}${plural(card.options.length, 'stay')}${SEP}via ${card.provider}`,
    headline: preferred
      ? headlineMoney('PICK', preferred.total, 14)
      : fromHeadline(card.options.map((o) => o.total)),
    status: preferred ? { label: 'Preferred', tone: 'ok' } : null,
    rows: [
      ...shown.map((o) => {
        const pick = o.optionId === card.preferredOptionId;
        const warn = !pick && nonRefundable(o.cancellation);
        return row({
          icon: 'hotel',
          title: o.hotel,
          detail: warn ? o.room : `${o.room}${SEP}${o.cancellation}`,
          value: moneyFit(o.total, 9),
          highlight: pick,
          badge: pick
            ? { label: 'PREFERRED', tone: 'ok' }
            : warn
              ? { label: 'Non-refundable', tone: 'bad' }
              : null,
        });
      }),
      ...summaryRows(
        shown.length,
        card.options.reduce((s, o) => s + o.preferenceVotes, 0),
        card.provider,
        !!preferred,
      ),
    ],
    note:
      more > 0
        ? `+${more} more stay${more === 1 ? '' : 's'}${SEP}compare and vote in the group`
        : 'Compare and vote; booking needs passkey approvals',
    stats: [stat('OPTIONS', String(card.options.length))],
    refs: card.proposalId
      ? [{ label: 'PROPOSAL', value: shortHex(card.proposalId, 8, 4) }]
      : [],
    art: { slot: 'hotel' },
    grade: preferred ? 'RARE' : 'COMMON',
  };
}

export function dcaContent(card: CardOf<'DCA_MANDATE'>): Body {
  const r = ratio(card.spent.amount, card.cumulativeLimit.amount);
  const tone = STATUS_TONE[card.status] ?? 'neutral';
  return {
    section: 'DCA MANDATE',
    title: `Buy ${card.asset}`,
    subtitle: `DCA mandate${SEP}${card.frequency}`,
    headline: headlineMoney('PER BUY', card.perExecutionLimit, 14),
    status: { label: card.status, tone },
    rows: [
      row({
        icon: 'chart',
        title: 'Spent',
        detail: `of ${moneyFit(card.cumulativeLimit, 18)} cap`,
        value: moneyFit(card.spent, 14),
        progress: r,
      }),
      row({
        icon: 'coin',
        title: 'Per execution',
        detail: card.frequency,
        value: moneyFit(card.perExecutionLimit, 14),
      }),
      row({
        icon: 'calendar',
        title: 'Next execution',
        detail:
          card.status === 'ACTIVE' && card.nextExecutionAt !== null
            ? when(card.nextExecutionAt)
            : 'None scheduled',
        value: card.status,
        tone,
      }),
    ],
    note: `Mandate ${card.mandateId}${card.status === 'ACTIVE' || card.status === 'PAUSED' ? `${SEP}pause or revoke from Synq` : ''}`,
    stats: [stat('STATUS', card.status, tone)],
    refs: [{ label: 'MANDATE', value: clip(card.mandateId, 20) }],
    art: { slot: 'dca', progress: r, tone },
    grade: card.status === 'ACTIVE' ? 'RARE' : 'COMMON',
  };
}

const RECEIPT_TONE: Record<CardOf<'EXECUTION_RECEIPT'>['status'], Tone> = {
  CONFIRMED: 'ok',
  RECONCILED: 'ok',
  SUBMITTED: 'pending',
  FAILED: 'bad',
  REFUNDED: 'pending',
};

export function receiptContent(card: CardOf<'EXECUTION_RECEIPT'>): Body {
  const tone = RECEIPT_TONE[card.status];
  const ref = card.transactionHash
    ? { name: 'Transaction', value: shortHex(card.transactionHash, 10, 8) }
    : card.orderId
      ? {
          name: 'Order',
          value:
            card.orderId.length > 20
              ? shortHex(card.orderId, 8, 6)
              : card.orderId,
        }
      : null;
  const settled = card.settlementStatus === 'SETTLED';
  const done = card.status === 'CONFIRMED' || card.status === 'RECONCILED';
  return {
    section: 'RECEIPT',
    title: card.status.charAt(0) + card.status.slice(1).toLowerCase(),
    subtitle: `Execution receipt${SEP}${card.subjectId}`,
    headline: null,
    status: { label: card.status, tone },
    rows: [
      row({
        icon: 'tx',
        title: ref ? ref.name : 'Reference',
        detail: ref ? 'Shortened; full id in the caption' : 'No reference yet',
        value: ref ? ref.value : NONE,
      }),
      row({
        icon: 'settlement',
        title: 'Settlement',
        detail: settled ? 'Funds settled' : 'Settlement state',
        value: words(card.settlementStatus),
        tone: settled ? 'ok' : 'neutral',
      }),
      row({
        icon: 'status',
        title: 'Status',
        detail: card.explorerUrl
          ? 'Verifiable on the explorer'
          : 'Execution status',
        value: card.status,
        tone,
      }),
    ],
    note: card.label,
    stats: [],
    refs: ref ? [{ label: ref.name.toUpperCase(), value: ref.value }] : [],
    art: { slot: 'receipt', tone },
    grade: done && settled ? 'HOLO_RARE' : done ? 'RARE' : 'COMMON',
  };
}

/** Route text between two places, e.g. "DEL → GOI". */
export const route = (...stops: string[]) => stops.join(ARROW);
