import { z } from 'zod';

const Text = (max: number) => z.string().max(max);
export const ModelAmountSchema = z.strictObject({
  display: Text(40),
  baseUnits: Text(80),
  decimals: z.number().int(),
});
const ACTIONS = [
  'TRANSFER',
  'SPOT_TRADE',
  'PERP_HEDGE',
  'CROSS_CHAIN_FUND',
] as const;
const common = {
  rationale: Text(1000),
  ambiguities: z.array(Text(300)).max(10),
  uncertainty: z.number().min(0).max(1),
};
export const ActionDraftSchema = z.strictObject({
  kind: z.literal('ACTION'),
  requestedBy: Text(128),
  action: z.enum(ACTIONS),
  network: Text(64),
  providerId: Text(64),
  mandateId: Text(128),
  mandateVersion: z.number().int(),
  token: Text(64),
  amount: ModelAmountSchema,
  recipient: Text(64),
  deadlineSeconds: z.number().int(),
  ...common,
});
export type ActionDraft = z.output<typeof ActionDraftSchema>;
export const MandateDraftSchema = z.strictObject({
  kind: z.literal('MANDATE'),
  requestedBy: z.array(Text(128)).min(1).max(16),
  change: z.enum(['NEW', 'SUPERSEDE']),
  baseMandateId: Text(128),
  newMandateId: Text(128).nullable(),
  goal: Text(300),
  action: z.enum(ACTIONS),
  providerId: Text(64),
  network: Text(64),
  inputToken: Text(64),
  outputToken: Text(64).nullable(),
  perActionCap: ModelAmountSchema,
  cumulativeBudget: ModelAmountSchema,
  recipients: z.array(Text(64)).max(8),
  cadenceSeconds: z.number().int().nullable(),
  maxSlippageBps: z.number().int(),
  durationDays: z.number().int(),
  ...common,
});
export type MandateDraft = z.output<typeof MandateDraftSchema>;
export const ClarificationSchema = z.strictObject({
  kind: z.literal('CLARIFICATION'),
  questions: z.array(Text(300)).min(1).max(5),
  ...common,
});
export const NoActionSchema = z.strictObject({
  kind: z.literal('NO_ACTION'),
  reason: Text(500),
  ...common,
});
export const IntentItemSchema = z.discriminatedUnion('kind', [
  ActionDraftSchema,
  MandateDraftSchema,
  ClarificationSchema,
  NoActionSchema,
]);
export type IntentItem = z.output<typeof IntentItemSchema>;
export const IntentOutputSchema = z.strictObject({
  items: z.array(IntentItemSchema).min(1).max(4),
});
export type IntentOutput = z.output<typeof IntentOutputSchema>;

export const ResearchOutputSchema = z.strictObject({
  summary: Text(1500),
  claims: z
    .array(
      z.strictObject({
        text: Text(500),
        evidenceIds: z.array(Text(128)).max(10),
      }),
    )
    .max(12),
  recommendation: z.enum(['SUPPORT', 'CAUTION', 'OPPOSE']),
  uncertainty: z.number().min(0).max(1),
});
export type ResearchOutput = z.output<typeof ResearchOutputSchema>;

export const CriticOutputSchema = z.strictObject({
  verdict: z.enum(['SUPPORT', 'OBJECT', 'UNCERTAIN']),
  issues: z.array(Text(500)).max(12),
  disagreements: z
    .array(z.strictObject({ topic: Text(120), position: Text(500) }))
    .max(8),
  uncertainty: z.number().min(0).max(1),
});
export type CriticOutput = z.output<typeof CriticOutputSchema>;

export type StrictParse<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'MALFORMED_JSON' | 'SCHEMA_REJECTED'; issues: string[] };

export function strictParse<S extends z.ZodType>(
  schema: S,
  text: string,
): StrictParse<z.output<S>> {
  const trimmed = text.trim();
  const body =
    /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed)?.[1] ?? trimmed;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { ok: false, code: 'MALFORMED_JSON', issues: ['not valid JSON'] };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      code: 'SCHEMA_REJECTED',
      issues: parsed.error.issues
        .slice(0, 12)
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`),
    };
  return { ok: true, value: parsed.data };
}

export function jsonSchemaOf(schema: z.ZodType): { [key: string]: unknown } {
  return z.toJSONSchema(schema, { target: 'draft-7' }) as {
    [key: string]: unknown;
  };
}
