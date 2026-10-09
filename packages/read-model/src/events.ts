import { z } from 'zod';
import { ReadModelError } from './errors.js';

export const CHAIN_EVENT_SCHEMA_VERSION = 1;
const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((x) => x.toLowerCase() as `0x${string}`);
const bytes32 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/)
  .transform((x) => x.toLowerCase() as `0x${string}`);
const bytes4 = z
  .string()
  .regex(/^0x[0-9a-fA-F]{8}$/)
  .transform((x) => x.toLowerCase() as `0x${string}`);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const blockInt = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const flag = z.boolean();
const groupRef = { groupId: bytes32, account: address };

export const EVENT_PAYLOADS = {
  GroupCreated: z.strictObject({
    groupId: bytes32,
    account: address,
    owners: z.array(address).min(1),
    threshold: uint,
    module: address,
    registry: address,
    creator: address,
    salt: bytes32,
  }),
  GroupBound: z.strictObject({ ...groupRef, module: address }),
  GroupModuleChanged: z.strictObject({
    ...groupRef,
    previousModule: address,
    newModule: address,
  }),
  MandateConfigured: z.strictObject({
    ...groupRef,
    mandateId: bytes32,
    version: uint,
    mandateHash: bytes32,
    token: address,
    maxTokenPerAction: uint,
    maxNativePerAction: uint,
    cumulativeTokenCap: uint,
    cumulativeNativeCap: uint,
    validAfter: uint,
    validUntil: uint,
    callTargets: z.array(address),
    callSelectors: z.array(bytes4),
    recipients: z.array(address),
  }),
  MandateSuperseded: z.strictObject({
    ...groupRef,
    mandateId: bytes32,
    newVersion: uint,
    previousVersion: uint,
    securitySensitive: flag,
    minValidVersion: uint,
  }),
  MandateRevoked: z.strictObject({
    ...groupRef,
    mandateId: bytes32,
    version: uint,
  }),
  SpendRecorded: z.strictObject({
    ...groupRef,
    mandateId: bytes32,
    version: uint,
    module: address,
    tokenAmount: uint,
    nativeAmount: uint,
    spentToken: uint,
    spentNative: uint,
  }),
  ExecutorSet: z.strictObject({
    ...groupRef,
    executor: address,
    allowed: flag,
  }),
  Paused: z.strictObject(groupRef),
  Unpaused: z.strictObject(groupRef),
  NonceCancelled: z.strictObject({ ...groupRef, nonce: uint }),
  GrantExecuted: z.strictObject({
    ...groupRef,
    intentHash: bytes32,
    mandateId: bytes32,
    mandateVersion: uint,
    executor: address,
    pluginId: bytes32,
    chainId: uint,
    nonce: uint,
    grantHash: bytes32,
    target: address,
    selector: bytes4,
    calldataHash: bytes32,
    token: address,
    recipient: address,
    tokenAmount: uint,
    nativeValue: uint,
    outputAmount: uint,
  }),
  SafeSetup: z.strictObject({
    initiator: address,
    owners: z.array(address).min(1),
    threshold: uint,
    initializer: address,
    fallbackHandler: address,
  }),
  AddedOwner: z.strictObject({ owner: address }),
  RemovedOwner: z.strictObject({ owner: address }),
  ChangedThreshold: z.strictObject({ threshold: uint }),
  EnabledModule: z.strictObject({ module: address }),
  DisabledModule: z.strictObject({ module: address }),
  ChangedGuard: z.strictObject({ guard: address }),
  Transfer: z.strictObject({ from: address, to: address, value: uint }),
} as const;
export type EventName = keyof typeof EVENT_PAYLOADS;
export const EVENT_NAMES = Object.keys(EVENT_PAYLOADS) as EventName[];
export const FACTORY_EVENTS = ['GroupCreated'] as const;
export const REGISTRY_EVENTS = [
  'GroupBound',
  'GroupModuleChanged',
  'MandateConfigured',
  'MandateSuperseded',
  'MandateRevoked',
  'SpendRecorded',
] as const;
export const MODULE_EVENTS = [
  'ExecutorSet',
  'Paused',
  'Unpaused',
  'NonceCancelled',
  'GrantExecuted',
] as const;
export const SAFE_EVENTS = [
  'SafeSetup',
  'AddedOwner',
  'RemovedOwner',
  'ChangedThreshold',
  'EnabledModule',
  'DisabledModule',
  'ChangedGuard',
] as const;
export const ECONOMIC_EVENTS: readonly EventName[] = [
  'Transfer',
  'GrantExecuted',
  'SpendRecorded',
];

