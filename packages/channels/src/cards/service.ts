import { createHash } from 'node:crypto';
import {
  CARD_SCHEMA,
  ExecutionModeSchema,
  InteractiveCardSchema,
  type CardAction,
  type CardMoney,
  type CardOf,
  type InteractiveCard,
} from '@synq/schemas';
import type {
  ApprovalSummary,
  ReceiptSummary,
  TreasurySummary,
} from '../gateway.js';
import type { CardLinkIssuer } from './links.js';

/** The id a card link carries for an approval: Send/action intent hash, or mandate proposal id. */
export function approvalProposalId(a: ApprovalSummary): string {
  return a.proposalId ?? (a.kind === 'MANDATE' ? a.draftDigest : a.intentHash);
}

type Common = { groupId: string; groupLabel: string };
type GiftInput = Common &
  Pick<
    CardOf<'GROUP_GIFT'>,
    | 'proposalId'
    | 'occasion'
    | 'options'
    | 'finalOptionId'
    | 'provider'
    | 'executionMode'
  > & { votePath?: string };
type HotelInput = Common &
  Pick<
    CardOf<'HOTEL_COMPARISON'>,
    | 'proposalId'
    | 'stay'
    | 'options'
    | 'preferredOptionId'
    | 'provider'
    | 'executionMode'
  > & { votePath?: string };
type DcaInput = Common &
  Pick<
    CardOf<'DCA_MANDATE'>,
    | 'mandateId'
    | 'asset'
    | 'frequency'
    | 'perExecutionLimit'
    | 'cumulativeLimit'
    | 'spent'
    | 'nextExecutionAt'
    | 'status'
  > & { proposalId?: string | null; managePath: string };

/**
 * Builds canonical cards from backend read models. It formats nothing and
 * computes no money: amounts arrive as exact decimal strings. Approval
 * actions point at short-lived, group-bound card links when a link issuer is
 * configured, otherwise at the authenticated review page.
 */
export class InteractiveCardService {
  constructor(
    private readonly options: {
      webBaseUrl: string;
      explorerTxUrl: string;
      now: () => number;
      links?: CardLinkIssuer | null;
    },
  ) {}

  private web(path: string) {
    return `${this.options.webBaseUrl.replace(/\/$/, '')}${path}`;
  }

  private id(...parts: (string | number)[]) {
    return `card_${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24)}`;
  }

  private finish<T extends InteractiveCard>(card: T): T {
    return InteractiveCardSchema.parse(card) as T;
  }

  /** URL a member taps to review (and then approve with a passkey) a proposal. */
  reviewUrl(groupId: string, proposalId: string, fallbackPath: string) {
    return this.options.links
      ? this.options.links.url({ groupId, proposalId, action: 'REVIEW' })
      : this.web(fallbackPath);
  }

