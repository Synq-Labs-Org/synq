import { describe, expect, it } from 'vitest';
import {
  concat,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  numberToHex,
  pad,
  slice,
  stringToHex,
  zeroAddress,
  type Address,
  type Hex,
  type Log,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  InvoiceService,
  MemoryInvoiceStore,
  draftInvoice,
  issueTypedData,
} from '@synq/invoices';
import { MemoryNonceFence, admitGrant } from '@synq/kernel/arc';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import type { CctpTransfer } from '@synq/plugin-circle-cctp';
import {
  MESSAGE_RECEIVED_EVENT,
  reconcileMintReceipt,
} from '@synq/execution-worker/cctp';
import type { ChainReceipt, SettlementAudit } from '@synq/agent-runtime';
import {
  MemoryPayoutJournal,
  MemoryRouteStore,
  runFreelancerDemo,
  settleInvoiceFromMint,
  testTelegramProof,
  type DemoChainPort,
  type ExecutorPort,
} from '../../scripts/lib/freelancer-demo.js';
import { ScriptedReasoner } from './finance-team.harness.js';

const USDC = token('arc-testnet', 'USDC');
const WEI = 1_000_000_000_000n;
const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const agent = `0x${'a9'.repeat(20)}` as Address;
const vault = `0x${'7a'.repeat(20)}` as Address;
const policy = `0x${'70'.repeat(20)}` as Address;
const client = `0x${'c1'.repeat(20)}` as Address;
const sarah = `0x${'5a'.repeat(20)}` as Address;
const walletB = `0x${'ba'.repeat(20)}` as Address;
const stranger = `0x${'0d'.repeat(20)}` as Address;
const RUN = 'ci1';
const PAYOUT = 5_000n;
const GAS = 1_223_450_000_000_000n; // 0.00122345 USDC: a sub-unit remainder
const transmitter = contract('arc-testnet', 'CCTP_MESSAGE_TRANSMITTER_V2')
  .address as Address;

const h = (tag: string) => keccak256(stringToHex(tag));
const u32 = (n: number) => numberToHex(n, { size: 4 });
const u256 = (n: bigint) => numberToHex(n, { size: 32 });
const b32 = (a: Address) => pad(a, { size: 32 });

type Tamper = 'none' | 'wrongMintRecipient' | 'wrongHookData' | 'leakWei';

