import {
  EXECUTION_MODE_LABEL,
  type CardMoney,
  type InteractiveCard,
} from '@synq/schemas';
import type {
  ChannelId,
  OutboundCallback,
  OutboundMessage,
} from '../events.js';

/*
 * Renderers only lay out a canonical card. They never compute amounts,
 * decide eligibility or approve: every action is a link to an authenticated
 * page, and the only callback (the refresh button on Telegram and WhatsApp)
 * re-reads canonical state.
 */

const money = (m: CardMoney) => `${m.amount} ${m.symbol}`;
const when = (seconds: number) =>
  new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
export const CHAT_NEVER_APPROVES =
  'Approve only on the Synq page with your passkey. Chat replies and buttons never approve.';

const RECEIPT_VERB = {
  SUBMITTED: 'Submitted',
  CONFIRMED: 'Confirmed',
  RECONCILED: 'Reconciled',
  FAILED: 'Failed',
  REFUNDED: 'Refunded',
} as const;

export function cardTitle(card: InteractiveCard): string {
  switch (card.type) {
    case 'GROUP_TREASURY':
      return `${card.groupLabel} treasury`;
    case 'APPROVAL_PROPOSAL':
      return card.status === 'PENDING'
        ? `Approval needed for ${card.reason}`
        : card.status === 'SATISFIED'
          ? `Quorum reached for ${card.reason}`
          : `${card.reason} is no longer valid`;
    case 'GROUP_GIFT':
      return `Group gift: ${card.occasion}`;
    case 'HOTEL_COMPARISON':
      return `Hotels: ${card.stay}`;
    case 'DCA_MANDATE':
      return `DCA ${card.asset}: ${card.status.toLowerCase()}`;
    case 'EXECUTION_RECEIPT':
      return `${RECEIPT_VERB[card.status]} [${card.executionMode}]: ${card.label}`;
  }
}

/** Plain lines shared by every text surface. */
export function cardLines(card: InteractiveCard): string[] {
  switch (card.type) {
    case 'GROUP_TREASURY':
      return [
        `Balance: ${money(card.balance)}`,
        `Available: ${money(card.available)} · Reserved: ${money(card.reserved)} · Pending: ${money(card.pending)}`,
        ...(card.memberCount !== null ? [`Members: ${card.memberCount}`] : []),
        `Account ${card.account} on chain ${card.chainId} (${card.asOf})`,
        ...card.activity.map((a) => `· ${a.label}${a.at ? ` (${a.at})` : ''}`),
      ];
    case 'APPROVAL_PROPOSAL':
      return [
        ...(card.amount ? [`Amount: ${money(card.amount)}`] : []),
        ...(card.recipient
          ? [
              `Recipient: ${card.recipient.label}${card.recipient.address ? ` (${card.recipient.address})` : ''}`,
            ]
          : []),
        `Kind: ${card.proposalKind.toLowerCase()}`,
        `Quorum: ${card.quorum.counted}/${card.quorum.required} verified ${card.proposalKind === 'MANDATE' ? 'passkey owner' : 'passkey'} approvals`,
        ...(card.statusReason ? [`Reason: ${card.statusReason}`] : []),
        ...(card.status === 'PENDING' ? [CHAT_NEVER_APPROVES] : []),
        ...(card.status === 'INVALIDATED' ? ['Nothing will execute.'] : []),
      ];
    case 'GROUP_GIFT':
      return [
        ...card.options.map(
          (o) =>
            `${o.optionId === card.finalOptionId ? '★ ' : '· '}${o.product}: ${money(o.price)}, ${o.delivery} (${o.votes} votes)`,
        ),
        `Provider: ${card.provider} [${EXECUTION_MODE_LABEL[card.executionMode]}]`,
        ...(card.proposalId ? [CHAT_NEVER_APPROVES] : []),
      ];
    case 'HOTEL_COMPARISON':
      return [
        ...card.options.map(
          (o) =>
            `${o.optionId === card.preferredOptionId ? '★ ' : '· '}${o.hotel}, ${o.room}: ${money(o.total)} total; ${o.cancellation} (${o.preferenceVotes} prefer)`,
        ),
        `Provider: ${card.provider} [${EXECUTION_MODE_LABEL[card.executionMode]}]`,
        ...(card.proposalId ? [CHAT_NEVER_APPROVES] : []),
      ];
    case 'DCA_MANDATE':
      return [
        `Asset: ${card.asset}, ${card.frequency}`,
        `Per execution: ${money(card.perExecutionLimit)} · Limit: ${money(card.cumulativeLimit)} · Spent: ${money(card.spent)}`,
        `Next execution: ${card.nextExecutionAt === null ? 'none scheduled' : when(card.nextExecutionAt)}`,
      ];
    case 'EXECUTION_RECEIPT':
      return [
        `Status: ${card.status} · Settlement: ${card.settlementStatus}`,
        `Mode: [${card.executionMode}] ${EXECUTION_MODE_LABEL[card.executionMode]}`,
        ...(card.transactionHash ? [`tx ${card.transactionHash}`] : []),
        ...(card.orderId ? [`order ${card.orderId}`] : []),
      ];
  }
}

export function primaryAction(card: InteractiveCard) {
  return (
    card.actions.find((a) => a.style === 'PRIMARY') ?? card.actions[0] ?? null
  );
}

