import { describe, expect, it } from 'vitest';
import {
  PolicyEngine,
  IntentCanonicalizer,
  minimumOutput,
  toMandateConfig,
  onchainMandateId,
} from '../../packages/kernel/src/index.js';
import { MandateSchema } from '../../packages/schemas/src/index.js';
import {
  ACCOUNT,
  RECIPIENT,
  TOKEN,
  TOKEN_2,
  address,
  approve,
  authorizeWith,
  evidence,
  expectDraft,
  grantFor,
  harness,
  intent,
  mandate,
  nativeAsset,
  nativeIntent,
  network,
  now,
  owners,
  quote,
  swapIntent,
  tradeMandate,
  transferBinding,
} from './fixtures.js';

const evaluate = (patch: Record<string, unknown>, policy = mandate()) =>
  new PolicyEngine().evaluate({
    canonical: new IntentCanonicalizer().canonicalize(intent(patch)),
    mandate: policy,
    network,
    now,
  });

describe('PolicyEngine typed result and tiers (B02.2)', () => {
  it('returns a typed PolicyResult with matched rules, facts and required approvals', () => {
    const result = evaluate({ maxInputAmount: '21' });
    expect(result).toMatchObject({
      schemaVersion: 1,
      tier: 'REVIEW',
      requiredApprovals: 1,
      rejection: null,
      facts: {
        action: 'TRANSFER',
        tokenAmount: '21',
        nativeValue: '0',
        recipient: RECIPIENT,
        recipientPurpose: 'COUNTERPARTY',
        withdrawal: false,
      },
    });
    expect(result.matchedRules).toEqual(
      expect.arrayContaining([
        'binding.tuple',
        'recipient.allowlist',
        'cap.token',
        'tier.spend.token:REVIEW',
        'tier.spend.native:AUTO',
      ]),
    );
  });
  it.each([
    ['20', 'AUTO', 0],
    ['21', 'REVIEW', 1],
    ['50', 'REVIEW', 1],
    ['51', 'CONSENSUS', 2],
  ])('spend band %s → %s (%i approvals)', (amount, tier, required) => {
    expect(evaluate({ maxInputAmount: amount })).toMatchObject({
      tier,
      requiredApprovals: required,
    });
  });
  it('per-action-class floors raise or block a tier', () => {
    const floor = (tier: string) =>
      mandate({
        tierPolicy: {
          ...mandate().tierPolicy,
          actionFloors: [{ action: 'TRANSFER', tier }],
        },
      });
    expect(evaluate({ maxInputAmount: '1' }, floor('CONSENSUS'))).toMatchObject(
      { tier: 'CONSENSUS', requiredApprovals: 2 },
    );
    expect(evaluate({ maxInputAmount: '1' }, floor('BLOCKED'))).toMatchObject({
      tier: 'BLOCKED',
      rejection: { code: 'ACTION_BLOCKED', rule: 'tier.actionFloor' },
    });
  });
  it('withdrawal to a member is 3-of-3 when the mandate says UNANIMOUS', async () => {
    const member = owners[0]!.address.toLowerCase();
    const policy = mandate({
      recipients: [
        { address: RECIPIENT, purpose: 'COUNTERPARTY' },
        { address: member, purpose: 'MEMBER_WITHDRAWAL' },
      ],
    });
    expect(
      evaluate({ recipient: member, maxInputAmount: '1' }, policy),
    ).toMatchObject({
      tier: 'CONSENSUS',
      requiredApprovals: 3,
      facts: { withdrawal: true },
    });
    const input = evidence(intent({ recipient: member, maxInputAmount: '1' }));
    const h = harness(input, [policy]);
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    const two = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, expectDraft(pending), [0, 1]),
    });
    expect(two).toMatchObject({ code: 'MISSING_QUORUM', requiredApprovals: 3 });
    const three = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, expectDraft(pending), [0, 1, 2]),
    });
    expect(three).toMatchObject({ status: 'AUTHORIZED', requiredApprovals: 3 });
    const blocked = mandate({
      recipients: policy.recipients,
      tierPolicy: { ...policy.tierPolicy, withdrawal: 'BLOCKED' },
    });
    expect(evaluate({ recipient: member }, blocked)).toMatchObject({
      tier: 'BLOCKED',
      rejection: { code: 'WITHDRAWAL_BLOCKED' },
    });
  });
  it('a member address cannot be laundered as a counterparty recipient', () => {
    expect(
      MandateSchema.safeParse({
        ...mandate(),
        recipients: [
          {
            address: owners[0]!.address.toLowerCase(),
            purpose: 'COUNTERPARTY',
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      MandateSchema.safeParse({
        ...mandate(),
        operators: [owners[0]!.address.toLowerCase()],
      }).success,
    ).toBe(false);
  });
  it('ADR-0011 §8: an AUTO decision still needs the on-chain owner quorum and records the computed tier', async () => {
    const input = evidence(intent({ maxInputAmount: '20' }));
    const h = harness(input);
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    expect(pending).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'ONCHAIN_QUORUM_REQUIRED',
      tier: 'AUTO',
      requiredApprovals: 2,
    });
    expect(pending.policy?.requiredApprovals).toBe(0);
    const granted = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, expectDraft(pending)),
    });
    expect(granted).toMatchObject({ status: 'AUTHORIZED', tier: 'AUTO' });
    const review = evidence(intent({ maxInputAmount: '21', nonce: '2' }));
    const single = harness(review, [
      mandate({
        approvalPolicy: { ...mandate().approvalPolicy, accountThreshold: 1 },
      }),
    ]);
    const r = await single.kernel.authorize({ ...review, approvals: [] });
    expect(
      await single.kernel.authorize({
        ...review,
        approvals: await approve(single, expectDraft(r), [2]),
      }),
    ).toMatchObject({
      status: 'AUTHORIZED',
      tier: 'REVIEW',
      requiredApprovals: 1,
    });
  });
});

