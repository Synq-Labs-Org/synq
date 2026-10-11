import { z } from 'zod';
import { IdSchema, TimestampSchema } from '@synq/schemas';
import { CurrencySchema, FxRateSchema, MoneySchema } from './money.js';

export const DOMAINS = [
  'COMMERCE',
  'STAY',
  'FLIGHT',
  'CAR',
  'ACTIVITY',
  'TRANSFER',
  'TRADE',
  'SERVICE',
  'DATA',
] as const;
export const DomainSchema = z.enum(DOMAINS);
export type Domain = z.output<typeof DomainSchema>;

export const EVIDENCE_LABELS = [
  'REAL_TESTNET',
  'PROVIDER_SANDBOX',
  'MAINNET_READ_ONLY',
  'SIMULATED',
  'MOCKED',
  'BLOCKED_EXTERNAL',
] as const;
export const EvidenceLabelSchema = z.enum(EVIDENCE_LABELS);
export type EvidenceLabel = z.output<typeof EvidenceLabelSchema>;

export const CAPABILITY_VERBS = [
  'DISCOVER',
  'DETAIL',
  'QUOTE',
  'HOLD',
  'PURCHASE',
  'BOOK',
  'MODIFY',
  'CANCEL',
  'RETURN',
  'REFUND',
  'TRACK',
  'HANDOFF',
  'PAY',
] as const;
export const CapabilityVerbSchema = z.enum(CAPABILITY_VERBS);
export type CapabilityVerb = z.output<typeof CapabilityVerbSchema>;

export const PROVIDER_STATUSES = [
  'READY',
  'MISSING_CREDENTIALS',
  'PARTNER_GATED',
  'DEGRADED',
  'DOWN',
  'BLOCKED',
] as const;
export const ProviderStatusSchema = z.enum(PROVIDER_STATUSES);
export type ProviderStatus = z.output<typeof ProviderStatusSchema>;

export const ProviderEnvironmentSchema = z.enum([
  'SANDBOX',
  'PRODUCTION',
  'MAINNET_READ_ONLY',
  'FIXTURE',
]);
export type ProviderEnvironment = z.output<typeof ProviderEnvironmentSchema>;

export const SETTLEMENT_RAILS = [
  'AUSD_ONCHAIN',
  'USDC_ONCHAIN',
  'X402_USDC',
  'PROVIDER_BALANCE',
  'SCOPED_CARD',
  'STABLECOIN_CHECKOUT',
  'HUMAN_HANDOFF',
] as const;
export const SettlementRailSchema = z.enum(SETTLEMENT_RAILS);
export type SettlementRail = z.output<typeof SettlementRailSchema>;

export const ProviderCapabilitySchema = z.strictObject({
  providerId: IdSchema,
  displayName: z.string().min(1).max(80),
  domains: z.array(DomainSchema).min(1),
  verbs: z.array(CapabilityVerbSchema),
  environment: ProviderEnvironmentSchema,
  status: ProviderStatusSchema,
  statusReason: z.string().max(200).nullable(),
  kycRequired: z.boolean(),
  credentialEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/)),
  settlementRails: z.array(SettlementRailSchema),
  discoveryOnly: z.boolean(),
  sourceRefs: z.array(z.string().max(200)),
});
export type ProviderCapability = z.output<typeof ProviderCapabilitySchema>;

const VariantSchema = z.strictObject({
  color: z.string().max(64).optional(),
  storage: z.string().max(64).optional(),
  size: z.string().max(64).optional(),
  region: z.string().max(64).optional(),
  revision: z.string().max(64).optional(),
  warranty: z.string().max(64).optional(),
});
export const ConditionSchema = z.enum(['NEW', 'REFURBISHED', 'USED']);

export const ProductSubjectSchema = z.strictObject({
  kind: z.literal('PRODUCT'),
  title: z.string().min(1).max(300),
  gtin: z
    .string()
    .regex(/^[0-9]{8,14}$/)
    .optional(),
  mpn: z.string().max(64).optional(),
  brand: z.string().max(64).optional(),
  model: z.string().max(64).optional(),
  variant: VariantSchema.default({}),
  condition: ConditionSchema.default('NEW'),
  seller: z.string().max(128).optional(),
  sellerRatingBps: z.number().int().min(0).max(10_000).optional(),
  attributes: z.record(z.string().max(64), z.string().max(128)).default({}),
  deliverBy: TimestampSchema.optional(),
  quantity: z.number().int().positive().default(1),
});
export type ProductSubject = z.output<typeof ProductSubjectSchema>;

