import { randomUUID } from 'node:crypto';
import {
  AmountSchema,
  CorrelationIdSchema,
  DOMAIN_EVENT_SCHEMA_VERSION,
  ID_SCHEMAS,
  UINT256_MAX,
  domainEventSchema,
  isNonDelegable,
  type Capability,
  type DomainEventOf,
  type IdKind,
  type IdOf,
  type PrincipalRef,
} from '@synq/schemas';
import type { z } from 'zod';
import { CapabilityError, MoneyError, parseOrThrow } from './errors.js';

export * from '@synq/schemas';
export * from './errors.js';
export * from './kernel-errors.js';
export * from './lifecycle.js';

export type BrandedId<K extends IdKind> = IdOf<K>;
export function newId<K extends IdKind>(kind: K): IdOf<K> {
  const schemas: { [P in IdKind]: z.core.$ZodType<IdOf<P>, string> } =
    ID_SCHEMAS;
  return parseOrThrow(schemas[kind], `${kind}_${randomUUID()}`);
}
export function toAmount(value: bigint): string {
  return parseOrThrow(AmountSchema, value);
}
export function fromAmount(value: unknown): bigint {
  return BigInt(parseOrThrow(AmountSchema, value));
}
export function parseDecimal(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    throw new MoneyError('INVALID_DECIMAL');
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new MoneyError('DECIMAL_PRECISION');
  const result = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (result > UINT256_MAX) throw new MoneyError('AMOUNT_OVERFLOW');
  return result;
}
export function formatDecimal(value: bigint, decimals: number): string {
  toAmount(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new MoneyError('INVALID_DECIMALS');
  if (decimals === 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
export function delegateCapabilities(
  parent: readonly Capability[],
  child: readonly Capability[],
): Capability[] {
  if (
    new Set(child).size !== child.length ||
    child.some((cap) => isNonDelegable(cap) || !parent.includes(cap))
  )
    throw new CapabilityError('CAPABILITY_ESCALATION');
  return [...child];
}
export function createDomainEvent<P extends z.ZodType>(
  payloadSchema: P,
  input: {
    type: string;
    actor: PrincipalRef;
    correlationId: string;
    payload: z.input<P>;
    occurredAt?: Date;
    groupId?: string;
    intentId?: string;
    causationId?: string;
  },
): DomainEventOf<P> {
  return parseOrThrow(domainEventSchema(payloadSchema), {
    eventId: newId('event'),
    type: input.type,
    schemaVersion: DOMAIN_EVENT_SCHEMA_VERSION,
    ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
    ...(input.intentId === undefined ? {} : { intentId: input.intentId }),
    ...(input.causationId === undefined
      ? {}
      : { causationId: input.causationId }),
    correlationId: parseOrThrow(CorrelationIdSchema, input.correlationId),
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    actor: input.actor,
    payload: input.payload,
  });
}
