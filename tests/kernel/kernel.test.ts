import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  Kernel,
  artifactHash,
  economicIntentHash,
  intentHash,
  type AuthorizationRequest,
} from '../../packages/kernel/src/index.js';
import {
  address,
  approvals,
  asset,
  evidence,
  hash,
  intent,
  mandate,
  network,
  now,
  request,
} from './fixtures.js';

function kernelFor(
  inputs: AuthorizationRequest | AuthorizationRequest[],
  policy = mandate(),
) {
  const requests = Array.isArray(inputs) ? inputs : [inputs];
  return new Kernel({
    network,
    mandates: [policy],
    balances: [
      { account: policy.account, asset: policy.inputAsset, balance: '10000' },
    ],
    trustedEvidence: {
      riskPacketHashes: requests.map((r) => artifactHash(r.risk)),
      simulationHashes: requests.map((r) => artifactHash(r.simulation)),
    },
  });
}
async function economicRequest(patch: Record<string, unknown>) {
  const data = evidence(intent(patch));
  return { ...data, approvals: await approvals(data.intent), now };
}
describe('Deterministic authorization', () => {
  it('grant validity cannot outlive the simulation or evidence freshness envelope', async () => {
    const original = await request();
    const input = {
      ...original,
      simulation: { ...original.simulation, simulatedAt: now - 25 },
    };
    const result = await kernelFor(input).authorize(input);
    expect(result.status).toBe('AUTHORIZED');
    if (result.status === 'AUTHORIZED')
      expect(result.grant.validUntil).toBe(now + 5);
  });
  it('issues bounded consensus grant with distinct independently signed approvals', async () => {
    const input = await request();
    const kernel = kernelFor(input);
    const result = await kernel.authorize(input);
    expect(result.status).toBe('AUTHORIZED');
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.tier).toBe('CONSENSUS');
    expect(result.requiredApprovals).toBe(2);
    expect(result.grant.validUntil).toBe(now + 20);
    expect(kernel.accounting('group_1', 'mandate_1').reserved).toBe('60');
  });
  it.each([
    ['KER-001 amount cap', { maxInputAmount: '101' }, 'AMOUNT_CAP'],
    ['KER-002 wrong venue', { pluginId: 'wrong' }, 'PLUGIN_FORBIDDEN'],
    ['KER-003 wrong asset', { inputToken: address(11) }, 'ASSET_FORBIDDEN'],
    ['KER-006 blocked leverage', { leverageBps: 100 }, 'LEVERAGE_CAP'],
    ['KER-007 target mismatch', { target: address(11) }, 'TARGET_FORBIDDEN'],
    ['wrong selector', { selector: '0x12345678' }, 'SELECTOR_FORBIDDEN'],
    ['wrong operator', { operator: address(99) }, 'OPERATOR_FORBIDDEN'],
    ['wrong account', { account: address(99) }, 'ACCOUNT_MISMATCH'],
    ['wrong mandate version', { mandateVersion: 2 }, 'MANDATE_VERSION'],
    ['wrong group', { groupId: 'other' }, 'MANDATE_NOT_FOUND'],
    ['wrong mandate', { mandateId: 'other' }, 'MANDATE_NOT_FOUND'],
    ['wrong time envelope', { validUntil: 2001 }, 'TIME_WINDOW'],
    ['slippage cap', { maxSlippageBps: 51 }, 'SLIPPAGE_CAP'],
    ['native value cap', { nativeValue: '1' }, 'NATIVE_VALUE_CAP'],
  ])('%s rejects before issuing authority', async (_name, patch, code) => {
    const input = await economicRequest(patch);
    expect(await kernelFor(input).authorize(input)).toMatchObject({
      status: 'POLICY_REJECTED',
      code,
    });
  });
  it('KER-004 expires/revokes mandates and enforces latest policy version', async () => {
    const input = await request();
    expect(
      await kernelFor(input, mandate({ validUntil: 999 })).authorize(input),
    ).toMatchObject({ code: 'TIME_WINDOW' });
    expect(
      await kernelFor(input, mandate({ status: 'REVOKED' })).authorize(input),
    ).toMatchObject({ code: 'MANDATE_REVOKED' });
    const kernel = kernelFor(input);
    kernel.mandates.update(mandate({ version: 2 }));
    expect(await kernel.authorize(input)).toMatchObject({
      code: 'MANDATE_VERSION',
    });
    expect(() => kernel.mandates.update(mandate())).toThrow('MANDATE_VERSION');
  });
  it('KER-009 prevents network profile/address reuse', async () => {
    const testAsset = {
      ...asset,
      chainId: 10143,
      canonicalAssetId: `eip155:10143/erc20:${asset.address}`,
    };
    const input = await economicRequest({
      chainId: 10143,
      inputToken: testAsset.address,
    });
    expect(await kernelFor(input).authorize(input)).toMatchObject({
      code: 'NETWORK_MISMATCH',
    });
  });
  it('KER-005 missing, duplicate, impersonated, revoked or expired signers cannot satisfy quorum', async () => {
    const input = await request();
    expect(
      await kernelFor(input).authorize({
        ...input,
        approvals: input.approvals.slice(0, 1),
      }),
    ).toMatchObject({ status: 'PENDING_APPROVAL', code: 'MISSING_QUORUM' });
    expect(
      await kernelFor(input).authorize({
        ...input,
        approvals: [input.approvals[0]!, input.approvals[0]!],
      }),
    ).toMatchObject({ code: 'DUPLICATE_APPROVER' });
    expect(
      await kernelFor(input).authorize({
        ...input,
        approvals: [
          { ...input.approvals[0]!, signature: input.approvals[1]!.signature },
          input.approvals[1]!,
        ],
      }),
    ).toMatchObject({ code: 'INVALID_APPROVAL' });
    expect(
      await kernelFor(input).authorize({
        ...input,
        approvals: [
          { ...input.approvals[0]!, expiresAt: 999 },
          input.approvals[1]!,
        ],
      }),
    ).toMatchObject({ code: 'INVALID_APPROVAL' });
    const policy = mandate({
      members: mandate().members.map((m, i) => ({ ...m, active: i !== 0 })),
    });
    expect(await kernelFor(input, policy).authorize(input)).toMatchObject({
      code: 'INVALID_APPROVAL',
    });
    const changed = await economicRequest({ maxInputAmount: '61' });
    expect(
      await kernelFor(changed).authorize({
        ...changed,
        approvals: input.approvals,
      }),
    ).toMatchObject({ code: 'INVALID_APPROVAL' });
  });
  it('new output token demands consensus even inside AUTO amount cap', async () => {
    const input = await economicRequest({
      maxInputAmount: '1',
      outputToken: address(12),
      minOutputAmount: '1',
    });
    expect(
      await kernelFor(input).authorize({ ...input, approvals: [] }),
    ).toMatchObject({ status: 'PENDING_APPROVAL', tier: 'CONSENSUS' });
    expect(
      await kernelFor(
        input,
        mandate({ allowNewOutputAssets: false }),
      ).authorize(input),
    ).toMatchObject({ code: 'ASSET_FORBIDDEN' });
  });
  it('AUTO and REVIEW approval requirements derive from mandate facts', async () => {
    const auto = await economicRequest({ maxInputAmount: '20' }),
      review = await economicRequest({ maxInputAmount: '21' });
    expect(
      await kernelFor(auto).authorize({ ...auto, approvals: [] }),
    ).toMatchObject({
      status: 'AUTHORIZED',
      tier: 'AUTO',
      requiredApprovals: 0,
    });
    expect(
      await kernelFor(review).authorize({
        ...review,
        approvals: review.approvals.slice(0, 1),
      }),
    ).toMatchObject({
      status: 'AUTHORIZED',
      tier: 'REVIEW',
      requiredApprovals: 1,
    });
  });
  it.each([
    ['stale quote', { quoteAt: 900 }, 'STALE_QUOTE'],
    ['expired quote', { quoteExpiresAt: 999 }, 'STALE_QUOTE'],
    ['future quote', { quoteAt: 1001 }, 'STALE_QUOTE'],
    ['stale evidence', { evaluatedAt: 900 }, 'STALE_EVIDENCE'],
    ['blocked risk', { blocked: true }, 'RISK_REJECTED'],
    ['slippage risk', { slippageBps: 51 }, 'RISK_REJECTED'],
    ['oracle deviation', { referenceDeviationBps: 51 }, 'RISK_REJECTED'],
    [
      'untrusted oracle',
      [
        {
          source: 'web',
          retrievedAt: 1000,
          chainId: 31337,
          artifactHash: hash(8),
          untrusted: true,
        },
      ],
      'STALE_EVIDENCE',
    ],
  ])('%s blocks economic authority', async (name, patch, code) => {
    const riskPatch = name === 'untrusted oracle' ? { evidence: patch } : patch;
    const data = evidence(
      intent(),
      riskPatch as Parameters<typeof evidence>[1],
    );
    const input = { ...data, approvals: await approvals(data.intent), now };
    expect(await kernelFor(input).authorize(input)).toMatchObject({ code });
  });
  it('rejects simulation mismatch/failure/staleness and unregistered evidence', async () => {
    const input = await request();
    for (const [patch, code] of [
      [{ target: address(99) }, 'SIMULATION_MISMATCH'],
      [{ calldataHash: hash(99) }, 'SIMULATION_MISMATCH'],
      [{ succeeded: false }, 'SIMULATION_FAILED'],
      [{ simulatedAt: 900 }, 'STALE_SIMULATION'],
    ] as const) {
      const changed = {
        ...input,
        simulation: { ...input.simulation, ...patch },
      };
      expect(await kernelFor(changed).authorize(changed)).toMatchObject({
        code,
      });
    }
    expect(
      await new Kernel({
        network,
        mandates: [mandate()],
        balances: [{ account: input.intent.account, asset, balance: '10000' }],
      }).authorize(input),
    ).toMatchObject({ code: 'EVIDENCE_MISMATCH' });
    expect(
      await kernelFor(input).authorize({
        ...input,
        risk: { ...input.risk, referenceDeviationBps: 0 },
      }),
    ).toMatchObject({ code: 'EVIDENCE_MISMATCH' });
  });
  it('exact canonical hash binds every economic parameter and normalizes key order', () => {
    const base = intent();
    expect(intentHash({ ...base })).toBe(
      intentHash(
        Object.fromEntries(Object.entries(base).reverse()) as typeof base,
      ),
    );
    for (const patch of [
      { target: address(99) },
      { maxInputAmount: '61' },
      { minOutputAmount: '1', outputToken: asset.address },
      { pluginId: 'other' },
      { operator: address(99) },
      { calldataHash: hash(99) },
      { selector: '0x12345678' },
      { nonce: '2' },
      { nativeValue: '1' },
      { validUntil: 1499 },
      { evidenceHash: hash(99) },
      { riskPacketHash: hash(99) },
    ])
      expect(intentHash(intent(patch))).not.toBe(intentHash(base));
    expect(economicIntentHash(intent({ evidenceHash: hash(99) }))).toBe(
      economicIntentHash(base),
    );
  });
  it('KER-010 serializes concurrent reservations, reconciliation and cumulative spend', async () => {
    const first = await economicRequest({ maxInputAmount: '100' }),
      second = await economicRequest({
        maxInputAmount: '100',
        nonce: '2',
        intentId: 'intent_2',
      }),
      third = await economicRequest({
        maxInputAmount: '1',
        nonce: '3',
        intentId: 'intent_3',
      });
    const kernel = kernelFor([first, second, third]);
    const results = await Promise.all([
      kernel.authorize(first),
      kernel.authorize(second),
      kernel.authorize(third),
    ]);
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(2);
    expect(results[2]).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    const grant = results[0];
    if (grant?.status !== 'AUTHORIZED') throw new Error('expected grant');
    kernel.consume(grant.grant, first.intent, now);
    kernel.reconcile(grant.grant.grantId, '50');
    expect(kernel.accounting('group_1', 'mandate_1')).toMatchObject({
      spent: '50',
      reserved: '100',
    });
    expect(() => kernel.reconcile(grant.grant.grantId, '50')).toThrow(
      'RECONCILIATION_INVALID',
    );
    expect(await kernel.authorize(third)).toMatchObject({
      status: 'AUTHORIZED',
    });
  });
  it('locks nonces and single-use grant identity across expiry/restart/consume', async () => {
    const input = await request();
    let kernel = kernelFor(input);
    const result = await kernel.authorize(input);
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    kernel = Kernel.restore(JSON.parse(JSON.stringify(kernel.snapshot())));
    expect(await kernel.authorize(input)).toMatchObject({
      code: 'NONCE_REPLAY',
    });
    expect(() =>
      kernel.verify(
        { ...result.grant, maxInputAmount: '61' },
        input.intent,
        now,
      ),
    ).toThrow('GRANT_MISMATCH');
    expect(() =>
      kernel.verify(
        result.grant,
        { ...input.intent, calldataHash: hash(99) },
        now,
      ),
    ).toThrow('GRANT_MISMATCH');
    expect(() => kernel.verify(result.grant, input.intent, now + 20)).toThrow(
      'GRANT_EXPIRED',
    );
    kernel.consume(result.grant, input.intent, now);
    expect(() => kernel.consume(result.grant, input.intent, now)).toThrow(
      'GRANT_REPLAY',
    );
    expect(kernel.releaseExpired(now + 100)).toBe(0);
    expect(kernel.accounting('group_1', 'mandate_1').reserved).toBe('60');
    expect(() => kernel.reconcile(result.grant.grantId, '61')).toThrow(
      'RECONCILIATION_INVALID',
    );
  });
  it('expired unconsumed reservations release while revocation and supersession invalidate grants', async () => {
    const input = await request();
    const kernel = kernelFor(input);
    const result = await kernel.authorize(input);
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    kernel.mandates.update(mandate({ status: 'REVOKED' }));
    expect(() => kernel.verify(result.grant, input.intent, now)).toThrow(
      'MANDATE_REVOKED',
    );
    expect(kernel.releaseExpired(now + 20)).toBe(1);
    expect(kernel.accounting('group_1', 'mandate_1').reserved).toBe('0');
    expect(await kernel.authorize(input)).toMatchObject({
      code: 'MANDATE_REVOKED',
    });
    const another = kernelFor(input);
    const grant = await another.authorize(input);
    if (grant.status !== 'AUTHORIZED') throw new Error(grant.code);
    another.mandates.update(mandate({ version: 2 }));
    expect(() => another.verify(grant.grant, input.intent, now)).toThrow(
      'MANDATE_VERSION',
    );
  });
  it('recurring counts and frequency remain bounded after release', async () => {
    const one = await economicRequest({ maxInputAmount: '10' }),
      two = await economicRequest({ maxInputAmount: '10', nonce: '2' });
    const kernel = kernelFor([one, two], mandate({ maxExecutions: 1 }));
    expect(await kernel.authorize({ ...one, approvals: [] })).toMatchObject({
      status: 'AUTHORIZED',
    });
    kernel.releaseExpired(now + 20);
    expect(await kernel.authorize({ ...two, approvals: [] })).toMatchObject({
      code: 'RECURRING_CAP',
    });
    const cadence = kernelFor([one, two], mandate({ minIntervalSeconds: 60 }));
    await cadence.authorize(one);
    expect(await cadence.authorize(two)).toMatchObject({
      code: 'FREQUENCY_CAP',
    });
  });
  it('generated amounts never exceed per-action or cumulative envelope', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.integer({ min: 1, max: 150 }), {
          minLength: 1,
          maxLength: 15,
        }),
        async (amounts) => {
          const inputs = await Promise.all(
            amounts.map((amount, i) =>
              economicRequest({
                maxInputAmount: String(amount),
                nonce: String(i),
                intentId: `intent_${i}`,
              }),
            ),
          );
          const kernel = kernelFor(inputs);
          let reserved = 0n;
          for (const input of inputs) {
            const result = await kernel.authorize(input);
            if (result.status === 'AUTHORIZED') {
              expect(BigInt(result.grant.maxInputAmount)).toBeLessThanOrEqual(
                100n,
              );
              reserved += BigInt(result.grant.maxInputAmount);
              expect(reserved).toBeLessThanOrEqual(200n);
              expect(result.grant.intentHash).toBe(intentHash(input.intent));
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
  it('shared treasury reservations prevent independent mandates oversubscribing a balance', async () => {
    const first = await request(),
      second = await economicRequest({ mandateId: 'mandate_2', nonce: '2' });
    const kernel = new Kernel({
      network,
      mandates: [mandate(), mandate({ mandateId: 'mandate_2' })],
      balances: [{ account: first.intent.account, asset, balance: '100' }],
      trustedEvidence: {
        riskPacketHashes: [first, second].map((r) => artifactHash(r.risk)),
        simulationHashes: [first, second].map((r) =>
          artifactHash(r.simulation),
        ),
      },
    });
    const results = await Promise.all([
      kernel.authorize(first),
      kernel.authorize(second),
    ]);
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    expect(results[1]).toMatchObject({ code: 'INSUFFICIENT_BALANCE' });
  });
  it('rejects malformed or internally inconsistent persisted snapshots', async () => {
    const input = await request(),
      kernel = kernelFor(input);
    await kernel.authorize(input);
    const snapshot = kernel.snapshot();
    snapshot.ledger[0]![1].reserved = '0';
    expect(() => Kernel.restore(snapshot)).toThrow('INVALID_INPUT');
    const another = kernel.snapshot();
    another.nonces = [];
    expect(() => Kernel.restore(another)).toThrow('INVALID_INPUT');
    const third = kernel.snapshot();
    third.balances[0]!.balance = '-1';
    expect(() => Kernel.restore(third)).toThrow();
  });
});