export const MealPlanSchema = z.enum([
  'ROOM_ONLY',
  'BREAKFAST',
  'HALF_BOARD',
  'FULL_BOARD',
  'ALL_INCLUSIVE',
]);
export const StaySubjectSchema = z.strictObject({
  kind: z.literal('STAY'),
  propertyId: z.string().min(1).max(128).optional(),
  providerPropertyIds: z.record(IdSchema, z.string().max(128)).default({}),
  propertyName: z.string().max(200).optional(),
  checkIn: z.iso.date(),
  checkOut: z.iso.date(),
  rooms: z.number().int().positive(),
  adults: z.number().int().positive(),
  children: z.number().int().nonnegative().default(0),
  roomCategory: z.string().max(64).optional(),
  beds: z.string().max(64).optional(),
  mealPlan: MealPlanSchema.optional(),
  refundable: z.boolean().optional(),
  coordinates: z
    .strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  location: z
    .strictObject({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusKm: z.number().positive().max(100),
    })
    .optional(),
});
export type StaySubject = z.output<typeof StaySubjectSchema>;

export const CabinSchema = z.enum([
  'economy',
  'premium_economy',
  'business',
  'first',
]);
export const FlightSegmentSchema = z.strictObject({
  origin: z.string().regex(/^[A-Z]{3}$/),
  destination: z.string().regex(/^[A-Z]{3}$/),
  departureDate: z.iso.date(),
  carrier: z
    .string()
    .regex(/^[A-Z0-9]{2}$/)
    .optional(),
  flightNumber: z.string().max(8).optional(),
});
export const FlightSubjectSchema = z.strictObject({
  kind: z.literal('FLIGHT'),
  segments: z.array(FlightSegmentSchema).min(1).max(8),
  adults: z.number().int().positive(),
  cabin: CabinSchema,
  fareFamily: z.string().max(64).optional(),
  checkedBags: z.number().int().nonnegative().default(0),
  changeable: z.boolean().optional(),
  refundable: z.boolean().optional(),
});
export type FlightSubject = z.output<typeof FlightSubjectSchema>;

export const DataSubjectSchema = z.strictObject({
  kind: z.literal('DATA'),
  resource: z.url(),
  description: z.string().max(200),
});

export const SubjectSchema = z.discriminatedUnion('kind', [
  ProductSubjectSchema,
  StaySubjectSchema,
  FlightSubjectSchema,
  DataSubjectSchema,
]);
export type Subject = z.output<typeof SubjectSchema>;

export const ConstraintSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('MAX_LANDED_TOTAL'), max: MoneySchema }),
  z.strictObject({ kind: z.literal('REQUIRE_REFUNDABLE') }),
  z.strictObject({
    kind: z.literal('CONDITION_IN'),
    allowed: z.array(ConditionSchema).min(1),
  }),
  z.strictObject({ kind: z.literal('DELIVER_BY'), at: TimestampSchema }),
  z.strictObject({
    kind: z.literal('SELLER_MIN_RATING_BPS'),
    min: z.number().int().min(0).max(10_000),
  }),
  z.strictObject({
    kind: z.literal('PROVIDER_ALLOWLIST'),
    providers: z.array(IdSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal('MAX_STOPS'),
    max: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal('MIN_EXPIRY_SECONDS'),
    seconds: z.number().int().positive(),
  }),
]);
export type Constraint = z.output<typeof ConstraintSchema>;

export const WeightedPreferenceSchema = z.strictObject({
  key: z.enum(['REFUNDABLE', 'FAST_DELIVERY', 'SELLER_RATING', 'FEWER_STOPS']),
  weight: z.number().int().min(0).max(100),
});

export const EconomicIntentSchema = z
  .strictObject({
    id: IdSchema,
    groupId: IdSchema,
    domain: DomainSchema,
    objective: z.string().min(1).max(500),
    subject: SubjectSchema,
    hardConstraints: z.array(ConstraintSchema),
    preferences: z.array(WeightedPreferenceSchema),
    budget: z.strictObject({ max: MoneySchema }),
    autonomy: z.strictObject({
      execution: z.enum(['AUTO', 'SINGLE_APPROVAL', 'QUORUM']),
      substitution: z.enum(['NONE', 'EQUIVALENT', 'ANY_COMPLIANT']),
    }),
    maxPriceDriftBps: z.number().int().min(0).max(2_000).default(0),
    validUntil: TimestampSchema,
  })
  .superRefine((v, ctx) => {
    const expect: Record<string, Domain[]> = {
      PRODUCT: ['COMMERCE'],
      STAY: ['STAY'],
      FLIGHT: ['FLIGHT'],
      DATA: ['DATA', 'SERVICE'],
    };
    if (!expect[v.subject.kind]?.includes(v.domain))
      ctx.addIssue({
        code: 'custom',
        path: ['subject'],
        message: 'subject kind does not fit the intent domain',
      });
  });
