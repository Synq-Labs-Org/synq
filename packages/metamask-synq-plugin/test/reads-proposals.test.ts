import { describe, expect, it } from 'vitest';
import { contribute } from '../src/core/contribute.js';
import { SynqPluginError } from '../src/core/errors.js';
import type { Deps } from '../src/core/group.js';
import { MemoryJournal } from '../src/core/journal.js';
import { NETWORK } from '../src/core/network.js';
import { dca, propose } from '../src/core/proposals.js';
import {
  groups,
  receipts,
  risk,
  strategies,
  treasury,
} from '../src/core/reads.js';
import { apiConfigFromEnv } from '../src/core/synq-api.js';
import { FakeSynqApi } from './fake-api.js';
import { makeDeps } from './deps.js';
import { MemorySessionStore } from '../src/core/session.js';
import { login } from '../src/core/group.js';
import type { SynqCommandId } from '../src/core/capabilities.js';
import {
  AUSD,
  CHAIN_GROUP_ID,
  FakeChain,
  GROUP_ID,
  ROGUE_SAFE,
  SAFE,
  fakeHostContext,
} from './fakes.js';

const NOW = 1_790_000_000_000;
function setup() {
  const chain = new FakeChain();
  const api = new FakeSynqApi(chain, () => NOW);
  const { ctx, log } = fakeHostContext(chain);
  const store = new MemorySessionStore();
  const deps = (id: SynqCommandId): Deps =>
    makeDeps(ctx, api.fetch, id, store, () => NOW);
  return { chain, api, log, deps, store };
}
const signedIn = async () => {
  const t = setup();
  await login(t.deps('synq:login'), GROUP_ID);
  return t;
};
const mandate = () => ({
  schemaVersion: 2,
  mandateId: 'dca-weekly',
  groupId: GROUP_ID,
  version: 1,
  status: 'ACTIVE',
  network: {
    profile: NETWORK.profile,
    chainId: NETWORK.chainId,
    providerEnvironment: 'sandbox',
  },
  account: SAFE.toLowerCase(),
  chainGroupId: CHAIN_GROUP_ID,
  inputAsset: {
    canonicalAssetId: `eip155:${NETWORK.chainId}/erc20:${AUSD.toLowerCase()}`,
    chainId: NETWORK.chainId,
    address: AUSD.toLowerCase(),
    symbol: 'AUSD',
    decimals: 6,
  },
  validAfter: 1,
  validUntil: 2,
});

