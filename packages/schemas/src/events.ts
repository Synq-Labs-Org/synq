import { z } from 'zod';
import {
  CorrelationIdSchema,
  EventIdSchema,
  GroupIdSchema,
  IntentIdSchema,
  IsoTimestampSchema,
  PrincipalIdSchema,
} from './primitives.js';

export const PrincipalKindSchema = z.enum([
  'HUMAN',
  'AGENT',
  'SERVICE',
  'SMART_ACCOUNT',
]);
export type PrincipalKind = z.output<typeof PrincipalKindSchema>;
export const PrincipalRefSchema = z.strictObject({
  principalId: PrincipalIdSchema,
  kind: PrincipalKindSchema,
});
export type PrincipalRef = z.output<typeof PrincipalRefSchema>;

export const DOMAIN_EVENT_SCHEMA_VERSION = 1;
export const EventTypeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/, 'dotted lowercase type');
export function domainEventSchema<P extends z.ZodType>(payload: P) {
  return z.strictObject({
    eventId: EventIdSchema,
    type: EventTypeSchema,
    schemaVersion: z.literal(DOMAIN_EVENT_SCHEMA_VERSION),
    groupId: GroupIdSchema.optional(),
    intentId: IntentIdSchema.optional(),
    causationId: EventIdSchema.optional(),
    correlationId: CorrelationIdSchema,
    occurredAt: IsoTimestampSchema,
    actor: PrincipalRefSchema,
    payload,
  });
}
export const DomainEventSchema = domainEventSchema(z.json());
export type DomainEvent<T = unknown> = Omit<
  z.output<typeof DomainEventSchema>,
  'payload'
> & { payload: T };
export type DomainEventOf<P extends z.ZodType> = z.output<
  ReturnType<typeof domainEventSchema<P>>
>;
