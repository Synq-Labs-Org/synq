import {
  InteractiveCardSchema,
  arcCardBase,
  cardLine,
  cardRef,
  type ArcCardContext,
  type CardMoney,
  type CardOf,
} from '@synq/schemas';
import { redact } from './audit.js';
import type { RiskCase } from './cases.js';
import { NON_OVERRIDABLE_CODES } from './rules.js';

/*
 * Risk case → RISK_HOLD card. Flags are shown with their human-readable
 * detail after the audit trail's redaction (keys, tokens, passports and card
 * numbers never reach a card), and the card says what clears the hold:
 * policy flags only clear when the facts change, which no reviewer can
 * shortcut.
 */

const ADDRESS = /0x[0-9a-fA-F]{40}/;
const clean = (text: string, max: number) => {
  const r = redact(text).value;
  return cardLine(typeof r === 'string' ? r : '[REDACTED]', max);
};

function clearedBy(c: RiskCase): string {
  if (c.status === 'RELEASED') return 'Released by a human reviewer';
  if (c.status === 'RESOLVED')
    return 'Resolved: the facts changed or the owner signed a resolution';
  if (c.status === 'BLOCKED')
    return 'Blocked by policy; only changed, re-verified facts lift it';
  return c.flags.some((f) => NON_OVERRIDABLE_CODES.has(f.code))
    ? 'Owner signature required after the payout address is re-verified'
    : 'Owner signature, or a human reviewer releases it';
}

export function riskHoldCard(
  riskCase: RiskCase,
  ctx: ArcCardContext & {
    /** Who the hold is about, e.g. the vendor's name; defaults to the address. */
    subjectLabel?: string;
    /** The held payout, when the caller knows it exactly. */
    amount?: CardMoney | null;
    chainId?: number | null;
  },
): CardOf<'RISK_HOLD'> {
  const address =
    ADDRESS.exec(riskCase.subjectRef)?.[0] ??
    ADDRESS.exec(riskCase.counterparty)?.[0] ??
    null;
  const observed = Math.max(
    riskCase.openedAt,
    ...riskCase.events.map((e) => e.at),
  );
  return InteractiveCardSchema.parse({
    ...arcCardBase(
      ctx,
      observed,
      'risk',
      riskCase.caseId,
      riskCase.rev,
      riskCase.status,
    ),
    type: 'RISK_HOLD',
    chainId: ctx.chainId ?? null,
    caseId: cardRef(riskCase.caseId),
    revision: riskCase.rev,
    subject: {
      kind: riskCase.subjectRef.startsWith('payout:')
        ? 'DESTINATION'
        : address
          ? 'COUNTERPARTY'
          : 'VENDOR',
      label: clean(
        ctx.subjectLabel ??
          (address
            ? `Payout to ${address.slice(0, 6)}…${address.slice(-4)}`
            : riskCase.counterparty),
        120,
      ),
      address: address?.toLowerCase() ?? null,
    },
    state: riskCase.status,
    flags: riskCase.flags.slice(0, 8).map((f) => ({
      code:
        f.code
          .toUpperCase()
          .replace(/[^A-Z0-9_]/g, '_')
          .slice(0, 64) || 'FLAG',
      severity: f.severity,
      detail: clean(f.detail, 200),
      reviewerClearable: !NON_OVERRIDABLE_CODES.has(f.code),
    })),
    clearedBy: clearedBy(riskCase),
    amount: ctx.amount ?? null,
    alertCount: riskCase.alertKeys.length,
    openedAt: riskCase.openedAt,
  }) as CardOf<'RISK_HOLD'>;
}
