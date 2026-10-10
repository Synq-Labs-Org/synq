import { describe, expect, it } from 'vitest';
import {
  ProjectionReader,
  Projector,
  buildTreasuryView,
  indexedContributions,
  type ProjectionStore,
  type TreasuryAssetRef,
  type TreasuryViewInput,
} from '@synq/read-model';
import { officialAssets } from '@synq/chain-registry';
import {
  account,
  address,
  ausdLower,
  config,
  creation,
  execution,
  ev,
  governance,
  groupId,
  tx,
} from '../read-model/fixtures.js';

export const coreAsset: TreasuryAssetRef = {
  canonicalAssetId: officialAssets.testnetAUSD.canonicalAssetId,
  chainId: officialAssets.testnetAUSD.chainId,
  address: ausdLower,
  symbol: 'AUSD',
  decimals: 6,
};
const usdc: TreasuryAssetRef = {
  canonicalAssetId: officialAssets.testnetUSDC.canonicalAssetId,
  chainId: officialAssets.testnetUSDC.chainId,
  address: officialAssets.testnetUSDC.address.toLowerCase() as `0x${string}`,
  symbol: 'USDC',
  decimals: 6,
};
const mon: TreasuryAssetRef = {
  canonicalAssetId: `eip155:${coreAsset.chainId}/native`,
  chainId: coreAsset.chainId,
  address: 'native',
  symbol: 'MON',
  decimals: 18,
};
const alice = address(0xa11ce);
const bob = address(0xb0b);
export const contribution = (
  block: number,
  from: `0x${string}`,
  value: string,
  label: string,
) =>
  ev(
    'Transfer',
    block,
    { from, to: account, value },
    { tx: tx(`contrib-${label}`), logIndex: 0 },
  );

