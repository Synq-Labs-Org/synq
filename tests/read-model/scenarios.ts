import { describe, expect, it } from 'vitest';
import {
  type ProjectionStore,
  ProjectionReader,
  Projector,
  ReadModelError,
  registerMandateArtifacts,
  defaultArtifactHasher,
  type ChainEvent,
  type ProjectionConfig,
} from '../../packages/read-model/src/index.js';
import {
  account,
  address,
  ausdLower,
  blockHash,
  chainId,
  config,
  creation,
  ev,
  execution,
  funding,
  governance,
  groupId,
  lifecycle,
  mandateId,
  mandateTerms,
  owners,
  recipient,
  tx,
  word,
} from './fixtures.js';

export type StoreFactory = () => Promise<ProjectionStore>;
export function projectionScenarios(label: string, makeStore: StoreFactory) {
  async function setup(cfg: ProjectionConfig = config()) {
    const store = await makeStore();
    return {
      store,
      projector: new Projector(store, cfg),
      reader: new ProjectionReader(store, cfg),
    };
  }
  const code = (e: unknown) =>
    e instanceof ReadModelError ? e.code : String(e);
  async function expectCode(p: Promise<unknown>, c: string) {
    await p.then(
      () => expect.fail(`expected ${c}`),
      (e: unknown) => expect(code(e)).toBe(c),
    );
  }

  describe(`${label}: incremental projection of the Safe group lifecycle`, () => {
    it('replays from the deployment block into normalized entities', async () => {
      const { projector, reader } = await setup();
      const out = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 110,
        events: lifecycle(),
      });
      expect(out.appended).toBe(lifecycle().length);
      const snap = await reader.groupSnapshot(groupId);
      expect(snap?.indexedThroughBlock).toBe(110);
      expect(snap?.group.owners).toEqual([...owners].sort());
      expect(snap?.group.threshold).toBe('2');
      expect(snap?.group.safeModules).toEqual([
        { module: config().module, enabled: true },
      ]);
      expect(snap?.group.treasury).toEqual([
        { asset: ausdLower, balance: '750000', lastBlock: 104 },
      ]);
      expect(snap?.group.mandates[0]).toMatchObject({
        mandateId,
        status: 'ACTIVE',
        currentVersion: '1',
        spentToken: '250000',
      });
      expect(snap?.group.grantsExecuted).toHaveLength(1);
      expect(snap?.group.executors).toEqual([
        { executor: address(0xe1), allowed: true },
      ]);
      expect(snap?.group.accountingStatus).toBe('OPEN');
    });

    it('applies membership, threshold, pause and supersession changes', async () => {
      const { projector, reader } = await setup();
      const t = tx('owners');
      const sup = tx('supersede');
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 110,
        events: [
          ...lifecycle(),
          ev('AddedOwner', 105, { owner: address(4) }, { tx: t, logIndex: 0 }),
          ev(
            'RemovedOwner',
            105,
            { owner: owners[0]! },
            { tx: t, logIndex: 1 },
          ),
          ev(
            'ChangedThreshold',
            105,
            { threshold: '3' },
            { tx: t, logIndex: 2 },
          ),
          ev('Paused', 106, { groupId, account }),
          ev(
            'MandateConfigured',
            107,
            {
              groupId,
              account,
              mandateId,
              version: '2',
              ...mandateTerms,
              maxTokenPerAction: '400000',
            },
            { tx: sup, logIndex: 0 },
          ),
          ev(
            'MandateSuperseded',
            107,
            {
              groupId,
              account,
              mandateId,
              newVersion: '2',
              previousVersion: '1',
              securitySensitive: true,
              minValidVersion: '2',
            },
            { tx: sup, logIndex: 1 },
          ),
        ],
      });
      const g = (await reader.groupSnapshot(groupId))!.group;
      expect(g.owners).toEqual([owners[1], owners[2], address(4)].sort());
      expect(g.threshold).toBe('3');
      expect(g.paused).toBe(true);
      expect(g.mandates[0]).toMatchObject({
        currentVersion: '2',
        minValidVersion: '2',
      });
      expect(g.mandates[0]!.versions.map((v) => v.securitySensitive)).toEqual([
        false,
        true,
      ]);
    });

    it('is incremental: later windows only append and are idempotent on replay', async () => {
      const { projector, reader, store } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 102,
        events: [...creation(101), funding(102)],
      });
      const second = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 104,
        events: lifecycle(),
      });
      expect(second.appended).toBe(governance().length + execution().length);
      expect(second.duplicates).toBe(creation().length + 1);
      const again = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 104,
        events: lifecycle(),
      });
      expect(again.appended).toBe(0);
      expect(again.generation).toBe(second.generation);
      expect(await store.read((s) => s.journalRange(0, 1000))).toHaveLength(
        lifecycle().length,
      );
      expect(
        (await reader.groupSnapshot(groupId))!.group.treasury[0]!.balance,
      ).toBe('750000');
    });

    it('AUSD-004: the same transfer delivered twice is credited once (tx/log identity)', async () => {
      const { projector, reader } = await setup();
      const fund = funding(102);
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 102,
        events: [...creation(), fund, fund],
      });
      await projector.applyWindow({
        fromBlockExclusive: 101,
        toBlockInclusive: 103,
        events: [fund],
      });
      expect(
        (await reader.groupSnapshot(groupId))!.group.treasury[0]!.balance,
      ).toBe('1000000');
    });

    it('rejects the same tx/log identity with different content and a tx in two blocks', async () => {
      const { projector } = await setup();
      const fund = funding(102);
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 99,
          toBlockInclusive: 103,
          events: [
            ...creation(),
            fund,
            { ...fund, payload: { ...fund.payload, value: '5' } },
          ],
        }),
        'CONFLICTING_DUPLICATE',
      );
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 102,
        events: [...creation(), fund],
      });
      const moved = {
        ...fund,
        blockNumber: 150,
        blockHash: blockHash(150),
        logIndex: 3,
      };
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 102,
          toBlockInclusive: 150,
          events: [moved],
        }),
        'CONFLICTING_DUPLICATE',
      );
    });

    it('R4: detects gaps instead of silently accepting events below the checkpoint', async () => {
      const { projector } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 120,
        events: creation(),
      });
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 125,
          toBlockInclusive: 130,
          events: [],
        }),
        'GAP_DETECTED',
      );
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 110,
          toBlockInclusive: 130,
          events: [funding(105)],
        }),
        'GAP_DETECTED',
      );
      const missed = funding(105);
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 100,
          toBlockInclusive: 130,
          events: [
            ...creation(),
            {
              ...missed,
              blockHash: blockHash(101),
              blockNumber: 101,
              transactionIndex: 1,
            },
          ],
        }),
        'INCONSISTENT_PROOF',
      );
      expect((await projector.checkpoint()).indexedThroughBlock).toBe(120);
    });

    it('fails closed on unknown event versions and names without mutating state', async () => {
      const { projector } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 101,
        events: creation(),
      });
      const before = await projector.checkpoint();
      const fund = funding(102);
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 101,
          toBlockInclusive: 103,
          events: [{ ...fund, schemaVersion: 2 }],
        }),
        'UNKNOWN_EVENT_VERSION',
      );
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 101,
          toBlockInclusive: 103,
          events: [{ ...fund, eventName: 'Minted' }],
        }),
        'UNKNOWN_EVENT_VERSION',
      );
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 101,
          toBlockInclusive: 103,
          events: [{ ...fund, payload: { ...fund.payload, extra: '1' } }],
        }),
        'INVALID_EVENT',
      );
      expect(await projector.checkpoint()).toEqual(before);
    });

    it('rejects untrusted sources, non-AUSD transfers and unbound Safe events', async () => {
      const { projector } = await setup();
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 99,
          toBlockInclusive: 101,
          events: creation().map((e) =>
            e.eventName === 'GroupBound'
              ? { ...e, contract: address(0xdead) }
              : e,
          ),
        }),
        'UNTRUSTED_SOURCE',
      );
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 101,
        events: creation(),
      });
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 101,
          toBlockInclusive: 102,
          events: [{ ...funding(102), contract: address(0x5555) }],
        }),
        'UNTRUSTED_SOURCE',
      );
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 101,
          toBlockInclusive: 102,
          events: [
            ev(
              'AddedOwner',
              102,
              { owner: address(9) },
              { contract: address(0x777) },
            ),
          ],
        }),
        'UNBOUND_ACCOUNT_EVENT',
      );
    });

    it('rejects a spend that does not reconcile with cumulative registry state', async () => {
      const { projector } = await setup();
      const bad = execution(104).map((e) =>
        e.eventName === 'SpendRecorded'
          ? { ...e, payload: { ...e.payload, spentToken: '1' } }
          : e,
      );
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 99,
          toBlockInclusive: 104,
          events: [...creation(), funding(102), ...governance(), ...bad],
        }),
        'INCONSISTENT_PROOF',
      );
    });

    it('flags a negative balance as missing treasury history', async () => {
      const { projector } = await setup();
      await expectCode(
        projector.applyWindow({
          fromBlockExclusive: 99,
          toBlockInclusive: 102,
          events: [
            ...creation(),
            ev('Transfer', 102, { from: account, to: recipient, value: '1' }),
          ],
        }),
        'NEGATIVE_BALANCE',
      );
    });
  });

  describe(`${label}: reorg handling by block-hash ancestry (R1 / AUSD-004)`, () => {
    it('a Transfer moved to a different height is credited once, orphan removed, accounting frozen then reopened', async () => {
      const { projector, reader, store } = await setup();
      const reopened: unknown[] = [];
      projector.onReconciliationReopened((s) => {
        reopened.push(...s);
      });
      const fundTx = tx('moving-transfer');
      const original = ev(
        'Transfer',
        102,
        { from: address(0xfa), to: account, value: '1000000' },
        { tx: fundTx, logIndex: 0, branch: 'a' },
      );
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 103,
        events: [...creation(), original],
      });
      expect(
        (await reader.groupSnapshot(groupId))!.group.treasury[0]!.balance,
      ).toBe('1000000');

      const moved = ev(
        'Transfer',
        103,
        { from: address(0xfa), to: account, value: '1000000' },
        { tx: fundTx, logIndex: 4, branch: 'b' },
      );
      const out = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 103,
        events: [...creation(), moved],
      });
      expect(out.reorg).toEqual({
        forkBlock: 102,
        removed: 1,
        orphaned: 1,
        reapplied: 1,
      });
      expect(out.reopened).toHaveLength(1);
      expect(out.reopened[0]).toMatchObject({
        transactionHash: fundTx,
        logIndex: 0,
        orphanedBlockHash: blockHash(102, 'a'),
        eventName: 'Transfer',
        groupIds: [groupId],
        status: 'OPEN',
      });
      expect(reopened).toHaveLength(1);
      let snap = (await reader.groupSnapshot(groupId))!;
      expect(snap.group.treasury[0]!.balance).toBe('1000000');
      expect(snap.group.accountingStatus).toBe('FROZEN');
      expect(
        await store.read((s) => s.journalByTransactions([fundTx])),
      ).toHaveLength(1);
      expect((await reader.progress()).frozenGroups).toEqual([groupId]);

      const later = await projector.applyWindow({
        fromBlockExclusive: 103,
        toBlockInclusive: 104,
        events: [],
      });
      expect(later.resolved).toHaveLength(1);
      expect(later.resolved[0]).toMatchObject({
        resolution: 'REOBSERVED',
        reobservedBlock: 103,
      });
      snap = (await reader.groupSnapshot(groupId))!;
      expect(snap.group.accountingStatus).toBe('OPEN');
      expect(snap.group.treasury[0]!.balance).toBe('1000000');
    });

    it('removes events of an orphaned block that never reappear and keeps the group frozen until resolved', async () => {
      const { projector, reader } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 104,
        events: lifecycle(),
      });
      const out = await projector.applyWindow({
        fromBlockExclusive: 100,
        toBlockInclusive: 106,
        events: [
          ...creation(),
          funding(102),
          ...governance(103),
          ev('Paused', 105, { groupId, account }, { branch: 'c' }),
        ],
      });
      expect(out.reorg?.forkBlock).toBe(104);
      expect(out.reopened.map((x) => x.eventName).sort()).toEqual([
        'GrantExecuted',
        'SpendRecorded',
        'Transfer',
      ]);
      expect(
        out.reopened.find((x) => x.eventName === 'GrantExecuted'),
      ).toMatchObject({ nonce: '1', intentHash: word('intent-1') });
      const g = (await reader.groupSnapshot(groupId))!.group;
      expect(g.treasury[0]!.balance).toBe('1000000');
      expect(g.grantsExecuted).toHaveLength(0);
      expect(g.mandates[0]!.spentToken).toBe('0');
      expect(g.paused).toBe(true);
      expect(g.accountingStatus).toBe('FROZEN');
      const later = await projector.applyWindow({
        fromBlockExclusive: 106,
        toBlockInclusive: 130,
        events: [],
      });
      expect(later.resolved).toHaveLength(0);
      expect(
        (await reader.groupSnapshot(groupId))!.group.accountingStatus,
      ).toBe('FROZEN');
      for (const s of out.reopened)
        await projector.resolveSignal(
          s.id,
          'DROPPED',
          'receipt not found at head 130',
        );
      expect(
        (await reader.groupSnapshot(groupId))!.group.accountingStatus,
      ).toBe('OPEN');
    });

    it('follows an indexer rollback below the checkpoint within the reorg window', async () => {
      const { projector, reader } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 110,
        events: lifecycle(),
      });
      const out = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 103,
        sourceProgressBlock: 103,
        events: [...creation(), funding(102), ...governance(103)],
      });
      expect(out.indexedThroughBlock).toBe(103);
      expect(out.reorg?.forkBlock).toBe(104);
      expect(
        (await reader.groupSnapshot(groupId))!.group.accountingStatus,
      ).toBe('FROZEN');
    });

    it('a reorg that removes group creation removes the group and its balances', async () => {
      const { projector, reader } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 102,
        events: [...creation(101), funding(102)],
      });
      const out = await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 103,
        events: [],
      });
      expect(out.reorg?.forkBlock).toBe(101);
      expect(await reader.groupSnapshot(groupId)).toBeNull();
      expect(out.reopened.map((x) => x.groupIds)).toEqual([[]]);
    });
  });

  describe(`${label}: deterministic rebuild with canonical mandate artifacts`, () => {
    it('rebuilding from indexed proof plus artifacts yields an identical state hash', async () => {
      const artifact = {
        kind: 'mandate',
        id: 'mandate-1',
        caps: { perAction: '500000' },
      };
      const cfg = config({});
      const terms = {
        ...mandateTerms,
        mandateHash: defaultArtifactHasher(artifact),
      };
      const events: ChainEvent[] = [
        ...creation(),
        funding(102),
        ev('MandateConfigured', 103, {
          groupId,
          account,
          mandateId,
          version: '1',
          ...terms,
        }),
      ];
      const a = await setup(cfg);
      await a.projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 103,
        events: events.slice(0, 5),
      });
      await a.projector.applyWindow({
        fromBlockExclusive: 101,
        toBlockInclusive: 110,
        events: events.slice(4),
      });
      await registerMandateArtifacts(a.store, [
        { mandateHash: terms.mandateHash, artifact },
      ]);
      const b = await setup(cfg);
      await registerMandateArtifacts(b.store, [
        { mandateHash: terms.mandateHash, artifact },
      ]);
      await b.projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 110,
        events,
      });
      expect(await b.reader.stateHash()).toBe(await a.reader.stateHash());
      expect(
        (await b.reader.groupSnapshot(groupId))!.group.mandates[0]!.versions[0]!
          .artifact,
      ).toBe('VERIFIED');
      await expect(
        registerMandateArtifacts(b.store, [
          { mandateHash: word('x'), artifact },
        ]),
      ).rejects.toThrow('MANDATE_ARTIFACT_MISMATCH');
    });

    it('refuses to serve a projection built with another configuration', async () => {
      const { store, projector } = await setup();
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 101,
        events: creation(),
      });
      const other = new ProjectionReader(
        store,
        config({ confirmationDepth: 9 }),
      );
      await expectCode(other.progress(), 'CONFIG_MISMATCH');
    });
  });

  describe(`${label}: observed (non-group) accounts with a verified baseline`, () => {
    it('tracks AUSD flows for an observed account from its baseline', async () => {
      const observed = address(0xabc);
      const cfg = config({
        observedAccounts: [
          {
            account: observed,
            baselineBlock: 99,
            baselineBalances: { [ausdLower]: '30' },
            label: 'test',
          },
        ],
      });
      const { projector, store } = await setup(cfg);
      await projector.applyWindow({
        fromBlockExclusive: 99,
        toBlockInclusive: 105,
        events: [
          ev('Transfer', 103, { from: address(1), to: observed, value: '20' }),
          ev('Transfer', 104, { from: observed, to: address(2), value: '50' }),
        ],
      });
      const balances = (await store.read((s) => s.allTables())).rows('balance');
      expect(balances).toEqual([
        expect.objectContaining({
          account: observed,
          balance: '0',
          last_block: 104,
        }),
      ]);
      void chainId;
    });
  });
}
