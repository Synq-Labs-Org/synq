import { keccak256, stringToHex } from 'viem';
import { z } from 'zod';
import type { ProjectionConfig } from './config.js';
import { canonicalJson, eventKey, type ChainEventOf } from './events.js';
import { initialCheckpoint } from './projector.js';
import type { ProjectionStore } from './store.js';
import type { Hex } from './tables.js';
import type { GroupSnapshot } from './views.js';

/** Bible §19/§96 buckets as the WorldSnapshot treasury view exposes them. */
export const TREASURY_VIEW_BUCKETS = [
  'CORE_AUSD',
  'USDC_SETTLEMENT_BUFFER',
  'MON_GAS_BUFFER',
  'STRATEGY_POSITIONS',
  'RESERVED',
  'PENDING_FUNDING',
  'EXTERNAL_COLLATERAL',
] as const;
export type TreasuryViewBucket = (typeof TREASURY_VIEW_BUCKETS)[number];
export const TREASURY_PROVENANCE = [
  'ENVIO',
  'POSTGRES',
  'CHAIN',
  'KERNEL',
  'PLUGIN',
  'TEMPORAL',
] as const;
export type TreasuryProvenance = (typeof TREASURY_PROVENANCE)[number];

const uint = z.string().regex(/^(0|[1-9][0-9]{0,77})$/);
const address = z.string().regex(/^0x[0-9a-f]{40}$/);
export const TreasuryAssetRefSchema = z.strictObject({
  canonicalAssetId: z.string().min(1),
  chainId: z.number().int().positive(),
  address: z.union([address, z.literal('native')]),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
});
export type TreasuryAssetRef = z.output<typeof TreasuryAssetRefSchema>;
export const TreasuryLineSchema = z.strictObject({
  bucket: z.enum(TREASURY_VIEW_BUCKETS),
  asset: TreasuryAssetRefSchema,
  amount: uint,
  provenance: z.enum(TREASURY_PROVENANCE),
  asOfBlock: z.number().int().nonnegative().nullable(),
  label: z.string().min(1),
  /** True only for the core free AUSD figure; every other line is not spendable capital. */
  countsAsFree: z.boolean(),
});
export type TreasuryLine = z.output<typeof TreasuryLineSchema>;
export const ContributionSchema = z.strictObject({
  transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  logIndex: z.number().int().nonnegative(),
  blockNumber: z.number().int().nonnegative(),
  from: address,
  amount: uint,
});
export type Contribution = z.output<typeof ContributionSchema>;
export const TreasuryViewSchema = z.strictObject({
  schemaVersion: z.literal(1),
  groupId: z.string().regex(/^0x[0-9a-f]{64}$/),
  account: address,
  chainId: z.number().int().positive(),
  indexedThroughBlock: z.number().int().nonnegative(),
  groupStateHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  coreAsset: TreasuryAssetRefSchema,
  core: z.strictObject({
    balance: uint,
    reserved: uint,
    pendingDebits: uint,
    free: uint,
    overcommitted: z.boolean(),
  }),
  pendingInbound: uint,
  externalCollateral: uint,
  buckets: z.array(TreasuryLineSchema),
  contributions: z.strictObject({
    total: uint,
    count: z.number().int().nonnegative(),
    byContributor: z.array(
      z.strictObject({
        from: address,
        amount: uint,
        count: z.number().int().positive(),
      }),
    ),
    events: z.array(ContributionSchema),
  }),
  viewHash: z.string().regex(/^0x[0-9a-f]{64}$/),
});
export type TreasuryView = z.output<typeof TreasuryViewSchema>;

export type TreasuryAmountInput = {
  asset: TreasuryAssetRef;
  amount: bigint;
  provenance: TreasuryProvenance;
  asOfBlock: number | null;
  label: string;
};
export type PendingFundingInput = {
  sessionId: string;
  state: string;
  route: string;
  asset: TreasuryAssetRef;
  /** Expected destination amount (minimum), never credited before receipt. */
  amount: bigint;
};

export type TreasuryViewInput = {
  snapshot: GroupSnapshot;
  coreAsset: TreasuryAssetRef;
  contributions: readonly Contribution[];
  /** Kernel reservations of the core asset (outstanding grants). */
  reserved: readonly TreasuryAmountInput[];
  /** Outbound core-asset debits executed or submitted but not yet indexed. */
  pendingDebits: readonly TreasuryAmountInput[];
  pendingFunding: readonly PendingFundingInput[];
  settlementBuffer?: TreasuryAmountInput | null;
  gasBuffer?: TreasuryAmountInput | null;
  strategyPositions?: readonly TreasuryAmountInput[];
  externalCollateral?: readonly TreasuryAmountInput[];
};

const sum = (xs: readonly { amount: bigint }[]) =>
  xs.reduce((a, x) => a + x.amount, 0n);

function line(
  bucket: TreasuryViewBucket,
  x: TreasuryAmountInput,
  countsAsFree = false,
): TreasuryLine {
  if (x.amount < 0n) throw new Error(`negative ${bucket} amount`);
  return {
    bucket,
    asset: x.asset,
    amount: String(x.amount),
    provenance: x.provenance,
    asOfBlock: x.asOfBlock,
    label: x.label,
    countsAsFree,
  };
}