/** Callback data for the read-only refresh button (≤ 64 bytes, Telegram and WhatsApp). */
export function refreshCallbackData(card: InteractiveCard): string | null {
  if (card.type !== 'APPROVAL_PROPOSAL' || card.status !== 'PENDING')
    return null;
  const hex = /^0x([0-9a-fA-F]{48})/.exec(card.proposalId)?.[1];
  return hex ? `r:${hex.toLowerCase()}` : null;
}
export const REFRESH_CALLBACK = /^r:([0-9a-f]{48})$/;

/** Telegram: text plus an inline keyboard of URL buttons and a refresh callback. */
export function renderTelegramCard(card: InteractiveCard): OutboundMessage {
  const refresh = refreshCallbackData(card);
  const callbacks: OutboundCallback[] = refresh
    ? [{ label: 'Refresh status', data: refresh }]
    : [];
  return {
    text: [cardTitle(card), ...cardLines(card)].join('\n').slice(0, 4000),
    buttons: card.actions.map((a) => ({ label: a.label, url: a.url })),
    ...(callbacks.length ? { callbacks } : {}),
    card,
  };
}

/**
 * WhatsApp (1:1 only): the review link becomes a CTA URL button and the
 * read-only refresh a reply button; neither can approve.
 */
export function renderWhatsAppCard(card: InteractiveCard): OutboundMessage {
  return renderTelegramCard(card);
}

/** iMessage without the Synq extension: one text bubble ending in a single link. */
export function renderIMessageFallback(card: InteractiveCard): OutboundMessage {
  const action = primaryAction(card);
  return {
    text: [
      cardTitle(card),
      ...cardLines(card),
      ...(action ? [`${action.label}: ${action.url}`] : []),
    ]
      .join('\n')
      .slice(0, 4000),
    card,
  };
}

/**
 * Bridge rich link: a summary bubble, then the bare URL in its own bubble so
 * Messages builds a link preview. The preview page's metadata is generic and
 * contains no financial details.
 */
export function renderBridgeRichLink(card: InteractiveCard): {
  text: string;
  url: string | null;
  preview: { title: string; summary: string };
} {
  const action = primaryAction(card);
  return {
    text: [cardTitle(card), ...cardLines(card)].join('\n').slice(0, 4000),
    url: action?.url ?? null,
    preview: {
      title: 'Synq',
      summary:
        card.type === 'APPROVAL_PROPOSAL'
          ? 'Review a group proposal. Sign in to see details.'
          : 'Open in Synq.',
    },
  };
}

/** Plain text for channels without buttons. */
export function renderPlainCard(card: InteractiveCard): OutboundMessage {
  return renderIMessageFallback(card);
}

export function renderCardForChannel(
  channel: ChannelId,
  card: InteractiveCard,
): OutboundMessage {
  switch (channel) {
    case 'telegram':
      return renderTelegramCard(card);
    case 'whatsapp':
      return renderWhatsAppCard(card);
    case 'linq':
    case 'imessage':
      return renderIMessageFallback(card);
    default:
      return renderPlainCard(card);
  }
}

export const NATIVE_CARD_SCHEMA = 'synq.native-card/v1' as const;
export type NativeCardPayload = {
  schema: typeof NATIVE_CARD_SCHEMA;
  card: InteractiveCard;
  layout: {
    caption: string;
    subcaption: string | null;
    trailingCaption: string | null;
    trailingSubcaption: string | null;
    imageTitle: string | null;
    imageSubtitle: string | null;
  };
  /** Page the extension opens (via the system browser / universal link); it authenticates the member. */
  openUrl: string | null;
  /**
   * Value for MSMessage.url. Recipients without the extension (and macOS)
   * open it in a browser, so it is the web fallback; the embedded card is a
   * display hint only and the page never trusts it.
   */
  messageUrl: string | null;
};

const MAX_NATIVE_URL = 4096;

/** JSON for the native Messages extension's MSMessageLiveLayout/TemplateLayout. */
export function renderNativeLiveLayout(
  card: InteractiveCard,
): NativeCardPayload {
  const action = primaryAction(card);
  const lines = cardLines(card);
  const trailing =
    card.type === 'APPROVAL_PROPOSAL'
      ? `${card.quorum.counted}/${card.quorum.required}`
      : card.type === 'GROUP_TREASURY'
        ? money(card.balance)
        : card.type === 'EXECUTION_RECEIPT'
          ? card.executionMode
          : null;
  let messageUrl: string | null = null;
  if (action) {
    const sep = action.url.includes('?') ? '&' : '?';
    const encoded = Buffer.from(JSON.stringify(card)).toString('base64url');
    const candidate = `${action.url}${sep}card=${encoded}`;
    messageUrl = candidate.length <= MAX_NATIVE_URL ? candidate : action.url;
  }
  return {
    schema: NATIVE_CARD_SCHEMA,
    card,
    layout: {
      caption: cardTitle(card).slice(0, 120),
      subcaption: lines[0]?.slice(0, 120) ?? null,
      trailingCaption: trailing,
      trailingSubcaption:
        card.type === 'APPROVAL_PROPOSAL' ? 'approvals' : null,
      imageTitle: card.groupLabel.slice(0, 60),
      imageSubtitle: 'Synq',
    },
    openUrl: action?.url ?? null,
    messageUrl,
  };
}