export function treasuryScenarios(
  label: string,
  makeStore: () => Promise<ProjectionStore>,
) {
  const cfg = config();
  async function project(events: Parameters<Projector['applyWindow']>[0][]) {
    const store = await makeStore();
    const projector = new Projector(store, cfg);
    for (const w of events) await projector.applyWindow(w);
    const reader = new ProjectionReader(store, cfg);
    return { store, projector, reader };
  }
  async function view(
    store: ProjectionStore,
    reader: ProjectionReader,
    extra: Partial<TreasuryViewInput> = {},
  ) {
    const snapshot = (await reader.groupSnapshot(groupId))!;
    const { contributions } = await indexedContributions(
      store,
      cfg,
      account,
      ausdLower,
    );
    return buildTreasuryView({
      snapshot,
      coreAsset,
      contributions,
      reserved: [],
      pendingDebits: [],
      pendingFunding: [],
      ...extra,
    });
  }
  const lifecycle = [
    ...creation(101),
    contribution(102, alice, '3000000', 'alice-1'),
    ...governance(103),
    contribution(104, bob, '2000000', 'bob-1'),
  ];
  const window = (to: number, events = lifecycle) => ({
    fromBlockExclusive: 99,
    toBlockInclusive: to,
    events: events.filter((e) => e.blockNumber <= to),
  });

  describe(`${label}: treasury accounting (B08.2/B08.3)`, () => {
    it('E2E-003/AUSD-002 direct AUSD contributions credit the indexed core balance once each', async () => {
      const { store, reader } = await project([window(110)]);
      const v = await view(store, reader);
      expect(v.core.balance).toBe('5000000');
      expect(v.core.free).toBe('5000000');
      expect(v.contributions.count).toBe(2);
      expect(v.contributions.byContributor).toEqual([
        { from: bob, amount: '2000000', count: 1 },
        { from: alice, amount: '3000000', count: 1 },
      ]);
      expect(
        v.buckets.filter((b) => b.countsAsFree).map((b) => b.bucket),
      ).toEqual(['CORE_AUSD']);
    });

    it('AUSD-004 duplicate contribution ingest (same window replayed, overlapping window) never double-credits', async () => {
      const { store, reader, projector } = await project([window(110)]);
      const replay = await projector.applyWindow(window(110));
      expect(replay.appended).toBe(0);
      expect(replay.duplicates).toBe(lifecycle.length);
      const overlap = await projector.applyWindow({
        fromBlockExclusive: 103,
        toBlockInclusive: 112,
        events: lifecycle.filter((e) => e.blockNumber > 103),
      });
      expect(overlap.appended).toBe(0);
      const v = await view(store, reader);
      expect(v.core.balance).toBe('5000000');
      expect(v.contributions.count).toBe(2);
      expect(v.contributions.total).toBe('5000000');
    });

    it('pending funding is never free; reserved and pending debits reduce free; external collateral is not free', async () => {
      const { store, reader } = await project([window(110)]);
      const v = await view(store, reader, {
        reserved: [
          {
            asset: coreAsset,
            amount: 1_000_000n,
            provenance: 'KERNEL',
            asOfBlock: null,
            label: 'outstanding grant',
          },
        ],
        pendingDebits: [
          {
            asset: coreAsset,
            amount: 500_000n,
            provenance: 'POSTGRES',
            asOfBlock: null,
            label: 'send submitted, not indexed',
          },
        ],
        pendingFunding: [
          {
            sessionId: '0xabc',
            state: 'BRIDGE_PENDING',
            route: 'AUSD_OFT',
            asset: coreAsset,
            amount: 9_000_000n,
          },
        ],
        settlementBuffer: {
          asset: usdc,
          amount: 2_000_000n,
          provenance: 'CHAIN',
          asOfBlock: 110,
          label: 'USDC edge buffer',
        },
        gasBuffer: {
          asset: mon,
          amount: 10n ** 17n,
          provenance: 'CHAIN',
          asOfBlock: 110,
          label: 'MON gas',
        },
        strategyPositions: [
          {
            asset: mon,
            amount: 5n,
            provenance: 'PLUGIN',
            asOfBlock: null,
            label: 'WMON DCA',
          },
        ],
        externalCollateral: [
          {
            asset: coreAsset,
            amount: 7_000_000n,
            provenance: 'PLUGIN',
            asOfBlock: null,
            label: 'Perpl collateral',
          },
        ],
      });
      expect(v.core).toEqual({
        balance: '5000000',
        reserved: '1000000',
        pendingDebits: '500000',
        free: '3500000',
        overcommitted: false,
      });
      expect(v.pendingInbound).toBe('9000000');
      expect(v.externalCollateral).toBe('7000000');
      const free = v.buckets.filter((b) => b.countsAsFree);
      expect(free).toHaveLength(1);
      expect(free[0]!.amount).toBe('3500000');
      expect(new Set(v.buckets.map((b) => b.bucket))).toEqual(
        new Set([
          'CORE_AUSD',
          'RESERVED',
          'PENDING_FUNDING',
          'USDC_SETTLEMENT_BUFFER',
          'MON_GAS_BUFFER',
          'STRATEGY_POSITIONS',
          'EXTERNAL_COLLATERAL',
        ]),
      );
      const over = await view(store, reader, {
        reserved: [
          {
            asset: coreAsset,
            amount: 6_000_000n,
            provenance: 'KERNEL',
            asOfBlock: null,
            label: 'r',
          },
        ],
      });
      expect(over.core.free).toBe('0');
      expect(over.core.overcommitted).toBe(true);
      await expect(
        view(store, reader, {
          reserved: [
            {
              asset: usdc,
              amount: 1n,
              provenance: 'KERNEL',
              asOfBlock: null,
              label: 'x',
            },
          ],
        }),
      ).rejects.toThrow('core asset');
    });

    it('indexer delayed: a contribution after the checkpoint is not counted until indexed', async () => {
      const { store, reader, projector } = await project([window(103)]);
      const early = await view(store, reader);
      expect(early.core.balance).toBe('3000000');
      expect(early.contributions.count).toBe(1);
      await projector.applyWindow({
        fromBlockExclusive: 103,
        toBlockInclusive: 110,
        events: lifecycle.filter((e) => e.blockNumber > 103),
      });
      const late = await view(store, reader);
      expect(late.core.balance).toBe('5000000');
      expect(late.contributions.count).toBe(2);
    });

    it('outflows reduce the balance but are not contributions', async () => {
      const events = [...lifecycle, ...execution(106, '1', '250000')];
      const { store, reader } = await project([window(110, events)]);
      const v = await view(store, reader);
      expect(v.core.balance).toBe('4750000');
      expect(v.contributions.total).toBe('5000000');
    });

    it('rebuild produces identical accounting (view hash) from the same chain events', async () => {
      const a = await project(
        [window(104), window(110)].map((w, i) =>
          i === 0
            ? w
            : {
                ...w,
                fromBlockExclusive: 104,
                events: lifecycle.filter((e) => e.blockNumber > 104),
              },
        ),
      );
      const b = await project([window(110)]);
      const va = await view(a.store, a.reader);
      const vb = await view(b.store, b.reader);
      expect(va.viewHash).toBe(vb.viewHash);
      expect(va.core).toEqual(vb.core);
      expect(va.contributions).toEqual(vb.contributions);
    });
  });
}
