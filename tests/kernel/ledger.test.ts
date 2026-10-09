import { describe, expect, it } from 'vitest';
import {
  ACTION_MACHINE,
  verifyHistory,
} from '../../packages/domain/src/index.js';
import {
  AuditRecorder,
  Kernel,
  type KernelSnapshot,
} from '../../packages/kernel/src/index.js';
import {
  ACCOUNT,
  allPlugins,
  approve,
  asset,
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
  type Harness,
} from './fixtures.js';

function restore(h: Harness, snapshot: unknown) {
  return Kernel.restore(snapshot, {
    clock: h.clock,
    approvalLedger: h.ledger,
    membershipDirectory: h.directory,
    freshness: { probe: h.probe, maxLagBlocks: 0 },
    plugins: allPlugins(),
  });
}
const callHash = hash(0xca11);

describe('grant consumption and preparation (S8)', () => {
  it('regression: a grant is prepared once, only by its claiming worker, and is never released after claim', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const claim = h.kernel.claimForExecution(grant, input.intent, 'worker-a');
    expect(() =>
      h.kernel.prepare({ ...claim, workerId: 'worker-b' }, callHash),
    ).toThrow('GRANT_CLAIM_INVALID');
    expect(h.kernel.prepare(claim, callHash).grantId).toBe(grant.grantId);
    expect(() => h.kernel.prepare(claim, callHash)).toThrow(
      'GRANT_NOT_PREPARABLE',
    );
    h.clock.t = now + 500;
    expect(h.kernel.releaseExpired()).toBe(0);
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe(
      '60',
    );
    expect(h.kernel.lifecycle(grant.intentId).at(-1)?.to).toBe('PREPARED');
  });
  it('preparation fails after expiry and after revocation', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const claim = h.kernel.claimForExecution(grant, input.intent, 'w');
    h.kernel.revokeMandate('group_1', 'mandate_1');
    expect(() => h.kernel.prepare(claim, callHash)).toThrow('MANDATE_REVOKED');
    const g = harness(input);
    const issued = await grantFor(g, input);
    const c = g.kernel.claimForExecution(issued.grant, input.intent, 'w');
    g.clock.t = issued.grant.validUntil;
    expect(() => g.kernel.prepare(c, callHash)).toThrow('GRANT_EXPIRED');
  });
  it('unclaimed expired reservations release and unexecuted claimed grants release only with chain proof', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    h.clock.t = grant.validUntil;
    expect(h.kernel.releaseExpired()).toBe(1);
    expect(h.kernel.lifecycle(grant.intentId).at(-1)?.to).toBe('EXPIRED');
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
    const g = harness(input);
    const issued = await grantFor(g, input);
    const claim = g.kernel.claimForExecution(issued.grant, input.intent, 'w');
    g.kernel.prepare(claim, callHash);
    expect(() =>
      g.kernel.releaseUnexecuted(issued.grant.grantId, {
        nonceUsed: false,
        intentUsed: false,
        blockTimestamp: issued.grant.validUntil - 1,
      }),
    ).toThrow('RECONCILIATION_INVALID');
    expect(() =>
      g.kernel.releaseUnexecuted(issued.grant.grantId, {
        nonceUsed: true,
        intentUsed: true,
        blockTimestamp: issued.grant.validUntil,
      }),
    ).toThrow('RECONCILIATION_INVALID');
    g.kernel.releaseUnexecuted(issued.grant.grantId, {
      nonceUsed: false,
      intentUsed: false,
      blockTimestamp: issued.grant.validUntil,
    });
    expect(g.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });
});