export type EconomicIntent = z.output<typeof EconomicIntentSchema>;
export type EconomicIntentInput = z.input<typeof EconomicIntentSchema>;

export const PriceQuoteSchema = z.strictObject({
  quoteId: z.string().min(1).max(128),
  base: MoneySchema,
  shipping: MoneySchema,
  tax: MoneySchema,
  fees: MoneySchema,
  fx: z.array(FxRateSchema).default([]),
  quotedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  revalidatedAt: TimestampSchema.nullable(),
});
export type PriceQuote = z.output<typeof PriceQuoteSchema>;

export const SettlementRequirementSchema = z.strictObject({
  accepts: z
    .array(
      z.strictObject({ rail: SettlementRailSchema, currency: CurrencySchema }),
    )
    .min(1),
  payee: z.string().max(128).nullable(),
});
export type SettlementRequirement = z.output<
  typeof SettlementRequirementSchema
>;

export const CancellationPolicySchema = z.strictObject({
  kind: z.enum(['FREE_UNTIL', 'PARTIAL', 'NON_REFUNDABLE', 'UNKNOWN']),
  refundable: z.boolean(),
  freeUntil: TimestampSchema.nullable(),
  penalty: MoneySchema.nullable(),
  changeable: z.boolean(),
});
export type CancellationPolicy = z.output<typeof CancellationPolicySchema>;

export const EXECUTION_MODES = [
  'NATIVE_API',
  'STABLECOIN_CHECKOUT',
  'SCOPED_CARD',
  'CONTROLLED_BROWSER',
  'HUMAN_HANDOFF',
  'DISCOVERY_ONLY',
] as const;
export const ExecutionRequirementSchema = z.strictObject({
  mode: z.enum(EXECUTION_MODES),
  requiresQuote: z.boolean(),
  requiresKyc: z.boolean(),
  requiresStepUp: z.boolean(),
  piiFields: z.array(
    z.enum(['TRAVELER_NAME', 'DOB', 'EMAIL', 'PHONE', 'SHIPPING_ADDRESS']),
  ),
});
export type ExecutionRequirement = z.output<typeof ExecutionRequirementSchema>;

export const EconomicOfferSchema = z.strictObject({
  offerId: z.string().min(1).max(160),
  intentId: IdSchema,
  domain: DomainSchema,
  discoveryProviderId: IdSchema,
  alsoDiscoveredBy: z.array(IdSchema).default([]),
  fulfillmentProviderId: IdSchema,
  providerRef: z.string().min(1).max(200),
  subject: SubjectSchema,
  price: PriceQuoteSchema,
  cancellation: CancellationPolicySchema,
  settlement: SettlementRequirementSchema,
  execution: ExecutionRequirementSchema,
  environment: ProviderEnvironmentSchema,
  evidence: EvidenceLabelSchema,
  stops: z.number().int().nonnegative().optional(),
  retrievedAt: TimestampSchema,
  executable: z.boolean(),
});
export type EconomicOffer = z.output<typeof EconomicOfferSchema>;
export type EconomicOfferInput = z.input<typeof EconomicOfferSchema>;

export const FULFILLMENT_STATES = [
  'CONFIRMED',
  'SIMULATED_CHECKOUT',
  'ORDER_PLACED',
  'CANCELED',
  'REFUND_PENDING',
  'REFUNDED',
  'FAILED',
  'UNKNOWN_PROVIDER_OUTCOME',
] as const;
export const FulfillmentReceiptSchema = z.strictObject({
  receiptId: z.string().min(1).max(160),
  intentId: IdSchema,
  offerId: z.string().min(1).max(160),
  providerId: IdSchema,
  providerRef: z.string().max(200).nullable(),
  providerReference: z.string().max(64).nullable(),
  state: z.enum(FULFILLMENT_STATES),
  charged: MoneySchema.nullable(),
  idempotencyKey: z.string().min(8).max(128),
  reservationId: z.string().max(160).nullable(),
  grantId: z.string().max(160).nullable(),
  environment: ProviderEnvironmentSchema,
  evidence: EvidenceLabelSchema,
  createdAt: TimestampSchema,
});
export type FulfillmentReceipt = z.output<typeof FulfillmentReceiptSchema>;
