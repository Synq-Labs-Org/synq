import { z } from 'zod';
import { canonicalJson } from './events.js';
import { keccak256, stringToHex } from 'viem';
import { Tables, type Hex } from './tables.js';

const hex = z.string().regex(/^0x[0-9a-f]*$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
const bytes32 = z.string().regex(/^0x[0-9a-f]{64}$/);
const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const block = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const MandateVersionViewSchema = z.strictObject({
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
  callSelectors: z.array(hex),
  recipients: z.array(address),
  securitySensitive: z.boolean().nullable(),
  configuredBlock: block,
  configuredTx: bytes32,
  artifact: z.enum(['VERIFIED', 'MISSING']),
});
export const MandateViewSchema = z.strictObject({
  mandateId: bytes32,
  status: z.enum(['ACTIVE', 'REVOKED']),
  currentVersion: uint,
  minValidVersion: uint,
  spentToken: uint,
  spentNative: uint,
  versions: z.array(MandateVersionViewSchema),
});
export const GroupStateSchema = z.strictObject({
  groupId: bytes32,
  account: address,
  registry: address,
  module: address,
  creator: address.nullable(),
  salt: bytes32.nullable(),
  owners: z.array(address),
  threshold: uint.nullable(),
  guard: address.nullable(),
  safeModules: z.array(
    z.strictObject({ module: address, enabled: z.boolean() }),
  ),
  paused: z.boolean(),
  accountingStatus: z.enum(['OPEN', 'FROZEN']),
  executors: z.array(
    z.strictObject({ executor: address, allowed: z.boolean() }),
  ),
  mandates: z.array(MandateViewSchema),
  treasury: z.array(
    z.strictObject({ asset: address, balance: uint, lastBlock: block }),
  ),
  grantsExecuted: z.array(
    z.strictObject({
      nonce: uint,
      intentHash: bytes32,
      mandateId: bytes32,
      mandateVersion: uint,
      executor: address,
      token: address,
      recipient: address,
      tokenAmount: uint,
      nativeValue: uint,
      outputAmount: uint,
      transactionHash: bytes32,
      blockNumber: block,
    }),
  ),
  cancelledNonces: z.array(uint),
  createdBlock: block,
  createdTransaction: bytes32,
});
export type GroupState = z.output<typeof GroupStateSchema>;

export const BuildIdentitySchema = z.strictObject({
  id: z.string().regex(/^0x[0-9a-f]{32}$/),
  store: z.string().min(1),
  configHash: bytes32,
});
export type BuildIdentity = z.output<typeof BuildIdentitySchema>;

export const GroupSnapshotSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceChainId: block.positive(),
  profile: z.string(),
  build: BuildIdentitySchema,
  indexedThroughBlock: block,
  generation: block,
  groupRevision: block,
  revisionLineage: bytes32.nullable(),
  stateHash: bytes32,
  group: GroupStateSchema,
});
export type GroupSnapshot = z.output<typeof GroupSnapshotSchema>;

export const ProgressSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sourceChainId: block.positive(),
  profile: z.string(),
  build: BuildIdentitySchema,
  indexedThroughBlock: block,
  generation: block,
  lineage: bytes32,
  frozenGroups: z.array(bytes32),
  groups: z.array(
    z.strictObject({
      groupId: bytes32,
      account: address,
      revision: block,
      accountingStatus: z.enum(['OPEN', 'FROZEN']),
    }),
  ),
});
export type Progress = z.output<typeof ProgressSchema>;

export const CheckpointStampSchema = z.strictObject({
  build: BuildIdentitySchema,
  generation: block,
  lineage: bytes32,
});
export type CheckpointStamp = z.output<typeof CheckpointStampSchema>;

export const GroupStampSchema = z.strictObject({
  build: BuildIdentitySchema,
  generation: block,
  indexedThroughBlock: block,
  groupRevision: block,
  revisionLineage: bytes32.nullable(),
  accountingStatus: z.enum(['OPEN', 'FROZEN']),
});
export type GroupStamp = z.output<typeof GroupStampSchema>;

