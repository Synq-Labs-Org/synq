import { keccak256, stringToHex } from 'viem';
import {
  BoundActionIntentSchema,
  IntentIdSchema,
  type BoundActionIntent,
  type IntentId,
} from '@synq/schemas';
import { parseAs } from './errors.js';

export type Hash = `0x${string}`;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  if (typeof value === 'bigint') throw new Error('BIGINT_WIRE_VALUE');
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('UNDEFINED_CANONICAL_VALUE');
  return result;
}
export function artifactHash(value: unknown): Hash {
  return keccak256(stringToHex(canonicalJson(value)));
}

const NON_ECONOMIC = ['intentId', 'evidenceHash', 'riskPacketHash'] as const;
function economicView(intent: BoundActionIntent): Record<string, unknown> {
  const view: Record<string, unknown> = { ...intent };
  for (const key of NON_ECONOMIC) delete view[key];
  return view;
}
export function economicIntentHash(intent: BoundActionIntent): Hash {
  return artifactHash(economicView(BoundActionIntentSchema.parse(intent)));
}
export function canonicalIntentId(intent: BoundActionIntent): IntentId {
  return IntentIdSchema.parse(`intent_${economicIntentHash(intent).slice(2)}`);
}
export function intentHash(intent: BoundActionIntent): Hash {
  const parsed = BoundActionIntentSchema.parse(intent);
  return artifactHash({ ...parsed, intentId: canonicalIntentId(parsed) });
}

export type CanonicalIntent = Readonly<{
  intent: BoundActionIntent;
  intentId: IntentId;
  proposedIntentId: string;
  intentHash: Hash;
  economicHash: Hash;
}>;

export class IntentCanonicalizer {
  canonicalize(raw: unknown): CanonicalIntent {
    const parsed = parseAs(BoundActionIntentSchema, raw, 'INVALID_INTENT');
    const economicHash = artifactHash(economicView(parsed));
    const intentId = IntentIdSchema.parse(`intent_${economicHash.slice(2)}`);
    const intent = { ...parsed, intentId };
    return Object.freeze({
      intent,
      intentId,
      proposedIntentId: parsed.intentId,
      intentHash: artifactHash(intent),
      economicHash,
    });
  }
}
