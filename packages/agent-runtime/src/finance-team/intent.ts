import { z } from 'zod';
import type { SpecialistRole } from './manifests.js';

/**
 * Fast-path intent classifier. Simple reads (balance, cash, receipt) map to
 * deterministic handlers with no model call; finance requests map to one
 * specialist. Only an unrecognised request is offered to the Supervisor
 * model, and the model can only pick one of these typed intents (and never
 * the money path: the Supervisor refuses model-classified payments).
 *
 * Payments: only an explicit imperative ("Pay the supplier's invoice") is
 * PAY_INVOICE. Questions and wishes ("can I pay…?") are PAY_CHECK, which
 * ends in a typed owner confirmation and never in a grant. Negations go to
 * timing advice and past tense ("did I pay…?") to the Audit read path.
 */

export const INTENT_KINDS = [
  'BALANCE',
  'RECEIPT',
  'CREATE_INVOICE',
  'RECEIVABLES',
  'PAY_INVOICE',
  'PAY_CHECK',
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
  /** Explicit invoice number in the request ("INV-0043"), if any. */
  invoiceNumber: string | null;
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
  PAY_CHECK: { route: 'SPECIALIST', role: 'PAYMENT' },
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
    invoiceNumber: null,
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

const NOT_NAMES = new Set([
  'pay',
  'settle',
  'please',
  'ok',
  'okay',
  'now',
  'can',
  'could',
  'should',
  'did',
  'do',
  'does',
  "don't",
  'how',
  'what',
  'when',
  'i',
  'we',
  'go',
  'kindly',
  'yes',
]);
/** Drops sentence-initial verbs and pronouns a capitalised-name match can swallow. */
function cleanName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const words = raw.split(/\s+/);
  while (words.length && NOT_NAMES.has(words[0]!.toLowerCase())) words.shift();
  return words.length ? words.join(' ') : null;
}

const PAY_WORD = /\b(pay|paying|settle|settling)\b/;
const NEGATED =
  /\b(don'?t|do not|never|not yet|no need to|stop|hold off|cancel|shouldn'?t|won'?t|wouldn'?t)\b/;
const PAST =
  /\b(did|didn'?t|have|has|had|was|were)\b[^.?!]*\b(pay|paid|settle|settled)\b|\b(paid|settled)\b/;
const QUESTION =
  /\?\s*$|^(can|could|should|shall|may|might|would|will|is|are|am|do|does|how|what|when|why|who|which)\b/;
const IMPERATIVE =
  /^(?:(?:please|ok(?:ay)?|now|kindly|go ahead and)[,!]?\s+)*(pay|settle)\b/;

export function classifyIntent(message: string): FinanceIntent {
  const text = message.replace(/\s+/g, ' ').trim();
  const t = text.toLowerCase();
  const tx = (TX.exec(text)?.[0] ?? null) as `0x${string}` | null;
  const possessive = cleanName(
    new RegExp(`\\b${NAME}'s\\b`).exec(text)?.[1] ?? null,
  );
  const invoiceNumber = /\bINV[-# ]?\d{1,8}\b/i.exec(text)?.[0] ?? null;

  if (/\bexplain\b|\bwhat happened\b|\bwhy did\b/.test(t)) {
    if (/\b(payment|payout|transaction|transfer|tx|paid|pay)\b/.test(t) || tx)
      return intent('EXPLAIN_TRANSACTION', { txHash: tx });
  }
  if (PAST.test(t))
    return intent('EXPLAIN_TRANSACTION', {
      txHash: tx,
      counterparty: possessive,
    });
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
      counterparty: cleanName(m?.[1]),
      amount: m?.[2] ?? null,
      asset: m ? ((m[3]?.toUpperCase() ?? 'USDC') as 'USDC' | 'EURC') : null,
    });
  }
  if (
    /\b(runway|burn|liquidity|how long (can|will)|cash flow|forecast)\b/.test(t)
  )
    return intent('RUNWAY');
  if (
    /\bwhen should (i|we) pay\b|\b(timing|pay early|early payment|discount)\b/.test(
      t,
    ) ||
    (PAY_WORD.test(t) && NEGATED.test(t))
  )
    return intent('PAYMENT_TIMING', {
      counterparty: possessive,
      invoiceNumber,
    });
  if (
    /\b(fraud|suspicious|scam|legit|changed (wallet|address)|new (wallet|address))\b/.test(
      t,
    )
  )
    return intent('RISK_REVIEW', { counterparty: possessive, invoiceNumber });
  if (PAY_WORD.test(t)) {
    const counterparty =
      possessive ??
      cleanName(
        new RegExp(`\\b(?:[Pp]ay|[Ss]ettle)\\s+${NAME}`).exec(text)?.[1],
      );
    const imperative = IMPERATIVE.test(t) && !QUESTION.test(t);
    return intent(imperative ? 'PAY_INVOICE' : 'PAY_CHECK', {
      counterparty,
      invoiceNumber,
    });
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