describe('§37 reconciliation binds to the decoded GrantExecuted event', () => {
  async function prepared() {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const claim = h.kernel.claimForExecution(grant, input.intent, 'w');
    h.kernel.prepare(claim, callHash);
    return { h, grant, input };
  }
  it('regression: caller-asserted spend is not accepted; the observed event fields must match', async () => {
    const { h, grant } = await prepared();
    expect(() => h.kernel.reconcile(grant.grantId, '60')).toThrow(
      'RECONCILIATION_INVALID',
    );
    for (const patch of [
      { recipient: `0x${'5'.repeat(40)}` },
      { tokenAmount: '61' },
      { nonce: '2' },
      { account: `0x${'6'.repeat(40)}` },
      { target: `0x${'7'.repeat(40)}` },
      { selector: '0x12345678' },
      { token: `0x${'8'.repeat(40)}` },
      { chainId: '10143' },
      { intentHash: hash(1) },
      { grantHash: hash(2) },
    ])
      expect(() =>
        h.kernel.reconcile(grant.grantId, executedObservation(grant, patch)),
      ).toThrow('RECONCILIATION_MISMATCH');
    expect(() =>
      h.kernel.reconcile(
        grant.grantId,
        executedObservation(grant, {}, { emitter: `0x${'9'.repeat(40)}` }),
      ),
    ).toThrow('RECONCILIATION_MISMATCH');
    expect(() =>
      h.kernel.reconcile(
        grant.grantId,
        executedObservation(grant, {}, { chainId: 10143 }),
      ),
    ).toThrow('RECONCILIATION_MISMATCH');
    h.kernel.reconcile(
      grant.grantId,
      executedObservation(grant, { tokenAmount: '55' }),
    );
    expect(h.kernel.accounting('group_1', 'mandate_1')).toMatchObject({
      spentToken: '55',
      reservedToken: '0',
    });
    expect(() =>
      h.kernel.reconcile(grant.grantId, executedObservation(grant)),
    ).toThrow('RECONCILIATION_INVALID');
  });
  it('a reverted receipt keeps the reservation until the grant can no longer execute', async () => {
    const { h, grant } = await prepared();
    h.kernel.reconcile(
      grant.grantId,
      executedObservation(
        grant,
        {},
        { receiptStatus: 'reverted', event: null, emitter: null },
      ),
    );
    expect(h.kernel.grantState(grant.grantId).state).toBe('REVERTED');
    expect(h.kernel.releaseExpired()).toBe(0);
    h.clock.t = grant.validUntil;
    expect(h.kernel.releaseExpired()).toBe(1);
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });
  it('S6: balance observations are monotonic and reconciliation never double-debits an observed balance', async () => {
    const { h, grant } = await prepared();
    h.kernel.observeBalance(
      { account: ACCOUNT, asset, balance: '9940' },
      '150',
    );
    expect(() =>
      h.kernel.observeBalance({ account: ACCOUNT, asset, balance: '1' }, '149'),
    ).toThrow('BALANCE_REGRESSION');
    h.kernel.reconcile(grant.grantId, executedObservation(grant));
    const balance = h.kernel
      .snapshot()
      .balances.find(
        (b) => b.asset.canonicalAssetId === asset.canonicalAssetId,
      );
    expect(balance?.balance).toBe('9940');
    const { h: other, grant: g2 } = await prepared();
    other.kernel.reconcile(g2.grantId, executedObservation(g2));
    expect(
      other.kernel
        .snapshot()
        .balances.find(
          (b) => b.asset.canonicalAssetId === asset.canonicalAssetId,
        )?.balance,
    ).toBe('9940');
  });
});

describe('snapshot integrity', () => {
  it('round-trips through JSON and keeps nonces, reservations, lifecycle and audit', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const { grant } = await grantFor(h, input);
    const restored = restore(
      h,
      JSON.parse(JSON.stringify(h.kernel.snapshot())),
    );
    expect(restored.accounting('group_1', 'mandate_1').reservedToken).toBe(
      '60',
    );
    expect(restored.lifecycle(grant.intentId).map((t) => t.to)).toEqual([
      'RISKED',
      'SIMULATED',
      'PENDING_APPROVAL',
      'AUTHORIZED',
    ]);
    expect(restored.auditLog()).toEqual(h.kernel.auditLog());
    expect(restored.verify(grant, input.intent).grantId).toBe(grant.grantId);
  });
  it.each([
    [
      'reservedToken',
      (s: KernelSnapshot) => (s.budgets[0]![1].reservedToken = '1'),
    ],
    ['spentToken', (s: KernelSnapshot) => (s.budgets[0]![1].spentToken = '1')],
    ['issued', (s: KernelSnapshot) => (s.budgets[0]![1].issued = 2)],
    ['lastIssued', (s: KernelSnapshot) => (s.budgets[0]![1].lastIssued = 2)],
    ['nonces', (s: KernelSnapshot) => (s.nonces = [])],
    [
      'grant digest',
      (s: KernelSnapshot) => (s.grants[0]!.grant.grantId = hash(5)),
    ],
    ['grant state', (s: KernelSnapshot) => (s.grants[0]!.state = 'RECONCILED')],
    ['lifecycle', (s: KernelSnapshot) => (s.lifecycles = [])],
    ['audit chain', (s: KernelSnapshot) => (s.audit[0]!.recordedAt = 1)],
    [
      'regression: balance below outstanding reservations',
      (s: KernelSnapshot) => (s.balances[0]!.balance = '59'),
    ],
    [
      'negative balance',
      (s: KernelSnapshot) => (s.balances[0]!.balance = '-1'),
    ],
    [
      'module',
      (s: KernelSnapshot) => (s.executionModule = `0x${'1'.repeat(40)}`),
    ],
  ])('restore rejects inconsistent %s', async (_name, mutate) => {
    const input = evidence(intent());
    const h = harness(input);
    await grantFor(h, input);
    const snapshot = h.kernel.snapshot();
    mutate(snapshot);
    expect(() => restore(h, snapshot)).toThrow(
      /SNAPSHOT_INVALID|AUDIT_CHAIN_BROKEN/,
    );
  });
});

