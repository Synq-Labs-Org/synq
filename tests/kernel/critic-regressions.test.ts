import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  Kernel,
  type NonceStatusReply,
  WIDENING_RULES,
  isPureWidening,
  minimumOutput,
  narrowedFields,
} from '../../packages/kernel/src/index.js';
import type { Mandate } from '../../packages/schemas/src/index.js';
import {
  ACCOUNT,
  OPERATOR,
  RECIPIENT,
  address,
  allPlugins,
  approve,
  authorizeWith,
  evidence,
  executedObservation,
  expectDraft,
  grantFor,
  harness,
  hash,
  intent,
  mandate,
  now,
  outputAsset,
  quote,
  swapIntent,
  tradeMandate,
  transferBinding,
  trust,
  type Harness,
  AUDIT_KEY,
} from './fixtures.js';

const callHash = hash(0x55);
const deps = (h: Harness) => ({
  clock: h.clock,
  auditKey: AUDIT_KEY,
  approvalLedger: h.ledger,
  membershipDirectory: h.directory,
  nonceStatus: h.chain,
  freshness: { probe: h.probe, maxLagBlocks: 0 },
  plugins: allPlugins(),
});
async function prepared(nonce = '1', amount = '60') {
  const input = evidence(intent({ maxInputAmount: amount, nonce }));
  const h = harness(input);
  const { grant } = await grantFor(h, input);
  const claim = h.kernel.claimForExecution(grant, input.intent, 'w');
  h.kernel.prepare(claim, callHash);
  return { h, grant, claim, input };
}
const reverted = (txHash: `0x${string}`) => ({
  schemaVersion: 1,
  chainId: 31337,
  transactionHash: txHash,
  blockNumber: '5',
  receiptStatus: 'reverted',
  emitter: null,
  event: null,
});

describe('F1/F4 release and revert require chain truth', () => {
  it('R1: an unrelated reverted receipt is refused; chain truth reconciles even after a bound revert', async () => {
    const { h, grant, claim } = await prepared();
    expect(() =>
      h.kernel.reconcile(grant.grantId, reverted(hash(0xdead))),
    ).toThrow('RECONCILIATION_MISMATCH');
    expect(h.kernel.grantState(grant.grantId).state).toBe('PREPARED');
    h.kernel.recordSubmission(claim, hash(0xbeef));
    h.kernel.reconcile(grant.grantId, reverted(hash(0xbeef)));
    expect(h.kernel.grantState(grant.grantId).state).toBe('REVERTED');
    h.kernel.reconcile(grant.grantId, executedObservation(grant));
    expect(h.kernel.accounting('group_1', 'mandate_1')).toMatchObject({
      spentToken: '60',
      reservedToken: '0',
    });
    h.clock.t = grant.validUntil;
    expect(await h.kernel.releaseExpired()).toBe(0);
    expect(h.kernel.accounting('group_1', 'mandate_1').spentToken).toBe('60');
  });
  it('a reverted grant whose nonce was later used on chain is never released', async () => {
    const { h, grant, claim } = await prepared();
    h.kernel.recordSubmission(claim, hash(0xbeef));
    h.kernel.reconcile(grant.grantId, reverted(hash(0xbeef)));
    h.clock.t = grant.validUntil;
    h.chain.usedNonces.add(grant.nonce);
    expect(await h.kernel.releaseExpired()).toBe(0);
    h.chain.usedNonces.clear();
    h.chain.usedIntents.add(grant.intentHash);
    expect(await h.kernel.releaseExpired()).toBe(0);
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe(
      '60',
    );
  });
  it('R3: releaseUnexecuted takes no caller booleans and fails closed without a chain reader', async () => {
    const { h, grant } = await prepared();
    h.clock.t = grant.validUntil;
    const blind = Kernel.restore(h.kernel.snapshot(), {
      ...deps(h),
      nonceStatus: undefined,
    });
    await expect(blind.releaseUnexecuted(grant.grantId)).rejects.toThrow(
      'RECONCILIATION_INVALID',
    );
    expect(await blind.releaseExpired()).toBe(0);
    const failing = Kernel.restore(h.kernel.snapshot(), {
      ...deps(h),
      nonceStatus: {
        status: async () => {
          throw new Error('rpc down');
        },
      },
    });
    await expect(failing.releaseUnexecuted(grant.grantId)).rejects.toThrow(
      'RECONCILIATION_INVALID',
    );
    const lying = Kernel.restore(h.kernel.snapshot(), {
      ...deps(h),
      nonceStatus: {
        status: async () =>
          ({ nonceUsed: 'no' }) as unknown as NonceStatusReply,
      },
    });
    expect(await lying.releaseExpired()).toBe(0);
    await h.kernel.releaseUnexecuted(grant.grantId);
    expect(h.kernel.grantState(grant.grantId).state).toBe('RELEASED');
  });
});