/** In-memory Arc + Sepolia (native wei balances), CCTP with real message/receipt checks, and the vault. */
function fakeChain(tamper: Tamper = 'none') {
  const wei = new Map<string, bigint>([
    [owner.address.toLowerCase(), 5_000_000n * WEI],
    [agent.toLowerCase(), 500_000n * WEI],
    [vault.toLowerCase(), 35_000n * WEI],
    [sarah.toLowerCase(), 0n],
  ]);
  const nonces = new Map<string, number>();
  const receipts = new Map<string, ChainReceipt>();
  const gas = new Map<string, { payer: Address; feeWei: bigint }>();
  const raw = new Map<string, Log[]>();
  const order: string[] = [];
  let block = 1_000n;
  const bal = (a: string) => wei.get(a.toLowerCase()) ?? 0n;
  const add = (a: string, v: bigint) => wei.set(a.toLowerCase(), bal(a) + v);
  const spendGas = (payer: Address, hash: Hex) => {
    add(payer, -GAS);
    nonces.set(payer.toLowerCase(), (nonces.get(payer.toLowerCase()) ?? 0) + 1);
    gas.set(hash, { payer, feeWei: GAS });
  };
  let index = 0;
  const log = (address: Address, topics: Hex[], data: Hex): Log =>
    ({
      address,
      topics,
      data,
      logIndex: index++,
      blockNumber: block,
      blockHash: `0x${'11'.repeat(32)}`,
      transactionHash: `0x${'00'.repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    }) as unknown as Log;
  let burned: CctpTransfer | null = null;
  let message: Hex = '0x';
  const windowSpent = 5_000n;
  const port: DemoChainPort = {
    labels: { arc: 'FAKE_ARC', sepolia: 'FAKE_SEPOLIA' },
    arcUsdcBalance: async (a) => bal(a) / WEI,
    nativeBalance: async (a) => bal(a),
    arcNonce: async (a) => nonces.get(a.toLowerCase()) ?? 0,
    gatewayAvailable: async () => [{ chain: 'eth-sepolia', available: 0n }],
    probe: async () => ({
      ok: true,
      detail: 'fake',
      observedAt: Math.floor(Date.now() / 1000),
    }),
    receipt: async (hash) => receipts.get(hash) ?? null,
    txGas: async (hash) => gas.get(hash)!,
    vaultInfo: async (check) => ({
      vault,
      policy,
      operator: agent,
      healthy: true,
      problems: [],
      perPaymentCap: 10_000n,
      windowCap: 20_000n,
      windowSpent,
      windowEndsAt: Math.floor(Date.now() / 1000) + 3600,
      allowlisted: Object.fromEntries(
        check.map((a) => [a.toLowerCase(), a === sarah]),
      ),
    }),
    vaultPayCall: async ({ operator, recipient, amount }) =>
      operator !== agent
        ? { ok: false, reason: 'NotOperator()' }
        : recipient !== sarah
          ? { ok: false, reason: `RecipientNotAllowed(${recipient})` }
          : amount > 10_000n
            ? { ok: false, reason: 'CapExceeded' }
            : { ok: true, reason: null },
    fund: async () => [],
    cctpMinimumFeeBps: async () => 1,
    cctpBurn: async (t, onBurnHash) => {
      const burnTx = h(`burn:${t.transferId}`);
      await onBurnHash(burnTx);
      burned = t;
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
        tamper === 'wrongHookData' ? h('another invoice') : t.reference!,
      ]);
      message = concat([header, body]);
      return { message, attestation: h('att'), polls: 1 };
    },
    cctpMint: async (t, m, _a, onMintHash) => {
      const mintTx = h(`mint:${t.transferId}`);
      await onMintHash(mintTx);
      const to = tamper === 'wrongMintRecipient' ? stranger : t.recipient;
      const credited = t.amount - t.maxFee;
      add(to, credited * WEI);
      spendGas(owner.address, mintTx);
      block++;
      raw.set(mintTx, [
        log(
          USDC.address,
          encodeEventTopics({
            abi: erc20Abi,
            eventName: 'Transfer',
            args: { from: zeroAddress, to },
          }) as Hex[],
          encodeAbiParameters([{ type: 'uint256' }], [credited]),
        ),
        log(
          transmitter,
          encodeEventTopics({
            abi: [MESSAGE_RECEIVED_EVENT],
            eventName: 'MessageReceived',
            args: {
              caller: owner.address,
              nonce: h(`nonce:${t.transferId}`),
              finalityThresholdExecuted: t.minFinalityThreshold,
            },
          }) as Hex[],
          encodeAbiParameters(
            [{ type: 'uint32' }, { type: 'bytes32' }, { type: 'bytes' }],
            [CHAINS['eth-sepolia'].cctpDomain!, b32(t.payer), slice(m, 148)],
          ),
        ),
      ]);
      receipts.set(mintTx, {
        status: 'success',
        blockNumber: block,
        from: owner.address,
        transfers: [{ from: zeroAddress, to, baseUnits: credited }],
      });
      return { mintTx, alreadyUsed: false };
    },
    // The real receipt check, over a synthetic receipt.
    cctpReconcile: async (t, m, mintTx) =>
      reconcileMintReceipt({
        transfer: t,
        message: m,
        mintTx,
        explorer: `${CHAINS['arc-testnet'].explorer}/tx/${mintTx}`,
        receipt: {
          status: 'success',
          to: transmitter,
          from: owner.address,
          blockNumber: block,
          gasUsed: 1n,
          effectiveGasPrice: GAS,
          logs: raw.get(mintTx) ?? [],
        },
      }),
  };
  const fence = new MemoryNonceFence();
  let grantKey: Uint8Array = new Uint8Array();
  const admit = (
    grant: Parameters<ExecutorPort['admit']>[0]['grant'],
    recipient: Address,
    amount: bigint,
  ) =>
    admitGrant({
      grantKey,
      grant,
      call: {
        chainId: USDC.chainId,
        token: USDC.address,
        payer: vault,
        recipient,
        amount,
      },
      now: Math.floor(Date.now() / 1000),
      mandateRevoked: false,
      fence,
    });
  const executor: ExecutorPort = {
    label: 'IN_PROCESS_FAKE',
    async start(key) {
      grantKey = key;
      return { operator: agent, vault, policy, pid: null };
    },
    async pay({ grant, recipient, amount, onHash }) {
      await admit(grant, recipient, amount);
      const hash = h(`payout:${grant.grantId}`);
      await onHash(hash);
      order.push(`journal-ack:${hash}`);
      order.push(`broadcast:${hash}`);
      add(vault, -amount * WEI);
      add(recipient, amount * WEI);
      spendGas(agent, hash);
      if (tamper === 'leakWei') add(owner.address, -1n);
      block++;
      receipts.set(hash, {
        status: 'success',
        blockNumber: block,
        from: agent,
        transfers: [{ from: vault, to: recipient, baseUnits: amount }],
      });
      return {
        hash,
        blockNumber: block,
        explorer: `${CHAINS['arc-testnet'].explorer}/tx/${hash}`,
        logIndex: 0,
        payer: vault,
        gasPayer: agent,
        feeWei: GAS,
      };
    },
    async admit({ grant, recipient, amount }) {
      return admit(grant, recipient, amount).then(
        () => 'ADMITTED',
        (e: Error & { code?: string }) => `${e.code ?? e.name}: ${e.message}`,
      );
    },
    async stop() {},
  };
  return { port, executor, wei, order, message: () => message };
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

async function run(tamper: Tamper = 'none') {
  const chain = fakeChain(tamper);
  const routes = new MemoryRouteStore();
  const payouts = new MemoryPayoutJournal();
  const invoices = new MemoryInvoiceStore();
  const r = await runFreelancerDemo({
    runId: RUN,
    parties: { owner, agent, client, sarah, walletB },
    chain: chain.port,
    executor: chain.executor,
    stores: {
      ledger: new MemoryLedgerStore(),
      invoices,
      routes,
      payouts,
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
      minimumReserve: 10_000n,
    },
    env: {},
    blockers: [],
    now: () => Math.floor(Date.now() / 1000),
  });
  const byStep = Object.fromEntries(r.steps.map((s) => [s.step, s]));
  return { r, byStep, chain, routes, payouts, invoices };
}

describe('Synq Freelancer Finance Team (fake chain, HTTP and executor ports)', () => {
  it('runs guest invocation to reconciliation through the real channel, identity, invoice, team, Kernel and ledger code', async () => {
    const { r, byStep, chain, routes, payouts } = await run();
    expect(r.steps.map((s) => [s.step, s.status, s.error ?? null])).toEqual(
      [1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [n, 'OK', null]),
    );

    // 1. Guest: only the message and the replied-to message; answered via
    // answerGuestQuery; the gateway returns and tracks the inline id under a
    // disclosed retention, and the footer says exactly that.
    expect(byStep[1]!.labels).toEqual(['LOCAL_INGRESS']);
    const s1 = byStep[1]!.detail as {
      outcome: { code: string; messageRef: string };
      answer: string;
      tracked: unknown[];
      sendMessageCalls: number;
    };
    expect(s1.outcome).toMatchObject({ code: 'GUEST_ANSWERED' });
    expect(s1.outcome.messageRef).toBe('inline-1');
    expect(s1.tracked).toHaveLength(1);
    expect(s1.sendMessageCalls).toBe(0);
    expect(s1.answer).toContain('Acme Corp for 0.50 USDC');
    expect(s1.answer).toContain(
      "I keep nothing from this chat except this reply's message reference, for 7 days",
    );
    expect(s1.answer).not.toContain('I keep nothing.');

    // 2. Onboarding through the gateway: an unlinked sender is refused, then
    // the proof is consumed, the DM code returns, the wallet signs.
    expect(byStep[2]!.labels).toEqual([
      'LOCAL_INGRESS',
      'EOA_WALLET_LINK',
      'TEST_TELEGRAM_PROOF',
    ]);
    expect(byStep[2]!.detail).toMatchObject({
      unlinkedRequest: { status: 'UNAUTHORIZED', code: 'DIRECT_ONBOARDING' },
      complete: { code: 'DIRECT_ONBOARDING' },
      link: { wallet: owner.address, channelUserId: '70011' },
    });
    expect(String(byStep[2]!.detail.proofReplay)).toContain('already used');

    // 3. Model-extracted terms, persisted invoice, signed issuance, checkout
    // link only in the issuer's DM.
    expect(byStep[3]!.labels).toEqual([
      'LOCAL_INGRESS',
      'MEMORY_STORE',
      'REPLAY_MODEL',
    ]);
    expect(byStep[3]!.detail).toMatchObject({
      gateway: { code: 'DIRECT_ANSWERED' },
      supervisor: { termsSource: 'MODEL' },
      invoice: { number: 'INV-0001', total: '0.5', status: 'ISSUED' },
      checkout: { view: { amountDue: '0.5', payTo: owner.address } },
    });

    // 4-5. Not paid in flight; paid once from the reconciled mint.
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
    });
    expect(
      (byStep[5]!.detail.outbox as { topic: string }[]).map((e) => e.topic),
    ).toEqual(['invoice.issued', 'invoice.payment_applied']);
    expect(
      (byStep[5]!.detail.statusUpdates as { result: unknown }[]).slice(-2),
    ).toEqual([
      {
        key: `deal:${RUN}:client-chat`,
        result: { updated: 0, unchanged: 1, failed: 0 },
      },
      {
        key: `deal:${RUN}:issuer-dm`,
        result: { updated: 0, unchanged: 1, failed: 0 },
      },
    ]);
    expect(await routes.list(r.workspaceId)).toHaveLength(1);
    expect(await routes.list('wsp_other')).toHaveLength(0);

    // 6. A chat imperative gets PROPOSED (no grant); only the owner's wallet
    // signature turns it into a grant; the vault pays; a second approved
    // request for the same obligation is refused.
    expect(byStep[6]!.labels).toEqual([
      'LOCAL_INGRESS',
      'FAKE_ARC',
      'IN_PROCESS_FAKE',
      'REPLAY_MODEL',
    ]);
    expect(byStep[6]!.detail).toMatchObject({
      chatImperative: {
        intent: 'PAY_INVOICE',
        status: 'PROPOSED',
        grantIssued: false,
        world: { decisionGrade: true, refreshed: false },
      },
      ownerApproval: { signer: owner.address },
      confirmed: { status: 'GRANTED' },
      kernel: {
        outcome: 'ALLOW',
        grant: { recipient: sarah, payer: vault },
      },
      secondGrantForSameObligation: { status: 'DENIED', grantIssued: false },
      contractor: { creditedExactly: true },
    });
    // The hash was journaled (and acknowledged) before the broadcast.
    const hash = (byStep[6]!.detail.tx as { hash: string }).hash;
    expect(payouts.rows).toEqual([
      {
        hash,
        grantId: expect.any(String),
        workspaceId: r.workspaceId,
        state: 'SIGNED',
      },
    ]);
    expect(chain.order).toEqual([`journal-ack:${hash}`, `broadcast:${hash}`]);
    expect(JSON.stringify(r)).not.toContain('"mac"');

    // 7. Audit: invoice, route, amount, recipient, tx and current state.
    const audit7 = byStep[7]!.detail as {
      invoicePayment: { audit: SettlementAudit; answer: string };
      payout: { audit: { chainCheck: string; recipient: string } };
    };
    expect(audit7.invoicePayment.audit).toMatchObject({
      subject: 'INVOICE_PAYMENT',
      chainCheck: 'VERIFIED',
      recipient: owner.address,
      amount: '0.5',
      invoice: { number: 'INV-0001', status: 'PAID' },
      route: { route: 'CCTP_V2', sourceChain: 'eth-sepolia' },
    });
    expect(audit7.payout.audit).toMatchObject({
      chainCheck: 'VERIFIED',
      recipient: sarah,
    });

    // 8. Changed wallet: Risk flags it, Kernel denies (no confirmation is even
    // offered), the executor will not admit the old grant, the vault refuses.
    const s8 = byStep[8]!.detail as {
      riskFlags: { code: string }[];
      kernel: {
        outcome: string;
        reasons: string[];
        grantIssued: boolean;
        confirmationOffered: boolean;
      };
      executorAdmitWalletB: string;
      vaultPayToWalletB: { reverted: boolean; reason: string; method: string };
      balances: { unchanged: boolean };
      supervisor: { answer: string };
    };
    expect(s8.riskFlags.map((f) => f.code)).toContain('PAYOUT_ADDRESS_CHANGED');
    expect(s8.kernel).toMatchObject({
      outcome: 'DENY',
      grantIssued: false,
      confirmationOffered: false,
    });
    expect(s8.kernel.reasons.join(' ')).toContain(
      `recipient ${walletB} is not on the mandate allowlist`,
    );
    expect(s8.executorAdmitWalletB).toMatch(/GRANT_MISMATCH/);
    expect(s8.vaultPayToWalletB).toMatchObject({
      reverted: true,
      method: 'eth_call simulation (not broadcast)',
    });
    expect(s8.vaultPayToWalletB.reason).toContain('RecipientNotAllowed');
    expect(s8.balances.unchanged).toBe(true);
    expect(s8.supervisor.answer).toContain('Timing: not applicable');
    expect(s8.supervisor.answer).not.toContain('pay on the due date');

    // 9. Books equal chain, wallet by wallet, to the wei (including the
    // sub-unit gas remainder carried on its own dust line).
    expect(byStep[9]!.detail).toMatchObject({ status: 'RECONCILED' });
    expect(r.ledger.balances).toMatchObject({
      REVENUE: '-0.5',
      CONTRACTOR_EXPENSE: '0.005',
      NETWORK_FEES: '0.002446',
      CASH_ARC_USDC: '0.492554',
    });
    expect(r.ledger.dustWei).toEqual({
      NETWORK_FEES: '900000000000',
      CASH_ARC_USDC: '-900000000000',
    });
    expect(r.ledger.balances).not.toHaveProperty('ACCOUNTS_RECEIVABLE');

    // The original conversation is updated in place; no pay link in the group.
    const edits = r.transcript.filter(
      (t) => t.method === 'editMessageText' && t.messageRef === 'inline-1',
    );
    expect(edits.map((e) => e.text.split('\n')[0]!.slice(0, 30))).toEqual([
      expect.stringContaining('Invoice INV-0001: 0.5 USDC'),
      expect.stringContaining('Payment in flight'),
      expect.stringContaining('Invoice INV-0001: PAID'),
    ]);
    const group = r.transcript.filter((t) => t.chat === '-1002024001');
    expect(group.some((t) => t.text.includes('/pay/'))).toBe(false);
    expect(edits.at(-1)!.text).toContain('https://sepolia.etherscan.io/tx/');
    expect(
      r.transcript.some((t) => t.text.includes('link code is ••••••')),
    ).toBe(true);
    expect(JSON.stringify(r.transcript)).not.toMatch(
      /\/pay\/[^.\s]+\.[A-Za-z0-9_-]{8,}/,
    );
  }, 30_000);

  it('a mint to the wrong recipient fails settlement and leaves the invoice ISSUED', async () => {
    const { byStep, invoices, r } = await run('wrongMintRecipient');
    expect(byStep[4]!.status).toBe('OK');
    expect(byStep[5]!.status).toBe('FAILED');
    expect(byStep[5]!.error).toMatch(/expected one mint/);
    const inv = (await invoices.list(r.workspaceId))[0]!.invoice;
    expect(inv.status).toBe('ISSUED');
    // The relayer's mint gas is booked even though nothing settled.
    expect(byStep[9]!.status).toBe('OK');
  }, 30_000);

  it('an attestation carrying another reference is refused before any mint', async () => {
    const { byStep, invoices, r } = await run('wrongHookData');
    expect(byStep[4]!.status).toBe('FAILED');
    expect(byStep[4]!.error).toMatch(/hookData|REFERENCE/);
    expect(byStep[5]!.status).toBe('SKIPPED');
    const inv = (await invoices.list(r.workspaceId))[0]!.invoice;
    expect(inv.status).toBe('ISSUED');
  }, 30_000);

  it('a wallet whose chain balance moved without a ledger line fails reconciliation', async () => {
    const { byStep } = await run('leakWei');
    expect(byStep[9]!.status).toBe('FAILED');
    expect(byStep[9]!.error).toMatch(/owner chain .* vs ledger/);
  }, 30_000);

  it('an UNMATCHED settlement is a failure, never a silent no-op', async () => {
    const service = new InvoiceService(
      new MemoryInvoiceStore(),
      new Ledger(new MemoryLedgerStore()),
      () => 1_800_000_000,
    );
    const draft = draftInvoice({
      workspaceId: 'wsp_u',
      number: 'INV-0001',
      issuer: {
        principalId: 'p',
        name: 'Maya',
        wallet: owner.address,
        payoutAddress: owner.address,
      },
      payer: { name: 'Acme', contact: null },
      asset: USDC,
      lineItems: [{ description: 'x', quantity: 1, unitPrice: 500_000n }],
      dueDate: '2026-10-30',
      draftedBy: 'agent:invoice',
      now: 1_800_000_000,
    });
    await service.create(draft);
    await service.issue(
      draft.invoiceId,
      await owner.signTypedData(issueTypedData(draft)),
    );
    await expect(
      settleInvoiceFromMint(service, {
        chainId: USDC.chainId,
        txHash: h('mint'),
        logIndex: 0,
        paymentRef: h('unknown reference'),
        payer: client,
        recipient: owner.address,
        amount: 500_000n,
      }),
    ).rejects.toThrow(/settle UNMATCHED/);
  });
});
