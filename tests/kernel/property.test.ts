import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  BoundActionIntentSchema,
  executionGrantDigest,
  type ExecutionGrant,
  type Mandate,
} from '../../packages/schemas/src/index.js';
import { minimumOutput } from '../../packages/kernel/src/index.js';
import {
  ACCOUNT,
  OUT_TOKEN,
  RECIPIENT,
  ROUTER,
  SWAP_SELECTOR,
  TOKEN,
  TOKEN_2,
  ZERO,
  address,
  approve,
  evidence,
  expectDraft,
  harness,
  hash,
  intent,
  now,
  outputAsset,
  owners,
  tradeMandate,
  trust,
  type Harness,
} from './fixtures.js';

const E18 = 10n ** 18n;
const policy: Mandate = tradeMandate({
  bindings: [
    ...tradeMandate().bindings,
    {
      pluginId: 'local-transfer',
      action: 'TRANSFER',
      target: RECIPIENT,
      selector: '0x00000000',
    },
  ],
  recipients: [
    ...tradeMandate().recipients,
    { address: owners[0]!.address.toLowerCase(), purpose: 'MEMBER_WITHDRAWAL' },
  ],
  outputAssets: [outputAsset],
  maxNativeValue: (2n * E18).toString(),
  cumulativeNativeBudget: (3n * E18).toString(),
  tierPolicy: {
    ...tradeMandate().tierPolicy,
    nativeSpend: { autoMax: '0', reviewMax: E18.toString() },
  },
});

const dimension = {
  amount: fc.integer({ min: 0, max: 250 }).map(String),
  native: fc.constantFrom(
    '0',
    '1',
    E18.toString(),
    (2n * E18).toString(),
    (5n * E18).toString(),
  ),
  target: fc.constantFrom(TOKEN, TOKEN_2, RECIPIENT, ROUTER, address(99)),
  selector: fc.constantFrom(
    '0xa9059cbb',
    '0x00000000',
    SWAP_SELECTOR,
    '0x12345678',
  ),
  asset: fc.constantFrom(TOKEN, TOKEN_2, ZERO),
  chain: fc.constantFrom(31337, 10143),
  validAfter: fc.integer({ min: 800, max: 1100 }),
  duration: fc.integer({ min: 1, max: 1500 }),
  outputToken: fc.constantFrom(undefined, OUT_TOKEN, address(13)),
  minOutput: fc.integer({ min: 0, max: 1100 }).map(String),
  recipient: fc.constantFrom(
    RECIPIENT,
    ACCOUNT,
    address(51),
    owners[0]!.address.toLowerCase(),
  ),
  plugin: fc.constantFrom(
    'local-transfer',
    'second-transfer',
    'local-swap',
    'unknown',
  ),
  action: fc.constantFrom('TRANSFER', 'SPOT_TRADE'),
  slippage: fc.integer({ min: 0, max: 80 }),
  leverage: fc.constantFrom(0, 0, 0, 100),
};
const random = fc.record(dimension);
type Generated = typeof random extends fc.Arbitrary<infer T> ? T : never;
const shapes = {
  transfer: {
    plugin: 'local-transfer',
    action: 'TRANSFER',
    target: TOKEN,
    selector: '0xa9059cbb',
    asset: TOKEN,
    recipient: RECIPIENT,
    outputToken: undefined,
    native: '0',
    minOutput: '0',
  },
  native: {
    plugin: 'local-transfer',
    action: 'TRANSFER',
    target: RECIPIENT,
    selector: '0x00000000',
    asset: ZERO,
    amount: '0',
    recipient: RECIPIENT,
    outputToken: undefined,
    minOutput: '0',
  },
  swap: {
    plugin: 'local-swap',
    action: 'SPOT_TRADE',
    target: ROUTER,
    selector: SWAP_SELECTOR,
    asset: TOKEN,
    recipient: ACCOUNT,
    outputToken: OUT_TOKEN,
    native: '0',
  },
} as const;
const coherent = fc
  .tuple(
    random,
    fc.constantFrom('transfer', 'native', 'swap') as fc.Arbitrary<
      keyof typeof shapes
    >,
    fc.integer({ min: 1, max: 100 }),
    fc.integer({ min: 900, max: 1000 }),
    fc.integer({ min: 1001, max: 2000 }),
    fc.integer({ min: 25, max: 50 }),
    fc.constantFrom('1', E18.toString(), (2n * E18).toString()),
  )
  .map(([g, shape, amount, after, until, slippage, native]): Generated => {
    const base = {
      ...g,
      chain: 31337 as const,
      leverage: 0,
      amount: String(amount),
      native,
      validAfter: after,
      duration: until - after,
      slippage,
      minOutput: '1000',
      ...shapes[shape],
    };
    return base as Generated;
  });
const mutated = fc
  .tuple(
    coherent,
    random,
    fc.constantFrom(...(Object.keys(dimension) as (keyof Generated)[])),
  )
  .map(([base, other, key]) => ({ ...base, [key]: other[key] }) as Generated);
const generated = fc.oneof(coherent, mutated, random);

