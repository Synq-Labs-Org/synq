import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { money } from '@synq/domain';
import { contract } from '@synq/chain-registry/arc';
import {
  AuthorityError,
  MemoryNonceFence,
  admitGrant,
  decide,
  intentApprovalTypedData,
  mandateTypedData,
  verifyGrant,
  type AuthorityConfig,
  type ExecutionGrant,
  type MandateState,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  admitEscrowGrant,
  escrowIntent,
  type EscrowOpenCall,
} from '@synq/kernel/arc-escrow';
import {
  connectChain,
  prepareTransfer,
  signPrepared,
} from '@synq/execution-worker/arc';
import {
  MemoryOutboxStore,
  payGrantOnce,
} from '@synq/execution-worker/arc-outbox';
import {
  CapabilityGuard,
  NEVER_TOOLS,
  TEAM_MANIFESTS,
  AgentRuntimeError,
} from '@synq/agent-runtime';
import { USDC, countingSigner, fakeArc } from '../durable/fake-arc.js';

/**
 * Cross-cutting KERNEL rows (X-KER-01..07). Every case runs the real Arc
 * payment authority (`@synq/kernel/arc`), the real escrow binding and the real
 * executor path (`@synq/execution-worker`) against a local fake Arc RPC that
 * mines what it receives (LOCAL_FIXTURE; no network). X-KER-07 is a Foundry
 * fuzz test: contracts/test/unit/CrossCuttingKernel.t.sol.
 */

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const sarah = `0x${'5a'.repeat(20)}` as Address;
const attacker = `0x${'ba'.repeat(20)}` as Address;
const NOW = 1_800_000_000;
const SEPOLIA = 11_155_111;
const config: AuthorityConfig = {
  grantKey: new Uint8Array(32).fill(9),
  operator: 'arc-executor-xker',
  grantTtlSeconds: 120,
  riskRequiredAbove: 50_000_000n,
};
const clean = { flags: [], available: true } as const;

const mandateFor = (
  payer: Address,
  over: Partial<PaymentMandate> = {},
): PaymentMandate => ({
  mandateId: 'mnd_xker',
  version: 1,
  workspaceId: 'wsp_xker',
  owner: owner.address,
  chainId: USDC.chainId,
  token: USDC.address,
  payer,
  recipients: [sarah],
  purposes: ['CONTRACTOR_PAYOUT'],
  perActionCap: 1_000_000n,
  periodBudget: 3_000_000n,
  periodSeconds: 86_400,
  validFrom: NOW - 60,
  validUntil: NOW + 86_400,
  ...over,
});
const intentFor = (
  m: PaymentMandate,
  over: Partial<PaymentIntent> = {},
): PaymentIntent => ({
  intentId: 'int_xker',
  mandateId: m.mandateId,
  mandateVersion: m.version,
  chainId: m.chainId,
  token: m.token,
  payer: m.payer,
  recipient: sarah,
  amount: 250_000n,
  purpose: 'CONTRACTOR_PAYOUT',
  obligationRef: 'obl_xker',
  evidenceHash: `0x${'e1'.repeat(32)}`,
  proposedBy: 'agent:payments',
  ...over,
});
const sign = (m: PaymentMandate) => owner.signTypedData(mandateTypedData(m));

async function grantFor(
  m: PaymentMandate,
  over: Partial<PaymentIntent> = {},
  state: MandateState = { revoked: false, spends: [] },
  now = NOW,
): Promise<ExecutionGrant> {
  const d = await decide({
    config,
    mandate: m,
    mandateSignature: await sign(m),
    state,
    intent: intentFor(m, over),
    risk: clean,
    simulationOk: true,
    now,
  });
  if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
  return d.grant;
}

const callOf = (g: ExecutionGrant) => ({
  chainId: g.chainId,
  token: g.token,
  payer: g.payer,
  recipient: g.recipient,
  amount: BigInt(g.amount),
});