describe('§52 audit decision artifacts and §11 lifecycle', () => {
  it('every decision appends a hash-linked artifact carrying the typed PolicyResult', async () => {
    const input = evidence(intent());
    const bad = evidence(intent({ maxInputAmount: '101', nonce: '7' }));
    const h = harness([input, bad]);
    await authorizeWith(h, input);
    await h.kernel.authorize({ ...bad, approvals: [] });
    const log = h.kernel.auditLog();
    expect(log.map((r) => r.kind)).toEqual([
      'AUTHORIZATION',
      'AUTHORIZATION',
      'AUTHORIZATION',
    ]);
    expect(log.map((r) => (r.payload as { status: string }).status)).toEqual([
      'PENDING_APPROVAL',
      'AUTHORIZED',
      'POLICY_REJECTED',
    ]);
    expect(log[2]!.payload).toMatchObject({
      code: 'AMOUNT_CAP',
      policy: { rejection: { code: 'AMOUNT_CAP', rule: 'cap.token' } },
    });
    expect(AuditRecorder.verify(log)).toHaveLength(3);
    const tampered = structuredClone(log);
    (tampered[1]!.payload as { status: string }).status = 'POLICY_REJECTED';
    expect(() => AuditRecorder.verify(tampered)).toThrow('AUDIT_CHAIN_BROKEN');
    const sink: unknown[] = [];
    const withSink = harness(input, [mandate()], {
      auditSink: { append: (r) => sink.push(r) },
    });
    await withSink.kernel.authorize({ ...input, approvals: [] });
    expect(sink).toHaveLength(1);
  });
  it('Kernel transitions are valid §11 ACTION_MACHINE histories', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    expect(pending.transitions.map((t) => t.to)).toEqual([
      'RISKED',
      'SIMULATED',
      'PENDING_APPROVAL',
    ]);
    const granted = await h.kernel.authorize({
      ...input,
      approvals: await approve(h, expectDraft(pending)),
    });
    expect(granted.transitions.map((t) => [t.from, t.to])).toEqual([
      ['PENDING_APPROVAL', 'AUTHORIZED'],
    ]);
    const history = h.kernel.lifecycle(granted.intentId!);
    expect(verifyHistory(ACTION_MACHINE, history, 'PROPOSED')).toBe(
      'AUTHORIZED',
    );
    expect(history.every((t) => t.actor.principalId === 'synq-kernel')).toBe(
      true,
    );
    const stale = evidence(intent({ nonce: '3' }), { quoteAt: 900 });
    const s = harness(stale);
    const rejected = await s.kernel.authorize({ ...stale, approvals: [] });
    expect(rejected.transitions.map((t) => t.to)).toEqual([
      'RISKED',
      'RISK_REJECTED',
    ]);
    expect(await s.kernel.authorize({ ...stale, approvals: [] })).toMatchObject(
      {
        code: 'INTENT_TERMINAL',
      },
    );
  });
});

describe('TOCTOU and concurrency', () => {
  it('concurrent duplicate authorizations issue exactly one grant', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        h.kernel.authorize({ ...input, approvals }),
      ),
    );
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    expect(
      results
        .filter((r) => r.status !== 'AUTHORIZED')
        .every((r) => 'code' in r && r.code === 'NONCE_REPLAY'),
    ).toBe(true);
  });
  it('shared treasury reservations prevent two mandates oversubscribing one balance', async () => {
    const first = evidence(intent());
    const second = evidence(intent({ mandateId: 'mandate_2', nonce: '2' }));
    const h = harness(
      [first, second],
      [mandate(), mandate({ mandateId: 'mandate_2' })],
      {
        balances: [{ account: ACCOUNT, asset, balance: '100' }],
      },
    );
    const results = await Promise.all([
      authorizeWith(h, first),
      authorizeWith(h, second),
    ]);
    expect(results.filter((r) => r.status === 'AUTHORIZED')).toHaveLength(1);
    expect(results.find((r) => r.status !== 'AUTHORIZED')).toMatchObject({
      code: 'INSUFFICIENT_BALANCE',
    });
  });
  it('governance revocation while approvals are being verified invalidates the pending decision', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approvals = await approve(h, draft);
    const real = h.ledger.isConsumed.bind(h.ledger);
    let revoked = false;
    h.ledger.isConsumed = async (a) => {
      if (!revoked) {
        revoked = true;
        h.kernel.revokeMandate('group_1', 'mandate_1');
      }
      return real(a);
    };
    expect(await h.kernel.authorize({ ...input, approvals })).toMatchObject({
      status: 'POLICY_REJECTED',
      code: 'MANDATE_VERSION',
    });
    expect(h.kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });
  it('the decision is bound to the request as submitted, not to later caller mutation', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const request = {
      ...structuredClone(input),
      approvals: await approve(h, draft),
    };
    const pending = h.kernel.authorize(request);
    request.intent.maxInputAmount = '100';
    request.intent.recipient = `0x${'5'.repeat(40)}`;
    request.risk.slippageBps = 10_000;
    request.simulation.succeeded = false;
    const result = await pending;
    if (result.status !== 'AUTHORIZED') throw new Error(result.code);
    expect(result.grant).toMatchObject({
      maxInputAmount: '60',
      validAfter: 900,
    });
  });
});