/**
 * Pure treasury accounting over the indexed projection. Free core capital is
 * core − reserved − pending debits; pending inbound funding, external
 * collateral, buffers and strategy positions are never free.
 */
export function buildTreasuryView(input: TreasuryViewInput): TreasuryView {
  const { snapshot, coreAsset } = input;
  const group = snapshot.group;
  const sameCore = (a: TreasuryAssetRef) =>
    a.canonicalAssetId === coreAsset.canonicalAssetId;
  for (const x of [...input.reserved, ...input.pendingDebits])
    if (!sameCore(x.asset))
      throw new Error('reserved/pending debits must be in the core asset');
  const coreRow = group.treasury.find((t) => t.asset === coreAsset.address);
  const balance = BigInt(coreRow?.balance ?? '0');
  const reserved = sum(input.reserved);
  const pendingDebits = sum(input.pendingDebits);
  const committed = reserved + pendingDebits;
  const free = balance > committed ? balance - committed : 0n;
  const pendingInbound = sum(
    input.pendingFunding.filter((p) => sameCore(p.asset)),
  );
  const external = sum(input.externalCollateral ?? []);
  const contributions = [
    ...new Map(
      input.contributions.map((c) => [`${c.transactionHash}:${c.logIndex}`, c]),
    ).values(),
  ].sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  const byContributor = new Map<string, { amount: bigint; count: number }>();
  for (const c of contributions) {
    const prev = byContributor.get(c.from) ?? { amount: 0n, count: 0 };
    byContributor.set(c.from, {
      amount: prev.amount + BigInt(c.amount),
      count: prev.count + 1,
    });
  }
  const buckets: TreasuryLine[] = [
    line(
      'CORE_AUSD',
      {
        asset: coreAsset,
        amount: free,
        provenance: 'ENVIO',
        asOfBlock: snapshot.indexedThroughBlock,
        label: 'free core AUSD (indexed balance − reserved − pending debits)',
      },
      true,
    ),
    ...input.reserved.map((x) => line('RESERVED', x)),
    ...input.pendingDebits.map((x) => line('RESERVED', x)),
    ...input.pendingFunding.map((p) =>
      line('PENDING_FUNDING', {
        asset: p.asset,
        amount: p.amount,
        provenance: 'TEMPORAL',
        asOfBlock: null,
        label: `${p.route} ${p.state} ${p.sessionId}`,
      }),
    ),
    ...(input.settlementBuffer
      ? [line('USDC_SETTLEMENT_BUFFER', input.settlementBuffer)]
      : []),
    ...(input.gasBuffer ? [line('MON_GAS_BUFFER', input.gasBuffer)] : []),
    ...(input.strategyPositions ?? []).map((x) =>
      line('STRATEGY_POSITIONS', x),
    ),
    ...(input.externalCollateral ?? []).map((x) =>
      line('EXTERNAL_COLLATERAL', x),
    ),
  ];
  const body = {
    schemaVersion: 1 as const,
    groupId: group.groupId,
    account: group.account,
    chainId: snapshot.sourceChainId,
    indexedThroughBlock: snapshot.indexedThroughBlock,
    groupStateHash: snapshot.stateHash,
    coreAsset,
    core: {
      balance: String(balance),
      reserved: String(reserved),
      pendingDebits: String(pendingDebits),
      free: String(free),
      overcommitted: committed > balance,
    },
    pendingInbound: String(pendingInbound),
    externalCollateral: String(external),
    buckets,
    contributions: {
      total: String(contributions.reduce((a, c) => a + BigInt(c.amount), 0n)),
      count: contributions.length,
      byContributor: [...byContributor.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([from, v]) => ({
          from,
          amount: String(v.amount),
          count: v.count,
        })),
      events: contributions,
    },
  };
  return TreasuryViewSchema.parse({
    ...body,
    viewHash: keccak256(stringToHex(canonicalJson(body))),
  });
}

/**
 * Inbound core-asset transfers into the group account from the projection's
 * event journal, through the indexed checkpoint. The journal is keyed by
 * (transaction, log index), so a re-ingested event cannot appear twice.
 */
export async function indexedContributions(
  store: ProjectionStore,
  config: ProjectionConfig,
  account: Hex,
  asset: Hex,
): Promise<{ indexedThroughBlock: number; contributions: Contribution[] }> {
  const who = account.toLowerCase() as Hex;
  const token = asset.toLowerCase() as Hex;
  return store.read(async (s) => {
    const cp = (await s.checkpoint()) ?? initialCheckpoint(config);
    const events = await s.journalByScope(
      [`a:${who}`],
      cp.indexedThroughBlock + 1,
    );
    const seen = new Set<string>();
    const contributions: Contribution[] = [];
    for (const { event } of events) {
      if (event.eventName !== 'Transfer') continue;
      const e = event as ChainEventOf<'Transfer'>;
      if (
        e.contract !== token ||
        e.payload.to !== who ||
        e.payload.from === who
      )
        continue;
      const key = eventKey(e);
      if (seen.has(key)) continue;
      seen.add(key);
      contributions.push(
        ContributionSchema.parse({
          transactionHash: e.transactionHash,
          logIndex: e.logIndex,
          blockNumber: e.blockNumber,
          from: e.payload.from,
          amount: e.payload.value,
        }),
      );
    }
    return { indexedThroughBlock: cp.indexedThroughBlock, contributions };
  });
}
