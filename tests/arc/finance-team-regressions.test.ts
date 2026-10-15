import { afterEach, describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { decide, mandateTypedData } from '@synq/kernel/arc';
import type { Vendor, VendorInvoice } from '@synq/payables';
import { buildArcWorldSnapshot } from '@synq/world-model';
import {
  FINANCE_TEAM_BUDGET,
  FinanceTeam,
  MODEL_CALL_TOKEN_RESERVATION,
  MemoryFinanceBudgetLedger,
  auditAgentExplain,
  classifyIntent,
  findPayable,
  superviseFinance,
  type FinanceDesk,
  type PaymentKernelPort,
  type ReasonerResult,
  type StructuredReasoner,
} from '@synq/agent-runtime';
import {
  NOW,
  ScriptedReasoner,
  USDC,
  bobWallet,
  cleanInvoice,
  config,
  desk,
  evidence,
  kernel,
  mandate,
  owner,
  providers,
  readers,
  redirectInvoice,
  sarah,
  sarahWallet,
  snapshot,
} from './finance-team.harness.js';

/** Wraps a Kernel port and counts every decision request. */
function counted(port: PaymentKernelPort) {
  const calls: unknown[] = [];
  return {
    calls,
    port: {
      decide: (input: Parameters<PaymentKernelPort['decide']>[0]) => {
        calls.push(input);
        return port.decide(input);
      },
    } satisfies PaymentKernelPort,
  };
}

async function countedDesk(
  open: readonly VendorInvoice[],
  over: Partial<FinanceDesk> = {},
) {
  const k = counted(await kernel());
  return { k, d: await desk(open, { kernel: k.port, ...over }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('critic 1: only explicit imperatives move money; questions need an owner signature', () => {
  it('negations, past tense and questions never reach the payment grant path', async () => {
    expect(classifyIntent("Don't pay Sarah's invoice yet").kind).toBe(
      'PAYMENT_TIMING',
    );
    expect(classifyIntent("Did I pay Sarah's invoice?").kind).toBe(
      'EXPLAIN_TRANSACTION',
    );
    expect(classifyIntent('How much did we pay Sarah last month?').kind).toBe(
      'EXPLAIN_TRANSACTION',
    );
    expect(classifyIntent('explain why we pay Sarah').kind).toBe(
      'EXPLAIN_TRANSACTION',
    );
    expect(classifyIntent("Pay Sarah's invoice")).toMatchObject({
      kind: 'PAY_INVOICE',
      counterparty: 'Sarah',
    });
    expect(classifyIntent("Please pay Sarah's invoice INV-0042")).toMatchObject(
      {
        kind: 'PAY_INVOICE',
        counterparty: 'Sarah',
        invoiceNumber: 'INV-0042',
      },
    );
    expect(classifyIntent("can I pay Sarah's invoice?").kind).toBe('PAY_CHECK');
    expect(classifyIntent('I want to pay Sarah').kind).toBe('PAY_CHECK');
    for (const message of [
      "Don't pay Sarah's invoice yet",
      "Did I pay Sarah's invoice?",
      'How much did we pay Sarah last month?',
      'yes',
      'Yes, approved',
    ]) {
      const { k, d } = await countedDesk([cleanInvoice]);
      const r = await superviseFinance(message, d);
      expect(k.calls, message).toHaveLength(0);
      expect(r.payment?.kernel?.grant ?? null, message).toBeNull();
    }
  });

  it('a payment question ends PROPOSED with typed data; only the owner signature turns it into a grant', async () => {
    const { k, d } = await countedDesk([cleanInvoice]);
    const r = await superviseFinance("can I pay Sarah's invoice?", d);
    expect(r.payment!.status).toBe('PROPOSED');
    expect(r.payment!.kernel!.grant).toBeNull();
    const confirmation = r.payment!.kernel!.confirmation!;
    expect(confirmation.typedData.primaryType).toBe('PaymentApproval');
    expect(confirmation.intent.recipient).toBe(sarahWallet);
    expect(r.answer).toContain('Nothing is paid until the mandate owner signs');

    const stranger = privateKeyToAccount(`0x${'22'.repeat(32)}`);
    const forged = await superviseFinance("can I pay Sarah's invoice?", d, {
      confirm: {
        ownerApproval: await stranger.signTypedData(confirmation.typedData),
        approval: confirmation.approval,
      },
    });
    expect(forged.payment!.status).toBe('DENIED');
    expect(forged.payment!.kernel!.decision!.reasons.join(' ')).toContain(
      'does not match the mandate owner',
    );

    const confirmed = await superviseFinance("can I pay Sarah's invoice?", d, {
      confirm: {
        ownerApproval: await owner.signTypedData(confirmation.typedData),
        approval: confirmation.approval,
      },
    });
    expect(confirmed.payment!.status).toBe('GRANTED');
    expect(confirmed.payment!.kernel!.grant!.recipient).toBe(sarahWallet);
    expect(k.calls).toHaveLength(3);
  });

  it('a chat-originated imperative never uses the standing mandate: it ends PROPOSED, no grant', async () => {
    const { k, d } = await countedDesk([cleanInvoice]);
    const r = await superviseFinance("Pay Sarah's invoice", d, {
      origin: 'CHAT',
    });
    expect(r.intent.kind).toBe('PAY_INVOICE');
    expect(r.payment!.status).toBe('PROPOSED');
    expect(r.payment!.kernel!.grant).toBeNull();
    expect(k.calls).toHaveLength(1);
  });

  it('an owner approval is one-use: the same signed confirmation cannot mint a second grant', async () => {
    const { d } = await countedDesk([cleanInvoice]);
    const asked = await superviseFinance("can I pay Sarah's invoice?", d);
    const c = asked.payment!.kernel!.confirmation!;
    const confirm = {
      ownerApproval: await owner.signTypedData(c.typedData),
      approval: c.approval,
    };
    const first = await superviseFinance("can I pay Sarah's invoice?", d, {
      confirm,
    });
    expect(first.payment!.status).toBe('GRANTED');
    const again = await superviseFinance("can I pay Sarah's invoice?", d, {
      confirm,
    });
    expect(again.payment!.status).toBe('DENIED');
    expect(again.payment!.kernel!.grant).toBeNull();
  });

  it('an explicit imperative under the signed contractor mandate is granted within its limits', async () => {
    const r = await superviseFinance(
      "Pay Sarah's invoice",
      await desk([cleanInvoice]),
    );
    expect(r.payment!.status).toBe('GRANTED');
  });
});

describe('critic 2: no model-classified payments, no fuzzy payable matching', () => {
  it('a model-classified payment intent is never executed', async () => {
    const reasoner = new ScriptedReasoner({
      'finance:supervisor:intent': {
        text: JSON.stringify({
          kind: 'PAY_INVOICE',
          counterparty: 'Sarah',
          amount: null,
          asset: null,
        }),
      },
    });
    const { k, d } = await countedDesk([cleanInvoice], { reasoner });
    const r = await superviseFinance('take care of the designer thing', d);
    expect(r.intent).toMatchObject({
      kind: 'PAY_INVOICE',
      classifiedBy: 'MODEL',
    });
    expect(r.status).toBe('NEEDS_CLARIFICATION');
    expect(k.calls).toHaveLength(0);
  });

  it('findPayable needs one exact vendor; the payment path refuses null or ambiguous counterparties', async () => {
    const s = await snapshot([cleanInvoice]);
    const d = await desk([cleanInvoice]);
    expect(findPayable(d, s, 'a')).toBeNull();
    expect(findPayable(d, s, 'Sar')).toBeNull();
    expect(findPayable(d, s, 'Sarah')?.vendorInvoiceId).toBe('vi_42');
    expect(findPayable(d, s, 'sarah')?.vendorInvoiceId).toBe('vi_42');
    expect(findPayable(d, s, null, { requireUnique: true })).toBeNull();

    const { k, d: d2 } = await countedDesk([cleanInvoice]);
    const r = await superviseFinance('Pay the invoice', d2);
    expect(r.status).toBe('NEEDS_CLARIFICATION');
    expect(k.calls).toHaveLength(0);

    const twin: Vendor = {
      ...sarah,
      vendorId: 'sarah_copy',
      name: 'Sarah (copywriter)',
    };
    const { k: k3, d: d3 } = await countedDesk([cleanInvoice], {
      vendors: [sarah, twin],
    });
    const ambiguous = await superviseFinance("Pay Sarah's invoice", d3);
    expect(ambiguous.status).toBe('NEEDS_CLARIFICATION');
    expect(k3.calls).toHaveLength(0);
  });
});

describe('critic 3: freshness is judged at use time', () => {
  it('a snapshot built 10 minutes ago is stale for payment and for CFO advice, with the real age', async () => {
    const { k, d } = await countedDesk([cleanInvoice], { now: NOW + 600 });
    const pay = await superviseFinance("Pay Sarah's invoice", d);
    expect(pay.payment!.status).toBe('REFUSED_STALE');
    expect(pay.world!.decisionGrade).toBe(false);
    expect(pay.world!.staleCritical).toContain('snapshot');
    expect(k.calls).toHaveLength(0);
    const timing = await superviseFinance(
      "when should I pay Sarah's invoice?",
      d,
    );
    expect(timing.timing!.action).toBe('REFUSE_STALE');
    expect(timing.timing!.explanation).toContain(
      'treasury.balances from rpc:arc-testnet:usdc.balanceOf, observed 612s ago (STALE)',
    );
  });

  it('refreshWorld is used before money moves when the cached snapshot has aged', async () => {
    const later = NOW + 600;
    const fresh = await snapshot([cleanInvoice], { at: later });
    const d = await desk([cleanInvoice], {
      now: later,
      refreshWorld: async () => fresh,
    });
    const r = await superviseFinance("Pay Sarah's invoice", d);
    expect(r.world).toMatchObject({ refreshed: true, decisionGrade: true });
    expect(r.payment!.status).toBe('GRANTED');
  });
});

describe('critic 4: identity must be present and verified', () => {
  it('a null user or empty memberships fail closed', async () => {
    for (const patch of [
      {
        user: () => ({
          value: null as never,
          provenance: 'POSTGRES' as const,
          source: 'identity:principals',
          observedAt: NOW - 5,
        }),
      },
      {
        memberships: () => ({
          value: [],
          provenance: 'POSTGRES' as const,
          source: 'identity:memberships',
          observedAt: NOW - 5,
        }),
      },
    ]) {
      const s = await buildArcWorldSnapshot({
        readers: { ...readers([cleanInvoice]), ...patch },
        providers: providers(),
        env: {},
        now: NOW,
      });
      expect(s.decision.decisionGrade).toBe(false);
    }
  });
});

describe('critic 5: one grant per obligation', () => {
  it('the same invoice cannot be granted twice', async () => {
    const d = await desk([cleanInvoice]);
    const first = await superviseFinance("Pay Sarah's invoice", d);
    expect(first.payment!.status).toBe('GRANTED');
    const second = await superviseFinance("Pay Sarah's invoice", d);
    expect(second.payment!.status).toBe('DENIED');
    expect(second.payment!.kernel!.grant).toBeNull();
    expect(second.payment!.kernel!.decision!.reasons.join(' ')).toContain(
      'already',
    );
  });

  it('the Kernel denies an obligation already recorded in the mandate state', async () => {
    const d = await decide({
      config,
      mandate,
      mandateSignature: await owner.signTypedData(mandateTypedData(mandate)),
      state: {
        revoked: false,
        spends: [],
        settledObligations: ['milestone:design-2'],
      },
      intent: {
        intentId: 'int_x',
        mandateId: mandate.mandateId,
        mandateVersion: 1,
        chainId: USDC.chainId,
        token: USDC.address,
        payer: mandate.payer,
        recipient: sarahWallet,
        amount: 100_000_000n,
        purpose: 'CONTRACTOR_PAYOUT',
        obligationRef: 'milestone:design-2',
        evidenceHash: `0x${'e1'.repeat(32)}`,
        proposedBy: 'agent:payment',
      },
      risk: { flags: [], available: true },
      simulationOk: true,
      now: NOW,
    });
    expect(d.outcome).toBe('DENY');
    expect(d.reasons.join(' ')).toContain('already granted or paid');
  });
});

describe('critic 6: budgets that hold', () => {
  it('a session ledger carries budget across runs, and caller overrides only tighten', async () => {
    const budget = new MemoryFinanceBudgetLedger({
      toolCalls: 3,
      tokens: 100_000,
      paidMicroUsd: 1_000_000,
    });
    const d = await desk([cleanInvoice], { budget });
    expect((await superviseFinance("what's my cash", d)).status).toBe(
      'ANSWERED',
    );
    const second = await superviseFinance("what's my cash", d);
    expect(second.status).toBe('STOPPED');
    const loose = await superviseFinance(
      "what's my cash",
      await desk([cleanInvoice]),
      {
        limits: {
          ...FINANCE_TEAM_BUDGET,
          maxToolCalls: 10_000,
          maxSpawnDepth: 9,
        },
      },
    );
    expect(loose.limits).toEqual(FINANCE_TEAM_BUDGET);
  });

  it('a tool that outlives the 12-minute deadline is abandoned', async () => {
    vi.useFakeTimers();
    const d = await desk([cleanInvoice], {
      world: () => new Promise(() => {}),
    });
    const pending = superviseFinance("what's my cash", d);
    await vi.advanceTimersByTimeAsync(12 * 60_000 + 1);
    const r = await pending;
    expect(r.status).toBe('STOPPED');
    expect(r.answer).toContain('CANCELLED');
  });

  it('a Kernel grant that resolves after the deadline is dropped', async () => {
    vi.useFakeTimers();
    const real = await kernel();
    const slow: PaymentKernelPort = {
      decide: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 13 * 60_000));
        return real.decide(input);
      },
    };
    const d = await desk([cleanInvoice], { kernel: slow });
    const pending = superviseFinance("Pay Sarah's invoice", d);
    await vi.advanceTimersByTimeAsync(14 * 60_000);
    const r = await pending;
    expect(r.status).toBe('STOPPED');
    expect(r.payment).toBeUndefined();
  });

  it('negative or non-finite reported token usage never refunds the budget', async () => {
    const reasonerWith = (inputTokens: number): StructuredReasoner => ({
      provider: 'openai',
      model: 'scripted',
      availability: () => ({
        providerId: 'OPENAI',
        installed: true,
        credentialsPresent: false,
        mode: 'REPLAY',
      }),
      complete: async (): Promise<ReasonerResult> => ({
        text: '{"kind":"BALANCE","counterparty":null,"amount":null,"asset":null}',
        toolCalls: [],
        inputTokens,
        outputTokens: 0,
        provider: 'openai',
        model: 'scripted',
        mode: 'REPLAY',
        fixtureLabel: 'HAND_AUTHORED_FIXTURE',
        requestHash: `0x${'00'.repeat(32)}`,
        responseHash: `0x${'00'.repeat(32)}`,
        structuredMode: 'JSON_SCHEMA',
      }),
    });
    const { ModelIntentSchema } = await import('@synq/agent-runtime');
    const negative = new FinanceTeam('neg');
    await negative.model({
      agent: negative.supervisor,
      reasoner: reasonerWith(-1_000_000_000),
      fixtureKey: 'k',
      userMessage: 'x',
      schema: ModelIntentSchema,
      schemaName: 'finance_intent',
    });
    expect(negative.manager.usage().tokens).toBeGreaterThanOrEqual(
      MODEL_CALL_TOKEN_RESERVATION,
    );
    negative.close();
    const nan = new FinanceTeam('nan');
    const { record } = await nan.model({
      agent: nan.supervisor,
      reasoner: reasonerWith(Number.NaN),
      fixtureKey: 'k',
      userMessage: 'x',
      schema: ModelIntentSchema,
      schemaName: 'finance_intent',
    });
    expect(record.outcome).toBe('BLOCKED');
    expect(Number.isFinite(nan.manager.usage().tokens)).toBe(true);
    nan.close();
  });

  it('chain receipts are read through the fenced chain.receipt tool', async () => {
    const team = new FinanceTeam('receipt');
    const audit = team.spawn(team.supervisor, 'AUDIT');
    const d = await desk([cleanInvoice], {
      receipts: async () => ({
        status: 'success',
        blockNumber: 1n,
        from: evidence.agent as `0x${string}`,
        transfers: [
          {
            from: evidence.agent,
            to: evidence.sarahVerified,
            baseUnits: 40_000n,
          },
        ],
      }),
    });
    const a = await auditAgentExplain(team, audit, d, null);
    expect(a.chainCheck).toBe('VERIFIED');
    expect(team.toolLog.map((t) => t.tool)).toContain('chain.receipt');
    team.close();
  });
});

describe('critic 7: the deterministic payout goes to the verified address', () => {
  it("Sarah's invoice asking for Bob's allowlisted wallet proposes Sarah's verified address and is denied", async () => {
    const r = await superviseFinance(
      "Pay Sarah's invoice",
      await desk([redirectInvoice]),
    );
    expect(r.payment!.prepared!.proposal).toMatchObject({
      recipient: sarahWallet,
      verifiedRecipient: sarahWallet,
      draftSource: 'DETERMINISTIC',
    });
    expect(r.payment!.prepared!.intent!.recipient).not.toBe(bobWallet);
    expect(r.payment!.risk!.flags.map((f) => f.code)).toContain(
      'PAYOUT_ADDRESS_CHANGED',
    );
    expect(r.payment!.status).toBe('DENIED');
    expect(r.payment!.kernel!.grant).toBeNull();
  });

  it('a vendor without a verified payout address is refused before the Kernel', async () => {
    const newco: Vendor = {
      vendorId: 'newco',
      workspaceId: 'wsp_studio',
      name: 'Newco',
      kind: 'CONTRACTOR',
      addresses: [
        {
          chainId: USDC.chainId,
          address: bobWallet,
          status: 'PENDING',
          source: 'invoice email',
          at: NOW - 100,
          verifiedBy: null,
        },
      ],
    };
    const inv: VendorInvoice = {
      ...cleanInvoice,
      vendorInvoiceId: 'vi_n1',
      vendorId: 'newco',
      payTo: bobWallet,
    };
    const { k, d } = await countedDesk([inv], {
      vendors: [sarah, newco],
      vendorInvoices: [inv],
    });
    const r = await superviseFinance("Pay Newco's invoice", d);
    expect(r.payment!.status).toBe('NO_VERIFIED_PAYOUT');
    expect(k.calls).toHaveLength(0);
  });
});

describe('critic 8 and extras: hostile text, grant handling, cash and wallet checks', () => {
  it('very long vendor text never crashes a run', async () => {
    const longName = `Sarah ${'x'.repeat(5_000)}`;
    const longVendor: Vendor = { ...sarah, name: longName };
    const d = await desk([redirectInvoice], { vendors: [longVendor] });
    const risk = await superviseFinance('is this invoice legit?', d);
    expect(risk.status).toBe('ANSWERED');
    const timing = await superviseFinance('when should I pay?', d);
    expect(timing.status).toBe('ANSWERED');
    const longPayer = await superviseFinance(
      `create an invoice for ${'Acme '.repeat(40)}500 USDC`,
      await desk([cleanInvoice]),
    );
    expect(longPayer.status).not.toBe('ANSWERED');
    expect(longPayer.invoice?.draft ?? null).toBeNull();
  });

  it('the MAC-bearing grant is never serialised with the reply', async () => {
    const r = await superviseFinance(
      "Pay Sarah's invoice",
      await desk([cleanInvoice]),
    );
    const grant = r.payment!.kernel!.grant!;
    expect(grant.mac).toMatch(/^0x/);
    const json = JSON.stringify(r, (_k, v: unknown) =>
      typeof v === 'bigint' ? v.toString() : v,
    );
    expect(json).not.toContain(grant.mac);
    expect(json).not.toContain(grant.nonce);
    expect(r.answer).not.toContain(grant.mac);
  });

  it('cash already under the buffer is reported as it is, not as the buffer', async () => {
    const r = await superviseFinance(
      "when should I pay Sarah's invoice?",
      await desk([cleanInvoice], { balance: 150_000_000n }),
    );
    expect(r.timing!.freeCashBaseUnits).toBe('150000000');
    expect(r.timing!.action).toBe('HOLD');
  });

  it('an invoice payout wallet must be the user’s own verified wallet', async () => {
    const s = await buildArcWorldSnapshot({
      readers: {
        ...readers([cleanInvoice]),
        wallets: () => ({
          value: [
            {
              address: mandate.payer,
              chain: 'arc-testnet',
              ownerPrincipalId: 'usr_maya',
              kind: 'OWNER_EOA',
              role: 'TREASURY',
              verifiedBy: 'siwe',
            },
            {
              address: bobWallet,
              chain: 'arc-testnet',
              ownerPrincipalId: 'usr_someone_else',
              kind: 'OWNER_EOA',
              role: 'PAYOUT',
              verifiedBy: null,
            },
          ],
          provenance: 'POSTGRES',
          source: 'identity:wallets',
          observedAt: NOW - 5,
        }),
      },
      providers: providers(),
      env: {},
      now: NOW,
    });
    const r = await superviseFinance(
      'create an invoice for Acme 500 USDC',
      await desk([cleanInvoice], { world: async () => s }),
    );
    expect(r.invoice!.status).toBe('REFUSED');
  });
});
