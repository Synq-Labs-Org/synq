import { z } from 'zod';

/*
 * Shared wire types for the v3 app API (iOS app, web hub, channel bots).
 * Money is always an integer count of token base units in a decimal string;
 * times are UTC ISO-8601 strings. Nothing here has a default value: a field
 * the server cannot fill is null or the response says BLOCKED.
 */

export const CONTRACT_VERSION = '3.0.0';

export const UnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,77})$/)
  .describe('Integer token base units as a decimal string');
export const TimestampSchema = z.iso
  .datetime()
  .describe('UTC ISO-8601 timestamp');
export const AddressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .describe('EVM address');
export const AddressHintSchema = z
  .string()
  .max(16)
  .describe('Shortened address for display, such as 0x12ab…9f3c');
export const TxHashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const HashSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
export const IdSchema = z.uuid();
export const CursorSchema = z.string().min(1).max(200);

/** How strongly a fact is proven. Never mix levels in one claim. */
export const ProofLevelSchema = z.enum([
  'LIVE_ARC_TESTNET',
  'LIVE_ARC_MAINNET',
  'PROVIDER_SANDBOX',
  'LOCAL_FIXTURE',
  'NOT_VERIFIED',
  'BLOCKED',
]);

/** Whether a feature can be used, and how strongly it is enforced. */
export const CapabilityStatusSchema = z.enum([
  'AVAILABLE',
  'BLOCKED',
  'NOT_CONFIGURED',
  'UNSUPPORTED',
  'OFFCHAIN_ONLY',
  'ONCHAIN_AUTHENTICATED',
  'VERIFIED_TESTNET',
]);
export const CapabilitySchema = z.strictObject({
  status: CapabilityStatusSchema,
  reason: z.string().max(600),
});

export const WorkspaceKindSchema = z.enum(['PERSONAL', 'GROUP', 'BUSINESS']);
export const WorkspaceStatusSchema = z.enum(['FORMING', 'LAUNCHING', 'ACTIVE']);
export const RoleSchema = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);

/** One asset amount, with everything needed to format it exactly. */
export const MoneySchema = z.strictObject({
  assetId: z.string().max(64).describe('Registry id such as arc-testnet:USDC'),
  symbol: z.string().max(12),
  chainId: z.number().int(),
  decimals: z.number().int().min(0).max(36),
  units: UnitsSchema,
});

/**
 * Where an asset's money stands. Spendable is `settled - reserved`; pending
 * deposits, CCTP burns and unfinalized mints are never counted as settled, and
 * quarantined funds are never spendable.
 */
export const BalanceSchema = z.strictObject({
  assetId: z.string().max(64),
  symbol: z.string().max(12),
  chainId: z.number().int(),
  decimals: z.number().int().min(0).max(36),
  settled: UnitsSchema.describe('Final on chain; includes reserved'),
  reserved: UnitsSchema.describe(
    'Settled but held for bills, deals or members',
  ),
  pending: UnitsSchema.describe('Seen but not final'),
  quarantined: UnitsSchema.describe('Arrived without a matching authorization'),
});

export const FreshnessSchema = z.strictObject({
  observedAt: TimestampSchema,
  source: z.enum(['CHAIN', 'PROVIDER', 'LEDGER', 'CACHE']),
  stale: z.boolean(),
});

/**
 * Error body for every non-2xx response. Status codes:
 * 400 INVALID_REQUEST · 401 UNAUTHENTICATED / SESSION_EXPIRED (refresh, then sign in) ·
 * 403 FORBIDDEN / ORIGIN_MISMATCH · 404 NOT_FOUND (also for another tenant's ids) ·
 * 409 VERSION_CONFLICT / STALE · 422 POLICY_BLOCKED · 429 RATE_LIMITED ·
 * 503 UNSUPPORTED / NOT_CONFIGURED / INTEGRATION_UNAVAILABLE.
 */
export const ApiErrorSchema = z.strictObject({
  error: z.string().max(64),
  message: z.string().max(600),
  retryable: z.boolean().optional(),
});

export const OkSchema = z.strictObject({ ok: z.literal(true) });

export function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({
    items: z.array(item),
    nextCursor: CursorSchema.nullable(),
  });
}
