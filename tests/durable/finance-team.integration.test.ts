import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { privateKeyToAccount } from 'viem/accounts';
import type { Address, Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  intentApprovalTypedData,
  mandateTypedData,
  type AuthorityConfig,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  PostgresApprovalNonceFence,
  PostgresFinanceBudgetLedger,
  PostgresObligationFence,
  arcPaymentKernel,
  migrateFinanceTeam,
} from '@synq/agent-runtime';
import { durablePool, runId } from './pg.js';

let pool: pg.Pool;
const USDC = token('arc-testnet', 'USDC');
const caps = { toolCalls: 100, tokens: 10_000, paidMicroUsd: 5_000 };

beforeAll(async () => {
  pool = await durablePool();
  await migrateFinanceTeam(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('finance team durable state on Postgres', { timeout: 60_000 }, () => {
  it('budget usage survives a restart and never goes negative', async () => {
    const ws = `wsp_${runId()}`;
    let t = 1_800_000_000;
    const a = new PostgresFinanceBudgetLedger(pool, caps, { now: () => t });
    await a.record(ws, { toolCalls: 30, tokens: 4_000, paidMicroUsd: 1_000 });
    await a.record(ws, {
      toolCalls: -50,
      tokens: Number.NaN,
      paidMicroUsd: Number.POSITIVE_INFINITY,
    });
    const b = new PostgresFinanceBudgetLedger(pool, caps, { now: () => t });
    expect(await b.remaining(ws)).toEqual({
      toolCalls: 70,
      tokens: 6_000,
      paidMicroUsd: 4_000,
    });
    // The database itself refuses negative usage.
    await expect(
      pool.query(
        'UPDATE synq_finance_budget_usage SET tokens = -1 WHERE workspace_id=$1',
        [ws],
      ),
    ).rejects.toThrow(/check/i);
    // A new window starts fresh; the old one is kept.
    t += 86_400;
    expect(await b.remaining(ws)).toEqual(caps);
  });

  it('a run that crashes after reserving keeps its hold after restart (fail closed); settle is idempotent', async () => {
    const ws = `wsp_${runId()}`;
    const t = 1_800_000_000;
    const a = new PostgresFinanceBudgetLedger(pool, caps, { now: () => t });
    const held = await a.reserve(
      ws,
      { toolCalls: 40, tokens: 3_000, paidMicroUsd: 2_000 },
      'run_crashed',
    );
    expect(held.granted).toEqual({
      toolCalls: 40,
      tokens: 3_000,
      paidMicroUsd: 2_000,
    });
    // Process dies here: no settle. A fresh instance still sees the hold.
    const b = new PostgresFinanceBudgetLedger(pool, caps, { now: () => t });
    expect(await b.remaining(ws)).toEqual({
      toolCalls: 60,
      tokens: 7_000,
      paidMicroUsd: 3_000,
    });
    const run = await b.reserve(
      ws,
      { toolCalls: 40, tokens: 3_000, paidMicroUsd: 2_000 },
      'run_ok',
    );
    await b.settle(ws, run.reservationId, {
      toolCalls: 5,
      tokens: 100,
      paidMicroUsd: 0,
    });
    await b.settle(ws, run.reservationId, {
      toolCalls: 0,
      tokens: 0,
      paidMicroUsd: 0,
    });
    expect(await b.remaining(ws)).toEqual({
      toolCalls: 55,
      tokens: 6_900,
      paidMicroUsd: 3_000,
    });
  });

  it('concurrent runs from many processes can never jointly exceed a cap', async () => {
    const ws = `wsp_${runId()}`;
    const t = 1_800_000_000;
    const grants = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        new PostgresFinanceBudgetLedger(pool, caps, { now: () => t }).reserve(
          ws,
          { toolCalls: 20, tokens: 1_500, paidMicroUsd: 700 },
          `run_${i}`,
        ),
      ),
    );
    const sum = (k: 'toolCalls' | 'tokens' | 'paidMicroUsd') =>
      grants.reduce((n, g) => n + g.granted[k], 0);
    expect(sum('toolCalls')).toBe(100);
    expect(sum('tokens')).toBe(10_000);
    expect(sum('paidMicroUsd')).toBe(5_000);
    expect(
      await new PostgresFinanceBudgetLedger(pool, caps, {
        now: () => t,
      }).remaining(ws),
    ).toEqual({ toolCalls: 0, tokens: 0, paidMicroUsd: 0 });
  });

  it('an obligation is reserved once across processes and after restart; approval nonces redeem once', async () => {
    const scope = `mnd_${runId()}`;
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        new PostgresObligationFence(pool, scope).reserve('inv_42'),
      ),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await new PostgresObligationFence(pool, scope).reserve('inv_42'),
    ).toBe(false);
    expect(
      await new PostgresObligationFence(pool, `${scope}_other`).reserve(
        'inv_42',
      ),
    ).toBe(true);
    const nonce = `0x${'ab'.repeat(32)}` as Hex;
    const redeemed = await Promise.all(
      Array.from({ length: 6 }, () =>
        new PostgresApprovalNonceFence(pool, scope).redeem(nonce),
      ),
    );
    expect(redeemed.filter(Boolean)).toHaveLength(1);
  });

  it('two Kernel ports (two processes) on one database grant an obligation once and an owner approval once', async () => {
    const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
    const payer = `0x${'a1'.repeat(20)}` as Address;
    const sarah = `0x${'5a'.repeat(20)}` as Address;
    const now = 1_800_000_000;
    const config: AuthorityConfig = {
      grantKey: new Uint8Array(32).fill(3),
      operator: 'arc-executor',
      grantTtlSeconds: 120,
      riskRequiredAbove: 50_000_000n,
    };
    const mandate: PaymentMandate = {
      mandateId: `mnd_${runId()}`,
      version: 1,
      workspaceId: 'wsp_ports',
      owner: owner.address,
      chainId: USDC.chainId,
      token: USDC.address,
      payer,
      recipients: [sarah],
      purposes: ['CONTRACTOR_PAYOUT'],
      perActionCap: 1_000_000n,
      periodBudget: 10_000_000n,
      periodSeconds: 86_400,
      validFrom: now - 60,
      validUntil: now + 86_400,
    };
    const mandateSignature = await owner.signTypedData(
      mandateTypedData(mandate),
    );
    const port = () =>
      arcPaymentKernel({
        config,
        mandate,
        mandateSignature,
        state: () => ({ revoked: false, spends: [] }),
        simulate: async () => true,
        now: () => now,
        obligations: new PostgresObligationFence(pool, mandate.mandateId),
        approvals: new PostgresApprovalNonceFence(pool, mandate.mandateId),
      });
    const intent = (
      obligationRef: string,
      intentId: string,
    ): PaymentIntent => ({
      intentId,
      mandateId: mandate.mandateId,
      mandateVersion: 1,
      chainId: USDC.chainId,
      token: USDC.address,
      payer,
      recipient: sarah,
      amount: 500_000n,
      purpose: 'CONTRACTOR_PAYOUT',
      obligationRef,
      evidenceHash: `0x${'e1'.repeat(32)}`,
      proposedBy: 'agent:payments',
    });
    const risk = { flags: [], available: true } as const;
    const [a, b] = await Promise.all([
      port().decide({ intent: intent('inv_7', 'int_a'), risk }),
      port().decide({ intent: intent('inv_7', 'int_b'), risk }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['ALLOW', 'DENY']);
    // A restarted port still refuses the obligation.
    const again = await port().decide({
      intent: intent('inv_7', 'int_c'),
      risk,
    });
    expect(again.outcome).toBe('DENY');
    // An owner approval redeemed by one port is refused by another.
    const terms = { nonce: `0x${'cd'.repeat(32)}` as Hex, deadline: now + 600 };
    const sig = async (i: PaymentIntent) =>
      owner.signTypedData(intentApprovalTypedData(i, terms));
    const i1 = intent('inv_8', 'int_d');
    const first = await port().decide({
      intent: i1,
      risk,
      requireOwnerApproval: true,
      ownerApproval: { ...terms, signature: await sig(i1) },
    });
    expect(first.outcome).toBe('ALLOW');
    const i2 = intent('inv_9', 'int_d');
    const replay = await port().decide({
      intent: i2,
      risk,
      requireOwnerApproval: true,
      ownerApproval: { ...terms, signature: await sig(i2) },
    });
    expect(replay).toMatchObject({
      outcome: 'DENY',
      reasons: ['owner approval already used'],
    });
  });
});

describe('Supervisor on the durable budget ledger', { timeout: 60_000 }, () => {
  it('carries the session budget across runs and a restart, reserving each run atomically', async () => {
    const { desk, cleanInvoice } =
      await import('../arc/finance-team.harness.js');
    const { superviseFinance } = await import('@synq/agent-runtime');
    const ws = `wsp_${runId()}`;
    const ledger = () =>
      new PostgresFinanceBudgetLedger(
        pool,
        { toolCalls: 3, tokens: 100_000, paidMicroUsd: 1_000_000 },
        { now: () => 1_800_000_000 },
      );
    const d1 = {
      ...(await desk([cleanInvoice], { budget: ledger() })),
      workspaceId: ws,
    };
    expect((await superviseFinance("what's my cash", d1)).status).toBe(
      'ANSWERED',
    );
    // A fresh process (new ledger instance) still sees the spent budget.
    const d2 = {
      ...(await desk([cleanInvoice], { budget: ledger() })),
      workspaceId: ws,
    };
    expect((await superviseFinance("what's my cash", d2)).status).toBe(
      'STOPPED',
    );
    const open = await pool.query(
      'SELECT count(*)::int AS n FROM synq_finance_budget_reservations WHERE workspace_id=$1 AND settled_at IS NULL',
      [ws],
    );
    expect(open.rows[0]!.n).toBe(0);
  });
});

describe('critic C-03: a run that throws never strands its budget', { timeout: 60_000 }, () => {
  it('a supervisor run whose reader throws a plain Error settles its reservation; healthy runs still fit', async () => {
    const { desk, cleanInvoice } = await import('../arc/finance-team.harness.js');
    const { superviseFinance } = await import('@synq/agent-runtime');
    const ws = `wsp_${runId()}`;
    const { FINANCE_TEAM_BUDGET } = await import('@synq/agent-runtime');
    // Caps worth exactly two full runs.
    const caps = {
      toolCalls: FINANCE_TEAM_BUDGET.maxToolCalls * 2,
      tokens: FINANCE_TEAM_BUDGET.maxLlmTokens * 2,
      paidMicroUsd: FINANCE_TEAM_BUDGET.maxPaidMicroUsd * 2,
    };
    const ledger = () =>
      new PostgresFinanceBudgetLedger(pool, caps, { now: () => 1_800_000_000 });
    for (let i = 0; i < 3; i++) {
      const broken = {
        ...(await desk([cleanInvoice], {
          budget: ledger(),
          world: async () => {
            throw new Error('rpc temporarily unavailable');
          },
        })),
        workspaceId: ws,
      };
      await expect(superviseFinance("what's my cash", broken)).rejects.toThrow(
        /temporarily unavailable/,
      );
    }
    const open = await pool.query(
      'SELECT count(*)::int AS n FROM synq_finance_budget_reservations WHERE workspace_id=$1 AND settled_at IS NULL',
      [ws],
    );
    expect(open.rows[0]!.n).toBe(0);
    const healthy = { ...(await desk([cleanInvoice], { budget: ledger() })), workspaceId: ws };
    expect((await superviseFinance("what's my cash", healthy)).status).toBe('ANSWERED');
  });

  it("a dead process's hold expires after the hold TTL, not at the end of the window", async () => {
    const ws = `wsp_${runId()}`;
    let t = 1_800_000_000 - (1_800_000_000 % 86_400) + 100;
    const l = () =>
      new PostgresFinanceBudgetLedger(pool, caps, {
        now: () => t,
        holdTtlSeconds: 900,
      });
    await l().reserve(ws, caps, 'run_dead'); // the process dies here
    expect(await l().remaining(ws)).toEqual({ toolCalls: 0, tokens: 0, paidMicroUsd: 0 });
    t += 899;
    expect((await l().remaining(ws)).toolCalls).toBe(0);
    t += 2;
    expect(await l().remaining(ws)).toEqual(caps);
    const expired = await pool.query(
      'SELECT expired FROM synq_finance_budget_reservations WHERE workspace_id=$1',
      [ws],
    );
    expect(expired.rows).toEqual([{ expired: true }]);
  });
});
