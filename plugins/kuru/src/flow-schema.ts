import { z } from 'zod';
import type { Hex } from 'viem';
import { KuruError } from './errors.js';
import type { Address } from './deployment.js';

const decimal = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as Address);
const calldata = z
  .string()
  .regex(/^(0x)?[0-9a-fA-F]+$/)
  .refine((v) => v.replace(/^0x/, '').length % 2 === 0, 'odd hex length')
  .transform((v) => `0x${v.replace(/^0x/, '').toLowerCase()}` as Hex);

export const FlowTokenResponseSchema = z.object({
  token: z.string().min(16),
  expires_at: z.number().int().positive().optional(),
  rate_limit: z.unknown().optional(),
});

const LiveTransactionSchema = z.object({
  calldata,
  value: decimal,
  to: address,
});
/** Live shape observed on 2026-10-10 (differs from the published OpenAPI example). */
export const FlowLiveQuoteSchema = z.object({
  type: z.literal('calculate_swap_result'),
  status: z.literal('success'),
  output: decimal,
  minOut: decimal,
  transaction: LiveTransactionSchema,
  gasPrices: z.record(z.string(), z.string()).optional(),
});
/** OpenAPI `CalculateBestPathResponse` shape with a buildResponse transaction. */
export const FlowSpecQuoteSchema = z.object({
  status: z.literal('success'),
  output: decimal,
  minOut: decimal.optional(),
  buildResponse: z.object({
    transaction: z
      .object({
        to: address,
        data: calldata.optional(),
        calldata: calldata.optional(),
        value: decimal.default('0'),
      })
      .refine((t) => (t.data ?? t.calldata) !== undefined, 'calldata'),
  }),
});
export const FlowErrorSchema = z.object({
  status: z.literal('error').optional(),
  error: z.string().optional(),
  message: z.string().optional(),
});

export type NormalizedFlowQuote = {
  shape: 'LIVE' | 'SPEC';
  output: bigint;
  minOut: bigint | null;
  to: Address;
  data: Hex;
  value: bigint;
  gasPrices: Record<string, string> | null;
};

export function parseFlowQuote(raw: unknown): NormalizedFlowQuote {
  const live = FlowLiveQuoteSchema.safeParse(raw);
  if (live.success)
    return {
      shape: 'LIVE',
      output: BigInt(live.data.output),
      minOut: BigInt(live.data.minOut),
      to: live.data.transaction.to,
      data: live.data.transaction.calldata,
      value: BigInt(live.data.transaction.value),
      gasPrices: live.data.gasPrices ?? null,
    };
  const spec = FlowSpecQuoteSchema.safeParse(raw);
  if (spec.success) {
    const tx = spec.data.buildResponse.transaction;
    return {
      shape: 'SPEC',
      output: BigInt(spec.data.output),
      minOut: spec.data.minOut === undefined ? null : BigInt(spec.data.minOut),
      to: tx.to,
      data: (tx.data ?? tx.calldata)!,
      value: BigInt(tx.value),
      gasPrices: null,
    };
  }
  const error = FlowErrorSchema.safeParse(raw);
  if (
    error.success &&
    (error.data.status === 'error' || error.data.error !== undefined)
  )
    throw new KuruError(
      'QUOTE_FAILED',
      (error.data.message ?? error.data.error ?? 'error').slice(0, 200),
    );
  throw new KuruError('QUOTE_SCHEMA_CHANGED', 'unrecognized Flow quote shape');
}