const envelope = {
  schemaVersion: z.literal(CHAIN_EVENT_SCHEMA_VERSION),
  chainId: blockInt.positive(),
  blockNumber: blockInt,
  blockHash: bytes32,
  transactionHash: bytes32,
  transactionIndex: blockInt,
  logIndex: blockInt,
  contract: address,
};
type Payloads = typeof EVENT_PAYLOADS;
type EventOf<K extends EventName> = {
  schemaVersion: 1;
  chainId: number;
  blockNumber: number;
  blockHash: `0x${string}`;
  transactionHash: `0x${string}`;
  transactionIndex: number;
  logIndex: number;
  contract: `0x${string}`;
  eventName: K;
  payload: z.output<Payloads[K]>;
};
export type ChainEvent = { [K in EventName]: EventOf<K> }[EventName];
export type ChainEventOf<K extends EventName> = EventOf<K>;

const schemas = EVENT_NAMES.map((name) =>
  z.strictObject({
    ...envelope,
    eventName: z.literal(name),
    payload: EVENT_PAYLOADS[name],
  }),
);
export const ChainEventSchema = z.discriminatedUnion(
  'eventName',
  schemas as unknown as [
    (typeof schemas)[number],
    ...(typeof schemas)[number][],
  ],
) as unknown as z.ZodType<ChainEvent, unknown>;

const probe = z.looseObject({
  schemaVersion: z.unknown(),
  eventName: z.unknown(),
});
export function parseChainEvent(raw: unknown): ChainEvent {
  const head = probe.safeParse(raw);
  if (!head.success) throw new ReadModelError('INVALID_EVENT', 'not an object');
  if (head.data.schemaVersion !== CHAIN_EVENT_SCHEMA_VERSION)
    throw new ReadModelError(
      'UNKNOWN_EVENT_VERSION',
      `schemaVersion ${String(head.data.schemaVersion)}`,
    );
  if (
    typeof head.data.eventName !== 'string' ||
    !(EVENT_NAMES as string[]).includes(head.data.eventName)
  )
    throw new ReadModelError(
      'UNKNOWN_EVENT_VERSION',
      `eventName ${String(head.data.eventName)}`,
    );
  const parsed = ChainEventSchema.safeParse(raw);
  if (!parsed.success)
    throw new ReadModelError(
      'INVALID_EVENT',
      parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('; '),
    );
  return parsed.data;
}

export function eventKey(e: {
  chainId: number;
  transactionHash: string;
  logIndex: number;
}): string {
  return `${e.chainId}:${e.transactionHash.toLowerCase()}:${e.logIndex}`;
}

export function compareEvents(
  a: Pick<ChainEvent, 'blockNumber' | 'transactionIndex' | 'logIndex'>,
  b: Pick<ChainEvent, 'blockNumber' | 'transactionIndex' | 'logIndex'>,
): number {
  return (
    a.blockNumber - b.blockNumber ||
    a.transactionIndex - b.transactionIndex ||
    a.logIndex - b.logIndex
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('UNDEFINED_CANONICAL_VALUE');
  return result;
}

export function sameEvent(a: ChainEvent, b: ChainEvent): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function eventFingerprint(e: ChainEvent): string {
  return canonicalJson({
    chainId: e.chainId,
    transactionHash: e.transactionHash,
    contract: e.contract,
    eventName: e.eventName,
    payload: e.payload,
  });
}