export const FRESHNESS_STATUSES = [
  'FRESH',
  'STALE',
  'FROZEN',
  'INCONSISTENT',
] as const;
export const FreshnessSchema = z.strictObject({
  sourceChainId: block.positive(),
  indexedThroughBlock: block,
  observedHead: block,
  observedAt: z.number().int().nonnegative(),
  lagBlocks: block,
  maxLagBlocks: block,
  status: z.enum(FRESHNESS_STATUSES),
});
export type Freshness = z.output<typeof FreshnessSchema>;

export function groupState(
  tables: Tables,
  groupId: Hex,
  artifacts: ReadonlySet<string>,
): GroupState | null {
  const g = tables.get('group', groupId);
  if (!g) return null;
  const mine = <T extends { group_id: Hex }>(rows: T[]) =>
    rows.filter((r) => r.group_id === groupId);
  const byString =
    <T>(f: (x: T) => string) =>
    (a: T, b: T) =>
      f(a) < f(b) ? -1 : f(a) > f(b) ? 1 : 0;
  const byBig =
    <T>(f: (x: T) => string) =>
    (a: T, b: T) =>
      BigInt(f(a)) < BigInt(f(b)) ? -1 : BigInt(f(a)) > BigInt(f(b)) ? 1 : 0;
  const versions = mine(tables.rows('mandate_version'));
  return GroupStateSchema.parse({
    groupId: g.group_id,
    account: g.account,
    registry: g.registry,
    module: g.module,
    creator: g.creator,
    salt: g.salt,
    owners: mine(tables.rows('owner'))
      .map((o) => o.owner)
      .sort(),
    threshold: g.threshold,
    guard: g.guard,
    safeModules: mine(tables.rows('safe_module'))
      .sort(byString((m) => m.module))
      .map((m) => ({ module: m.module, enabled: m.enabled })),
    paused: g.paused,
    accountingStatus: g.accounting_status,
    executors: mine(tables.rows('executor'))
      .sort(byString((m) => m.executor))
      .map((m) => ({ executor: m.executor, allowed: m.allowed })),
    mandates: mine(tables.rows('mandate'))
      .sort(byString((m) => m.mandate_id))
      .map((m) => ({
        mandateId: m.mandate_id,
        status: m.status,
        currentVersion: m.current_version,
        minValidVersion: m.min_valid_version,
        spentToken: m.spent_token,
        spentNative: m.spent_native,
        versions: versions
          .filter((v) => v.mandate_id === m.mandate_id)
          .sort(byBig((v) => v.version))
          .map((v) => ({
            version: v.version,
            mandateHash: v.mandate_hash,
            token: v.token,
            maxTokenPerAction: v.max_token_per_action,
            maxNativePerAction: v.max_native_per_action,
            cumulativeTokenCap: v.cumulative_token_cap,
            cumulativeNativeCap: v.cumulative_native_cap,
            validAfter: v.valid_after,
            validUntil: v.valid_until,
            callTargets: [...v.call_targets],
            callSelectors: [...v.call_selectors],
            recipients: [...v.recipients],
            securitySensitive: v.security_sensitive,
            configuredBlock: v.configured_block,
            configuredTx: v.configured_tx,
            artifact: artifacts.has(v.mandate_hash) ? 'VERIFIED' : 'MISSING',
          })),
      })),
    treasury: tables
      .rows('balance')
      .filter((b) => b.account === g.account)
      .sort(byString((b) => b.asset))
      .map((b) => ({
        asset: b.asset,
        balance: b.balance,
        lastBlock: b.last_block,
      })),
    grantsExecuted: mine(tables.rows('grant_executed'))
      .sort(byBig((x) => x.nonce))
      .map((x) => ({
        nonce: x.nonce,
        intentHash: x.intent_hash,
        mandateId: x.mandate_id,
        mandateVersion: x.mandate_version,
        executor: x.executor,
        token: x.token,
        recipient: x.recipient,
        tokenAmount: x.token_amount,
        nativeValue: x.native_value,
        outputAmount: x.output_amount,
        transactionHash: x.tx_hash,
        blockNumber: x.block_number,
      })),
    cancelledNonces: mine(tables.rows('cancelled_nonce'))
      .sort(byBig((x) => x.nonce))
      .map((x) => x.nonce),
    createdBlock: g.created_block,
    createdTransaction: g.created_tx,
  });
}

export function groupStateHash(state: GroupState): Hex {
  return keccak256(stringToHex(canonicalJson(state)));
}