describe('S1 native value is a first-class spend dimension (B02.3)', () => {
  const nativeMandate = (overrides: Record<string, unknown> = {}) =>
    mandate({
      bindings: [
        transferBinding,
        {
          pluginId: 'local-transfer',
          action: 'TRANSFER',
          target: RECIPIENT,
          selector: '0x00000000',
        },
      ],
      maxNativeValue: (2n * 10n ** 18n).toString(),
      cumulativeNativeBudget: (3n * 10n ** 18n).toString(),
      tierPolicy: {
        ...mandate().tierPolicy,
        nativeSpend: {
          autoMax: (10n ** 17n).toString(),
          reviewMax: (5n * 10n ** 17n).toString(),
        },
      },
      ...overrides,
    });
  const ONE = (10n ** 18n).toString();
  it('regression: five 1e18 native intents are never AUTO and stop at the cumulative native cap', async () => {
    const inputs = [1, 2, 3, 4, 5].map((n) =>
      evidence(nativeIntent(ONE, { nonce: String(n) })),
    );
    const h = harness(inputs, [nativeMandate()]);
    const results = [];
    for (const input of inputs) results.push(await authorizeWith(h, input));
    expect(results.map((r) => r.tier)).toEqual(Array(5).fill('CONSENSUS'));
    expect(results.map((r) => r.status)).toEqual([
      'AUTHORIZED',
      'AUTHORIZED',
      'AUTHORIZED',
      'POLICY_REJECTED',
      'POLICY_REJECTED',
    ]);
    expect(results[3]).toMatchObject({ code: 'NATIVE_BUDGET_EXHAUSTED' });
    expect(h.kernel.accounting('group_1', 'mandate_1')).toMatchObject({
      reservedNative: (3n * 10n ** 18n).toString(),
      reservedToken: '0',
    });
  });
  it('native value counts in the per-action cap and the treasury balance', async () => {
    const big = evidence(nativeIntent((3n * 10n ** 18n).toString()));
    const h = harness(big, [nativeMandate()]);
    expect(await h.kernel.authorize({ ...big, approvals: [] })).toMatchObject({
      code: 'NATIVE_VALUE_CAP',
    });
    const one = evidence(nativeIntent(ONE));
    const two = evidence(nativeIntent(ONE, { nonce: '2' }));
    const poor = harness([one, two], [nativeMandate()], {
      balances: [
        {
          account: ACCOUNT,
          asset: nativeAsset,
          balance: (15n * 10n ** 17n).toString(),
        },
      ],
    });
    expect((await authorizeWith(poor, one)).status).toBe('AUTHORIZED');
    expect(await authorizeWith(poor, two)).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
    const noNative = harness(one, [nativeMandate()], { balances: [] });
    expect(
      await noNative.kernel.authorize({ ...one, approvals: [] }),
    ).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });
  it('the native draft is the on-chain native transfer shape', async () => {
    const one = evidence(nativeIntent(ONE));
    const h = harness(one, [nativeMandate()]);
    const decision = await grantFor(h, one);
    expect(decision.grant.draft.grant).toMatchObject({
      token: address(0),
      maxInputAmount: '0',
      nativeValue: ONE,
      target: RECIPIENT,
      recipient: RECIPIENT,
      selector: '0x00000000',
    });
    expect(decision.grant.inputAsset).toBeNull();
    const shaped = evidence(nativeIntent(ONE, { target: TOKEN }));
    expect(
      await harness(shaped, [nativeMandate()]).kernel.authorize({
        ...shaped,
        approvals: [],
      }),
    ).toMatchObject({ code: 'SELECTOR_FORBIDDEN' });
  });
});

