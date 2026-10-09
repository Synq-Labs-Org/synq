import { describe, expect, it } from 'vitest';
import {
  Kernel,
  canonicalIntentId,
  economicIntentHash,
  intentHash,
} from '../../packages/kernel/src/index.js';
import {
  address,
  allPlugins,
  approve,
  asset,
  authorizeWith,
  evidence,
  expectDraft,
  grantFor,
  harness,
  hash,
  intent,
  mandate,
  now,
  request,
  swapIntent,
  quote,
  tradeMandate,
  trust,
  type Harness,
  type Prepared,
  AUDIT_KEY,
} from './fixtures.js';

async function decide(
  patch: Record<string, unknown>,
  policy = mandate(),
  approvals = true,
) {
  const input = evidence(intent(patch));
  const h = harness(input, [policy]);
  return approvals
    ? authorizeWith(h, input)
    : h.kernel.authorize({ ...input, approvals: [] });
}

describe('Kernel authorization (KER-001…022)', () => {
  it('issues a bounded consensus grant only with two distinct consumed approvals', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    expect(pending).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'MISSING_QUORUM',
      tier: 'CONSENSUS',
      state: 'PENDING_APPROVAL',
      requiredApprovals: 2,
    });
    const draft = expectDraft(pending);
    const result = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, draft),
    });
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.tier).toBe('CONSENSUS');
    expect(result.grant.grantId).toBe(draft.digest);
    expect(result.grant.draft).toEqual(draft);
    expect(result.grant.validUntil).toBe(now + 20);
    expect(result.grant.approvals).toHaveLength(2);
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe(
      '60',
    );
  });

  it.each([
    [
      'KER-001 §52 amount mismatch: amount exceeds mandate cap',
      { maxInputAmount: '101' },
      'AMOUNT_CAP',
    ],
    [
      'KER-012 amount exceeds mandate cap (no grant)',
      { maxInputAmount: '1000000' },
      'AMOUNT_CAP',
    ],
    ['KER-002 §52 wrong venue', { pluginId: 'wrong' }, 'PLUGIN_FORBIDDEN'],
    [
      'KER-013 wrong venue (second plugin not bound)',
      { pluginId: 'second-transfer' },
      'PLUGIN_FORBIDDEN',
    ],
    ['KER-003 §52 wrong asset', { inputToken: address(11) }, 'ASSET_FORBIDDEN'],
    [
      'KER-014 wrong token for native-shaped intent',
      { inputToken: address(0) },
      'ASSET_FORBIDDEN',
    ],
    [
      'KER-007 §52 target mismatch',
      { target: address(11) },
      'TARGET_FORBIDDEN',
    ],
    [
      'KER-018 target mismatch on another selector',
      { target: address(13), selector: '0x00000000' },
      'TARGET_FORBIDDEN',
    ],
    ['wrong selector', { selector: '0x12345678' }, 'SELECTOR_FORBIDDEN'],
    ['wrong operator', { operator: address(99) }, 'OPERATOR_FORBIDDEN'],
    ['wrong account', { account: address(99) }, 'ACCOUNT_MISMATCH'],
    ['wrong mandate version', { mandateVersion: 2 }, 'MANDATE_VERSION'],
    ['wrong group', { groupId: 'other' }, 'MANDATE_NOT_FOUND'],
    ['wrong mandate', { mandateId: 'other' }, 'MANDATE_NOT_FOUND'],
    ['§52 time-window mismatch', { validUntil: 2001 }, 'TIME_WINDOW'],
    ['slippage cap', { maxSlippageBps: 51 }, 'SLIPPAGE_CAP'],
    [
      'recipient outside allowlist',
      { recipient: address(51) },
      'RECIPIENT_FORBIDDEN',
    ],
    [
      'native value on an ERC20 transfer',
      { nativeValue: '1' },
      'ACTION_SHAPE_INVALID',
    ],
  ])('%s rejects before issuing authority', async (_name, patch, code) => {
    expect(await decide(patch)).toMatchObject({
      status: 'POLICY_REJECTED',
      code,
      state: 'POLICY_REJECTED',
    });
  });

  it('KER-006 / KER-017 §52 blocked leverage is BLOCKED and rejected', async () => {
    const result = await decide({ leverageBps: 100 });
    expect(result).toMatchObject({
      status: 'POLICY_REJECTED',
      code: 'LEVERAGE_BLOCKED',
      tier: 'BLOCKED',
    });
    expect(result.policy?.rejection).toEqual({
      rule: 'leverage.policy',
      code: 'LEVERAGE_BLOCKED',
    });
    const tolerated = mandate({
      maxLeverageBps: 200,
      tierPolicy: { ...mandate().tierPolicy, leverage: 'CONSENSUS' },
    });
    expect(await decide({ leverageBps: 300 }, tolerated)).toMatchObject({
      code: 'LEVERAGE_BLOCKED',
    });
    expect(
      await decide({ leverageBps: 100, maxInputAmount: '1' }, tolerated, false),
    ).toMatchObject({ status: 'PENDING_APPROVAL', tier: 'CONSENSUS' });
  });

  it('KER-004 / KER-015 §52 expired mandate rejects before prepare', async () => {
    expect(await decide({}, mandate({ validUntil: 999 }))).toMatchObject({
      code: 'TIME_WINDOW',
    });
    const input = evidence(intent({ validUntil: 1010 }));
    const granted = harness(input, [mandate({ validUntil: 1010 })]);
    const decision = await grantFor(granted, input);
    expect(decision.grant.validUntil).toBe(1010);
    granted.clock.t = 1010;
    expect(() => granted.kernel.verify(decision.grant, input.intent)).toThrow(
      'GRANT_EXPIRED',
    );
    expect(() =>
      granted.kernel.claimForExecution(decision.grant, input.intent, 'w'),
    ).toThrow('GRANT_EXPIRED');
  });

  it('KER-005 / KER-016 §52 missing quorum leaves the action pending without a grant', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    const one = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, expectDraft(pending), [0]),
    });
    expect(one).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'MISSING_QUORUM',
      countedApprovals: 1,
      state: 'PENDING_APPROVAL',
    });
    expect(one.transitions).toEqual([]);
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });

  it('KER-008 / KER-019 calldata hash mismatch rejects at simulation and grant verification', async () => {
    const input = evidence(intent());
    const changed = {
      ...input,
      simulation: { ...input.simulation, calldataHash: hash(99) },
    };
    const h = harness(changed);
    expect(
      await h.kernel.authorize({ ...changed, approvals: [] }),
    ).toMatchObject({ status: 'RISK_REJECTED', code: 'SIMULATION_MISMATCH' });
    const g = harness(input);
    const decision = await grantFor(g, input);
    expect(() =>
      g.kernel.verify(decision.grant, {
        ...input.intent,
        calldataHash: hash(99),
      }),
    ).toThrow('GRANT_MISMATCH');
  });

  it('KER-009 / KER-020 SEC-009 wrong chain/profile and cross-network address reuse are rejected', async () => {
    expect(await decide({ chainId: 10143 })).toMatchObject({
      code: 'NETWORK_MISMATCH',
    });
    const testnetMandate = {
      ...mandate(),
      network: {
        profile: 'sandbox/monad-testnet',
        chainId: 10143,
        providerEnvironment: 'sandbox',
      },
      inputAsset: {
        ...asset,
        chainId: 10143,
        canonicalAssetId: `eip155:10143/erc20:${asset.address}`,
      },
    };
    const input = evidence(intent());
    const h = harness(input, [testnetMandate]);
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      { code: 'NETWORK_MISMATCH' },
    );
  });

  it('KER-010 / KER-021 §52 over-budget: cumulative budget is exhausted across issued grants', async () => {
    const first = evidence(intent({ maxInputAmount: '100' }));
    const second = evidence(intent({ maxInputAmount: '100', nonce: '2' }));
    const third = evidence(intent({ maxInputAmount: '1', nonce: '3' }));
    const h = harness([first, second, third]);
    expect((await authorizeWith(h, first)).status).toBe('AUTHORIZED');
    expect((await authorizeWith(h, second)).status).toBe('AUTHORIZED');
    expect(await authorizeWith(h, third)).toMatchObject({
      status: 'POLICY_REJECTED',
      code: 'BUDGET_EXHAUSTED',
    });
  });

  it('KER-011 / KER-022 §52 revoked mandate rejects new and outstanding authority', async () => {
    expect(await decide({}, mandate({ status: 'REVOKED' }))).toMatchObject({
      code: 'MANDATE_REVOKED',
    });
    const input = evidence(intent());
    const h = harness(input);
    const decision = await grantFor(h, input);
    h.kernel.revokeMandate('group_1', 'mandate_1');
    expect(() => h.kernel.verify(decision.grant, input.intent)).toThrow(
      'MANDATE_REVOKED',
    );
    expect(() =>
      h.kernel.supersedeMandate(mandate({ version: 2 }), {
        securitySensitive: true,
      }),
    ).toThrow('MANDATE_REVOKED');
  });

  it('§52 stale quote rejects as a risk failure', async () => {
    const data = evidence(intent(), { quoteAt: 900 });
    const h = harness(data);
    expect(await h.kernel.authorize({ ...data, approvals: [] })).toMatchObject({
      status: 'RISK_REJECTED',
      code: 'STALE_QUOTE',
      state: 'RISK_REJECTED',
    });
  });

  it('§52 new-token consensus: an unknown output asset needs quorum even under the AUTO band', async () => {
    const input = evidence(swapIntent({ maxInputAmount: '1' }), quote);
    const h = harness(input, [tradeMandate()]);
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      {
        status: 'PENDING_APPROVAL',
        tier: 'CONSENSUS',
      },
    );
    const blocked = harness(input, [
      tradeMandate({
        tierPolicy: { ...mandate().tierPolicy, newOutputAsset: 'BLOCKED' },
      }),
    ]);
    expect(
      await blocked.kernel.authorize({ ...input, approvals: [] }),
    ).toMatchObject({ code: 'NEW_ASSET_BLOCKED', tier: 'BLOCKED' });
  });

  it('§52 recurring-cap exhausted and frequency cap stay bounded after release', async () => {
    const one = evidence(intent({ maxInputAmount: '10' }));
    const two = evidence(intent({ maxInputAmount: '10', nonce: '2' }));
    const h = harness([one, two], [mandate({ maxExecutions: 1 })]);
    await grantFor(h, one);
    h.clock.t = now + 25;
    expect(await h.kernel.releaseExpired()).toBe(1);
    h.clock.t = now;
    const later = harness([one, two], [mandate({ maxExecutions: 1 })]);
    await grantFor(later, one);
    expect(await authorizeWith(later, two)).toMatchObject({
      code: 'RECURRING_CAP',
    });
    const cadence = harness([one, two], [mandate({ minIntervalSeconds: 60 })]);
    await grantFor(cadence, one);
    expect(await authorizeWith(cadence, two)).toMatchObject({
      code: 'FREQUENCY_CAP',
    });
  });

  it('§52 grant reuse: a grant is claimed once and its nonce stays locked across restart', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const decision = await grantFor(h, input);
    h.kernel.claimForExecution(decision.grant, input.intent, 'worker-1');
    expect(() =>
      h.kernel.claimForExecution(decision.grant, input.intent, 'worker-2'),
    ).toThrow('GRANT_REPLAY');
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(h.kernel.snapshot())),
      {
        clock: h.clock,
        auditKey: AUDIT_KEY,
        approvalLedger: h.ledger,
        membershipDirectory: h.directory,
        freshness: { probe: h.probe, maxLagBlocks: 0 },
        plugins: allPlugins(),
      },
    );
    expect(await restored.authorize({ ...input, approvals: [] })).toMatchObject(
      { code: 'NONCE_REPLAY' },
    );
    const sameNonce = evidence(intent({ maxInputAmount: '61' }));
    trust({ ...h, kernel: restored } as Harness, sameNonce);
    expect(
      await restored.authorize({ ...sameNonce, approvals: [] }),
    ).toMatchObject({ code: 'NONCE_REPLAY' });
  });

  it('§52 policy version supersession: sensitive supersession invalidates, widening keeps grants', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const decision = await grantFor(h, input);
    h.kernel.supersedeMandate(mandate({ version: 2, perActionCap: '150' }), {
      securitySensitive: false,
    });
    expect(h.kernel.verify(decision.grant, input.intent).grantId).toBe(
      decision.grant.grantId,
    );
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      { code: 'NONCE_REPLAY' },
    );
    expect(() =>
      h.kernel.supersedeMandate(mandate({ version: 3, perActionCap: '50' }), {
        securitySensitive: false,
      }),
    ).toThrow('NARROWING_REQUIRES_INVALIDATION');
    h.kernel.supersedeMandate(mandate({ version: 3, perActionCap: '50' }), {
      securitySensitive: true,
    });
    expect(() => h.kernel.verify(decision.grant, input.intent)).toThrow(
      'MANDATE_VERSION',
    );
    const stale = evidence(intent({ nonce: '9' }));
    trust(h, stale);
    expect(await h.kernel.authorize({ ...stale, approvals: [] })).toMatchObject(
      { code: 'MANDATE_VERSION' },
    );
  });
});