  treasury(
    input: Common & {
      treasury: TreasurySummary;
      memberCount?: number | null;
      activity?: { label: string; at: string }[];
    },
  ): CardOf<'GROUP_TREASURY'> {
    const t = input.treasury;
    const m = (amount: string): CardMoney => ({ amount, symbol: t.symbol });
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'GROUP_TREASURY',
      cardId: this.id('treasury', input.groupId, t.asOf, t.total, t.free),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      balance: m(t.total),
      available: m(t.free),
      reserved: m(t.reserved),
      pending: m(t.pending),
      memberCount: input.memberCount ?? null,
      account: t.account,
      chainId: t.chainId,
      asOf: t.asOf,
      activity: (input.activity ?? []).slice(0, 5),
      actions: [],
    });
  }

  approval(input: Common & { approval: ApprovalSummary }) {
    const a = input.approval;
    const proposalId = approvalProposalId(a);
    const path = a.reviewPath ?? `/intents/${a.intentHash}`;
    const actions: CardAction[] =
      a.status === 'PENDING'
        ? [
            {
              kind: 'REVIEW_APPROVE',
              label: 'Review and approve',
              url: this.reviewUrl(input.groupId, proposalId, path),
              style: 'PRIMARY',
            },
            {
              kind: 'REVIEW_REJECT',
              label: 'Review and decline',
              url: this.reviewUrl(input.groupId, proposalId, path),
              style: 'SECONDARY',
            },
          ]
        : [];
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'APPROVAL_PROPOSAL',
      cardId: this.id(
        'approval',
        input.groupId,
        proposalId,
        a.status,
        a.counted,
      ),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      proposalId,
      proposalKind: a.kind ?? 'SEND',
      amount: a.amount ?? null,
      recipient: a.recipient
        ? { label: a.recipient.label, address: a.recipient.address ?? null }
        : null,
      reason: a.label.slice(0, 280),
      quorum: { counted: a.counted, required: a.required },
      status: a.status,
      statusReason: a.reason?.slice(0, 200) ?? null,
      actions,
    });
  }

  gift(input: GiftInput): CardOf<'GROUP_GIFT'> {
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'GROUP_GIFT',
      cardId: this.id(
        'gift',
        input.groupId,
        input.proposalId ?? input.occasion,
        input.finalOptionId ?? '',
        input.options.map((o) => `${o.optionId}:${o.votes}`).join(','),
      ),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      proposalId: input.proposalId,
      occasion: input.occasion,
      options: input.options,
      finalOptionId: input.finalOptionId,
      provider: input.provider,
      executionMode: input.executionMode,
      actions: this.offerActions(
        input.groupId,
        input.proposalId,
        input.votePath,
      ),
    });
  }

  hotel(input: HotelInput): CardOf<'HOTEL_COMPARISON'> {
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'HOTEL_COMPARISON',
      cardId: this.id(
        'hotel',
        input.groupId,
        input.proposalId ?? input.stay,
        input.preferredOptionId ?? '',
        input.options
          .map((o) => `${o.optionId}:${o.preferenceVotes}`)
          .join(','),
      ),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      proposalId: input.proposalId,
      stay: input.stay,
      options: input.options,
      preferredOptionId: input.preferredOptionId,
      provider: input.provider,
      executionMode: input.executionMode,
      actions: this.offerActions(
        input.groupId,
        input.proposalId,
        input.votePath,
      ),
    });
  }

  private offerActions(
    groupId: string,
    proposalId: string | null,
    votePath: string | undefined,
  ): CardAction[] {
    const actions: CardAction[] = [];
    if (votePath)
      actions.push({
        kind: 'VOTE',
        label: 'Vote on the options',
        url: this.web(votePath),
        style: 'SECONDARY',
      });
    if (proposalId)
      actions.unshift({
        kind: 'REVIEW_APPROVE',
        label: 'Review final proposal',
        url: this.reviewUrl(groupId, proposalId, `/intents/${proposalId}`),
        style: 'PRIMARY',
      });
    return actions;
  }

  dca(input: DcaInput): CardOf<'DCA_MANDATE'> {
    const manage = (action: 'pause' | 'revoke') =>
      this.web(
        `${input.managePath}${input.managePath.includes('?') ? '&' : '?'}change=${action}`,
      );
    const actions: CardAction[] = [];
    if (input.status === 'PROPOSED' && input.proposalId)
      actions.push({
        kind: 'REVIEW_APPROVE',
        label: 'Review and approve',
        url: this.reviewUrl(input.groupId, input.proposalId, input.managePath),
        style: 'PRIMARY',
      });
    if (input.status === 'ACTIVE')
      actions.push({
        kind: 'PAUSE',
        label: 'Propose pause',
        url: manage('pause'),
        style: 'SECONDARY',
      });
    if (input.status === 'ACTIVE' || input.status === 'PAUSED')
      actions.push({
        kind: 'REVOKE',
        label: 'Propose revoke',
        url: manage('revoke'),
        style: 'DESTRUCTIVE',
      });
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'DCA_MANDATE',
      cardId: this.id(
        'dca',
        input.groupId,
        input.mandateId,
        input.status,
        input.spent.amount,
      ),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      mandateId: input.mandateId,
      asset: input.asset,
      frequency: input.frequency,
      perExecutionLimit: input.perExecutionLimit,
      cumulativeLimit: input.cumulativeLimit,
      spent: input.spent,
      nextExecutionAt: input.nextExecutionAt,
      status: input.status,
      actions,
    });
  }

  receipt(
    input: Common & {
      receipt: ReceiptSummary;
      orderId?: string | null;
    },
  ): CardOf<'EXECUTION_RECEIPT'> {
    const r = input.receipt;
    const mode = ExecutionModeSchema.safeParse(r.executionMode);
    const explorerUrl = /^0x[0-9a-fA-F]{64}$/.test(r.transactionHash)
      ? `${this.options.explorerTxUrl}${r.transactionHash}`
      : null;
    return this.finish({
      schema: CARD_SCHEMA,
      type: 'EXECUTION_RECEIPT',
      cardId: this.id('receipt', input.groupId, r.intentHash, r.state),
      groupId: input.groupId,
      groupLabel: input.groupLabel,
      issuedAt: this.options.now(),
      subjectId: r.intentHash,
      label: r.label.slice(0, 200),
      status: r.state,
      transactionHash: explorerUrl ? r.transactionHash : null,
      orderId: input.orderId ?? null,
      explorerUrl: explorerUrl?.startsWith('https://') ? explorerUrl : null,
      settlementStatus: r.state === 'RECONCILED' ? 'SETTLED' : 'PENDING',
      // An unknown label is shown as the weakest claim, never a stronger one.
      executionMode: mode.success ? mode.data : 'SIMULATION',
      actions: explorerUrl?.startsWith('https://')
        ? [
            {
              kind: 'EXPLORER',
              label: 'View on explorer',
              url: explorerUrl,
              style: 'SECONDARY',
            },
          ]
        : [],
    });
  }
}
