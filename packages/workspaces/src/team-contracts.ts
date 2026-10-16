import { z } from 'zod';
export const TeamQuestionSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  message: z.string().trim().min(1).max(2000),
});
export const WorkspaceTeamReplySchema = z.strictObject({
  runId: z.string(),
  status: z.enum(['ANSWERED', 'NEEDS_CLARIFICATION', 'STOPPED']),
  answer: z.string(),
  roles: z.array(z.string()),
  citations: z.array(
    z.strictObject({
      path: z.string(),
      provenance: z.string(),
      source: z.string(),
      observedAt: z.number().nullable(),
      freshness: z.enum(['FRESH', 'STALE', 'UNKNOWN']),
      ageSeconds: z.number().nullable(),
    }),
  ),
  world: z
    .strictObject({
      builtAt: z.number(),
      decisionGrade: z.boolean(),
      staleCritical: z.array(z.string()),
      refreshed: z.boolean(),
    })
    .nullable(),
  toolCalls: z.number().int().nonnegative(),
  proposals: z.enum([
    'USE_EXPLICIT_PAYMENT_REQUEST_FOR_WALLET_REVIEW',
    'PENDING_OWNER_SIGNATURE',
  ]),
  payoutId: z.uuid().optional(),
});
