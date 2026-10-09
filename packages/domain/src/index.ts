import { randomUUID } from 'node:crypto';
import {
  AmountSchema,
  UINT256_MAX,
  type Capability,
} from '../../schemas/src/index.js';

export * from '../../schemas/src/index.js';
export type BrandedId<T extends string> = string & { readonly __kind: T };
export function newId<T extends string>(kind: T): BrandedId<T> {
  return `${kind}_${randomUUID()}` as BrandedId<T>;
}
export function toAmount(value: bigint): string {
  return AmountSchema.parse(value.toString());
}
export function fromAmount(value: unknown): bigint {
  return BigInt(AmountSchema.parse(value));
}
export function parseDecimal(value: string, decimals: number): bigint {
  if (
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    !/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value)
  )
    throw new Error('INVALID_DECIMAL');
  const [whole = '', fraction = ''] = value.split('.');
  if (fraction.length > decimals) throw new Error('DECIMAL_PRECISION');
  const result = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (result > UINT256_MAX) throw new Error('AMOUNT_OVERFLOW');
  return result;
}
export function formatDecimal(value: bigint, decimals: number): string {
  toAmount(value);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error('INVALID_DECIMALS');
  if (decimals === 0) return value.toString();
  const digits = value.toString().padStart(decimals + 1, '0');
  return `${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}
export const ACTION_STATES = [
  'RECEIVED',
  'NORMALIZED',
  'RESEARCHING',
  'PROPOSED',
  'RISKED',
  'SIMULATED',
  'PENDING_APPROVAL',
  'AUTHORIZED',
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'EXPLAINED',
  'POLICY_REJECTED',
  'RISK_REJECTED',
  'EXPIRED',
  'CANCELLED',
  'PREPARE_FAILED',
  'SUBMIT_FAILED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];
const successors: Partial<Record<ActionState, readonly ActionState[]>> = {
  RECEIVED: ['NORMALIZED', 'CANCELLED'],
  NORMALIZED: ['RESEARCHING', 'PROPOSED', 'POLICY_REJECTED', 'CANCELLED'],
  RESEARCHING: ['PROPOSED', 'CANCELLED', 'EXPIRED'],
  PROPOSED: ['RISKED', 'POLICY_REJECTED', 'CANCELLED', 'EXPIRED'],
  RISKED: [
    'SIMULATED',
    'RISK_REJECTED',
    'MANUAL_REVIEW',
    'CANCELLED',
    'EXPIRED',
  ],
  SIMULATED: [
    'PENDING_APPROVAL',
    'AUTHORIZED',
    'RISK_REJECTED',
    'CANCELLED',
    'EXPIRED',
  ],
  PENDING_APPROVAL: ['AUTHORIZED', 'CANCELLED', 'EXPIRED', 'POLICY_REJECTED'],
  AUTHORIZED: ['PREPARED', 'CANCELLED', 'EXPIRED', 'PREPARE_FAILED'],
  PREPARED: ['SIGNED', 'PREPARE_FAILED', 'CANCELLED', 'EXPIRED'],
  SIGNED: ['SUBMITTED', 'SUBMIT_FAILED', 'RECONCILIATION_REQUIRED'],
  SUBMITTED: ['CONFIRMED', 'RECONCILIATION_REQUIRED'],
  CONFIRMED: ['INDEXED', 'RECONCILIATION_REQUIRED'],
  INDEXED: ['RECONCILED', 'RECONCILIATION_REQUIRED'],
  RECONCILED: ['EXPLAINED'],
  RECONCILIATION_REQUIRED: [
    'CONFIRMED',
    'INDEXED',
    'RECONCILED',
    'MANUAL_REVIEW',
  ],
  MANUAL_REVIEW: ['CANCELLED'],
};
export function transition(from: ActionState, to: ActionState): ActionState {
  if (!successors[from]?.includes(to))
    throw new Error(`INVALID_TRANSITION:${from}:${to}`);
  return to;
}
const nonDelegable = new Set<Capability>([
  'SIGN',
  'WITHDRAW',
  'CHANGE_OWNER',
  'CHANGE_THRESHOLD',
  'INSTALL_MODULE',
  'CHANGE_POLICY',
  'ISSUE_GRANT',
]);
export function delegateCapabilities(
  parent: readonly Capability[],
  child: readonly Capability[],
): Capability[] {
  if (
    new Set(child).size !== child.length ||
    child.some((cap) => nonDelegable.has(cap) || !parent.includes(cap))
  )
    throw new Error('CAPABILITY_ESCALATION');
  return [...child];
}
export class UniqueIds {
  private readonly ids = new Set<string>();
  claim(id: string): void {
    if (this.ids.has(id)) throw new Error('DUPLICATE_ID');
    this.ids.add(id);
  }
}