describe('S2 minimum output and allocation (B02.5)', () => {
  it('minOutputAmount must be ≥ quote × (1 − slippage), rounded up', async () => {
    expect(minimumOutput(1000n, 25)).toBe(998n);
    expect(minimumOutput(1000n, 0)).toBe(1000n);
    for (const [min, code] of [
      ['0', 'INVALID_INTENT'],
      ['997', 'MIN_OUTPUT_TOO_LOW'],
    ] as const) {
      const input = evidence(swapIntent({ minOutputAmount: min }), quote);
      const h = harness(input, [tradeMandate()]);
      const result = await h.kernel.authorize({ ...input, approvals: [] });
      expect(result.status).not.toBe('AUTHORIZED');
      if (min === '997')
        expect(result).toMatchObject({ code, status: 'RISK_REJECTED' });
    }
    const zero = evidence(
      swapIntent({ minOutputAmount: undefined, outputToken: undefined }),
      quote,
    );
    expect(zero.intent.minOutputAmount).toBe('0');
    const ok = evidence(swapIntent({ minOutputAmount: '998' }), quote);
    expect(
      (
        await harness(ok, [tradeMandate()]).kernel.authorize({
          ...ok,
          approvals: [],
        })
      ).status,
    ).toBe('PENDING_APPROVAL');
  });
  it('regression: minOutput "0" with an output token is never authorized', async () => {
    const input = evidence(swapIntent({ minOutputAmount: '0' }), quote);
    const h = harness(input, [tradeMandate()]);
    expect(await authorizeWith(h, input)).toMatchObject({
      status: 'RISK_REJECTED',
      code: 'MIN_OUTPUT_TOO_LOW',
    });
  });
  it('a trade without a quote or allocation fact fails closed', async () => {
    const input = evidence(swapIntent());
    const h = harness(input, [tradeMandate()]);
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      {
        code: 'QUOTE_REQUIRED',
      },
    );
  });
  it('post-trade allocation above the mandate cap is rejected', async () => {
    const input = evidence(swapIntent(), {
      ...quote,
      postTradeAllocationBps: 6000,
    });
    const h = harness(input, [tradeMandate({ maxAllocationBps: 5000 })]);
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      {
        code: 'ALLOCATION_CAP',
      },
    );
  });
});

describe('S3 tuple mandate keys (B02.8)', () => {
  it('regression: colon-bearing ids do not collide', async () => {
    const a = mandate({ groupId: 'a:b', mandateId: 'c' });
    const b = mandate({ groupId: 'a', mandateId: 'b:c' });
    const one = evidence(intent({ groupId: 'a:b', mandateId: 'c' }));
    const two = evidence(
      intent({ groupId: 'a', mandateId: 'b:c', nonce: '2' }),
    );
    const h = harness([one, two], [a, b]);
    await grantFor(h, one);
    expect(h.kernel.accounting('a:b', 'c').reservedToken).toBe('60');
    expect(h.kernel.accounting('a', 'b:c').reservedToken).toBe('0');
    expect(onchainMandateId(a)).not.toBe(onchainMandateId(b));
  });
});

describe('S4 recipient allowlist and S5 tuple bindings (B02.4)', () => {
  it('regression: an unlisted recipient is a hard rejection and the draft binds the recipient', async () => {
    const bad = evidence(intent({ recipient: address(51) }));
    expect(
      await harness(bad).kernel.authorize({ ...bad, approvals: [] }),
    ).toMatchObject({ code: 'RECIPIENT_FORBIDDEN', status: 'POLICY_REJECTED' });
    const good = evidence(intent());
    const decision = await grantFor(harness(good), good);
    expect(decision.grant.draft.grant.recipient).toBe(RECIPIENT);
  });
  it('regression: plugin/target/selector allowances do not combine as a cartesian product', async () => {
    const policy = mandate({
      bindings: [
        transferBinding,
        {
          pluginId: 'second-transfer',
          action: 'TRANSFER',
          target: TOKEN_2,
          selector: '0x095ea7b3',
        },
      ],
    });
    for (const [patch, code] of [
      [{ pluginId: 'second-transfer' }, 'TARGET_FORBIDDEN'],
      [{ target: TOKEN_2 }, 'TARGET_FORBIDDEN'],
      [{ selector: '0x095ea7b3' }, 'SELECTOR_FORBIDDEN'],
      [
        {
          pluginId: 'second-transfer',
          target: TOKEN_2,
          selector: '0xa9059cbb',
        },
        'SELECTOR_FORBIDDEN',
      ],
      [{ action: 'SPOT_TRADE' }, 'ACTION_FORBIDDEN'],
    ] as const) {
      const input = evidence(intent(patch));
      expect(
        await harness(input, [policy]).kernel.authorize({
          ...input,
          approvals: [],
        }),
      ).toMatchObject({ code });
    }
  });
});

describe('on-chain MandateRegistry mapping', () => {
  it('maps 1:1 to MandateConfig with deduplicated call pairs and recipients', () => {
    const policy = tradeMandate();
    const config = toMandateConfig(policy);
    expect(config).toMatchObject({
      token: TOKEN,
      maxTokenPerAction: 100n,
      maxNativePerAction: 0n,
      cumulativeTokenCap: 200n,
      cumulativeNativeCap: 0n,
      validAfter: 900n,
      validUntil: 2000n,
      recipients: [RECIPIENT, ACCOUNT],
    });
    expect(config.callTargets).toHaveLength(2);
    expect(config.callSelectors).toEqual(['0xa9059cbb', '0x5ae401dc']);
    const dup = mandate({
      bindings: [
        transferBinding,
        { ...transferBinding, pluginId: 'second-transfer' },
      ],
    });
    expect(toMandateConfig(dup).callTargets).toEqual([TOKEN]);
  });
});
