import { describe, expect, it } from 'vitest';
import {
  HedgeGrantAuthority,
  HedgeGrantCodec,
  artifactHash,
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
  fixtureRisk,
  marketEvidence,
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
  return a.issue({ ...x, hedgeMandate: x.hm, now });
};
const withRisk = (
  risk: ReturnType<typeof fixtureRisk>,
  changes: Record<string, unknown> = {},
  factChanges: Record<string, unknown> = {},
) => {
  const intent = HedgeIntentSchema.parse(
    hedgeIntent({ riskPacketHash: artifactHash(risk), ...changes }),
  );
  return new HedgePolicy().evaluate({
    intent,
    hedgeMandate: hedgeMandate(),
    mandate: parentMandate(),
    facts: facts({ risk, ...factChanges }),
  });
};
describe('economic fields are derived from trusted evidence, never from the intent', () => {
  it('baseline evidence authorizes only the derived size', () => {
    expect(withRisk(fixtureRisk()).rejection).toBeNull();
  });
  it('F1 rejects a forged size that keeps the reported notional', () => {
    const real = hedgeIntent();
    expect(
      withRisk(fixtureRisk(), { ...real, size: '41' }).rejection?.code,
    ).toBe('ECONOMIC_MISMATCH');
  });
  it('F1 rejects a low reported notional for the real size', () => {
    expect(
      withRisk(fixtureRisk(), { notional: '1', collateral: '1' }).rejection
        ?.code,
    ).toBe('ECONOMIC_MISMATCH');
  });
  it('F1 rejects a forged post-trade liquidation buffer', () => {
    const real = HedgeIntentSchema.parse(hedgeIntent());
    expect(
      withRisk(fixtureRisk(), {
        postTradeLiquidationBufferBps:
          (real.postTradeLiquidationBufferBps ?? 0) + 500,
      }).rejection?.code,
    ).toBe('LIQUIDATION_BUFFER');
  });
  it('F1 rejects a forged hedge ratio', () => {
    expect(
      withRisk(fixtureRisk(), { postTradeHedgeRatioBps: 1 }).rejection?.code,
    ).toBe('HEDGE_EXCEEDS_MANDATE');
  });
  it('F1 rejects mismatched market price or decimals', () => {
    expect(
      withRisk(
        fixtureRisk(),
        {},
        { market: { ...marketEvidence, mark: '9000' } },
      ).status,
    ).toBe('REJECTED');
    expect(
      withRisk(
        fixtureRisk(),
        {},
        { market: { ...marketEvidence, priceDecimals: 6 } },
      ).status,
    ).toBe('REJECTED');
  });
  it('F1 rejects risk evidence in other value units than the collateral', () => {
    expect(
      withRisk({ ...fixtureRisk(), valueDecimals: 18 }).rejection?.code,
    ).toBe('ECONOMIC_MISMATCH');
  });
  it('F1 rejects blocked and stale risk packets', () => {
    expect(withRisk({ ...fixtureRisk(), blocked: true }).rejection?.code).toBe(
      'STALE_MARKET',
    );
    expect(
      withRisk({ ...fixtureRisk(), asOf: T0 * 1000 - 600_000 }).rejection?.code,
    ).toBe('STALE_MARKET');
  });
  it('F1 rejects leverage above the venue market maximum', () => {
    expect(
      withRisk(
        fixtureRisk(),
        {},
        { market: { ...marketEvidence, maxLeverageHundredths: 50 } },
      ).rejection?.code,
    ).toBe('LEVERAGE_CAP');
  });
  it('SIMULATION evidence can never sign a REAL_TESTNET grant', () => {
    const decision = withRisk(fixtureRisk(), {}, {});
    expect(decision.evidenceMode).toBe('SIMULATION');
    const intent = HedgeIntentSchema.parse(
      hedgeIntent({ riskPacketHash: artifactHash(fixtureRisk()) }),
    );
    expect(() =>
      new HedgeGrantCodec(GRANT_KEY).sign({
        decision: { ...decision, requiredApprovals: 0 },
        intent,
        hedgeMandate: hedgeMandate(),
        mandate: parentMandate(),
        approvers: [],
        executionMode: 'REAL_TESTNET',
        now: T0,
      }),
    ).toThrow(/simulation evidence cannot authorize a live order/);
  });
  it('grant lifetime is bounded by the evidence lifetime', () => {
    const decision = withRisk(fixtureRisk());
    const intent = HedgeIntentSchema.parse(
      hedgeIntent({ riskPacketHash: artifactHash(fixtureRisk()) }),
    );
    const grant = new HedgeGrantCodec(GRANT_KEY).sign({
      decision,
      intent,
      hedgeMandate: hedgeMandate(),
      mandate: parentMandate(),
      approvers: ['member_0', 'member_1'],
      now: T0,
    });
    expect(grant.expiresAt).toBeLessThanOrEqual(decision.evidenceExpiresAt);
    expect(decision.evidenceExpiresAt).toBeLessThanOrEqual(T0 + 60);
  });
});
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
        })),
      } as never),
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
