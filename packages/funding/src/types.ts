import { z } from 'zod';

export const FUNDING_ROUTES = [
  'DIRECT_MONAD_AUSD',
  'AUSD_OFT',
  'AURORA_INTENTS',
  'BRIDGE_TO_USDC_THEN_CONVERT',
] as const;
export type FundingRoute = (typeof FUNDING_ROUTES)[number];

export const EXECUTION_MODES = [
  'REAL_TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'MAINNET_SIMULATION',
  'SIMULATION',
  'CANARY_READY',
] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const ROUTE_AVAILABILITY = [
  'AVAILABLE',
  'UNAVAILABLE',
  'UNAVAILABLE_IN_NETWORK_PROFILE',
  'PENDING_CREDENTIALS',
] as const;
export type RouteAvailability = (typeof ROUTE_AVAILABILITY)[number];

const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
export const TokenRefSchema = z.strictObject({
  chainId: z.number().int().positive(),
  /** EVM address, or "native" for the chain's gas token. */
  address: z.union([
    z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .transform((a) => a.toLowerCase() as `0x${string}`),
    z.literal('native'),
  ]),
  symbol: z.string().min(1).max(32),
  decimals: z.number().int().min(0).max(36),
});
export type TokenRef = z.output<typeof TokenRefSchema>;

export const FundingRequestSchema = z.strictObject({
  requestId: z.string().min(8).max(128),
  groupId: z.string().min(1),
  destination: z.strictObject({
    chainId: z.number().int().positive(),
    account: z
      .string()
      .regex(/^0x[0-9a-fA-F]{40}$/)
      .transform((a) => a.toLowerCase() as `0x${string}`),
    token: TokenRefSchema,
  }),
  source: z.strictObject({
    token: TokenRefSchema,
    amount: uint,
    sender: z.string().min(1).max(128),
    refundTo: z.string().min(1).max(128),
  }),
  maxSlippageBps: z.number().int().min(0).max(1000),
  now: z.number().int().positive(),
});
export type FundingRequest = z.output<typeof FundingRequestSchema>;
export type FundingRequestInput = z.input<typeof FundingRequestSchema>;

export type FeeLine = {
  kind: 'NETWORK' | 'PROTOCOL' | 'APP' | 'REFUND' | 'WITHDRAW' | 'MESSAGING';
  token: TokenRef;
  amount: string;
};

export type NormalizedQuote = {
  quoteId: string;
  route: FundingRoute;
  provider: string;
  mode: ExecutionMode;
  dry: boolean;
  source: TokenRef;
  destination: TokenRef;
  recipient: string;
  amountIn: string;
  amountOut: string;
  minAmountOut: string;
  fees: FeeLine[];
  quotedAt: number;
  expiresAt: number;
  timeEstimateSeconds: number | null;
  depositAddress: string | null;
  correlationId: string | null;
  /** keccak256 of the canonical provider response (evidence, not authority). */
  artifactHash: `0x${string}`;
};

export type RouteCapability = {
  route: FundingRoute;
  availability: RouteAvailability;
  reason: string;
  mode: ExecutionMode;
};

export interface FundingRouteAdapter {
  readonly route: FundingRoute;
  capability(request: FundingRequest): Promise<RouteCapability>;
  quote(request: FundingRequest): Promise<NormalizedQuote>;
}

/** An intents provider able to quote into an arbitrary destination token (used by the USDC-then-convert leg). */
export interface IntentLegQuoter {
  readonly provider: string;
  supportsDestination(token: TokenRef): Promise<boolean>;
  quoteInto(request: FundingRequest, token: TokenRef): Promise<NormalizedQuote>;
}
