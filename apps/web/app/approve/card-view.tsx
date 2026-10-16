import {
  CARD_EXECUTION_MODE_LABEL,
  EXECUTION_MODE_LABEL,
  isArcCard,
  type ArcCard,
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

/** Facts of an Arc-era card, then its network, mode and freshness. */
function arcRows(card: ArcCard) {
  const facts: [string, string][] = (() => {
    switch (card.type) {
      case 'DEAL_PROPOSAL':
        return [
          ['Deal', `${card.title} (v${card.version}, ${card.status})`],
          ['Total', money(card.total)],
          [
            'Client',
            `${card.client.label} ${card.client.address} ${card.signatures.client}`,
          ],
          [
            'Freelancer',
            `${card.freelancer.label} ${card.freelancer.address} ${card.signatures.freelancer}`,
          ],
          ['Terms hash', card.termsHash],
        ];
      case 'ESCROW_MILESTONE':
        return [
          [
            'Milestone',
            `${card.milestoneIndex + 1}/${card.milestoneCount} ${card.title}`,
          ],
          ['Amount', money(card.amount)],
          ['State', card.state],
          ['Terms hash', card.termsHash],
          ...card.transactions.map((t): [string, string] => [t.label, t.hash]),
        ];
      case 'INVOICE':
        return [
          ['Invoice', `${card.number} v${card.version} (${card.status})`],
          ['Total', money(card.total)],
          ['Paid', money(card.paid)],
          ['Due', `${money(card.due)} by ${card.dueDate}`],
          ...(card.paymentRef
            ? [['Memo reference', card.paymentRef] as [string, string]]
            : []),
        ];
      case 'RISK_HOLD':
        return [
          ['Case', `${card.caseId} (${card.state})`],
          [
            'Subject',
            `${card.subject.label}${card.subject.address ? ` ${card.subject.address}` : ''}`,
          ],
          ...card.flags.map((f): [string, string] => [
            `${f.severity} ${f.code}`,
            f.detail,
          ]),
          ['Clears with', card.clearedBy],
        ];
      case 'AGENT_RECOMMENDATION':
        return [
          ...card.roles.map((r): [string, string] => [
            r.persona,
            `${r.stance}: ${r.summary}`,
          ]),
          ['Decision (Kernel)', card.decision.outcome],
        ];
      case 'CONTRACTOR_PAYMENT':
        return [
          [
            'Pay',
            `${money(card.amount)} to ${card.recipient.label} ${card.recipient.address}`,
          ],
          ['Verified payout address', card.recipient.verified ? 'yes' : 'NO'],
          ['Approvals', `${card.approvals.counted}/${card.approvals.required}`],
          ['Status', card.status],
          ...(card.transactionHash
            ? [['Transaction', card.transactionHash] as [string, string]]
            : []),
        ];
      case 'FLIGHT_COMPARISON':
        return [
          [
            'Route',
            `${card.origin} to ${card.destination}${card.returnDate ? ' and back' : ''}`,
          ],
          ...card.options.map((o): [string, string] => [
            o.optionId === card.preferredOptionId ? 'Preferred' : 'Option',
            `${o.carrier}: ${money(o.price)}, ${o.refundable ? 'refundable' : 'non-refundable'}, ${o.votes} votes`,
          ]),
        ];
    }
  })();
  return (
    <>
      {facts.map(([k, v], i) => (
        <Row key={i} k={k} v={v} />
      ))}
      <Row
        k="Network"
        v={card.chainId === null ? 'Off-chain' : `chain ${card.chainId}`}
      />
      <Row
        k="Mode"
        v={`[${card.executionMode}] ${CARD_EXECUTION_MODE_LABEL[card.executionMode]}`}
      />
      <Row k="Observed" v={new Date(card.observedAt * 1000).toISOString()} />
    </>
  );
}

function rows(card: InteractiveCard) {
  if (isArcCard(card)) return arcRows(card);
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
