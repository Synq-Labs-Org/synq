import { isArcCard, type InteractiveCard } from '@synq/schemas';
import { arcContent } from './arc.js';
import {
  dcaContent,
  giftContent,
  hotelContent,
  proposalContent,
  receiptContent,
  treasuryContent,
  type Body,
} from './classic.js';
import type { CardContent } from './model.js';
import { CARD_MODE, cardNetworkLabel, networkMode } from './network.js';

export * from './model.js';
export { CARD_MODE, cardNetworkLabel } from './network.js';
export {
  ageLabel,
  clip,
  dayLabel,
  displayAmount,
  groupDigits,
  shortHex,
  when,
} from './text.js';

export const TYPE_LABEL: Record<InteractiveCard['type'], string> = {
  GROUP_TREASURY: 'GROUP TREASURY',
  APPROVAL_PROPOSAL: 'APPROVAL',
  GROUP_GIFT: 'GROUP GIFT',
  HOTEL_COMPARISON: 'HOTEL COMPARISON',
  DCA_MANDATE: 'DCA MANDATE',
  EXECUTION_RECEIPT: 'RECEIPT',
  DEAL_PROPOSAL: 'DEAL ROOM',
  ESCROW_MILESTONE: 'ESCROW MILESTONE',
  INVOICE: 'INVOICE',
  RISK_HOLD: 'RISK HOLD',
  AGENT_RECOMMENDATION: 'AGENT COUNCIL',
  CONTRACTOR_PAYMENT: 'CONTRACTOR PAYMENT',
  FLIGHT_COMPARISON: 'FLIGHT COMPARISON',
};

export type CardContentOptions = {
  /** Network for cards that do not carry a chain id (default "Monad Testnet"). */
  networkLabel?: string | null;
};

function body(card: InteractiveCard): Body {
  if (isArcCard(card)) return arcContent(card);
  switch (card.type) {
    case 'GROUP_TREASURY':
      return treasuryContent(card);
    case 'APPROVAL_PROPOSAL':
      return proposalContent(card);
    case 'GROUP_GIFT':
      return giftContent(card);
    case 'HOTEL_COMPARISON':
      return hotelContent(card);
    case 'DCA_MANDATE':
      return dcaContent(card);
    case 'EXECUTION_RECEIPT':
      return receiptContent(card);
  }
}

/** The theme-independent description of a card: what every theme draws. */
export function cardContent(
  card: InteractiveCard,
  options: CardContentOptions = {},
): CardContent {
  const network = isArcCard(card)
    ? cardNetworkLabel(card.chainId)
    : card.type === 'GROUP_TREASURY'
      ? cardNetworkLabel(card.chainId)
      : options.networkLabel === undefined
        ? 'Monad Testnet'
        : options.networkLabel;
  const mode =
    isArcCard(card) ||
    card.type === 'GROUP_GIFT' ||
    card.type === 'HOTEL_COMPARISON' ||
    card.type === 'EXECUTION_RECEIPT'
      ? CARD_MODE[card.executionMode]
      : networkMode(network);
  const primary = card.actions.find((a) => a.style === 'PRIMARY');
  return {
    ...body(card),
    type: card.type,
    cardId: card.cardId,
    typeLabel: TYPE_LABEL[card.type],
    network,
    mode,
    chainId:
      isArcCard(card) || card.type === 'GROUP_TREASURY' ? card.chainId : null,
    actions: card.actions.map((a) => ({
      label: a.label,
      primary: a === (primary ?? card.actions[0]),
    })),
    issuedAt: card.issuedAt,
    observedAt: isArcCard(card) ? card.observedAt : null,
  };
}
