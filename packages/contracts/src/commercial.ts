import { z } from 'zod';
import { HashSchema, TimestampSchema } from './common.js';
import { OfferVersionSchema } from './business.js';

/*
 * Commercial authority for private leads: the owner-signed policy the sales
 * agent must stay inside, and the offer terms it may propose. A deterministic
 * validator on the server checks every offer against the active policy.
 */

export const OfferUnitsSchema = z.string().regex(/^(0|[1-9][0-9]{0,30})$/);
export const SkuSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/);

export const CommercialPolicySchema = z.strictObject({
  catalog: z
    .array(
      z.strictObject({
        sku: SkuSchema,
        description: z.string().trim().min(1).max(200),
        /** List price per unit, USDC base units. */
        unitUnits: OfferUnitsSchema,
        /** Lowest price per unit any offer may use. */
        floorUnits: OfferUnitsSchema,
        maxQuantity: z.number().int().min(1).max(1000),
        leadTimeDays: z.number().int().min(0).max(365),
        rushSurchargeBps: z.number().int().min(0).max(10000),
        /** Owner-declared capacity; null means unknown, so rush work is refused. */
        capacity: z
          .strictObject({
            unitsAvailable: z.number().int().min(0),
            asOf: TimestampSchema,
          })
          .nullable(),
      }),
    )
    .min(1)
    .max(50)
    .refine(
      (c) => new Set(c.map((i) => i.sku)).size === c.length,
      'duplicate sku',
    )
    .refine(
      (c) => c.every((i) => BigInt(i.floorUnits) <= BigInt(i.unitUnits)),
      'floor above list price',
    ),
  maxDiscountBps: z.number().int().min(0).max(5000),
  minDepositBps: z.number().int().min(0).max(10000),
  maxMilestones: z.number().int().min(1).max(6),
  offerTtlSeconds: z
    .number()
    .int()
    .min(3600)
    .max(30 * 24 * 3600),
  /** Offers above this total need the owner, never the agent. */
  ownerApprovalAboveUnits: OfferUnitsSchema,
  /** How old declared capacity may be before it counts as unknown. */
  capacityFreshSeconds: z
    .number()
    .int()
    .min(3600)
    .max(30 * 24 * 3600),
});

export const OfferTermsSchema = z.strictObject({
  lines: z
    .array(
      z.strictObject({
        sku: SkuSchema,
        quantity: z.number().int().min(1).max(1000),
        unitUnits: OfferUnitsSchema,
      }),
    )
    .min(1)
    .max(20),
  rush: z.boolean(),
  deliveryDays: z.number().int().min(1).max(365),
  milestones: z
    .array(
      z.strictObject({
        label: z.string().trim().min(1).max(120),
        units: OfferUnitsSchema,
        dueInDays: z.number().int().min(0).max(365),
      }),
    )
    .min(1)
    .max(6),
  depositUnits: OfferUnitsSchema,
  note: z.string().trim().max(400),
});

export const CommercialPolicyViewSchema = z.strictObject({
  version: z.number().int().positive(),
  state: z.enum(['REVIEW', 'ACTIVE', 'SUPERSEDED']),
  policyHash: HashSchema,
  policy: CommercialPolicySchema,
  approvedBy: z.string().nullable(),
});
export const CommercialPolicyListSchema = z.strictObject({
  policies: z.array(CommercialPolicyViewSchema),
});
export const OfferCheckSchema = z.strictObject({
  rule: z.string().max(60),
  passed: z.boolean(),
  detail: z.string().max(300),
});
export const OfferSendRequestSchema = z.strictObject({
  terms: OfferTermsSchema,
  offerId: z.uuid().optional(),
});
export const OfferSendResultSchema = z.strictObject({
  sent: z.boolean(),
  checks: z.array(OfferCheckSchema),
  needsOwner: z.boolean(),
  offer: OfferVersionSchema.nullable(),
});
