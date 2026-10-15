import { describe, expect, it } from 'vitest';
import {
  concat,
  keccak256,
  numberToHex,
  pad,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, token } from '@synq/chain-registry/arc';
import { MemoryInvoiceStore } from '@synq/invoices';
import { admitGrant } from '@synq/kernel/arc';
import { MemoryLedgerStore } from '@synq/ledger';
import type { CctpTransfer } from '@synq/plugin-circle-cctp';
import type { ChainReceipt, SettlementAudit } from '@synq/agent-runtime';
import {
  MemoryRouteStore,
  runFreelancerDemo,
  testTelegramProof,
  type DemoChainPort,
} from '../../scripts/lib/freelancer-demo.js';
import { ScriptedReasoner } from './finance-team.harness.js';

const USDC = token('arc-testnet', 'USDC');
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const agent = `0x${'a9'.repeat(20)}` as Address;
const client = `0x${'c1'.repeat(20)}` as Address;
const sarah = `0x${'5a'.repeat(20)}` as Address;
const walletB = `0x${'ba'.repeat(20)}` as Address;
const RUN = 'ci1';
const PAYOUT = 30_000n;

const h = (tag: string) => keccak256(stringToHex(tag));
const u32 = (n: number) => numberToHex(n, { size: 4 });
const u256 = (n: bigint) => numberToHex(n, { size: 32 });
const b32 = (a: Address) => pad(a, { size: 32 });

/** In-memory Arc + Sepolia: balances, nonces, receipts, CCTP messages, grant admission. */
function fakeChain() {
  const balances = new Map<string, bigint>([
    [owner.address.toLowerCase(), 5_000_000n],
    [agent.toLowerCase(), 1_000_000n],
    [sarah.toLowerCase(), 0n],
  ]);
  const nonces = new Map<string, number>();
  const receipts = new Map<string, ChainReceipt>();
  const sent: string[] = [];
  let block = 1_000n;
  const bal = (a: string) => balances.get(a.toLowerCase()) ?? 0n;
  const move = (from: Address, to: Address, amount: bigint, hash: Hex) => {
    if (from !== zeroAddress)
      balances.set(from.toLowerCase(), bal(from) - amount);
    balances.set(to.toLowerCase(), bal(to) + amount);
    receipts.set(hash, {
      status: 'success',
      blockNumber: ++block,
      from,
      transfers: [{ from, to, baseUnits: amount }],
    });
  };
  let burned: CctpTransfer | null = null;
  const port: DemoChainPort = {
    labels: { arc: 'FAKE_ARC', sepolia: 'FAKE_SEPOLIA' },
    arcUsdcBalance: async (a) => bal(a),
    arcNonce: async (a) => nonces.get(a.toLowerCase()) ?? 0,
    gatewayAvailable: async () => [{ chain: 'eth-sepolia', available: 0n }],
    probe: async () => ({
      ok: true,
      detail: 'fake',
      observedAt: Math.floor(Date.now() / 1000),
    }),
    receipt: async (hash) => receipts.get(hash) ?? null,
    simulateTransfer: async ({ from, amount }) => bal(from) >= amount,
    fund: async () => [],
    cctpMinimumFeeBps: async () => 1,
    cctpBurn: async (t, onBurnHash) => {
      const burnTx = h(`burn:${t.transferId}`);
      await onBurnHash(burnTx);
      burned = t;
      sent.push(`burn:${burnTx}`);
      return { approveTx: null, burnTx };
    },
    cctpAttestation: async () => {
      const t = burned!;
      const header = concat([
        u32(1),
        u32(CHAINS['eth-sepolia'].cctpDomain!),
        u32(CHAINS['arc-testnet'].cctpDomain!),
        h(`nonce:${t.transferId}`),
        b32(t.payer),
        b32(t.recipient),
        b32(zeroAddress),
        u32(t.minFinalityThreshold),
        u32(t.minFinalityThreshold),
      ]);
      const body = concat([
        u32(1),
        b32(token('eth-sepolia', 'USDC').address),
        b32(t.recipient),
        u256(t.amount),
        b32(t.payer),
        u256(t.maxFee),
        u256(t.maxFee),
        u256(0n),
        t.reference!,
      ]);
      return {
        message: concat([header, body]),
        attestation: h('att'),
        polls: 1,
      };
    },
    cctpMint: async (t, _m, _a, onMintHash) => {
      const mintTx = h(`mint:${t.transferId}`);
      await onMintHash(mintTx);
      move(zeroAddress, t.recipient, t.amount - t.maxFee, mintTx);
      return { mintTx, alreadyUsed: false };
    },
    cctpReconcile: async (t) => ({
      minted: t.amount - t.maxFee,
      feeExecuted: t.maxFee,
      logIndex: 0,
      nonce: h(`nonce:${t.transferId}`),
      blockNumber: block,
    }),
    executeGranted: async (input) => {
      await admitGrant({
        grantKey: input.grantKey,
        grant: input.grant,
        call: {
          chainId: USDC.chainId,
          token: USDC.address,
          payer: agent,
          recipient: input.to,
          amount: input.amount,
        },
        now: Math.floor(Date.now() / 1000),
        mandateRevoked: false,
        fence: input.fence,
      });
      const hash = h(`payout:${input.grant.grantId}`);
      await input.onBroadcast(hash);
      move(agent, input.to, input.amount, hash);
      balances.set(agent.toLowerCase(), bal(agent) - 7n);
      nonces.set(
        agent.toLowerCase(),
        (nonces.get(agent.toLowerCase()) ?? 0) + 1,
      );
      sent.push(`payout:${hash}`);
      return {
        hash,
        blockNumber: block,
        explorer: `${CHAINS['arc-testnet'].explorer}/tx/${hash}`,
        logIndex: 0,
        feeBaseUnits: 7n,
      };
    },
  };
  return { port, balances, sent };
}