async function executor() {
  const payer = privateKeyToAccount(generatePrivateKey());
  const arc = fakeArc();
  arc.setPayer(payer.address);
  const chain = await connectChain('arc-testnet', undefined, arc.client);
  return { payer, arc, chain, signer: countingSigner(payer) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    return e instanceof AuthorityError ? e.code : (e as Error).message;
  }
};

describe('X-KER cross-cutting kernel attacks', () => {
  it('X-KER-01 wrong chain and wrong EIP-712 domain in a typed owner approval are denied; only the exact domain grants', async () => {
    const m = mandateFor(`0x${'a1'.repeat(20)}`);
    const signature = await sign(m);
    const base = {
      config,
      mandate: m,
      mandateSignature: signature,
      state: { revoked: false, spends: [] },
      intent: intentFor(m),
      risk: clean,
      simulationOk: true,
      now: NOW,
      requireOwnerApproval: true,
    };
    const asked = await decide(base);
    expect(asked.outcome).toBe('REQUIRE_OWNER_APPROVAL');
    if (asked.outcome !== 'REQUIRE_OWNER_APPROVAL') return;
    const typed = intentApprovalTypedData(base.intent, asked.approval);
    const variants: Hex[] = [
      // Same message, another chain in the domain (Sepolia, Ethereum mainnet).
      await owner.signTypedData({
        ...typed,
        domain: { ...typed.domain, chainId: SEPOLIA },
      }),
      await owner.signTypedData({
        ...typed,
        domain: { ...typed.domain, chainId: 1 },
      }),
      // Another Synq domain (the mandate domain) over the same message.
      await owner.signTypedData({
        ...typed,
        domain: { ...typed.domain, name: 'Synq Payment Mandate' },
      }),
      // A domain that adds a verifying contract the Kernel never uses.
      await owner.signTypedData({
        ...typed,
        domain: {
          ...typed.domain,
          verifyingContract: contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW')
            .address,
        },
      }),
    ];
    for (const sig of variants) {
      const d = await decide({
        ...base,
        ownerApproval: { ...asked.approval, signature: sig },
      });
      expect(d.outcome).toBe('DENY');
      expect(d.reasons.join(' ')).toMatch(/does not match the mandate owner/);
    }
    // An intent naming another chain never reaches signature checks.
    const wrongChain = await decide({
      ...base,
      intent: intentFor(m, { chainId: SEPOLIA }),
    });
    expect(wrongChain).toMatchObject({
      outcome: 'DENY',
      reasons: [`wrong chain ${SEPOLIA}`],
    });
    // A mandate signed for Arc and replayed with its chain id edited is not the owner's mandate.
    const moved = await decide({
      ...base,
      mandate: { ...m, chainId: SEPOLIA },
      intent: intentFor({ ...m, chainId: SEPOLIA }),
    });
    expect(moved.outcome).toBe('DENY');
    expect(moved.reasons[0]).toMatch(/mandate not signed by its owner/);
    // The exact domain works once.
    const ok = await decide({
      ...base,
      ownerApproval: {
        ...asked.approval,
        signature: await owner.signTypedData(typed),
      },
    });
    expect(ok.outcome).toBe('ALLOW');
  });

  it('X-KER-01 property: an approval signed under any other chain id is never accepted', async () => {
    const m = mandateFor(`0x${'a1'.repeat(20)}`);
    const signature = await sign(m);
    const i = intentFor(m);
    const approval = {
      nonce: `0x${'ab'.repeat(32)}` as Hex,
      deadline: NOW + 60,
    };
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 2 ** 31 }).filter((c) => c !== m.chainId),
        async (chainId) => {
          const typed = intentApprovalTypedData(i, approval);
          const sig = await owner.signTypedData({
            ...typed,
            domain: { ...typed.domain, chainId },
          });
          const d = await decide({
            config,
            mandate: m,
            mandateSignature: signature,
            state: { revoked: false, spends: [] },
            intent: i,
            risk: clean,
            simulationOk: true,
            now: NOW,
            requireOwnerApproval: true,
            ownerApproval: { ...approval, signature: sig },
          });
          expect(d.outcome).toBe('DENY');
        },
      ),
      { numRuns: 40 },
    );
  });

  it('X-KER-02 a grant for one escrow (spender) contract cannot fund another; the unlisted contract is denied at decision time', async () => {
    const client = `0x${'c1'.repeat(20)}` as Address;
    const payee = `0x${'f1'.repeat(20)}` as Address;
    const arbiterAddr = `0x${'a7'.repeat(20)}` as Address;
    const escrow = contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address;
    const rogueEscrow = `0x${'de'.repeat(20)}` as Address;
    const m = mandateFor(client, {
      recipients: [escrow],
      purposes: ['ESCROW_FUNDING'],
      perActionCap: 5_000_000n,
      periodBudget: 5_000_000n,
    });
    const open: EscrowOpenCall = {
      op: 'OPEN',
      chainId: USDC.chainId,
      escrow,
      token: USDC.address,
      sender: client,
      termsHash: `0x${'12'.repeat(32)}`,
      payee,
      arbiter: arbiterAddr,
      refundAfter: NOW + 30 * 86_400,
      amounts: [1_000_000n, 2_000_000n],
    };
    const meta = {
      mandateId: m.mandateId,
      mandateVersion: m.version,
      obligationRef: 'deal:xker02:v1',
      evidenceHash: `0x${'e2'.repeat(32)}` as Hex,
      proposedBy: 'dealroom',
    };
    const d = await decide({
      config,
      mandate: m,
      mandateSignature: await sign(m),
      state: { revoked: false, spends: [] },
      intent: escrowIntent(open, meta),
      risk: clean,
      simulationOk: true,
      now: NOW,
    });
    if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
    const fence = new MemoryNonceFence();
    // Same grant, the executor is pointed at a different spender contract.
    expect(
      await code(
        admitEscrowGrant({
          grantKey: config.grantKey,
          grant: d.grant,
          call: { ...open, escrow: rogueEscrow },
          now: NOW + 1,
          mandateRevoked: false,
          fence,
        }),
      ),
    ).toBe('GRANT_MISMATCH');
    // The refused attempt did not burn the nonce: the exact call is admitted once.
    await admitEscrowGrant({
      grantKey: config.grantKey,
      grant: d.grant,
      call: open,
      now: NOW + 2,
      mandateRevoked: false,
      fence,
    });
    expect(
      await code(
        admitEscrowGrant({
          grantKey: config.grantKey,
          grant: d.grant,
          call: open,
          now: NOW + 3,
          mandateRevoked: false,
          fence,
        }),
      ),
    ).toBe('GRANT_REPLAYED');
    // Asking the Kernel directly for the rogue contract: not on the signed allowlist.
    const rogue = await decide({
      config,
      mandate: m,
      mandateSignature: await sign(m),
      state: { revoked: false, spends: [] },
      intent: escrowIntent({ ...open, escrow: rogueEscrow }, meta),
      risk: clean,
      simulationOk: true,
      now: NOW,
    });
    expect(rogue.outcome).toBe('DENY');
    expect(rogue.reasons.join(' ')).toMatch(/not on the mandate allowlist/);
  });

  it('X-KER-03 one grant presented by two workers with different idempotency keys pays once (shared fence)', async () => {
    const { payer, arc, chain, signer } = await executor();
    const m = mandateFor(payer.address);
    const g = await grantFor(m);
    const fence = new MemoryNonceFence();
    const run = (key: string) =>
      payGrantOnce({
        key,
        store: new MemoryOutboxStore(),
        fence,
        grant: g,
        grantKey: config.grantKey,
        mandateRevoked: false,
        chain,
        signer,
        transfer: {
          from: payer.address,
          to: sarah,
          amount: money(USDC, 250_000n),
        },
        now: () => NOW + 5,
      });
    const results = await Promise.allSettled([
      run('worker-a:payout'),
      run('worker-b:payout'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as
      | PromiseRejectedResult
      | undefined;
    expect(rejected?.reason).toMatchObject({ code: 'GRANT_REPLAYED' });
    expect(arc.mined.size).toBe(1);
    expect(arc.sent).toHaveLength(1);
  });

  it('X-KER-03 property (P23-01 nonce): across any interleaving of admissions, each grant is admitted exactly once and forged grants never', async () => {
    const payer = `0x${'a1'.repeat(20)}` as Address;
    const m = mandateFor(payer, { periodBudget: 1_000_000_000n });
    const grants: ExecutionGrant[] = [];
    for (let n = 0; n < 4; n++)
      grants.push(await grantFor(m, { intentId: `int_${n}` }));
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            g: fc.integer({ min: 0, max: grants.length - 1 }),
            forge: fc.constantFrom(
              'none',
              'amount',
              'recipient',
              'nonce',
              'expiry',
            ),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        async (attempts) => {
          const fence = new MemoryNonceFence();
          const admitted = new Map<number, number>();
          for (const a of attempts) {
            const g = grants[a.g]!;
            const forged: ExecutionGrant =
              a.forge === 'amount'
                ? { ...g, amount: String(BigInt(g.amount) + 1n) }
                : a.forge === 'recipient'
                  ? { ...g, recipient: attacker }
                  : a.forge === 'nonce'
                    ? { ...g, nonce: `0x${'00'.repeat(32)}` }
                    : a.forge === 'expiry'
                      ? { ...g, expiresAt: g.expiresAt + 3600 }
                      : g;
            const r = await code(
              admitGrant({
                grantKey: config.grantKey,
                grant: forged,
                call: callOf(forged),
                now: NOW + 1,
                mandateRevoked: false,
                fence,
              }),
            );
            if (a.forge !== 'none') expect(r).toBe('GRANT_FORGED');
            else if (r === 'OK')
              admitted.set(a.g, (admitted.get(a.g) ?? 0) + 1);
            else expect(r).toBe('GRANT_REPLAYED');
          }
          for (const n of admitted.values()) expect(n).toBe(1);
          const distinct = new Set(
            attempts.filter((a) => a.forge === 'none').map((a) => a.g),
          );
          expect(admitted.size).toBe(distinct.size);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('X-KER-04 an approval or grant that expires before broadcast stops before signing; nothing is recorded or sent', async () => {
    const { payer, arc, chain, signer } = await executor();
    const m = mandateFor(payer.address);
    const i = intentFor(m);
    const base = {
      config,
      mandate: m,
      mandateSignature: await sign(m),
      state: { revoked: false, spends: [] },
      intent: i,
      risk: clean,
      simulationOk: true,
      requireOwnerApproval: true,
    };
    const asked = await decide({ ...base, now: NOW });
    if (asked.outcome !== 'REQUIRE_OWNER_APPROVAL') throw new Error('asked');
    const signature = await owner.signTypedData(
      intentApprovalTypedData(i, asked.approval),
    );
    // The owner signed in time, but the approval is presented after its deadline.
    const late = await decide({
      ...base,
      now: asked.approval.deadline + 1,
      ownerApproval: { ...asked.approval, signature },
    });
    expect(late).toMatchObject({
      outcome: 'DENY',
      reasons: ['owner approval expired'],
    });
    // In time: a grant with a 120 s life.
    const ok = await decide({
      ...base,
      now: NOW + 10,
      ownerApproval: { ...asked.approval, signature },
    });
    if (ok.outcome !== 'ALLOW') throw new Error(ok.reasons.join('; '));
    const store = new MemoryOutboxStore();
    const fence = new MemoryNonceFence();
    // The executor reaches the broadcast step only after the grant expired.
    expect(
      await code(
        payGrantOnce({
          store,
          fence,
          grant: ok.grant,
          grantKey: config.grantKey,
          mandateRevoked: false,
          chain,
          signer,
          transfer: {
            from: payer.address,
            to: sarah,
            amount: money(USDC, 250_000n),
          },
          now: () => ok.grant.expiresAt,
        }),
      ),
    ).toBe('GRANT_EXPIRED');
    expect(signer.count).toBe(0);
    expect(arc.sent).toHaveLength(0);
    expect(await store.get(`grant:${ok.grant.grantId}`)).toBeNull();
    // The expired grant's nonce was never consumed: a fresh decision is required, not a replay.
    expect(await fence.consume(ok.grant.nonce)).toBe(true);
  });

  it('X-KER-05 a model cannot raise the cumulative cap: an edited mandate is unsigned, and the guard refuses limit tools', async () => {
    const payer = `0x${'a1'.repeat(20)}` as Address;
    const m = mandateFor(payer);
    const signature = await sign(m);
    const spends = [
      { amount: 1_000_000n, at: NOW - 100 },
      { amount: 1_000_000n, at: NOW - 50 },
      { amount: 900_000n, at: NOW - 10 },
    ];
    // Prompt-injected "the owner raised the budget to 10,000 USDC": the agent submits the edited mandate.
    for (const raised of [
      { periodBudget: 10_000_000_000n },
      { perActionCap: 3_000_000n, periodBudget: 10_000_000_000n },
      { periodSeconds: 60 },
      { recipients: [sarah, attacker] },
    ]) {
      const d = await decide({
        config,
        mandate: { ...m, ...raised },
        mandateSignature: signature,
        state: { revoked: false, spends },
        intent: intentFor(m),
        risk: clean,
        simulationOk: true,
        now: NOW,
      });
      expect(d.outcome).toBe('DENY');
      expect(d.reasons[0]).toMatch(/mandate not signed by its owner/);
    }
    // The real mandate: 2.9 of 3.0 USDC spent, so 0.25 USDC is over budget.
    const d = await decide({
      config,
      mandate: m,
      mandateSignature: signature,
      state: { revoked: false, spends },
      intent: intentFor(m),
      risk: clean,
      simulationOk: true,
      now: NOW,
    });
    expect(d.outcome).toBe('DENY');
    expect(d.reasons[0]).toMatch(/period budget exceeded/);
    // No agent holds a tool that changes limits or mandates.
    const kindOf = (f: () => unknown) => {
      try {
        f();
        return 'OK';
      } catch (e) {
        return e instanceof AgentRuntimeError ? e.kind : String(e);
      }
    };
    for (const role of Object.keys(TEAM_MANIFESTS).filter(
      (r) => r !== 'SUPERVISOR',
    )) {
      const g = new CapabilityGuard({ verifiedCounterparties: () => [sarah] });
      g.root('sup');
      g.delegate({ parentId: 'sup', childId: role, role: role as never });
      for (const id of ['sup', role])
        for (const tool of ['policy.raiseLimit', 'mandate.update'] as const) {
          expect(NEVER_TOOLS).toContain(tool);
          expect(kindOf(() => g.authorize(id, tool))).toBe(
            'FORBIDDEN_TOOL_CALL',
          );
        }
    }
  });

  it('X-KER-05 property (P23-01 conservation): any request sequence grants at most the signed period budget', async () => {
    const payer = `0x${'a1'.repeat(20)}` as Address;
    const m = mandateFor(payer, { validUntil: NOW + 10 * 86_400 });
    const signature = await sign(m);
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            amount: fc.bigInt({ min: 1n, max: 2_000_000n }),
            dt: fc.integer({ min: 0, max: 20_000 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        async (reqs) => {
          const spends: { amount: bigint; at: number }[] = [];
          let t = NOW;
          for (const [n, r] of reqs.entries()) {
            t += r.dt;
            const d = await decide({
              config,
              mandate: m,
              mandateSignature: signature,
              state: { revoked: false, spends },
              intent: intentFor(m, {
                intentId: `int_${n}`,
                obligationRef: `obl_${n}`,
                amount: r.amount,
              }),
              risk: clean,
              simulationOk: true,
              now: t,
            });
            if (r.amount > m.perActionCap) expect(d.outcome).not.toBe('ALLOW');
            if (d.outcome === 'ALLOW') spends.push({ amount: r.amount, at: t });
            // Rolling window invariant at every step.
            const inWindow = spends
              .filter((s) => s.at > t - m.periodSeconds)
              .reduce((a, s) => a + s.amount, 0n);
            expect(inWindow <= m.periodBudget).toBe(true);
          }
        },
      ),
      { numRuns: 30 },
    );
  }, 60_000);

  it('X-KER-06 an agent that swaps the recipient in the prepared transfer or its calldata gets nothing signed', async () => {
    const { payer, arc, chain, signer } = await executor();
    const m = mandateFor(payer.address);
    const g = await grantFor(m);
    const store = new MemoryOutboxStore();
    const fence = new MemoryNonceFence();
    const pay = (to: Address, amount = 250_000n) =>
      payGrantOnce({
        store,
        fence,
        grant: g,
        grantKey: config.grantKey,
        mandateRevoked: false,
        chain,
        signer,
        transfer: { from: payer.address, to, amount: money(USDC, amount) },
        now: () => NOW + 5,
      });
    expect(await code(pay(attacker))).toBe('GRANT_MISMATCH');
    expect(await code(pay(sarah, 250_001n))).toBe('GRANT_MISMATCH');
    expect(signer.count).toBe(0);
    expect(arc.sent).toHaveLength(0);
    // Tampering after preparation: calldata or `to` edited on the frozen object's copy.
    const prepared = await prepareTransfer(chain, {
      from: payer.address,
      to: sarah,
      amount: money(USDC, 250_000n),
    });
    const swappedData = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [attacker, 250_000n],
    });
    for (const tampered of [
      { ...prepared, data: swappedData },
      { ...prepared, to: attacker },
      { ...prepared, token: attacker },
    ])
      await expect(signPrepared(signer, tampered)).rejects.toMatchObject({
        code: 'TX_MISMATCH',
      });
    expect(signer.count).toBe(0);
    // The untouched grant still pays the exact recipient once.
    const r = await pay(sarah);
    expect(r.record.state).toBe('CONFIRMED');
    expect(arc.mined.size).toBe(1);
    expect([...arc.mined.values()][0]!.to.toLowerCase()).toBe(
      sarah.toLowerCase(),
    );
  });

  it('X-KER-06 property: any call differing from the grant in recipient, amount, token, payer or chain is refused', async () => {
    const payer = `0x${'a1'.repeat(20)}` as Address;
    const g = await grantFor(mandateFor(payer));
    const addr = fc
      .uint8Array({ minLength: 20, maxLength: 20 })
      .map((b) => `0x${Buffer.from(b).toString('hex')}` as Address);
    await fc.assert(
      fc.property(
        fc.record({
          recipient: fc.option(addr, { nil: undefined }),
          amount: fc.option(fc.bigInt({ min: 1n, max: 10n ** 12n }), {
            nil: undefined,
          }),
          token: fc.option(addr, { nil: undefined }),
          payer: fc.option(addr, { nil: undefined }),
          chainId: fc.option(fc.integer({ min: 1, max: 2 ** 31 }), {
            nil: undefined,
          }),
        }),
        (mut) => {
          const call = { ...callOf(g) };
          for (const [k, v] of Object.entries(mut))
            if (v !== undefined) (call as Record<string, unknown>)[k] = v;
          const same =
            call.recipient.toLowerCase() === g.recipient.toLowerCase() &&
            call.amount === BigInt(g.amount) &&
            call.token.toLowerCase() === g.token.toLowerCase() &&
            call.payer.toLowerCase() === g.payer.toLowerCase() &&
            call.chainId === g.chainId;
          let r = 'OK';
          try {
            verifyGrant({
              grantKey: config.grantKey,
              grant: g,
              call,
              now: NOW + 1,
              mandateRevoked: false,
            });
          } catch (e) {
            r = (e as AuthorityError).code;
          }
          expect(r).toBe(same ? 'OK' : 'GRANT_MISMATCH');
        },
      ),
      { numRuns: 300 },
    );
  });
});
