import { z } from 'zod';
import type { SpecialistRole } from './manifests.js';

/**
 * Fast-path intent classifier. Simple reads (balance, cash, receipt) map to
 * deterministic handlers with no model call; finance requests map to one
 * specialist. Only an unrecognised request is offered to the Supervisor
 * model, and the model can only pick one of these typed intents.
 */

export const INTENT_KINDS = [
  'BALANCE',
  'RECEIPT',
  'CREATE_INVOICE',
  'RECEIVABLES',
  'PAY_INVOICE',
  'PAYMENT_TIMING',
  'RUNWAY',
  'EXPLAIN_TRANSACTION',
  'RISK_REVIEW',
  'UNKNOWN',
] as const;
export type IntentKind = (typeof INTENT_KINDS)[number];

export type FinanceIntent = Readonly<{
  kind: IntentKind;
  route: 'FAST_PATH' | 'SPECIALIST' | 'CLARIFY';
  role: SpecialistRole | null;
  counterparty: string | null;
  /** Display decimal, e.g. "500". */
  amount: string | null;
  asset: 'USDC' | 'EURC' | null;
  txHash: `0x${string}` | null;
  classifiedBy: 'RULES' | 'MODEL';
}>;

export const ROUTES: Readonly<
  Record<
    IntentKind,
    { route: FinanceIntent['route']; role: SpecialistRole | null }
  >
> = {
  BALANCE: { route: 'FAST_PATH', role: null },
  RECEIPT: { route: 'FAST_PATH', role: null },
  CREATE_INVOICE: { route: 'SPECIALIST', role: 'INVOICE' },
  RECEIVABLES: { route: 'SPECIALIST', role: 'INVOICE' },
  PAY_INVOICE: { route: 'SPECIALIST', role: 'PAYMENT' },
  PAYMENT_TIMING: { route: 'SPECIALIST', role: 'CFO' },
  RUNWAY: { route: 'SPECIALIST', role: 'CFO' },
  EXPLAIN_TRANSACTION: { route: 'SPECIALIST', role: 'AUDIT' },
  RISK_REVIEW: { route: 'SPECIALIST', role: 'RISK' },
  UNKNOWN: { route: 'CLARIFY', role: null },
};

/** What the Supervisor model may return for an unrecognised request. */
export const ModelIntentSchema = z.strictObject({
  kind: z.enum(INTENT_KINDS),
  counterparty: z.string().min(1).max(80).nullable(),
  amount: z
    .string()
    .regex(/^\d{1,12}(\.\d{1,6})?$/)
    .nullable(),
  asset: z.enum(['USDC', 'EURC']).nullable(),
});
export type ModelIntent = z.output<typeof ModelIntentSchema>;

const TX = /\b0x[0-9a-fA-F]{64}\b/;
const NAME = `([A-Z][\\w&.'-]*(?:\\s+[A-Z][\\w&.'-]*)*)`;

function intent(
  kind: IntentKind,
  extra: Partial<FinanceIntent> = {},
): FinanceIntent {
  return {
    kind,
    ...ROUTES[kind],
    counterparty: null,
    amount: null,
    asset: null,
    txHash: null,
    classifiedBy: 'RULES',
    ...extra,
  };
}

export function fromModelIntent(m: ModelIntent): FinanceIntent {
  return intent(m.kind, {
    counterparty: m.counterparty,
    amount: m.amount,
    asset: m.asset,
    classifiedBy: 'MODEL',
  });
}

export function classifyIntent(message: string): FinanceIntent {
  const text = message.replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase();
  const tx = (TX.exec(text)?.[0] ?? null) as `0x${string}` | null;
  const possessive = new RegExp(`\\b${NAME}'s\\b`).exec(text)?.[1] ?? null;

  if (/\bexplain\b|\bwhat happened\b|\bwhy did\b/.test(t)) {
    if (/\b(payment|payout|transaction|transfer|tx|paid)\b/.test(t) || tx)
      return intent('EXPLAIN_TRANSACTION', { txHash: tx });
  }
  if (tx || /\breceipt\b/.test(t)) return intent('RECEIPT', { txHash: tx });

  if (
    /\b(create|draft|make|raise|issue|send|bill)\b.*\binvoice\b|\binvoice\s+(for|to)\b/.test(
      t,
    )
  ) {
    const m = new RegExp(
      `\\b(?:for|to)\\s+${NAME}\\s+(?:for\\s+)?\\$?(\\d{1,12}(?:\\.\\d{1,6})?)\\s*(usdc|eurc)?\\b`,
      'i',
    ).exec(text);
    return intent('CREATE_INVOICE', {
      counterparty: m?.[1] ?? null,
      amount: m?.[2] ?? null,
      asset: m ? ((m[3]?.toUpperCase() ?? 'USDC') as 'USDC' | 'EURC') : null,
    });
  }
  if (
    /\b(runway|burn|liquidity|how long (can|will)|cash flow|forecast)\b/.test(t)
  )
    return intent('RUNWAY');
  if (
    /\bwhen should i pay\b|\b(timing|pay early|early payment|discount)\b/.test(
      t,
    )
  )
    return intent('PAYMENT_TIMING', { counterparty: possessive });
  if (
    /\b(fraud|suspicious|scam|legit|changed (wallet|address)|new (wallet|address))\b/.test(
      t,
    )
  )
    return intent('RISK_REVIEW', { counterparty: possessive });
  if (/\b(can i |should i |please |go ahead and )?(pay|settle)\b/.test(t)) {
    const direct =
      possessive ??
      new RegExp(`\\b(?:pay|settle)\\s+${NAME}\\b`).exec(text)?.[1] ??
      null;
    return intent('PAY_INVOICE', { counterparty: direct });
  }
  if (
    /\b(who owes|receivables?|outstanding invoices?|unpaid invoices?|overdue)\b/.test(
      t,
    )
  )
    return intent('RECEIVABLES');
  if (
    /\b(balance|cash|how much (usdc|money|do i have)|available|treasury)\b/.test(
      t,
    )
  )
    return intent('BALANCE');
  return intent('UNKNOWN');
}
