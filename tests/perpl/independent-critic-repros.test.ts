import { describe, expect, it } from 'vitest';
import {
  HedgeGrantAuthority,
  HedgeIntentSchema,
  HedgePolicy,
} from '@synq/kernel';
import { MarketCatalog, PerplRestClient } from '@synq/plugin-perpl';
import { PerplHedgeExecutor } from '@synq/perpl-executor';
import { contextFixture } from './context-fixture.js';
import { FakePerplRest, testSigner } from './fake-perpl.js';
import {
  GRANT_KEY,
  T0,
  facts,
  hedgeIntent,
  hedgeMandate,
  mainnetPerpl,
  parentMandate,
  testnetPerpl,
  members,
} from '../risk/hedge-fixtures.js';
const evaluate = (
  changes: Record<string, unknown> = {},
  parent: Record<string, unknown> = {},
) => {
  const intent = HedgeIntentSchema.parse(hedgeIntent(changes)),
    mandate = parentMandate(parent),
    hm = hedgeMandate();
  const decision = new HedgePolicy().evaluate({
    intent,
    hedgeMandate: hm,
    mandate,
    facts: facts(),
  });
  return { intent, mandate, hm, decision };
};
const issue = (a: HedgeGrantAuthority, now = T0) => {
  const x = evaluate();
  return a.issue({ ...x, hedgeMandate: x.hm, approvals: [], now });
};
describe('independent critic findings inverted to local fail-closed regressions', () => {
  it('F1 rejects executable size disconnected from reported economy', () => {
    expect(
      evaluate({
        size: '40000000',
        notional: '1',
        collateral: '1',
        postTradeHedgeRatioBps: 1,
        postTradeLiquidationBufferBps: 10000,
      }).decision.status,
    ).toBe('REJECTED');
  });
  it('F2 enforces parent caps, cumulative budget and leverage tier', () => {
    expect(
      evaluate({}, { perActionCap: '1', cumulativeBudget: '1' }).decision
        .status,
    ).toBe('REJECTED');
    expect(
      evaluate(
        {},
        {
          tierPolicy: { ...parentMandate().tierPolicy, leverage: 'CONSENSUS' },
        },
      ).decision,
    ).toMatchObject({ status: 'PENDING_APPROVAL', requiredApprovals: 2 });
  });
  it('F3 refuses claimed member approval strings', () => {
    const x = evaluate(
      {},
      { tierPolicy: { ...parentMandate().tierPolicy, leverage: 'CONSENSUS' } },
    );
    expect(() =>
      new HedgeGrantAuthority(GRANT_KEY).issue({
        ...x,
        hedgeMandate: x.hm,
        now: T0,
        approvals: members.slice(0, 2).map((m, i) => ({
          memberId: `member_${i}`,
          signer: m.address,
          intentHash: x.decision.intentHash,
        })) as never,
      }),
    ).toThrow(/APPROVALS_MISSING/);
  });
  it('F4 cannot use restartable in-memory fixture grants for a live executor', () => {
    const rest = new PerplRestClient({
      network: testnetPerpl,
      signer: testSigner('trade'),
    });
    expect(
      () =>
        new PerplHedgeExecutor({
          rest,
          grants: new HedgeGrantAuthority(GRANT_KEY),
          catalog: new MarketCatalog(
            testnetPerpl,
            contextFixture('testnet'),
            T0 * 1000,
          ),
          mode: 'REAL_TESTNET',
        }),
    ).toThrow(/PROFILE_MISMATCH/);
  });
  it('F4 cannot reissue an increasing intent through the fixture-only issuer', () => {
    const a = new HedgeGrantAuthority(GRANT_KEY);
    expect(() => issue(a)).toThrow(/APPROVALS_MISSING/);
  });
  it('F5 pending reservations are added to collateral and budget', () => {
    const x = evaluate();
    expect(
      new HedgePolicy().evaluate({
        intent: x.intent,
        mandate: x.mandate,
        hedgeMandate: x.hm,
        facts: facts({
          freeCoreTreasury: '1000000',
          reservedTreasury: '987600',
        }),
      }).status,
    ).toBe('REJECTED');
  });
  it('F6 binds the exact parent target and rejects a mismatched REST profile', () => {
    const x = evaluate();
    expect(
      new HedgePolicy().evaluate({
        intent: x.intent,
        mandate: x.mandate,
        hedgeMandate: hedgeMandate({ exchange: mainnetPerpl.exchange }),
        facts: facts(),
      }).status,
    ).toBe('REJECTED');
    const server = new FakePerplRest(
        mainnetPerpl.chainId,
        mainnetPerpl.restUrl,
      ),
      rest = new PerplRestClient({
        network: mainnetPerpl,
        signer: testSigner('trade'),
        fetch: server.fetch,
        simulation: true,
      });
    expect(
      () =>
        new PerplHedgeExecutor({
          rest,
          grants: new HedgeGrantAuthority(GRANT_KEY),
          catalog: new MarketCatalog(
            testnetPerpl,
            contextFixture('testnet'),
            0,
          ),
          mode: 'SIMULATION',
        }),
    ).toThrow(/PROFILE_MISMATCH/);
    expect(() =>
      rest.submitOrders([
        {
          rq: 1,
          mkt: 64,
          acc: 1058,
          t: 2,
          p: 2400,
          s: 1,
          lv: 100,
          fl: 4,
          lb: 0,
        },
      ]),
    ).toThrow(/mainnet orders disabled/);
  });
});