function rawIntent(g: Generated, nonce: number) {
  return {
    ...intent(),
    intentId: `gen_${nonce}`,
    chainId: g.chain,
    pluginId: g.plugin,
    action: g.action,
    target: g.target,
    selector: g.selector,
    calldataHash: hash(nonce + 1),
    inputToken: g.asset,
    maxInputAmount: g.amount,
    nativeValue: g.native,
    recipient: g.recipient,
    outputToken: g.outputToken,
    minOutputAmount: g.minOutput,
    maxSlippageBps: g.slippage,
    leverageBps: g.leverage,
    validAfter: g.validAfter,
    validUntil: g.validAfter + g.duration,
    nonce: String(nonce),
  };
}

function assertInsideEnvelope(grant: ExecutionGrant, g: Generated) {
  const d = grant.draft.grant;
  const tuple = policy.bindings.some(
    (b) =>
      b.pluginId === grant.pluginId &&
      b.action === g.action &&
      b.target === grant.target &&
      b.selector === grant.selector,
  );
  expect(tuple).toBe(true);
  expect(policy.recipients.map((r) => r.address)).toContain(grant.recipient);
  expect(BigInt(grant.maxInputAmount)).toBeLessThanOrEqual(
    BigInt(policy.perActionCap),
  );
  expect(BigInt(grant.nativeValue)).toBeLessThanOrEqual(
    BigInt(policy.maxNativeValue),
  );
  expect(grant.chainId).toBe(policy.network.chainId);
  if (BigInt(grant.maxInputAmount) > 0n)
    expect(d.token).toBe(policy.inputAsset.address);
  else expect(d.token).toBe(ZERO);
  expect(grant.validAfter).toBeGreaterThanOrEqual(policy.validAfter);
  expect(grant.validAfter).toBeGreaterThanOrEqual(g.validAfter);
  expect(grant.validUntil).toBeLessThanOrEqual(policy.validUntil);
  expect(grant.validUntil).toBeLessThanOrEqual(g.validAfter + g.duration);
  expect(now).toBeGreaterThanOrEqual(grant.validAfter);
  expect(now).toBeLessThan(grant.validUntil);
  if (grant.outputToken !== null)
    expect(BigInt(grant.minOutputAmount)).toBeGreaterThanOrEqual(
      minimumOutput(1000n, Math.min(g.slippage, policy.maxSlippageBps)),
    );
  expect(g.leverage).toBe(0);
  expect(grant.approvals.length).toBeGreaterThanOrEqual(
    grant.requiredApprovals,
  );
  expect(new Set(grant.approvals.map((a) => a.signer)).size).toBe(
    grant.approvals.length,
  );
  expect(executionGrantDigest(grant.draft.domain, d)).toBe(grant.grantId);
}

async function attempt(h: Harness, g: Generated, nonce: number, sign: boolean) {
  const raw = rawIntent(g, nonce);
  if (!BoundActionIntentSchema.safeParse(raw).success) {
    const r = await h.kernel.authorize({
      intent: raw,
      risk: {},
      simulation: {},
      approvals: [],
    });
    expect(r.status).not.toBe('AUTHORIZED');
    return null;
  }
  const input = evidence(BoundActionIntentSchema.parse(raw), {
    quotedOutputAmount: '1000',
    postTradeAllocationBps: 100,
  });
  trust(h, input);
  const first = await h.kernel.authorize({ ...input, approvals: [] });
  expect(first.status).not.toBe('AUTHORIZED');
  if (!sign || first.status !== 'PENDING_APPROVAL' || !first.draft) return null;
  const result = await h.kernel.authorize({
    ...input,
    approvals: await approve(h, expectDraft(first), [0, 1, 2]),
  });
  return result.status === 'AUTHORIZED' ? result.grant : null;
}

describe('B02.9 property: no generated input yields a grant outside the mandate envelope', () => {
  it('every dimension is generated (amount, native, target, selector, asset, chain, time, minOutput, recipient, plugin)', async () => {
    let authorized = 0;
    await fc.assert(
      fc.asyncProperty(generated, async (g) => {
        const h = harness([], [policy]);
        const grant = await attempt(h, g, 1, true);
        if (grant) {
          authorized++;
          assertInsideEnvelope(grant, g);
        }
      }),
      { numRuns: 300 },
    );
    expect(authorized).toBeGreaterThan(30);
  });

  it('sequences never exceed per-action, cumulative token, cumulative native or treasury bounds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(generated, { minLength: 1, maxLength: 8 }),
        async (list) => {
          const h = harness([], [policy]);
          let token = 0n;
          let native = 0n;
          for (const [i, g] of list.entries()) {
            const grant = await attempt(h, g, i + 1, true);
            if (!grant) continue;
            assertInsideEnvelope(grant, g);
            token += BigInt(grant.maxInputAmount);
            native += BigInt(grant.nativeValue);
            expect(token).toBeLessThanOrEqual(BigInt(policy.cumulativeBudget));
            expect(native).toBeLessThanOrEqual(
              BigInt(policy.cumulativeNativeBudget),
            );
          }
          const budget = h.kernel.accounting('group_1', 'mandate_1');
          expect(BigInt(budget.reservedToken)).toBe(token);
          expect(BigInt(budget.reservedNative)).toBe(native);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('without approvals nothing is ever authorized', async () => {
    await fc.assert(
      fc.asyncProperty(generated, async (g) => {
        const h = harness([], [policy]);
        expect(await attempt(h, g, 1, false)).toBeNull();
      }),
      { numRuns: 200 },
    );
  });
});
