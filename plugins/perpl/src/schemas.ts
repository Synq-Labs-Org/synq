import { z } from 'zod';

const uint = z
  .number()
  .int()
  .nonnegative()
  .refine(Number.isSafeInteger, 'unsafe integer');
const sint = z.number().int().refine(Number.isSafeInteger, 'unsafe integer');
const amount = z.string().regex(/^-?(0|[1-9][0-9]*)$/, 'integer amount');
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((v) => v.toLowerCase() as `0x${string}`);

export const BlockTimestampSchema = z.looseObject({
  b: uint.optional(),
  t: uint.optional(),
  tx: uint.optional(),
  txid: z.string().optional(),
  l: uint.optional(),
});
export type BlockTimestamp = z.output<typeof BlockTimestampSchema>;

export const TokenSchema = z.looseObject({
  id: uint.optional(),
  address: z.string().optional(),
  symbol: z.string(),
  name: z.string().optional(),
  decimals: uint,
});
export const InstanceSchema = z.looseObject({
  id: uint,
  address,
  collateral_token_id: uint,
  min_account_open_amount: amount,
  min_deposit_amount: amount,
  min_withdraw_amount: amount.optional(),
  max_account_equity: amount.optional(),
});
export const MarketConfigSchema = z.looseObject({
  at: BlockTimestampSchema.optional(),
  is_open: z.boolean(),
  price_decimals: uint,
  size_decimals: uint,
  min_posting_amount: amount.optional(),
  min_settle_amount: amount.optional(),
  initial_margin: uint,
  maintenance_margin: uint,
  maker_fee: sint,
  taker_fee: sint,
  maker_fees: z.array(sint).optional(),
  taker_fees: z.array(sint).optional(),
  recycle_fee: amount.optional(),
});
export const MarketStateSchema = z.looseObject({
  at: BlockTimestampSchema,
  orl: uint,
  mrk: uint,
  lst: uint,
  mid: uint,
  bid: uint,
  ask: uint,
  prv: uint.optional(),
  dv: uint.optional(),
  dva: amount.optional(),
  oi: uint.optional(),
  tvl: amount.optional(),
});
export type MarketState = z.output<typeof MarketStateSchema>;
export const MarketSchema = z.looseObject({
  id: uint,
  instance_id: uint,
  perpetual_id: uint.optional(),
  symbol: z.string(),
  name: z.string(),
  size_units: z.string(),
  order_ttl_blocks: uint,
  order_retry_blocks: uint.optional(),
  order_max_market_slippage_bps: uint,
  order_max_neg_pnl_collat_bps: uint,
  config: MarketConfigSchema,
  state: MarketStateSchema.optional(),
});
export type Market = z.output<typeof MarketSchema>;
export const ContextSchema = z.looseObject({
  chain: z.looseObject({ chain_id: uint }),
  instances: z.array(InstanceSchema).min(1),
  tokens: z.array(TokenSchema).min(1),
  markets: z.array(MarketSchema),
});
export type PerplContext = z.output<typeof ContextSchema>;

export const TickerSchema = z.looseObject({
  mt: z.literal(9).optional(),
  sn: uint.optional(),
  d: z.record(z.string().regex(/^[0-9]+$/), MarketStateSchema),
});
export type Ticker = z.output<typeof TickerSchema>;

const LevelSchema = z.looseObject({ p: uint, s: uint, o: uint });
export const BookSchema = z.looseObject({
  mt: z.number().optional(),
  sn: uint.optional(),
  at: BlockTimestampSchema,
  bid: z.array(LevelSchema),
  ask: z.array(LevelSchema),
});
export type L2Book = z.output<typeof BookSchema>;

export const AccountSchema = z.looseObject({
  in: uint,
  id: uint,
  fr: z.boolean(),
  fw: z.boolean(),
  ft: uint.optional(),
  lfr: uint,
  b: amount,
  lb: amount,
});
export type PerplAccount = z.output<typeof AccountSchema>;
export const WalletSchema = z.looseObject({
  mt: z.number().optional(),
  sn: uint.optional(),
  at: BlockTimestampSchema.optional(),
  addr: z.string(),
  as: z.array(AccountSchema).optional(),
});
export type PerplWallet = z.output<typeof WalletSchema>;

export const OrderSchema = z.looseObject({
  at: BlockTimestampSchema.optional(),
  rq: uint,
  mkt: uint,
  acc: uint,
  oid: uint.optional(),
  st: uint,
  sr: uint.optional(),
  fr: uint.optional(),
  t: uint,
  r: z.boolean().optional(),
  p: uint.optional(),
  os: uint.optional(),
  fp: uint.optional(),
  fs: uint.optional(),
  f: amount.optional(),
  lv: uint.optional(),
});
export type PerplOrder = z.output<typeof OrderSchema>;
export const OrdersSchema = z.looseObject({
  mt: z.number().optional(),
  sn: uint.optional(),
  at: BlockTimestampSchema.optional(),
  d: z.array(OrderSchema),
});

export const PositionSchema = z.looseObject({
  at: BlockTimestampSchema.optional(),
  mkt: uint,
  acc: uint,
  pid: uint,
  st: uint,
  sr: uint.optional(),
  sd: z.union([z.literal(1), z.literal(2)]),
  c: amount,
  ep: uint,
  s: uint,
  fee: amount.optional(),
  lv: uint.optional(),
  dpnl: amount.optional(),
  fnd: amount.optional(),
});
export type PerplPosition = z.output<typeof PositionSchema>;
export const PositionsSchema = z.looseObject({
  mt: z.number().optional(),
  sn: uint.optional(),
  at: BlockTimestampSchema.optional(),
  d: z.array(PositionSchema),
});

export const FillSchema = z.looseObject({
  at: BlockTimestampSchema,
  mkt: uint,
  acc: uint,
  oid: uint,
  t: uint,
  l: uint.optional(),
  p: uint.optional(),
  s: uint,
  f: amount,
});
export type PerplFill = z.output<typeof FillSchema>;
export const HistoryPageSchema = <T extends z.ZodType>(item: T) =>
  z.looseObject({ d: z.array(item), np: z.string().optional() });

export const StatusSchema = z.looseObject({
  code: sint,
  error: z.string().optional(),
});
export const BatchStatusSchema = z.looseObject({
  mt: z.number().optional(),
  cid: uint.optional(),
  status: StatusSchema,
  statuses: z.array(StatusSchema).optional(),
});
export type BatchStatus = z.output<typeof BatchStatusSchema>;

export const ApiKeyInfoSchema = z.looseObject({
  api_key: z.string().min(1),
  address: z.string(),
  scope_mask: uint,
  label: z.string(),
  origin: z.string().optional(),
  expires_at: uint.optional(),
  created_at: uint.optional(),
});
export const EnrollPayloadSchema = z.looseObject({
  typed_data: z.looseObject({
    types: z.record(
      z.string(),
      z.array(z.looseObject({ name: z.string(), type: z.string() })),
    ),
    primaryType: z.string(),
    domain: z.record(z.string(), z.unknown()),
    message: z.record(z.string(), z.unknown()),
  }),
  mac: z.string().min(1),
});
export type EnrollPayload = z.output<typeof EnrollPayloadSchema>;