describe('F2 supersession narrowing is defined over every mandate field', () => {
  const base = mandate({
    maxNativeValue: '10',
    cumulativeNativeBudget: '20',
    outputAssets: [outputAsset],
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['LOCAL_FIXTURE', 'MERA_HUMAN'],
    },
    delegationScope: {
      actions: ['TRANSFER'],
      maxInputPerAction: '10',
      maxNativePerAction: '0',
      periodSeconds: 60,
      maxUsesPerPeriod: 2,
    },
    minIntervalSeconds: 5,
    maxLeverageBps: 100,
    tierPolicy: { ...mandate().tierPolicy, leverage: 'CONSENSUS' },
  });
  const tp = base.tierPolicy;
  const narrowing: [keyof Mandate, Record<string, unknown>][] = [
    ['operators', { operators: [address(31)] }],
    [
      'bindings',
      { bindings: [{ ...transferBinding, selector: '0x095ea7b3' }] },
    ],
    [
      'recipients',
      { recipients: [{ address: address(52), purpose: 'COUNTERPARTY' }] },
    ],
    ['outputAssets', { outputAssets: [] }],
    ['perActionCap', { perActionCap: '99' }],
    ['cumulativeBudget', { cumulativeBudget: '199' }],
    ['maxNativeValue', { maxNativeValue: '9' }],
    ['cumulativeNativeBudget', { cumulativeNativeBudget: '19' }],
    ['maxSlippageBps', { maxSlippageBps: 49 }],
    ['maxReferenceDeviationBps', { maxReferenceDeviationBps: 49 }],
    ['maxLeverageBps', { maxLeverageBps: 99 }],
    ['maxAllocationBps', { maxAllocationBps: 9_999 }],
    [
      'tierPolicy',
      { tierPolicy: { ...tp, tokenSpend: { autoMax: '19', reviewMax: '50' } } },
    ],
    [
      'tierPolicy',
      {
        tierPolicy: {
          ...tp,
          nativeSpend: { autoMax: '0', reviewMax: '0' },
          tokenSpend: { autoMax: '20', reviewMax: '49' },
        },
      },
    ],
    [
      'tierPolicy',
      {
        tierPolicy: {
          ...tp,
          actionFloors: [{ action: 'TRANSFER', tier: 'REVIEW' }],
        },
      },
    ],
    ['tierPolicy', { tierPolicy: { ...tp, newOutputAsset: 'BLOCKED' } }],
    ['tierPolicy', { tierPolicy: { ...tp, leverage: 'BLOCKED' } }],
    ['tierPolicy', { tierPolicy: { ...tp, withdrawal: 'BLOCKED' } }],
    [
      'approvalPolicy',
      { approvalPolicy: { ...base.approvalPolicy, quorum: 3 } },
    ],
    [
      'approvalPolicy',
      { approvalPolicy: { ...base.approvalPolicy, reviewApprovals: 2 } },
    ],
    [
      'approvalPolicy',
      {
        approvalPolicy: {
          ...base.approvalPolicy,
          eligibleKinds: ['LOCAL_FIXTURE'],
        },
      },
    ],
    [
      'approvalPolicy',
      { approvalPolicy: { ...base.approvalPolicy, accountThreshold: 1 } },
    ],
    ['delegationScope', { delegationScope: null }],
    [
      'delegationScope',
      { delegationScope: { ...base.delegationScope!, maxUsesPerPeriod: 1 } },
    ],
    [
      'members',
      { members: base.members.map((m, i) => ({ ...m, active: i !== 2 })) },
    ],
    ['validAfter', { validAfter: 901 }],
    ['validUntil', { validUntil: 1999 }],
    ['quoteTtlSeconds', { quoteTtlSeconds: 29 }],
    ['evidenceTtlSeconds', { evidenceTtlSeconds: 59 }],
    ['simulationTtlSeconds', { simulationTtlSeconds: 29 }],
    ['maxGrantTtlSeconds', { maxGrantTtlSeconds: 19 }],
    ['minIntervalSeconds', { minIntervalSeconds: 6 }],
    ['maxExecutions', { maxExecutions: 9 }],
  ];
  it('every mandate field has an explicit widening rule', () => {
    expect(Object.keys(WIDENING_RULES).sort()).toEqual(
      Object.keys(base).sort(),
    );
  });
  it.each(narrowing.map(([k, p], i) => [`${i}:${k}`, k, p] as const))(
    'R2: narrowing %s is refused as non-sensitive',
    (_n, field, patch) => {
      const next = mandate({ ...base, ...patch, version: 2 });
      expect(narrowedFields(base, next)).toContain(field);
      expect(isPureWidening(base, next)).toBe(false);
    },
  );
  it('R2: removing the operator needs a sensitive supersession, which invalidates its grants', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const narrowed = mandate({ version: 2, operators: [address(31)] });
    expect(() =>
      h.kernel.supersedeMandate(narrowed, { securitySensitive: false }),
    ).toThrow('NARROWING_REQUIRES_INVALIDATION');
    expect(h.kernel.mandate('group_1', 'mandate_1').operators).toEqual([
      OPERATOR,
    ]);
    h.kernel.supersedeMandate(narrowed, { securitySensitive: true });
    expect(() => h.kernel.claimForExecution(grant, input.intent, 'w')).toThrow(
      'MANDATE_VERSION',
    );
  });
  it('a genuine widening across many fields is accepted without invalidation', () => {
    const wider = mandate({
      ...base,
      version: 2,
      operators: [...base.operators, address(31)],
      perActionCap: '150',
      cumulativeBudget: '300',
      maxSlippageBps: 60,
      validUntil: 2100,
      approvalPolicy: {
        ...base.approvalPolicy,
        eligibleKinds: ['LOCAL_FIXTURE', 'MERA_HUMAN', 'PRIVY_DELEGATE'],
      },
      tierPolicy: { ...tp, tokenSpend: { autoMax: '30', reviewMax: '60' } },
      maxExecutions: 20,
    });
    expect(narrowedFields(base, wider)).toEqual([]);
  });
  it('property: changing any single field in the narrowing direction is never a pure widening', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: narrowing.length - 1 }), (i) => {
        const [, patch] = narrowing[i]!;
        expect(
          isPureWidening(base, mandate({ ...base, ...patch, version: 2 })),
        ).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe('F3 audit is written before state commits', () => {
  it('R6: a failing audit sink yields a typed refusal and leaves no live grant', async () => {
    const input = evidence(intent());
    let failing = false;
    const h = harness(input, [mandate()], {
      auditSink: {
        append: () => {
          if (failing) throw new Error('sink down');
        },
      },
    });
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    failing = true;
    const refused = await h.kernel.authorize({ ...input, approvals });
    expect(refused).toMatchObject({ code: 'AUDIT_UNAVAILABLE', audit: null });
    expect(() => h.kernel.grantState(draft.digest)).toThrow('GRANT_UNKNOWN');
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
    expect(h.kernel.lifecycle(refused.intentId!).at(-1)?.to).toBe(
      'PENDING_APPROVAL',
    );
    failing = false;
    const granted = await h.kernel.authorize({ ...input, approvals });
    expect(granted.status).toBe('AUTHORIZED');
    if (granted.status !== 'AUTHORIZED') return;
    failing = true;
    expect(() =>
      h.kernel.claimForExecution(granted.grant, input.intent, 'w'),
    ).toThrow('AUDIT_UNAVAILABLE');
    expect(h.kernel.grantState(granted.grant.grantId).state).toBe('RESERVED');
    expect(() => h.kernel.revokeMandate('group_1', 'mandate_1')).toThrow(
      'AUDIT_UNAVAILABLE',
    );
    expect(h.kernel.mandate('group_1', 'mandate_1').status).toBe('ACTIVE');
  });
});

describe('F5 snapshot integrity is bound to the audit chain', () => {
  async function reconciled() {
    const { h, grant } = await prepared('7', '100');
    h.kernel.reconcile(grant.grantId, executedObservation(grant));
    return { h, grant };
  }
  it.each([
    [
      'grants, nonces and budgets deleted',
      (s: ReturnType<Kernel['snapshot']>) => {
        s.grants = [];
        s.nonces = [];
        s.budgets = [];
      },
    ],
    [
      'trusted evidence injected',
      (s: ReturnType<Kernel['snapshot']>) => {
        s.trustedEvidence.riskPacketHashes.push(hash(0x1234));
      },
    ],
    [
      'balances inflated',
      (s: ReturnType<Kernel['snapshot']>) => {
        s.balances = s.balances.map((b) => ({ ...b, balance: '999999999' }));
      },
    ],
    [
      'claim sequence rewound',
      (s: ReturnType<Kernel['snapshot']>) => {
        s.claimSequence = 0;
      },
    ],
    [
      'snapshot checkpoint removed',
      (s: ReturnType<Kernel['snapshot']>) => {
        s.audit.pop();
      },
    ],
  ])('R7: restore refuses %s', async (_name, mutate) => {
    const { h } = await reconciled();
    const snapshot = h.kernel.snapshot();
    mutate(snapshot);
    expect(() => Kernel.restore(snapshot, deps(h))).toThrow(
      /SNAPSHOT_INVALID|AUDIT_CHAIN_BROKEN/,
    );
  });
  it('an untampered snapshot restores with spend, nonces and audit intact', async () => {
    const { h, grant } = await reconciled();
    const restored = Kernel.restore(
      JSON.parse(JSON.stringify(h.kernel.snapshot())),
      deps(h),
    );
    expect(restored.accounting('group_1', 'mandate_1').spentToken).toBe('100');
    expect(restored.grantState(grant.grantId).state).toBe('RECONCILED');
  });
});

describe('leverage, slippage edge and split spends', () => {
  it('leverage above the mandate maximum is BLOCKED; permitted leverage is never below CONSENSUS', async () => {
    const m = mandate({
      maxLeverageBps: 200,
      tierPolicy: { ...mandate().tierPolicy, leverage: 'CONSENSUS' },
    });
    for (const [lev, tier, status] of [
      [300, 'BLOCKED', 'POLICY_REJECTED'],
      [100, 'CONSENSUS', 'PENDING_APPROVAL'],
    ] as const) {
      const input = evidence(intent({ leverageBps: lev, maxInputAmount: '1' }));
      expect(
        await harness(input, [m]).kernel.authorize({ ...input, approvals: [] }),
      ).toMatchObject({ tier, status });
    }
  });
  it('R8: 100% slippage still requires a positive minimum output', async () => {
    expect(minimumOutput(1000n, 10_000)).toBe(0n);
    expect(minimumOutput(1n, 50)).toBe(1n);
    const policy = tradeMandate({ maxSlippageBps: 10_000 });
    const input = evidence(
      swapIntent({ maxSlippageBps: 10_000, minOutputAmount: '0' }),
      quote,
    );
    expect(
      await harness(input, [policy]).kernel.authorize({
        ...input,
        approvals: [],
      }),
    ).toMatchObject({ code: 'MIN_OUTPUT_TOO_LOW' });
  });
  it('R4/F7: AUTO-size splits are bounded by frequency and cumulative budget, not by per-action tier', async () => {
    const m = mandate({ minIntervalSeconds: 60 });
    const inputs = [1, 2].map((n) =>
      evidence(intent({ maxInputAmount: '20', nonce: String(100 + n) })),
    );
    const h = harness(inputs, [m]);
    expect((await authorizeWith(h, inputs[0]!)).tier).toBe('AUTO');
    expect(await authorizeWith(h, inputs[1]!)).toMatchObject({
      code: 'FREQUENCY_CAP',
    });
  });
  it('R5: lag without a verifier refuses', async () => {
    const input = evidence(intent());
    const h = harness(input);
    h.probe.observation = { ...h.probe.observation, indexedThroughBlock: 90 };
    expect(await h.kernel.authorize({ ...input, approvals: [] })).toMatchObject(
      {
        code: 'STALE_READ_MODEL',
      },
    );
  });
});

describe('F6 stateful property: approval sets and execution outcomes', () => {
  it('quorum is never undercounted and budgets stay consistent through claim, revert, reconcile and release', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.integer({ min: 1, max: 120 }),
            signers: fc.subarray([0, 1, 2]),
            wrongSigner: fc.boolean(),
            outcome: fc.constantFrom('none', 'executed', 'reverted', 'expired'),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        async (steps) => {
          const h = harness([], [mandate()]);
          let spent = 0n;
          for (const [i, step] of steps.entries()) {
            const input = evidence(
              intent({
                maxInputAmount: String(step.amount),
                nonce: String(i + 1),
              }),
              {},
              h.clock.t,
            );
            trust(h, input);
            const pending = await h.kernel.authorize({
              ...input,
              approvals: [],
            });
            if (pending.status !== 'PENDING_APPROVAL' || !pending.draft)
              continue;
            const approvals = await approve(h, pending.draft, step.signers, {
              ...(step.wrongSigner && step.signers.length
                ? { signerOverride: (await import('./fixtures.js')).outsider }
                : {}),
            });
            const decision = await h.kernel.authorize({ ...input, approvals });
            const required = Math.max(pending.policy!.requiredApprovals, 2);
            if (decision.status === 'AUTHORIZED') {
              expect(step.wrongSigner && step.signers.length > 0).toBe(false);
              expect(decision.grant.approvals.length).toBeGreaterThanOrEqual(
                required,
              );
              expect(
                new Set(decision.grant.approvals.map((a) => a.signer)).size,
              ).toBe(decision.grant.approvals.length);
              const tier =
                step.amount <= 20
                  ? 'AUTO'
                  : step.amount <= 50
                    ? 'REVIEW'
                    : 'CONSENSUS';
              expect(decision.tier).toBe(tier);
              const grant = decision.grant;
              if (step.outcome === 'none') continue;
              const claim = h.kernel.claimForExecution(
                grant,
                input.intent,
                'w',
              );
              h.kernel.prepare(claim, callHash);
              if (step.outcome === 'executed') {
                h.kernel.reconcile(grant.grantId, executedObservation(grant));
                h.chain.usedNonces.add(grant.nonce);
                spent += BigInt(step.amount);
              } else if (step.outcome === 'reverted') {
                h.kernel.recordSubmission(claim, hash(1000 + i));
                h.kernel.reconcile(grant.grantId, reverted(hash(1000 + i)));
              }
            } else {
              expect(
                step.signers.length < required ||
                  step.wrongSigner ||
                  decision.status !== 'PENDING_APPROVAL',
              ).toBe(true);
            }
            h.clock.t += 25;
            await h.kernel.releaseExpired();
          }
          const budget = h.kernel.accounting('group_1', 'mandate_1');
          const snapshot = h.kernel.snapshot();
          const outstanding = snapshot.grants
            .filter((g) =>
              ['RESERVED', 'CONSUMED', 'PREPARED', 'REVERTED'].includes(
                g.state,
              ),
            )
            .reduce((n, g) => n + BigInt(g.grant.maxInputAmount), 0n);
          expect(BigInt(budget.spentToken)).toBe(spent);
          expect(BigInt(budget.reservedToken)).toBe(outstanding);
          expect(spent + outstanding).toBeLessThanOrEqual(200n);
          expect(() => Kernel.restore(snapshot, deps(h))).not.toThrow();
          void ACCOUNT;
          void RECIPIENT;
          void now;
        },
      ),
      { numRuns: 40 },
    );
  }, 60_000);
});