describe('canonical intent identity (§36.2)', () => {
  it('one stable intentId per economic action, independent of the proposer label and evidence refresh', () => {
    const a = intent({ intentId: 'proposal_a' });
    const b = intent({ intentId: 'proposal_b' });
    expect(canonicalIntentId(a)).toBe(canonicalIntentId(b));
    expect(intentHash(a)).toBe(intentHash(b));
    const refreshed = intent({ evidenceHash: hash(5) });
    expect(canonicalIntentId(refreshed)).toBe(canonicalIntentId(a));
    expect(intentHash(refreshed)).not.toBe(intentHash(a));
    expect(intentHash({ ...a })).toBe(
      intentHash(Object.fromEntries(Object.entries(a).reverse()) as typeof a),
    );
    for (const patch of [
      { target: address(99) },
      { maxInputAmount: '61' },
      { pluginId: 'other' },
      { operator: address(99) },
      { recipient: address(98) },
      { calldataHash: hash(99) },
      { selector: '0x12345678' },
      { nonce: '2' },
      { nativeValue: '1' },
      { validUntil: 1499 },
    ])
      expect(canonicalIntentId(intent(patch))).not.toBe(canonicalIntentId(a));
    expect(economicIntentHash(intent({ evidenceHash: hash(99) }))).toBe(
      economicIntentHash(a),
    );
  });

  it('the Kernel assigns the canonical id to decisions and grants', async () => {
    const input = evidence(intent({ intentId: 'whatever_label' }));
    const h = harness(input);
    const decision = await grantFor(h, input);
    expect(decision.intentId).toBe(canonicalIntentId(input.intent));
    expect(decision.grant.intentId).toBe(canonicalIntentId(input.intent));
    expect(decision.grant.draft.grant.intentHash).toBe(
      intentHash(input.intent),
    );
  });
});