describe('read commands', () => {
  it('groups lists verified groups and the caller membership; unverifiable groups are flagged', async () => {
    const t = setup();
    const r = await groups(t.deps('synq:groups'), [GROUP_ID, 'missing']);
    expect(r.groups[0]).toMatchObject({
      groupId: GROUP_ID,
      safe: SAFE,
      verifiedOnChain: true,
      myMembership: 'ACTIVE',
      activeMembers: 2,
    });
    expect(r.groups[1]).toMatchObject({
      groupId: 'missing',
      verifiedOnChain: false,
    });
    await expect(groups(t.deps('synq:groups'), [])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(
      t.log.flatMap((l) => l.requests).filter((r) => r.kind === 'transaction'),
    ).toHaveLength(0);
  });

  it('treasury cross-checks the indexed balance against the chain', async () => {
    const t = await signedIn();
    t.chain.balances.set(SAFE.toLowerCase(), 3_000_000n);
    const r = await treasury(t.deps('synq:treasury'), GROUP_ID);
    expect(r).toMatchObject({
      safe: SAFE,
      onChainBalance: '3',
      indexedBalance: '3',
      consistent: true,
    });
    t.chain.accountOf.set(CHAIN_GROUP_ID, ROGUE_SAFE);
    await expect(
      treasury(t.deps('synq:treasury'), GROUP_ID),
    ).rejects.toMatchObject({ code: 'WRONG_SAFE' });
  });

  it('risk and strategies project the Synq world snapshot', async () => {
    const t = await signedIn();
    const r = await risk(t.deps('synq:risk'), GROUP_ID);
    expect(r).toMatchObject({
      status: 'HEALTHY',
      referenceDeviationBps: 12,
      market: [{ pair: 'MON/AUSD', price: '3.5' }],
    });
    const s = await strategies(t.deps('synq:strategies'), GROUP_ID);
    expect(s.mandates[0]).toMatchObject({
      mandateId: 'dca-1',
      perActionCap: '2',
      cumulativeBudget: '20',
      spent: '4',
    });
    expect(s.workflows[0]).toMatchObject({ type: 'DCA', status: 'RUNNING' });
  });

  it('receipts joins local submissions with indexed deposits', async () => {
    const t = await signedIn();
    const journal = new MemoryJournal();
    const c = await contribute(
      t.deps('synq:contribute'),
      { groupId: GROUP_ID, amount: '1' },
      { journal, reconcileDelayMs: 0, sleep: async () => {} },
    );
    const r = await receipts(t.deps('synq:receipts'), journal, GROUP_ID);
    expect(r.local[0]).toMatchObject({
      state: 'CREDITED',
      amount: '1',
      indexed: true,
    });
    expect(r.indexed[0]!.txHash).toBe(
      c.mode === 'REAL_TESTNET' ? c.txHash : '',
    );
  });

  it('authenticated reads need a member session and never sign on their own', async () => {
    const t = setup();
    await expect(
      treasury(t.deps('synq:treasury'), GROUP_ID),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(t.log).toHaveLength(0);
    const r = await login(t.deps('synq:login'), GROUP_ID);
    expect(r).toMatchObject({ memberId: 'alice', scope: 'MEMBER_CONTRIBUTE' });
    expect(t.log.flatMap((l) => l.requests).map((q) => q.kind)).toEqual([
      'typed-data',
    ]);
    expect((await treasury(t.deps('synq:treasury'), GROUP_ID)).safe).toBe(SAFE);
    expect(t.api.challengesIssued).toBe(1);
  });

  it('an expiring session is refused for reads instead of silently re-signing', async () => {
    const t = setup();
    let now = NOW;
    const at = (id: SynqCommandId) =>
      makeDeps(
        fakeHostContext(t.chain).ctx,
        t.api.fetch,
        id,
        t.store,
        () => now,
      );
    await login(at('synq:login'), GROUP_ID);
    now += 290_000;
    await expect(treasury(at('synq:treasury'), GROUP_ID)).rejects.toMatchObject(
      {
        code: 'SESSION_REQUIRED',
      },
    );
  });

  it('refuses the operator token and plain-http remote API URLs', () => {
    expect(() =>
      apiConfigFromEnv({ SYNQ_API_TOKEN: 'operator-admin-token' }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      apiConfigFromEnv({ SYNQ_API_URL: 'http://synq.example.com' }),
    ).toThrow(SynqPluginError);
    expect(
      apiConfigFromEnv({ SYNQ_API_URL: 'https://synq.example.com/' }).baseUrl,
    ).toBe('https://synq.example.com');
  });
});

describe('propose and dca', () => {
  it('propose posts a bound mandate and reports that quorum is still required', async () => {
    const t = await signedIn();
    const r = await propose(t.deps('synq:propose'), {
      groupId: GROUP_ID,
      mandate: mandate(),
      change: 'NEW',
    });
    expect(r).toMatchObject({
      state: 'PENDING',
      authority: 'GROUP_QUORUM_REQUIRED',
      approvals: { counted: 0, required: 2 },
    });
    expect(t.api.calls.some((c) => /approvals/.test(c.path))).toBe(false);
    expect(
      t.log.flatMap((l) => l.requests).filter((r) => r.kind === 'transaction'),
    ).toHaveLength(0);
  });

  it('propose rejects a mandate for another Safe, group or chain', async () => {
    const t = await signedIn();
    const d = t.deps('synq:propose');
    await expect(
      propose(d, {
        groupId: GROUP_ID,
        mandate: { ...mandate(), account: ROGUE_SAFE },
        change: 'NEW',
      }),
    ).rejects.toMatchObject({ code: 'WRONG_SAFE' });
    await expect(
      propose(d, {
        groupId: GROUP_ID,
        mandate: { ...mandate(), chainGroupId: `0x${'00'.repeat(32)}` },
        change: 'NEW',
      }),
    ).rejects.toMatchObject({ code: 'MANDATE_MISMATCH' });
    await expect(
      propose(d, {
        groupId: GROUP_ID,
        mandate: {
          ...mandate(),
          network: { profile: 'proof/monad-mainnet', chainId: 143 },
        },
        change: 'NEW',
      }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    expect(t.api.calls.some((c) => c.path === '/v1/mandate-proposals')).toBe(
      false,
    );
  });

  it('dca shapes a bounded cadence mandate and proposes it', async () => {
    const t = await signedIn();
    const until = NOW / 1000 + 86_400 * 60;
    const r = await dca(t.deps('synq:dca'), {
      groupId: GROUP_ID,
      template: mandate(),
      perBuy: '2',
      budget: '20',
      intervalSeconds: 604_800,
      maxExecutions: 10,
      validUntil: until,
      change: 'NEW',
    });
    expect(r.state).toBe('PENDING');
    const sent = t.api.calls.find((c) => c.path === '/v1/mandate-proposals')!
      .body as { mandate: Record<string, unknown> };
    expect(sent.mandate).toMatchObject({
      perActionCap: '2000000',
      cumulativeBudget: '20000000',
      minIntervalSeconds: 604_800,
      maxExecutions: 10,
      validUntil: until,
    });
    const base = {
      groupId: GROUP_ID,
      template: mandate(),
      perBuy: '2',
      budget: '20',
      intervalSeconds: 604_800,
      maxExecutions: 10,
      validUntil: until,
      change: 'NEW' as const,
    };
    const d = t.deps('synq:dca');
    await expect(dca(d, { ...base, perBuy: '30' })).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    await expect(
      dca(d, { ...base, intervalSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(dca(d, { ...base, maxExecutions: 2 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(dca(d, { ...base, validUntil: 1 })).rejects.toMatchObject({
      code: 'INTENT_EXPIRED',
    });
    await expect(
      dca(d, {
        ...base,
        template: {
          ...mandate(),
          inputAsset: { ...mandate().inputAsset, address: ROGUE_SAFE },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });
});
