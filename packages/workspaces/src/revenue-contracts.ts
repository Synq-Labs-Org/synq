import { z } from 'zod';
import {
  RevenuePolicySchema,
  policyHash,
  parsePolicy,
  type RevenuePolicy,
} from '@synq/allocations/policy-data';
import { UnitsSchema } from './finance-contracts.js';

const positive = UnitsSchema.refine((v) => BigInt(v) > 0n);
const distributions = z
  .array(
    z.discriminatedUnion('kind', [
      z.strictObject({
        kind: z.literal('FIXED'),
        label: z.string().trim().min(1).max(80),
        beneficiaryId: z.string().uuid(),
        amount: positive.transform(BigInt),
      }),
      z.strictObject({
        kind: z.literal('PERCENT_OF_SURPLUS'),
        label: z.string().trim().min(1).max(80),
        beneficiaryId: z.string().uuid(),
        bps: z.number().int().min(1).max(10000),
      }),
    ]),
  )
  .max(10);
const limits = z.strictObject({
  maxAutonomousPerLeg: positive.transform(BigInt),
  maxAutonomousPerWindow: positive.transform(BigInt),
  windowSeconds: z
    .number()
    .int()
    .min(60)
    .max(31 * 86400),
  maxSplitsPerWindow: z.number().int().min(1).max(1000),
});
export const RevenuePolicyWireSchema = z
  .strictObject({
    ...RevenuePolicySchema.shape,
    operatingFloor: UnitsSchema.transform(BigInt),
    distributions,
    limits,
  })
  .transform(parsePolicy);
export const DraftRevenuePolicySchema = z.strictObject({
  taxReserveBps: z.number().int().min(0).max(5000),
  operatingFloor: UnitsSchema.transform(BigInt),
  obligationHorizonDays: z.number().int().min(1).max(120),
  vendorIds: z.array(z.string().uuid()).min(1).max(20),
  distributions,
  limits,
  validForSeconds: z
    .number()
    .int()
    .min(900)
    .max(30 * 86400),
});
export const revenueWire = (
  p: RevenuePolicy,
): z.input<typeof RevenuePolicyWireSchema> =>
  JSON.parse(
    JSON.stringify(p, (_k, v) => (typeof v === 'bigint' ? String(v) : v)),
  );
export function revenueRevocationTypedData(p: RevenuePolicy) {
  return {
    domain: {
      name: 'Synq Workspace Revenue Revocation',
      version: '1',
      chainId: p.chainId,
      verifyingContract: p.treasury,
    },
    types: {
      RevokeRevenuePolicy: [
        { name: 'workspaceId', type: 'string' },
        { name: 'policyHash', type: 'bytes32' },
        { name: 'version', type: 'uint256' },
      ],
    },
    primaryType: 'RevokeRevenuePolicy' as const,
    message: {
      workspaceId: p.workspaceId,
      policyHash: policyHash(p),
      version: BigInt(p.version),
    },
  };
}

export const RevenuePolicyViewSchema = z.strictObject({
  id: z.uuid(),
  policy: RevenuePolicyWireSchema,
  state: z.enum(['REVIEW', 'ACTIVE', 'SUPERSEDED', 'REVOKED']),
  signedBy: z.array(z.string()),
  revokedBy: z.array(z.string()),
});

export const WorkspaceAllocationViewSchema = z.strictObject({
  id: z.string(),
  invoiceId: z.string(),
  state: z.string(),
  receiptReview: z.boolean(),
  received: UnitsSchema,
  receiptTx: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  policyVersion: z.number().int().positive(),
  legs: z.array(
    z.strictObject({
      kind: z.enum(['RESERVE', 'TRANSFER', 'FREE_CASH']),
      purpose: z.string(),
      amount: UnitsSchema,
      state: z.string(),
      recipient: z.string().nullable(),
      txHash: z.string().nullable(),
    }),
  ),
});