function reasoner() {
  const draft = (vi: string, recipient: Address) => ({
    text: JSON.stringify({
      kind: 'PAYMENT',
      vendorInvoiceId: vi,
      recipient,
      amountBaseUnits: String(PAYOUT),
      purpose: 'CONTRACTOR_PAYOUT',
      rationale: 'Sarah invoiced an accepted milestone.',
      riskAssessment: 'Looks routine.',
    }),
  });
  return new ScriptedReasoner({
    'finance:invoice:terms': {
      text: JSON.stringify({
        payer: 'Acme Corp',
        amount: '0.5',
        asset: 'USDC',
        description: 'Landing page build',
        dueInDays: 7,
      }),
    },
    [`finance:payment:vi_${RUN}_m2`]: draft(`vi_${RUN}_m2`, sarah),
    // The model is taken in by the changed-wallet note; the Kernel is not.
    [`finance:payment:vi_${RUN}_m3`]: draft(`vi_${RUN}_m3`, walletB),
  });
}

describe('Synq Freelancer Finance Team (fake chain and HTTP ports)', () => {
  it('runs guest invocation to fraud refusal through the real channel, invoice, team, Kernel and ledger code', async () => {
    const chain = fakeChain();
    const routes = new MemoryRouteStore();
    const r = await runFreelancerDemo({
      runId: RUN,
      parties: { owner, agent, client, sarah, walletB },
      chain: chain.port,
      stores: {
        ledger: new MemoryLedgerStore(),
        invoices: new MemoryInvoiceStore(),
        routes,
        label: 'MEMORY_STORE',
      },
      reasoner: reasoner(),
      telegramProof: testTelegramProof(Math.floor(Date.now() / 1000)),
      checkout: {
        client: {} as PublicClient,
        memoContract: `0x${'4e'.repeat(20)}`,
        listen: false,
      },
      amounts: {
        payout: PAYOUT,
        maxInvoice: 1_000_000n,
        minimumReserve: 50_000n,
      },
      env: {},
      blockers: [],
      now: () => Math.floor(Date.now() / 1000),
    });
    const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s]));
    expect(r.steps.map((s) => [s.step, s.status, s.error ?? null])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [n, 'OK', null]),
    );

    // 1. Guest: only the message and the replied-to message; answered via answerGuestQuery.
    expect(byStep[1]!.labels).toEqual(['LOCAL_INGRESS']);
    expect(byStep[1]!.detail).toMatchObject({
      eventType: 'GUEST_QUERY',
      outcome: { code: 'GUEST_ANSWERED' },
      sendMessageCalls: 0,
    });
    expect(String(byStep[1]!.detail.answer)).toContain(
      'Acme Corp for 0.50 USDC',
    );

    // 2. Onboarding: EOA link from a consumed Telegram proof + DM code + wallet signature.
    expect(byStep[2]!.labels).toEqual([
      'LOCAL_INGRESS',
      'EOA_WALLET_LINK',
      'TEST_TELEGRAM_PROOF',
    ]);
    expect(byStep[2]!.detail).toMatchObject({
      link: { wallet: owner.address, channelUserId: '70011' },
    });
    expect(String(byStep[2]!.detail.proofReplay)).toContain('already used');

    // 3. Model-extracted terms, persisted invoice, signed issuance, checkout view.
    expect(byStep[3]!.labels).toEqual([
      'LOCAL_INGRESS',
      'MEMORY_STORE',
      'REPLAY_MODEL',
    ]);
    expect(byStep[3]!.detail).toMatchObject({
      supervisor: { termsSource: 'MODEL' },
      invoice: { number: 'INV-0001', total: '0.5', status: 'ISSUED' },
      checkout: { view: { amountDue: '0.5', payTo: owner.address } },
    });

    // 4-5. CCTP: not paid in flight; paid once from the reconciled mint; replay is a no-op.
    expect(byStep[4]!.detail).toMatchObject({
      invoiceStatusWhileInFlight: 'ISSUED',
      plan: { gross: '0.50005', maxFee: '0.00005' },
    });
    expect(byStep[5]!.detail).toMatchObject({
      statusBefore: 'ISSUED',
      settle: 'APPLIED',
      replay: 'DUPLICATE',
      invoice: { status: 'PAID', amountDue: '0' },
      checkoutAfter: { status: 'PAID', amountDue: '0' },
      outbox: expect.arrayContaining([
        expect.objectContaining({ topic: 'invoice.payment_applied' }),
      ]),
    });
    expect(await routes.list()).toHaveLength(1);

    // 6. Payment Agent proposal → Kernel ALLOW → grant → executor; exact credit.
    expect(byStep[6]!.labels).toEqual([
      'LOCAL_INGRESS',
      'FAKE_ARC',
      'REPLAY_MODEL',
    ]);
    expect(byStep[6]!.detail).toMatchObject({
      request: "can I pay Sarah's invoice?",
      proposal: {
        status: 'PROPOSED',
        intent: { kind: 'PAY_CHECK' },
        world: { decisionGrade: true, refreshed: false },
      },
      ownerApproval: { signer: owner.address },
      confirmed: { status: 'GRANTED' },
      kernel: { outcome: 'ALLOW', grant: { recipient: sarah } },
      secondGrantForSameObligation: { status: 'DENIED', grantIssued: false },
      contractor: { creditedExactly: true },
      hashRecordedBeforeBroadcast: true,
    });

    expect(
      (byStep[6]!.detail.secondGrantForSameObligation as { reasons: string[] })
        .reasons[0],
    ).toContain('already has a grant');
    // The MAC'd grant never reaches evidence (only its id and action hash).
    expect(JSON.stringify(r)).not.toContain('"mac"');

    // 7. Audit: invoice, route, amount, recipient, tx and current state; payout re-read.
    const audit7 = byStep[7]!.detail as {
      invoicePayment: { audit: SettlementAudit; answer: string };
      payout: { audit: { chainCheck: string; recipient: string } };
    };
    expect(audit7.invoicePayment.audit).toMatchObject({
      subject: 'INVOICE_PAYMENT',
      chainCheck: 'VERIFIED',
      recipient: owner.address,
      amount: '0.5',
      ledgerBalanced: true,
      invoice: { number: 'INV-0001', status: 'PAID' },
      route: { route: 'CCTP_V2', sourceChain: 'eth-sepolia' },
    });
    expect(audit7.invoicePayment.answer).toContain('Circle CCTP V2');
    expect(audit7.invoicePayment.answer).toContain('Free to spend on Arc');
    expect(audit7.payout.audit).toMatchObject({
      chainCheck: 'VERIFIED',
      recipient: sarah,
    });

    // 8. Changed wallet: Risk flags it, Kernel denies, executor refuses the old grant, nothing moves.
    const s8 = byStep[8]!.detail as {
      riskFlags: { code: string }[];
      kernel: { outcome: string; reasons: string[]; grantIssued: boolean };
      executorGrantReplayToWalletB: string;
      agent: { unchanged: boolean };
      supervisor: { modelDraft: { accepted: boolean } | null };
    };
    expect(s8.riskFlags.map((f) => f.code)).toEqual(
      expect.arrayContaining(['PAYOUT_ADDRESS_CHANGED']),
    );
    expect(s8.kernel.outcome).toBe('DENY');
    expect(s8.kernel.grantIssued).toBe(false);
    expect(s8.kernel.reasons.join(' ')).toContain(
      `recipient ${walletB} is not on the mandate allowlist`,
    );
    expect(s8.executorGrantReplayToWalletB).toMatch(/GRANT_MISMATCH/);
    expect(s8.agent.unchanged).toBe(true);
    expect(chain.sent.filter((x) => x.startsWith('payout:'))).toHaveLength(1);
    expect(chain.balances.get(walletB.toLowerCase()) ?? 0n).toBe(0n);

    // Ledger: AR cleared, cash = invoice receipt − payout − fee.
    expect(r.ledger.balances).toMatchObject({
      CASH_ARC_USDC: '0.469993',
      REVENUE: '-0.5',
      CONTRACTOR_EXPENSE: '0.03',
    });
    expect(r.ledger.balances).not.toHaveProperty('ACCOUNTS_RECEIVABLE');

    // The original conversation is updated in place with status and receipts.
    const inline = byStep[1]!.detail.inlineMessageId as string;
    const edits = r.transcript.filter(
      (t) => t.method === 'editMessageText' && t.messageRef === inline,
    );
    expect(edits.map((e) => e.text.split('\n')[0]!.slice(0, 40))).toEqual([
      expect.stringContaining('Invoice INV-0001 issued'),
      expect.stringContaining('Invoice payment in flight'),
      expect.stringContaining('Invoice INV-0001: PAID'),
    ]);
    expect(edits.at(-1)!.text).toContain('https://explorer.testnet.arc.io/tx/');
    expect(edits.at(-1)!.text).toContain('https://sepolia.etherscan.io/tx/');
    expect(
      r.transcript.some((t) => t.text.includes('link code is ••••••')),
    ).toBe(true);
    expect(JSON.stringify(r.transcript)).not.toMatch(
      /\/pay\/[^.\s]+\.[A-Za-z0-9_-]{8,}/,
    );
  }, 30_000);
});