describe('typed failures (S7)', () => {
  it.each([null, undefined, 7, 'x', [], {}])(
    'authorize(%j) resolves to a typed INVALID_REQUEST with a path',
    async (value) => {
      const h = harness();
      const result = await h.kernel.authorize(value);
      expect(result.status).toBe('POLICY_REJECTED');
      if (result.status === 'AUTHORIZED') return;
      expect(result.code).toBe('INVALID_REQUEST');
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues[0]!.path).toBeTruthy();
    },
  );
  it('schema failures keep the component code and the issue path', async () => {
    const input = request();
    const h = harness();
    const bad = await h.kernel.authorize({
      ...input,
      intent: { ...input.intent, maxInputAmount: '1.5' },
    });
    expect(bad).toMatchObject({ code: 'INVALID_INTENT' });
    if (bad.status === 'AUTHORIZED') return;
    expect(bad.issues.map((i) => i.path)).toContain('maxInputAmount');
    expect(
      await h.kernel.authorize({ ...input, risk: { ...input.risk, x: 1 } }),
    ).toMatchObject({ code: 'INVALID_RISK_PACKET' });
    expect(
      await h.kernel.authorize({ ...input, simulation: null }),
    ).toMatchObject({ code: 'INVALID_SIMULATION' });
    const uncloneable = await h.kernel.authorize({
      ...input,
      approvals: [() => 1],
    });
    expect(uncloneable).toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('a backwards clock fails closed', async () => {
    const input = evidence(intent());
    const h = harness(input);
    await h.kernel.authorize({ ...input, approvals: [] });
    h.clock.t = now - 1;
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      { code: 'CLOCK_REGRESSION' },
    );
  });
});

export type { Prepared };
