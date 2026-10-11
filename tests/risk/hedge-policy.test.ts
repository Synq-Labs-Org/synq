import { describe, expect, it } from 'vitest';
import {
  HEDGE_ACTION_KINDS,
  HedgeGrantAuthority,
  HedgeGrantError,
  HedgeIntentSchema,
  HedgePolicy,
  hedgeIntentHash,
  perplOrderTypeFor,
} from '@synq/kernel';
import { officialAsset } from '@synq/chain-registry';
import {
  GRANT_KEY,
  T0,
  facts,
  factsFor,
  fixtureRisk,
  hedgeIntent,
  hedgeMandate,
  members,
  parentMandate,
  testnetPerpl,
} from './hedge-fixtures.js';
const policy = new HedgePolicy();
function setup(
  changes: Record<string, unknown> = {},
  opts: {
    hm?: Record<string, unknown>;
    mandate?: Record<string, unknown>;
    facts?: Parameters<typeof factsFor>[1];
  } = {},
) {
  let intent = HedgeIntentSchema.parse(hedgeIntent(changes));
  const facts = factsFor(intent, opts.facts);
  if (!('riskPacketHash' in changes))
    intent = {
      ...intent,
      riskPacketHash: facts.riskPacketHash as `0x${string}`,
    };
  const mandate = parentMandate(opts.mandate),
    hm = hedgeMandate(opts.hm);
  return {
    intent,
    mandate,
    hm,
    facts,
    decision: policy.evaluate({ intent, mandate, hedgeMandate: hm, facts }),
  };
}
const run = (
  changes: Record<string, unknown> = {},
  opts: Parameters<typeof setup>[1] = {},
) => setup(changes, opts).decision;
describe('Kernel hedge policy with bound exact economic evidence', () => {
  it('authorizes a bounded short inside every limit with the parent consensus floor', () => {
    expect(run()).toMatchObject({
      status: 'PENDING_APPROVAL',
      tier: 'CONSENSUS',
      requiredApprovals: 2,
      treasuryReservation: '987600',
      rejection: null,
    });
  });
  it.each([
    ['leverage violation', { leverageHundredths: 300 }, {}],
    [
      'parent leverage',
      { leverageHundredths: 200 },
      { mandate: { maxLeverageBps: 10000 } },
    ],
    ['under-collateralized', { collateral: '100' }, {}],
    ['notional cap', {}, { hm: { maxNotional: '987599' } }],
    [
      'hedge ratio cap',
      {},
      { hm: { targetHedgeRatioBps: 3000, maxHedgeRatioBps: 4000 } },
    ],
    ['forged notional', { notional: '1' }, {}],
    ['forged liquidation buffer', { postTradeLiquidationBufferBps: 10000 }, {}],
    ['unknown liquidation buffer', { postTradeLiquidationBufferBps: null }, {}],
    ['market not allowlisted', { marketId: 16 }, {}],
    ['stale market', { marketDataAt: T0 * 1000 - 200000 }, {}],
    ['market closed', {}, { facts: { marketOpen: false } }],
    ['expired intent', { createdAt: T0 - 60, expiresAt: T0 }, {}],
    ['long increases', { side: 'LONG' }, {}],
    ['risk packet mismatch', { riskPacketHash: `0x${'cd'.repeat(32)}` }, {}],
    [
      'collateral cap',
      { collateral: '6000000' },
      { hm: { maxCollateral: '5000000' } },
    ],
    ['free treasury', {}, { facts: { freeCoreTreasury: '987599' } }],
    ['account mismatch', { perplAccountId: '1' }, {}],
    ['parent cap', {}, { mandate: { perActionCap: '987599' } }],
    ['parent cumulative budget', {}, { facts: { parentSpent: '49500000' } }],
    [
      'pending cumulative budget',
      {},
      { facts: { pendingNotional: '49500000' } },
    ],
    [
      'parent leverage blocked',
      {},
      {
        mandate: {
          tierPolicy: { ...parentMandate().tierPolicy, leverage: 'BLOCKED' },
        },
      },
    ],
    [
      'missing perpl binding',
      {},
      {
        mandate: {
          bindings: [
            {
              pluginId: 'kuru',
              action: 'SPOT_TRADE',
              target: testnetPerpl.exchange,
              selector: '0x12345678',
            },
          ],
        },
      },
    ],
  ] as const)('rejects %s', (_name, changes, opts) => {
    const d = run(changes, opts as never);
    expect(d.status).toBe('REJECTED');
    expect(d.treasuryReservation).toBe('0');
  });
  it('rejects raw evidence whose hash was substituted and unavailable risk', () => {
    const x = setup();
    expect(
      policy.evaluate({
        intent: x.intent,
        mandate: x.mandate,
        hedgeMandate: x.hm,
        facts: { ...x.facts, risk: { ...fixtureRisk(), blocked: true } },
      }).rejection?.code,
    ).toBe('RISK_PACKET_MISMATCH');
    expect(run({}, { facts: { risk: undefined } }).status).toBe('REJECTED');
  });
  it('accounts for venue collateral and pending shared reservations', () => {
    expect(
      run(
        {},
        { facts: { perpFreeCollateral: '900000', freeCoreTreasury: '87600' } },
      ),
    ).toMatchObject({
      status: 'PENDING_APPROVAL',
      treasuryReservation: '87600',
    });
    expect(
      run(
        {},
        {
          facts: {
            perpFreeCollateral: '900000',
            freeCoreTreasury: '87600',
            reservedPerpCollateral: '1',
          },
        },
      ).status,
    ).toBe('REJECTED');
    expect(
      run(
        {},
        { facts: { freeCoreTreasury: '1000000', reservedTreasury: '987600' } },
      ).status,
    ).toBe('REJECTED');
    expect(run({}, { facts: { pendingHedgeNotional: '987600' } }).status).toBe(
      'REJECTED',
    );
  });
  it('rejects another collateral chain/address/decimals', () => {
    expect(
      run({}, { facts: { expectedCollateral: officialAsset('mainnetAUSD') } })
        .status,
    ).toBe('REJECTED');
    expect(() =>
      hedgeMandate({ collateralAsset: officialAsset('mainnetAUSD') }),
    ).toThrow();
    expect(
      run({}, { hm: { collateralAsset: officialAsset('testnetPerplUSD') } })
        .status,
    ).toBe('REJECTED');
  });
  it('allows bounded reduce-only on closed/stale markets and inactive windows', () => {
    for (const opts of [
      { facts: { marketOpen: false } },
      { hm: { status: 'CLOSE_ONLY' } },
      { mandate: { status: 'REVOKED' } },
      { mandate: { validUntil: T0 - 1 } },
    ]) {
      expect(run({}, opts).status).toBe('REJECTED');
      expect(
        run({ kind: 'CLOSE', leverageHundredths: 0, limitPrice: '2500' }, opts),
      ).toMatchObject({
        status: 'AUTHORIZED',
        mode: 'CLOSE_ONLY',
        riskReducing: true,
      });
    }
    expect(
      run(
        {
          kind: 'CLOSE',
          leverageHundredths: 0,
          limitPrice: '2500',
          marketDataAt: T0 * 1000 - 200000,
        },
        { facts: { market: { ...facts().market!, at: T0 * 1000 - 200000 } } },
      ).status,
    ).toBe('AUTHORIZED');
    expect(run({}, { hm: { status: 'REVOKED' } }).rejection?.code).toBe(
      'MANDATE_REVOKED',
    );
    expect(
      run({ kind: 'CLOSE', leverageHundredths: 0, size: '41' }).status,
    ).toBe('REJECTED');
    expect(
      run(
        { kind: 'CLOSE', leverageHundredths: 0 },
        { facts: { risk: fixtureRisk() } },
      ).status,
    ).toBe('REJECTED');
  });
  it.each(['CLOSE', 'REDUCE', 'CANCEL'])(
    'P10-N1 bounds %s prices to the mark slippage band',
    (kind) => {
      for (const limitPrice of ['1', '2600', '999999999'])
        expect(
          run({ kind, orderId: '10', leverageHundredths: 0, limitPrice })
            .rejection?.code,
        ).toBe('ECONOMIC_MISMATCH');
      expect(
        run({ kind, orderId: '10', leverageHundredths: 0, limitPrice: '2500' })
          .status,
      ).toBe('AUTHORIZED');
    },
  );
  it('P10-N2 permits bounded stale reductions but refuses stale opens and all future evidence', () => {
    const at = T0 * 1000 - 600000;
    const opts = { facts: { market: { ...facts().market!, at } } };
    expect(
      run(
        {
          kind: 'CLOSE',
          leverageHundredths: 0,
          limitPrice: '2500',
          marketDataAt: at,
        },
        opts,
      ),
    ).toMatchObject({ status: 'AUTHORIZED', mode: 'CLOSE_ONLY' });
    expect(run({ marketDataAt: at }, opts).rejection?.code).toBe(
      'STALE_MARKET',
    );
    const future = T0 * 1000 + 1;
    expect(
      run(
        {
          kind: 'CLOSE',
          leverageHundredths: 0,
          limitPrice: '2500',
          marketDataAt: future,
        },
        { facts: { market: { ...facts().market!, at: future } } },
      ).status,
    ).toBe('REJECTED');
  });
  it('honors parent leverage/action/token-spend tiers and refuses claimed member strings', () => {
    const parent = parentMandate();
    const x = setup(
      {},
      {
        mandate: {
          tierPolicy: { ...parent.tierPolicy, leverage: 'CONSENSUS' },
        },
      },
    );
    expect(x.decision).toMatchObject({
      tier: 'CONSENSUS',
      requiredApprovals: 2,
      status: 'PENDING_APPROVAL',
    });
    const a = new HedgeGrantAuthority(GRANT_KEY);
    expect(() =>
      a.issue({
        ...x,
        hedgeMandate: x.hm,
        approvals: members.slice(0, 2).map((m, i) => ({
          memberId: `member_${i}`,
          signer: m.address,
          intentHash: x.decision.intentHash,
        })),
        now: T0,
      } as never),
    ).toThrow(/APPROVALS_MISSING/);
    expect(
      run(
        {},
        {
          hm: {
            approval: { autoMaxNotional: '1', reviewMaxNotional: '1000000' },
          },
        },
      ).tier,
    ).toBe('CONSENSUS');
    expect(
      run(
        {},
        {
          mandate: {
            tierPolicy: {
              ...parent.tierPolicy,
              tokenSpend: { autoMax: '1', reviewMax: '2' },
            },
          },
        },
      ).tier,
    ).toBe('CONSENSUS');
  });
  it('never produces a withdrawal, transfer or collateral decrease', () => {
    expect([...HEDGE_ACTION_KINDS].sort()).toEqual([
      'CANCEL',
      'CLOSE',
      'INCREASE',
      'OPEN',
      'REDUCE',
    ]);
    for (const kind of [
      'WITHDRAW',
      'TRANSFER',
      'DEPOSIT',
      'DECREASE_COLLATERAL',
    ])
      expect(
        policy.evaluate({
          intent: hedgeIntent({ kind }),
          hedgeMandate: hedgeMandate(),
          mandate: parentMandate(),
          facts: factsFor({ kind }),
        }).rejection?.code,
      ).toBe('INVALID_HEDGE');
    for (const kind of HEDGE_ACTION_KINDS)
      for (const side of ['SHORT', 'LONG'] as const)
        expect([1, 2, 3, 4, 5]).toContain(perplOrderTypeFor(kind, side));
  });
});
describe('SIMULATION-only fixture grants', () => {
  const order = { t: 2, mkt: 64, acc: 1058, s: 40, p: 2400, lv: 100 };
  const issue = (
    a: HedgeGrantAuthority,
    changes: Record<string, unknown> = {},
  ) => {
    const x = setup(changes);
    return a.sign({
      ...x,
      hedgeMandate: x.hm,
      approvers: ['fixture_0', 'fixture_1'],
      now: T0,
    });
  };
  it('binds the order and never reissues a new grant for the same intent', () => {
    const a = new HedgeGrantAuthority(GRANT_KEY),
      grant = issue(a);
    expect(grant.intentHash).toBe(
      hedgeIntentHash(HedgeIntentSchema.parse(hedgeIntent())),
    );
    a.authorizeOrder(grant, order, T0 + 1);
    expect(() =>
      a.issue({
        ...setup(),
        hedgeMandate: hedgeMandate(),
        now: T0,
      }),
    ).toThrow(/APPROVALS_MISSING/);
    expect(() => a.authorizeOrder(grant, order, T0 + 2)).toThrow(
      /GRANT_CONSUMED/,
    );
  });
  it.each([
    ['market', { mkt: 16 }],
    ['account', { acc: 7 }],
    ['size', { s: 41 }],
    ['sell price', { p: 2399 }],
    ['leverage', { lv: 200 }],
    ['collateral increase', { t: 6 }],
    ['long', { t: 1 }],
  ])('rejects changed %s', (_n, change) => {
    const a = new HedgeGrantAuthority(GRANT_KEY),
      grant = issue(a);
    expect(() =>
      a.authorizeOrder(grant, { ...order, ...change }, T0 + 1),
    ).toThrow(HedgeGrantError);
    expect(a.isConsumed(grant.grantId)).toBe(false);
  });
  it('rejects tampering, foreign keys and expiry; caps TTL by fresh evidence', () => {
    const a = new HedgeGrantAuthority(GRANT_KEY),
      grant = issue(a);
    expect(grant.expiresAt).toBe(T0 + 55);
    expect(() =>
      a.authorizeOrder({ ...grant, maxSize: '400' }, order, T0 + 1),
    ).toThrow(/GRANT_INVALID/);
    expect(() =>
      new HedgeGrantAuthority(new Uint8Array(32).fill(1)).authorizeOrder(
        grant,
        order,
        T0 + 1,
      ),
    ).toThrow(/GRANT_MAC/);
    expect(() => a.authorizeOrder(grant, order, grant.expiresAt)).toThrow(
      /GRANT_EXPIRED/,
    );
  });
  it('binds cancels and risk-reducing close limits', () => {
    const a = new HedgeGrantAuthority(GRANT_KEY);
    const cancel = issue(a, {
      intentId: 'cancel1',
      kind: 'CANCEL',
      orderId: '777',
      size: '0',
      leverageHundredths: 0,
    });
    expect(() =>
      a.authorizeOrder(
        cancel,
        { t: 5, mkt: 64, acc: 1058, s: 0, lv: 0, oid: 778 },
        T0 + 1,
      ),
    ).toThrow(/order id/);
    a.authorizeOrder(
      cancel,
      { t: 5, mkt: 64, acc: 1058, s: 0, lv: 0, oid: 777 },
      T0 + 1,
    );
    const close = issue(a, {
      intentId: 'close1',
      kind: 'CLOSE',
      leverageHundredths: 0,
      limitPrice: '2500',
    });
    expect(() =>
      a.authorizeOrder(
        close,
        { t: 4, mkt: 64, acc: 1058, s: 40, p: 2601, lv: 0 },
        T0 + 1,
      ),
    ).toThrow(/price/);
    expect(
      a.authorizeOrder(
        close,
        { t: 4, mkt: 64, acc: 1058, s: 40, p: 2500, lv: 0 },
        T0 + 1,
      ).reduceOnly,
    ).toBe(true);
  });
});
