import {
  EXECUTION_MODE_LABEL,
  type CardMoney,
  type InteractiveCard,
} from '@synq/schemas';

const money = (m: CardMoney) => `${m.amount} ${m.symbol}`;

/**
 * Web/PWA renderer for canonical Synq cards. Display only: it formats the
 * backend's exact decimal strings and links; it never computes or approves.
 */
export function CardView({
  card,
  showActions = true,
}: {
  card: InteractiveCard;
  showActions?: boolean;
}) {
  return (
    <section className="card" data-testid={`card-${card.type}`}>
      <p className="lead">{card.groupLabel}</p>
      <dl>{rows(card)}</dl>
      {showActions && card.actions.length > 0 && (
        <p>
          {card.actions.map((a) => (
            <a
              key={`${a.kind}:${a.url}`}
              href={a.url}
              rel="noopener noreferrer"
              style={{ marginRight: 12 }}
            >
              {a.label}
            </a>
          ))}
        </p>
      )}
    </section>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <>
      <dt>{k}</dt>
      <dd>{v}</dd>
    </>
  );
}

function rows(card: InteractiveCard) {
  switch (card.type) {
    case 'GROUP_TREASURY':
      return (
        <>
          <Row k="Balance" v={money(card.balance)} />
          <Row k="Available" v={money(card.available)} />
          <Row k="Reserved" v={money(card.reserved)} />
          <Row k="Pending" v={money(card.pending)} />
          {card.memberCount !== null && (
            <Row k="Members" v={String(card.memberCount)} />
          )}
          <Row k="Account" v={`${card.account} (chain ${card.chainId})`} />
          <Row k="As of" v={card.asOf} />
          {card.activity.map((a, i) => (
            <Row key={i} k="Activity" v={`${a.label} ${a.at}`} />
          ))}
        </>
      );
    case 'APPROVAL_PROPOSAL':
      return (
        <>
          <Row k="Proposal" v={card.reason} />
          {card.amount && <Row k="Exact amount" v={money(card.amount)} />}
          {card.recipient && (
            <Row
              k="Recipient"
              v={`${card.recipient.label}${card.recipient.address ? ` (${card.recipient.address})` : ''}`}
            />
          )}
          <Row k="Kind" v={card.proposalKind} />
          <Row
            k="Quorum"
            v={`${card.quorum.counted}/${card.quorum.required} verified approvals`}
          />
          <Row k="Status" v={card.status} />
          {card.statusReason && <Row k="Reason" v={card.statusReason} />}
          <Row k="Proposal id" v={card.proposalId} />
        </>
      );
    case 'GROUP_GIFT':
      return (
        <>
          <Row k="Occasion" v={card.occasion} />
          {card.options.map((o) => (
            <Row
              key={o.optionId}
              k={o.optionId === card.finalOptionId ? 'Final choice' : 'Option'}
              v={`${o.product}: ${money(o.price)}, ${o.delivery}, ${o.votes} votes`}
            />
          ))}
          <Row k="Provider" v={card.provider} />
          <Row k="Mode" v={EXECUTION_MODE_LABEL[card.executionMode]} />
        </>
      );
    case 'HOTEL_COMPARISON':
      return (
        <>
          <Row k="Stay" v={card.stay} />
          {card.options.map((o) => (
            <Row
              key={o.optionId}
              k={o.optionId === card.preferredOptionId ? 'Preferred' : 'Option'}
              v={`${o.hotel}, ${o.room}: ${money(o.total)}; ${o.cancellation}; ${o.preferenceVotes} prefer`}
            />
          ))}
          <Row k="Provider" v={card.provider} />
          <Row k="Mode" v={EXECUTION_MODE_LABEL[card.executionMode]} />
        </>
      );
    case 'DCA_MANDATE':
      return (
        <>
          <Row k="Asset" v={card.asset} />
          <Row k="Frequency" v={card.frequency} />
          <Row k="Per execution" v={money(card.perExecutionLimit)} />
          <Row k="Limit" v={money(card.cumulativeLimit)} />
          <Row k="Spent" v={money(card.spent)} />
          <Row
            k="Next execution"
            v={
              card.nextExecutionAt === null
                ? 'none scheduled'
                : new Date(card.nextExecutionAt * 1000).toISOString()
            }
          />
          <Row k="Status" v={card.status} />
        </>
      );
    case 'EXECUTION_RECEIPT':
      return (
        <>
          <Row k="Receipt" v={card.label} />
          <Row k="Status" v={card.status} />
          <Row k="Settlement" v={card.settlementStatus} />
          <Row
            k="Mode"
            v={`[${card.executionMode}] ${EXECUTION_MODE_LABEL[card.executionMode]}`}
          />
          {card.transactionHash && (
            <Row k="Transaction" v={card.transactionHash} />
          )}
          {card.orderId && <Row k="Order" v={card.orderId} />}
        </>
      );
  }
}
