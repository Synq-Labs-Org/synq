/**
 * "Synq Freelancer Finance Team": the end-to-end orchestration shared by the
 * live script (scripts/arc-freelancer-demo.ts) and its CI test
 * (tests/arc/freelancer-demo.test.ts). Everything that touches a chain, an
 * HTTP provider or a key goes through the injected ports; everything else is
 * the real product code: the Telegram adapter and channel gateway, identity
 * channel linking, the invoice service and checkout API, the CCTP transfer
 * state machine, the finance team, the Kernel and the ledger.
 */
import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import type { Address, Hex, PublicClient } from 'viem';
import { CHAINS, token } from '@synq/chain-registry/arc';
import { moneyToDecimal, money } from '@synq/domain';
import {
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  signTelegramLoginForTest,
  verifyTelegramLogin,
  type ChannelEvent,
  type OutboundMessage,
} from '@synq/channels';
import {
  ChannelLinkService,
  MemoryChannelLinkStore,
  channelLinkTypedData,
  type ChannelProofVerifier,
} from '@synq/identity';
import {
  InvoiceService,
  amountDue,
  issueTypedData,
  payLinkToken,
  type InvoiceStore,
  type MemoPayment,
} from '@synq/invoices';
import {
  MemoryNonceFence,
  mandateTypedData,
  type AuthorityConfig,
  type ExecutionGrant,
  type NonceFence,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  Ledger,
  relayOutbox,
  type LedgerStore,
  type OutboxEvent,
} from '@synq/ledger';
import {
  apEntries,
  vendorDirectory,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import {
  advance,
  checkMessage,
  decodeMessage,
  maxFeeFor,
  planTransfer,
  type CctpTransfer,
} from '@synq/plugin-circle-cctp';
import {
  MemoryFinanceBudgetLedger,
  classifyIntent,
  type ChainReceipt,
  type SettlementEvidence,
  type StructuredReasoner,
  type SupervisorReply,
} from '@synq/agent-runtime';
import type { Blocker } from '@synq/world-model';
import { invoiceRoutes } from '../../apps/api/src/invoice-routes.js';
import {
  ask,
  explain,
  kernelOf,
  requestPayout,
  type FinanceBooks,
  type FinanceWiring,
  type OwnerSigner,
  type WorldChainReads,
} from './freelancer-finance.js';

export type StepLabel =
  | 'LIVE_ARC_TESTNET'
  | 'LIVE_SEPOLIA'
  | 'LIVE_MODEL'
  | 'REPLAY_MODEL'
  | 'NO_MODEL'
  | 'LOCAL_INGRESS'
  | 'EOA_WALLET_LINK'
  | 'TEST_TELEGRAM_PROOF'
  | 'POSTGRES'
  | 'MEMORY_STORE'
  | 'FAKE_ARC'
  | 'FAKE_SEPOLIA'
  | 'BLOCKED';

export type FundingRecord = Readonly<{
  what: string;
  chain: string;
  hash: Hex;
  explorer: string;
}>;

export type GrantedPayout = Readonly<{
  hash: Hex;
  blockNumber: bigint;
  explorer: string;
  logIndex: number;
  feeBaseUnits: bigint;
}>;

export type VaultCheck = Readonly<{
  vault: Address;
  policy: Address;
  operator: Address;
  operatorIsAgent: boolean;
  verifiedAllowlisted: boolean;
  changedAllowlisted: boolean;
  changedPayCall: { ok: boolean; reason: string | null };
  vaultHealthy: boolean;
  vaultProblems: string[];
}>;

/** Every chain/provider effect the demo needs. Live: viem + workers/execution; CI: fakes. */
export interface DemoChainPort extends WorldChainReads {
  readonly labels: { arc: StepLabel; sepolia: StepLabel };
  arcNonce(account: Address): Promise<number>;
  receipt(hash: Hex): Promise<ChainReceipt | null>;
  simulateTransfer(t: {
    from: Address;
    to: Address;
    amount: bigint;
  }): Promise<boolean>;
  /** Tops up the agent float on Arc and the client's Sepolia USDC/ETH from the operator. */
  fund(input: {
    agent: Address;
    agentMin: bigint;
    agentTopUp: bigint;
    client: Address;
    clientSepoliaUsdcMin: bigint;
  }): Promise<FundingRecord[]>;
  cctpMinimumFeeBps(): Promise<number>;
  cctpBurn(
    t: CctpTransfer,
    onBurnHash: (h: Hex) => Promise<void> | void,
  ): Promise<{ approveTx: Hex | null; burnTx: Hex }>;
  cctpAttestation(
    burnTx: Hex,
  ): Promise<{ message: Hex; attestation: Hex; polls: number }>;
  cctpMint(
    t: CctpTransfer,
    message: Hex,
    attestation: Hex,
    onMintHash: (h: Hex) => Promise<void> | void,
  ): Promise<{ mintTx: Hex | null; alreadyUsed: boolean }>;
  cctpReconcile(
    t: CctpTransfer,
    message: Hex,
    mintTx: Hex,
  ): Promise<{
    minted: bigint;
    feeExecuted: bigint;
    logIndex: number;
    nonce: Hex;
    blockNumber: bigint;
  }>;
  /** workers/execution `executeGrantedTransfer` from the agent wallet. */
  executeGranted(input: {
    grant: ExecutionGrant;
    grantKey: Uint8Array;
    fence: NonceFence;
    to: Address;
    amount: bigint;
    onBroadcast: (h: Hex) => Promise<void> | void;
  }): Promise<GrantedPayout>;
  /** Read-only: does the governed vault refuse an operator payment to `changed`? */
  vaultCheck?(input: {
    operator: Address;
    verified: Address;
    changed: Address;
    amount: bigint;
  }): Promise<VaultCheck | null>;
}

/** Where reconciled invoice routes are recorded (Postgres in the script). */
export interface RouteStore {
  save(r: SettlementEvidence): Promise<void>;
  list(): Promise<SettlementEvidence[]>;
}
export class MemoryRouteStore implements RouteStore {
  private rows = new Map<string, SettlementEvidence>();
  async save(r: SettlementEvidence) {
    this.rows.set(r.destinationTx.toLowerCase(), r);
  }
  async list() {
    return [...this.rows.values()];
  }
}

export type DemoDeps = {
  runId: string;
  parties: {
    /** Freelancer's EOA (testnet.key): signs link, issuance, mandate, approvals. */
    owner: OwnerSigner;
    /** Operational wallet that pays only under Kernel grants (arc-agent.key). */
    agent: Address;
    /** Client wallet paying from Sepolia (arc-client.key). */
    client: Address;
    /** Contractor's verified payout address (arc-contractor.key). */
    sarah: Address;
    /** Freshly generated "new wallet" from the fraud attempt. */
    walletB: Address;
  };
  chain: DemoChainPort;
  stores: {
    ledger: LedgerStore;
    invoices: InvoiceStore;
    routes: RouteStore;
    label: 'POSTGRES' | 'MEMORY_STORE';
  };
  reasoner?: StructuredReasoner;
  /** Telegram Login proof check. No real user exists here: a labelled test verifier. */
  telegramProof: {
    verifier: ChannelProofVerifier;
    proof: unknown;
    label: 'TEST_TELEGRAM_PROOF';
  };
  checkout: {
    client: PublicClient;
    memoContract: Address;
    /** Serve on a local port and use fetch (script) or in-process inject (test). */
    listen: boolean;
  };
  amounts: {
    payout: bigint;
    /** Refuse an invoice above this (a model-extracted amount is bounded). */
    maxInvoice: bigint;
    minimumReserve: bigint;
  };
  env: Readonly<Record<string, string | undefined>>;
  blockers: Blocker[];
  now: () => number;
  log?: (line: string) => void;
};

export type StepRecord = {
  step: number;
  title: string;
  labels: StepLabel[];
  status: 'OK' | 'FAILED' | 'SKIPPED';
  detail: Record<string, unknown>;
  error?: string;
};

export type TranscriptEntry = Readonly<{
  seq: number;
  at: number;
  direction: 'IN' | 'OUT';
  chat: string;
  method: string;
  from: string;
  text: string;
  messageRef: string | null;
}>;

const USDC = token('arc-testnet', 'USDC');
const ARC = CHAINS['arc-testnet'];
const SEPOLIA = CHAINS['eth-sepolia'];
const BOT = { id: 7_000_000_001, username: 'asksynqbot' };
const MAYA = { id: 70_011, name: 'Maya' };
const ACME = { id: 90_011, name: 'Dana (Acme Corp)' };
const CLIENT_CHAT = '-1002024001';
/** Local transport only: never a real bot token, never sent anywhere. */
const LOCAL_TOKEN = '7000000001:LOCAL_INGRESS_fake_transport_token';
const DM = String(MAYA.id);
const d = (b: bigint) => moneyToDecimal(money(USDC, b));
const arcTx = (h: string) => `${ARC.explorer}/tx/${h}`;
const sepTx = (h: string) => `${SEPOLIA.explorer}/tx/${h}`;
/** Pay-link tokens are bearer navigation links: evidence keeps only the invoice id part. */
const redactLink = (url: string) =>
  url.replace(/(\/pay\/[^.]+)\.[^/?#]+/, '$1.…');
const bigJson = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)),
  ) as Record<string, unknown>;

/**
 * A capturing Telegram Bot API transport. Telegram's live transport is
 * blocked for this bot (Guest Mode off), so every Bot API call the real
 * TelegramAdapter makes is answered here and recorded; nothing reaches
 * api.telegram.org.
 */
export function localTelegram(now: () => number) {
  const transcript: TranscriptEntry[] = [];
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let messageId = 500;
  let inline = 0;
  let seq = 0;
  const push = (e: Omit<TranscriptEntry, 'seq' | 'at'>) =>
    transcript.push({ seq: ++seq, at: now(), ...e });
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body =
      init?.body instanceof FormData
        ? {}
        : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    switch (method) {
      case 'getMe':
        return ok({
          id: BOT.id,
          is_bot: true,
          first_name: 'Synq',
          username: BOT.username,
          can_read_all_group_messages: false,
          // The live bot reports false (Guest Mode off); this transport
          // enables it so the guest path of the real adapter runs.
          supports_guest_queries: true,
        });
      case 'sendMessage': {
        const id = ++messageId;
        push({
          direction: 'OUT',
          chat: String(body.chat_id),
          method,
          from: `@${BOT.username}`,
          text: String(body.text ?? ''),
          messageRef: String(id),
        });
        return ok({ message_id: id, date: now() });
      }
      case 'answerGuestQuery': {
        const id = `inline-${++inline}`;
        const result = body.result as {
          input_message_content: { message_text: string };
        };
        push({
          direction: 'OUT',
          chat: CLIENT_CHAT,
          method,
          from: `@${BOT.username}`,
          text: result.input_message_content.message_text,
          messageRef: id,
        });
        return ok({ inline_message_id: id });
      }
      case 'editMessageText': {
        push({
          direction: 'OUT',
          chat: body.inline_message_id ? CLIENT_CHAT : String(body.chat_id),
          method,
          from: `@${BOT.username}`,
          text: String(body.text ?? ''),
          messageRef: String(body.inline_message_id ?? body.message_id),
        });
        return ok(true);
      }
    }
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }),
      { status: 404 },
    );
  }) as typeof fetch;
  const inbound = (chat: string, from: string, text: string, ref: string) =>
    push({
      direction: 'IN',
      chat,
      method: 'update',
      from,
      text,
      messageRef: ref,
    });
  return { fetch: fetchImpl, transcript, calls, inbound };
}

/**
 * A Telegram Login proof for the demo user. There is no real user to log in
 * with the widget, so the proof is HMAC-signed with the local transport's
 * token and checked by the real `verifyTelegramLogin`: the verification code
 * path is genuine, the proof is test material (labelled TEST_TELEGRAM_PROOF).
 */
export function testTelegramProof(now: number): DemoDeps['telegramProof'] {
  return {
    proof: signTelegramLoginForTest(
      { id: MAYA.id, first_name: MAYA.name, auth_date: now },
      LOCAL_TOKEN,
    ),
    verifier: (raw, at) => {
      const id = verifyTelegramLogin(raw, LOCAL_TOKEN, at);
      return id ? { channelUserId: id } : null;
    },
    label: 'TEST_TELEGRAM_PROOF',
  };
}

/**
 * Onboarding's identity step, isolated so the hardened channel-link API is
 * adapted here only: Telegram proof (consumed once) → code delivered by DM →
 * the wallet signs the exact EIP-712 challenge → link record.
 */
async function linkWallet(input: {
  workspaceId: string;
  owner: OwnerSigner;
  proof: DemoDeps['telegramProof'];
  sendDm: (text: string, code: string) => Promise<void>;
  readCode: () => string;
  now: () => number;
}) {
  const service = new ChannelLinkService(new MemoryChannelLinkStore(), {
    verifiers: { telegram: input.proof.verifier },
    deliverCode: async ({ code }) =>
      input.sendDm(
        `Your Synq link code is ${code}. Reply with it here to confirm; never share it.`,
        code,
      ),
    now: input.now,
  });
  const challenge = await service.requestLink({
    workspaceId: input.workspaceId,
    channel: 'telegram',
    channelProof: input.proof.proof,
    wallet: input.owner.address,
  });
  const signature = await input.owner.signTypedData(
    channelLinkTypedData(challenge),
  );
  const record = await service.completeLink({
    challengeId: challenge.challengeId,
    channelCode: input.readCode(),
    signature,
  });
  const replay = await service
    .requestLink({
      workspaceId: input.workspaceId,
      channel: 'telegram',
      channelProof: input.proof.proof,
      wallet: input.owner.address,
    })
    .then(
      () => 'ACCEPTED (unexpected)',
      (e: Error & { code?: string; detail?: string }) =>
        `${e.code ?? e.name}: ${e.detail ?? e.message}`,
    );
  return { challenge, record, proofReplay: replay };
}

export async function runFreelancerDemo(deps: DemoDeps) {
  const { parties, chain, now } = deps;
  const log = deps.log ?? (() => undefined);
  const steps: StepRecord[] = [];
  const workspaceId = `wsp_freelancer_${deps.runId}`;
  const tg = localTelegram(now);
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({
      token: LOCAL_TOKEN,
      fetch: tg.fetch,
    }),
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
    }),
    transport: 'BOT_API_POLL',
  });
  const botProfile = await adapter.init();
  let updateId = 9_000;
  const dm = async (text: string) => {
    const sent = await adapter.send(DM, { text });
    return sent.messageId;
  };
  const userSays = (text: string): ChannelEvent[] => {
    const id = ++updateId;
    tg.inbound(DM, MAYA.name, text, String(id));
    return adapter.normalize({
      update_id: id,
      message: {
        message_id: id,
        date: now(),
        chat: { id: MAYA.id, type: 'private', first_name: MAYA.name },
        from: { id: MAYA.id, is_bot: false, first_name: MAYA.name },
        text,
      },
    });
  };
  const bodyOf = (events: ChannelEvent[]) => {
    const e = events.find((x) => x.type === 'MESSAGE_RECEIVED');
    if (!e || e.type !== 'MESSAGE_RECEIVED')
      throw new Error('adapter did not produce a message event');
    return e.envelope.body;
  };
  const statusTargets: { inlineMessageId: string | null; dm: string | null } = {
    inlineMessageId: null,
    dm: null,
  };
  const updateConversation = async (message: OutboundMessage) => {
    if (statusTargets.inlineMessageId)
      await adapter.edit(
        { inlineMessageId: statusTargets.inlineMessageId },
        message,
      );
    if (statusTargets.dm)
      await adapter.edit({ chatId: DM, messageId: statusTargets.dm }, message);
  };

  const step = async (
    n: number,
    title: string,
    run: (labels: StepLabel[]) => Promise<Record<string, unknown>>,
  ) => {
    const labels: StepLabel[] = [];
    log(`\n=== Step ${n}: ${title}`);
    try {
      const detail = bigJson(await run(labels));
      steps.push({ step: n, title, labels, status: 'OK', detail });
      log(`--- Step ${n} [${labels.join(' + ')}] OK`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      steps.push({
        step: n,
        title,
        labels: [...labels, 'BLOCKED'],
        status: 'FAILED',
        detail: {},
        error: message.slice(0, 600),
      });
      log(`--- Step ${n} FAILED: ${message.slice(0, 300)}`);
      return false;
    }
  };
  const skip = (n: number, title: string, why: string) => {
    steps.push({
      step: n,
      title,
      labels: ['BLOCKED'],
      status: 'SKIPPED',
      detail: {},
      error: why,
    });
    log(`\n=== Step ${n}: ${title} SKIPPED (${why})`);
  };

  // ------------------------------------------------------------ books
  const sarah: Vendor = {
    vendorId: 'sarah',
    workspaceId,
    name: 'Sarah (designer)',
    kind: 'CONTRACTOR',
    addresses: [
      {
        chainId: USDC.chainId,
        address: parties.sarah,
        status: 'VERIFIED',
        source: 'contractor onboarding (address derived from her own key)',
        at: now() - 30 * 86_400,
        verifiedBy: 'owner',
      },
    ],
  };
  const ledger = new Ledger(deps.stores.ledger, vendorDirectory([sarah]));
  const invoices = new InvoiceService(deps.stores.invoices, ledger, now);
  const books: FinanceBooks = {
    workspaceId,
    identity: null,
    vendors: [sarah],
    vendorInvoices: [],
    obligations: [],
    payoutEvidence: [],
    settlements: await deps.stores.routes.list(),
    cctpInFlight: [],
    mandate: null,
    mandateState: { revoked: false, spends: [] },
    minimumReserve: deps.amounts.minimumReserve,
    blockers: deps.blockers,
  };
  books.settlements = books.settlements.filter((s) =>
    s.invoiceId.includes(workspaceId),
  );
  const wiring: FinanceWiring = {
    books,
    chain,
    ledger,
    invoices: {
      list: async (ws) => (await invoices.store.list(ws)).map((r) => r.invoice),
    },
    receipts: (h) => chain.receipt(h),
    budget: new MemoryFinanceBudgetLedger(),
    ...(deps.reasoner ? { reasoner: deps.reasoner } : {}),
    env: deps.env,
    now,
  };
  const modelLabel = (reply: SupervisorReply): StepLabel[] =>
    reply.modelCalls.length
      ? [
          ...new Set(
            reply.modelCalls.map((c) =>
              c.mode === 'LIVE'
                ? ('LIVE_MODEL' as const)
                : ('REPLAY_MODEL' as const),
            ),
          ),
        ]
      : ['NO_MODEL'];
  const modelCalls: unknown[] = [];

  // Balances first; top up the agent float and the client's Sepolia wallet.
  const funding = await chain.fund({
    agent: parties.agent,
    agentMin: deps.amounts.payout * 4n,
    agentTopUp: 500_000n,
    client: parties.client,
    clientSepoliaUsdcMin: deps.amounts.maxInvoice + 10_000n,
  });
  for (const f of funding) log(`funded ${f.what}: ${f.explorer}`);

  // ------------------------------------------------------------ 1 guest
  const gateway = new ChannelGateway({
    store: new MemoryChannelStore(),
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: `${ARC.explorer}/tx/`,
    now,
    botUsernames: { telegram: BOT.username },
    guestCooldownSeconds: 0,
    ports: {
      activeMember: async () => null,
      treasury: async () => null,
      mandates: async () => [],
      approvals: async () => [],
      receipts: async () => [],
      guest: async ({ text, reference }) => {
        // Only the guest's own text and the one replied-to message arrive here.
        const asked = classifyIntent(text);
        const quoted = reference ? classifyIntent(reference.text) : null;
        const inv =
          asked.kind === 'CREATE_INVOICE' && asked.amount
            ? asked
            : quoted?.kind === 'CREATE_INVOICE' && quoted.amount
              ? quoted
              : null;
        return {
          text: inv
            ? `Draft only: an invoice to ${inv.counterparty ?? 'the client'} for ${inv.amount} ${inv.asset ?? 'USDC'}, settled in USDC on Arc testnet; the client can pay from Ethereum Sepolia through Circle CCTP. Message me privately to link your wallet and issue it; I will update this message with the invoice status.`
            : 'Draft only: I can draft invoices, track payments into Arc and pay approved contractors. Message me privately to set up your finance workspace.',
        };
      },
    },
  });
  await step(1, 'Guest invocation in the client chat', async (labels) => {
    labels.push('LOCAL_INGRESS');
    const ask1 = ++updateId;
    const clientText =
      'Thanks Maya! Can you send the invoice for the landing page? We pay from Ethereum Sepolia.';
    tg.inbound(CLIENT_CHAT, ACME.name, clientText, String(ask1));
    const guestText = `@${BOT.username} draft an invoice to Acme Corp 0.50 USDC for the landing page`;
    const id = ++updateId;
    tg.inbound(CLIENT_CHAT, MAYA.name, guestText, String(id));
    const update = {
      update_id: id,
      guest_message: {
        message_id: id,
        date: now(),
        chat: {
          id: Number(CLIENT_CHAT),
          type: 'supergroup',
          title: 'Acme x Maya',
        },
        from: { id: MAYA.id, is_bot: false, first_name: MAYA.name },
        text: guestText,
        entities: [
          { type: 'mention', offset: 0, length: BOT.username.length + 1 },
        ],
        guest_query_id: `gq_${deps.runId}`,
        reply_to_message: {
          message_id: ask1,
          date: now() - 20,
          from: { id: ACME.id, is_bot: false, first_name: 'Dana' },
          text: clientText,
        },
      },
    };
    const events = adapter.normalize(update, 'BOT_API_POLL');
    const outcome = await gateway.handle(events[0]!);
    const answer = [...tg.transcript]
      .reverse()
      .find((t) => t.method === 'answerGuestQuery');
    if (outcome.code !== 'GUEST_ANSWERED' || !answer)
      throw new Error(`guest not answered: ${JSON.stringify(outcome)}`);
    statusTargets.inlineMessageId = answer.messageRef;
    const guestEvent = events[0]!;
    return {
      botProfile: {
        username: botProfile.username,
        guestQueries: botProfile.guestQueries,
        note: 'profile from the local transport; the live @asksynqbot reports supports_guest_queries=false',
      },
      eventType: guestEvent.type,
      contextReceived:
        guestEvent.type === 'GUEST_QUERY'
          ? {
              text: guestEvent.envelope.body,
              reference: guestEvent.reference
                ? {
                    messageId: guestEvent.reference.messageId,
                    textSha256: guestEvent.reference.textSha256,
                  }
                : null,
            }
          : null,
      outcome,
      answer: answer.text,
      inlineMessageId: answer.messageRef,
      sendMessageCalls: tg.calls.filter((c) => c.method === 'sendMessage')
        .length,
    };
  });

  // ------------------------------------------------------------ 2 onboarding
  const onboarded = await step(
    2,
    'Onboarding: wallet link and finance workspace',
    async (labels) => {
      labels.push('LOCAL_INGRESS', 'EOA_WALLET_LINK', deps.telegramProof.label);
      bodyOf(userSays('/start finance'));
      let code = '';
      const linked = await linkWallet({
        workspaceId,
        owner: parties.owner,
        proof: deps.telegramProof,
        sendDm: async (text, delivered) => {
          await dm(text);
          code = delivered; // the user reads the code in the DM and types it back
        },
        readCode: () => bodyOf(userSays(code)),
        now,
      });
      const user = { principalId: `prn_tg_${MAYA.id}`, displayName: MAYA.name };
      books.identity = {
        user,
        workspace: {
          workspaceId,
          name: 'Maya Studio (test)',
          kind: 'FREELANCER',
        },
        membership: {
          ...user,
          role: 'OWNER',
          verified: true,
          via: 'EIP-712 channel-link signature',
        },
        wallets: [
          {
            address: parties.owner.address,
            chain: 'arc-testnet',
            ownerPrincipalId: user.principalId,
            kind: 'OWNER_EOA',
            role: 'PAYOUT',
            verifiedBy: `channel-link ${linked.record.linkChallengeId}`,
          },
          {
            address: parties.agent,
            chain: 'arc-testnet',
            ownerPrincipalId: user.principalId,
            kind: 'AGENT_EOA',
            role: 'TREASURY',
            verifiedBy: 'payer of the owner-signed mandate',
          },
        ],
        source: 'identity:channel-link(memory store)',
      };
      const statusDm = await dm(
        [
          `Linked: Telegram user ${MAYA.id} <-> wallet ${parties.owner.address} (EIP-712 signature verified).`,
          `Workspace ${workspaceId} created. Invoices are paid into ${parties.owner.address} on Arc testnet.`,
          `Circle Wallets: UNAVAILABLE (no credentials), so your existing EOA is linked instead.`,
        ].join('\n'),
      );
      return {
        link: {
          linkId: linked.record.linkId,
          channelUserId: linked.record.channelUserId,
          wallet: linked.record.wallet,
          challengeId: linked.challenge.challengeId,
          statement: linked.challenge.statement,
          signature: linked.record.linkSignature,
        },
        proofReplay: linked.proofReplay,
        workspaceId,
        circleWallets: 'UNAVAILABLE: credentials missing (P03 blocker)',
        dmMessage: statusDm,
      };
    },
  );
  if (!onboarded) throw new Error('onboarding failed; nothing else can run');

  // ------------------------------------------------------------ 3 invoice
  const app = Fastify();
  const payLinkKey = randomBytes(32);
  await app.register(invoiceRoutes, {
    invoices,
    payLinkKey,
    client: deps.checkout.client,
    memoContract: deps.checkout.memoContract,
    now,
  });
  let base = 'http://checkout.local';
  if (deps.checkout.listen)
    base = await app.listen({ port: 0, host: '127.0.0.1' });
  const getJson = async (path: string) => {
    if (deps.checkout.listen)
      return (await (await fetch(`${base}${path}`)).json()) as Record<
        string,
        unknown
      >;
    return (await app.inject({ method: 'GET', url: path })).json() as Record<
      string,
      unknown
    >;
  };
  let invoiceId: string | null = null;
  let payLink = '';
  const invoiceOk = await step(
    3,
    'Invoice from natural language, persisted, with secure checkout',
    async (labels) => {
      labels.push('LOCAL_INGRESS', deps.stores.label);
      const text =
        'Please draft an invoice to Acme Corp for the landing page build, half a USDC, due in 7 days';
      const reply = await ask(wiring, bodyOf(userSays(text)));
      modelCalls.push(...reply.modelCalls);
      labels.push(...modelLabel(reply));
      const outcome = reply.invoice;
      if (!outcome?.draft || outcome.status !== 'DRAFTED')
        throw new Error(`invoice agent: ${reply.answer}`);
      if (outcome.draft.total > deps.amounts.maxInvoice)
        throw new Error(
          `drafted total ${outcome.draft.total} exceeds the demo cap`,
        );
      await invoices.create(outcome.draft);
      const signature = await parties.owner.signTypedData(
        issueTypedData(outcome.draft),
      );
      const issued = (await invoices.issue(outcome.draft.invoiceId, signature))
        .invoice;
      invoiceId = issued.invoiceId;
      payLink = `/v1/pay/${payLinkToken(payLinkKey, issued, now() + 86_400)}`;
      const view = await getJson(payLink);
      const msg = `Invoice ${issued.number} issued: ${d(issued.total)} USDC to ${issued.payer.name}, due ${issued.dueDate}. Pay on Arc, or from Ethereum Sepolia via CCTP.`;
      statusTargets.dm = await adapter
        .send(DM, {
          text: msg,
          buttons: [{ label: 'Checkout', url: `${base}${payLink}` }],
        })
        .then((r) => r.messageId);
      await updateConversation({
        text: `${msg}\nStatus: ISSUED, awaiting payment.`,
        buttons: [{ label: 'Checkout', url: `${base}${payLink}` }],
      });
      const stored = (await invoices.store.get(issued.invoiceId))!;
      return {
        request: text,
        supervisor: {
          intent: reply.intent,
          handledBy: reply.handledBy,
          answer: reply.answer,
          termsSource: outcome.termsSource,
        },
        invoice: {
          invoiceId: issued.invoiceId,
          number: issued.number,
          payer: issued.payer.name,
          total: d(issued.total),
          dueDate: issued.dueDate,
          status: stored.invoice.status,
          rev: stored.rev,
          paymentRef: issued.paymentRef,
          termsHash: issued.termsHash,
          issuerSignature: issued.issuerSignature,
          payoutAddress: issued.issuer.payoutAddress,
        },
        checkout: {
          url: redactLink(`${base}${payLink}`),
          served: deps.checkout.listen ? 'HTTP (local port)' : 'in-process',
          view: {
            status: view.status,
            amountDue: view.amountDue,
            payTo: view.payTo,
            paymentRef: view.paymentRef,
            arcMemoCall: view.call ? 'present' : null,
          },
        },
      };
    },
  );

  // ------------------------------------------------------------ 4 + 5 CCTP
  let mintTx: Hex | null = null;
  let cctp: CctpTransfer | null = null;
  if (!invoiceOk || !invoiceId) {
    skip(4, 'Cross-chain payment', 'no issued invoice');
    skip(5, 'Settlement', 'no issued invoice');
  } else {
    const id: string = invoiceId;
    let attested: { message: Hex; attestation: Hex; polls: number } | null =
      null;
    const paid = await step(
      4,
      'Client pays from Ethereum Sepolia via Circle CCTP V2 into Arc',
      async (labels) => {
        labels.push(chain.labels.sepolia, chain.labels.arc);
        // The client follows the checkout view: amount due, payout address, reference.
        const view = await getJson(payLink);
        const due = BigInt(
          Math.round(Number(String(view.amountDue)) * 1_000_000),
        );
        const fee = maxFeeFor(due, await chain.cctpMinimumFeeBps());
        const at = now();
        let t = planTransfer({
          transferId: `cctp_${deps.runId}`,
          source: 'eth-sepolia',
          destination: 'arc-testnet',
          payer: parties.client,
          payerKind: 'EOA',
          recipient: view.payTo as Address,
          amount: due + fee,
          maxFee: fee,
          fast: true,
          reference: view.paymentRef as Hex,
          at,
        });
        t = advance(t, 'APPROVED', now(), 'client approved the exact plan');
        const inFlight = () => {
          books.cctpInFlight = [
            {
              transferId: t.transferId,
              from: 'eth-sepolia',
              to: 'arc-testnet',
              baseUnits: String(t.amount),
              status:
                t.state === 'ATTESTED'
                  ? 'ATTESTED'
                  : t.state === 'DEST_SUBMITTED'
                    ? 'MINT_PENDING'
                    : 'BURNED',
              startedAt: at,
              invoiceRef: view.paymentRef as string,
            },
          ];
        };
        const burn = await chain.cctpBurn(t, (h) => {
          t = advance(t, 'SOURCE_SUBMITTED', now(), 'burn hash recorded', {
            burnTx: h,
          });
        });
        t = advance(t, 'SOURCE_CONFIRMED', now(), 'burn receipt success');
        inFlight();
        log(`burn ${sepTx(burn.burnTx)}`);
        await updateConversation({
          text: `Invoice payment in flight: ${d(t.amount)} USDC burned on Ethereum Sepolia by ${parties.client} (CCTP fast transfer).\nSource tx: ${sepTx(burn.burnTx)}\nStatus: AWAITING ATTESTATION. Not paid until the Arc mint is verified.`,
        });
        const statusDuring = (await invoices.store.get(id))!.invoice.status;
        t = advance(t, 'ATTESTATION_PENDING', now(), 'polling Iris');
        attested = await chain.cctpAttestation(burn.burnTx);
        const decoded = decodeMessage(attested.message);
        checkMessage(t, decoded);
        t = advance(t, 'ATTESTED', now(), `attested after ${attested.polls}`, {
          message: attested.message,
          attestation: attested.attestation,
          nonce: decoded.nonce,
        });
        inFlight();
        const minted = await chain.cctpMint(
          t,
          attested.message,
          attested.attestation,
          (h) => {
            t = advance(t, 'DEST_SUBMITTED', now(), 'mint hash recorded', {
              mintTx: h,
            });
          },
        );
        if (!minted.mintTx)
          throw new Error('nonce already used: reconcile, do not re-mint');
        mintTx = minted.mintTx;
        log(`mint ${arcTx(mintTx)}`);
        cctp = t;
        return {
          plan: {
            gross: d(t.amount),
            maxFee: d(t.maxFee),
            due: d(due),
            hookData: t.reference,
            recipient: t.recipient,
          },
          approveTx: burn.approveTx,
          approveExplorer: burn.approveTx ? sepTx(burn.approveTx) : null,
          burnTx: burn.burnTx,
          burnExplorer: sepTx(burn.burnTx),
          attestationPolls: attested.polls,
          irisNonce: decoded.nonce,
          hookData: decoded.burn.hookData,
          feeExecuted: d(decoded.burn.feeExecuted),
          mintTx,
          mintExplorer: arcTx(mintTx),
          invoiceStatusWhileInFlight: statusDuring,
        };
      },
    );
    if (!paid || !mintTx || !attested) skip(5, 'Settlement', 'no mint');
    else {
      const message: Hex = (attested as { message: Hex }).message;
      const mint: Hex = mintTx;
      await step(
        5,
        'Settlement only from the verified Arc mint',
        async (labels) => {
          labels.push(chain.labels.arc, deps.stores.label);
          let t = cctp!;
          const rec = await chain.cctpReconcile(t, message, mint);
          const decoded = decodeMessage(message);
          t = advance(t, 'DEST_FINAL', now(), 'mint receipt reconciled', {
            minted: rec.minted,
            feeExecuted: rec.feeExecuted,
          });
          const payment: MemoPayment = {
            chainId: USDC.chainId,
            txHash: mint,
            logIndex: rec.logIndex,
            paymentRef: decoded.burn.hookData,
            payer: decoded.burn.messageSender,
            recipient: decoded.burn.mintRecipient,
            amount: rec.minted,
          };
          const before = (await invoices.store.get(id))!.invoice.status;
          const settled = await invoices.settle(payment);
          const replay = await invoices.settle(payment);
          t = advance(t, 'MATCHED', now(), 'invoice settled');
          t = advance(t, 'RECONCILED', now(), 'ledger posted');
          cctp = t;
          books.cctpInFlight = [];
          const route: SettlementEvidence = {
            invoiceId: id,
            route: 'CCTP_V2',
            sourceChain: 'eth-sepolia',
            sourceTx: t.burnTx,
            sourceExplorer: sepTx(t.burnTx!),
            attestationNonce: rec.nonce,
            destinationChain: 'arc-testnet',
            destinationTx: mint,
            destinationExplorer: arcTx(mint),
            payer: decoded.burn.messageSender,
            recipient: decoded.burn.mintRecipient,
            grossBaseUnits: String(t.amount),
            feeBaseUnits: String(rec.feeExecuted),
            creditedBaseUnits: String(rec.minted),
          };
          await deps.stores.routes.save(route);
          books.settlements.push(route);
          // Status updates go out from the ledger outbox, committed with the entry.
          const published: OutboxEvent[] = [];
          await relayOutbox(deps.stores.ledger, async (e) => {
            const p = e.payload as { invoiceId?: string };
            if (p.invoiceId !== id) return;
            published.push(e);
          });
          const after = (await invoices.store.get(id))!;
          const paidEvent = published.find(
            (e) => e.topic === 'invoice.payment_applied',
          );
          if (paidEvent && after.invoice.status === 'PAID')
            await updateConversation({
              text: `Invoice ${after.invoice.number}: PAID. ${d(rec.minted)} USDC received on Arc from ${decoded.burn.messageSender} via CCTP.\nSource (Sepolia burn): ${sepTx(t.burnTx!)}\nArc mint: ${arcTx(mint)}\nIris nonce: ${rec.nonce}`,
            });
          const view = await getJson(payLink);
          return {
            reconciled: {
              minted: d(rec.minted),
              feeExecuted: d(rec.feeExecuted),
              logIndex: rec.logIndex,
              block: rec.blockNumber,
              nonce: rec.nonce,
            },
            statusBefore: before,
            settle: settled.outcome,
            replay: replay.outcome,
            invoice: {
              number: after.invoice.number,
              status: after.invoice.status,
              paid: d(after.invoice.paid),
              amountDue: d(amountDue(after.invoice)),
              rev: after.rev,
              payments: after.invoice.payments.map((p) => ({
                txHash: p.txHash,
                logIndex: p.logIndex,
                payer: p.payer,
                amount: d(p.amount),
              })),
            },
            outbox: published.map((e) => ({
              eventId: e.eventId,
              topic: e.topic,
            })),
            checkoutAfter: { status: view.status, amountDue: view.amountDue },
            transfer: { state: t.state, history: t.history },
            route,
          };
        },
      );
    }
  }
  if (deps.checkout.listen) await app.close();

  // ------------------------------------------------------------ 6 payout
  const at0 = now();
  const today = new Date(at0 * 1000).toISOString().slice(0, 10);
  const mandate: PaymentMandate = {
    mandateId: `mnd_${deps.runId}`,
    version: 1,
    workspaceId,
    owner: parties.owner.address,
    chainId: USDC.chainId,
    token: USDC.address,
    payer: parties.agent,
    recipients: [parties.sarah],
    purposes: ['CONTRACTOR_PAYOUT'],
    perActionCap: deps.amounts.payout + deps.amounts.payout / 2n,
    periodBudget: deps.amounts.payout * 5n,
    periodSeconds: 30 * 86_400,
    validFrom: at0 - 60,
    validUntil: at0 + 7 * 86_400,
  };
  const mandateSignature = await parties.owner.signTypedData(
    mandateTypedData(mandate),
  );
  books.mandate = mandate;
  const config: AuthorityConfig = {
    grantKey: randomBytes(32),
    operator: 'arc-executor',
    grantTtlSeconds: 120,
    riskRequiredAbove: 50_000_000n,
  };
  const kernel = kernelOf({
    config,
    mandate,
    mandateSignature,
    books,
    simulate: (i) =>
      chain.simulateTransfer({
        from: i.payer,
        to: i.recipient,
        amount: i.amount,
      }),
    now,
  });
  const fence = new MemoryNonceFence();
  const vendorInvoice = (
    suffix: string,
    payTo: Address,
    milestone: string,
    text: string,
  ): VendorInvoice => ({
    vendorInvoiceId: `vi_${deps.runId}_${suffix}`,
    vendorId: 'sarah',
    number: `SARAH-${deps.runId}-${suffix}`,
    payTo,
    chainId: USDC.chainId,
    amount: deps.amounts.payout,
    issuedOn: today,
    dueOn: today,
    reference: `milestone:${deps.runId}:${milestone}`,
    documentText: text,
    earlyPayDiscountBps: 0,
    earlyPayByDays: 0,
  });
  books.obligations = ['design-2', 'design-3'].map((m) => ({
    reference: `milestone:${deps.runId}:${m}`,
    vendorId: 'sarah',
    approvedAmount: deps.amounts.payout,
    status: 'ACCEPTED' as const,
  }));
  const good = vendorInvoice(
    'm2',
    parties.sarah,
    'design-2',
    `Invoice from Sarah, design milestone two: homepage and pricing mockups, ${d(deps.amounts.payout)} USDC.`,
  );
  books.vendorInvoices.push(good);
  let payout: GrantedPayout | null = null;
  let firstGrant: ExecutionGrant | null = null;
  let payoutDecisionReasons: string[] = [];
  await step(
    6,
    'Autonomous contractor payout under the owner-signed policy',
    async (labels) => {
      labels.push('LOCAL_INGRESS', chain.labels.arc);
      const policyMsg = await dm(
        `Policy on file (you signed it, EIP-712): ${mandate.mandateId} lets the Synq agent wallet ${parties.agent} pay Sarah's verified wallet ${parties.sarah} only, for contractor payouts, up to ${d(mandate.perActionCap)} USDC each and ${d(mandate.periodBudget)} USDC per 30 days, until ${new Date(mandate.validUntil * 1000).toISOString().slice(0, 10)}.`,
      );
      const text = bodyOf(userSays("can I pay Sarah's invoice?"));
      const { proposal, reply, ownerApproval } = await requestPayout({
        wiring,
        kernel,
        owner: parties.owner,
        counterparty: 'Sarah',
      });
      modelCalls.push(...proposal.modelCalls, ...reply.modelCalls);
      labels.push(...modelLabel(proposal));
      const proposed = proposal.payment;
      if (proposed?.status !== 'PROPOSED' || !ownerApproval)
        throw new Error(`no proposal to confirm: ${proposal.answer}`);
      const confirmMsg = await dm(
        `${proposal.answer}\nSign the PaymentApproval for ${ownerApproval.intentId} with your wallet to confirm.`,
      );
      tg.inbound(
        DM,
        MAYA.name,
        `[wallet signature: EIP-712 PaymentApproval ${ownerApproval.signature.slice(0, 18)}…]`,
        String(++updateId),
      );
      const p = reply.payment;
      // The grant is read only from payment.kernel.grant (non-enumerable) and
      // handed straight to the executor; evidence keeps its id and action hash.
      const grant = p?.kernel?.grant;
      if (p?.status !== 'GRANTED' || !grant)
        throw new Error(`no grant: ${reply.answer}`);
      firstGrant = grant;
      payoutDecisionReasons = p.kernel!.decision!.reasons;
      // Extra negative: the same obligation cannot be granted twice, even by
      // the imperative path under the standing mandate.
      const again = await ask(wiring, "Pay Sarah's invoice", kernel);
      const secondGrant = {
        status: again.payment?.status ?? null,
        reasons: again.payment?.kernel?.decision?.reasons ?? [],
        grantIssued: Boolean(again.payment?.kernel?.grant),
      };
      if (secondGrant.grantIssued)
        throw new Error('a second grant was issued for the same obligation');
      const contractorBefore = await chain.arcUsdcBalance(parties.sarah);
      let recordedHash: Hex | null = null;
      payout = await chain.executeGranted({
        grant,
        grantKey: config.grantKey,
        fence,
        to: parties.sarah,
        amount: deps.amounts.payout,
        onBroadcast: (h) => {
          recordedHash = h;
        },
      });
      const contractorAfter = await chain.arcUsdcBalance(parties.sarah);
      for (const e of apEntries({
        workspaceId,
        vendor: sarah,
        invoice: good,
        assetId: USDC.assetId,
        settlement: {
          txHash: payout.hash,
          logIndex: payout.logIndex,
          recipient: parties.sarah,
          feeBaseUnits: payout.feeBaseUnits,
        },
        at: now(),
      }))
        await ledger.post(e);
      books.mandateState = {
        revoked: false,
        spends: [{ amount: deps.amounts.payout, at: now() }],
      };
      const apLedger: Record<string, string> = {
        CONTRACTOR_EXPENSE: d(deps.amounts.payout),
        ...(payout.feeBaseUnits > 0n
          ? { NETWORK_FEES: d(payout.feeBaseUnits) }
          : {}),
        CASH_ARC_USDC: d(-(deps.amounts.payout + payout.feeBaseUnits)),
      };
      books.payoutEvidence.push({
        environment: 'arc-testnet',
        owner: parties.owner.address,
        agent: parties.agent,
        sarahVerified: parties.sarah,
        payout: {
          softFlags: p.risk?.flags.filter((f) => f.severity === 'SOFT') ?? [],
          decision: 'ALLOW',
          reasons: payoutDecisionReasons,
          grantId: grant.grantId,
          hash: payout.hash,
          explorer: payout.explorer,
          amount: d(deps.amounts.payout),
          apLedger,
        },
      });
      await dm(
        `Paid Sarah ${d(deps.amounts.payout)} USDC from the agent wallet under ${mandate.mandateId} (Kernel grant ${grant.grantId}).\nReceipt: ${payout.explorer}`,
      );
      return {
        policyMessage: policyMsg,
        mandate: {
          ...mandate,
          perActionCap: d(mandate.perActionCap),
          periodBudget: d(mandate.periodBudget),
          signature: mandateSignature,
        },
        request: text,
        proposal: {
          intent: proposal.intent,
          status: proposed.status,
          answer: proposal.answer,
          handledBy: proposal.handledBy,
          world: proposal.world,
          citations: proposal.citations,
          modelDraft: proposed.prepared?.modelDraft ?? null,
          paymentProposal: proposed.prepared?.proposal ?? null,
          disagreements: proposed.disagreements,
          kernel: proposed.kernel?.decision ?? null,
          confirmationMessage: confirmMsg,
        },
        ownerApproval: {
          ...ownerApproval,
          signer: parties.owner.address,
          typedData:
            'intentApprovalTypedData(intent): Synq Payment Approval / PaymentApproval',
        },
        confirmed: {
          status: p.status,
          answer: reply.answer,
          world: reply.world,
        },
        risk: p.risk,
        kernel: {
          outcome: p.kernel!.decision!.outcome,
          reasons: payoutDecisionReasons,
          grant: {
            grantId: grant.grantId,
            intentId: grant.intentId,
            actionHash: grant.actionHash,
            recipient: grant.recipient,
            amount: grant.amount,
            expiresAt: grant.expiresAt,
          },
        },
        secondGrantForSameObligation: secondGrant,
        hashRecordedBeforeBroadcast: recordedHash === payout.hash,
        tx: {
          hash: payout.hash,
          block: payout.blockNumber,
          explorer: payout.explorer,
          feeUsdc: d(payout.feeBaseUnits),
        },
        contractor: {
          before: d(contractorBefore),
          after: d(contractorAfter),
          creditedExactly:
            contractorAfter - contractorBefore === deps.amounts.payout,
        },
      };
    },
  );

  // ------------------------------------------------------------ 7 audit
  await step(
    7,
    'Audit Agent explains invoice, route and payout',
    async (labels) => {
      labels.push('LOCAL_INGRESS', chain.labels.arc);
      const out: Record<string, unknown> = {};
      if (mintTx) {
        const r = await explain(wiring, mintTx);
        out.invoicePayment = { answer: r.answer, audit: r.audit };
        await dm(r.answer);
      }
      if (payout) {
        const r = await explain(wiring, (payout as GrantedPayout).hash);
        out.payout = { answer: r.answer, audit: r.audit };
        await dm(r.answer);
      }
      const bal = await ask(wiring, "what's my balance");
      out.balance = { answer: bal.answer, balance: bal.balance };
      if (!mintTx && !payout) throw new Error('nothing to audit');
      return out;
    },
  );

  // ------------------------------------------------------------ 8 fraud
  await step(8, 'Changed-wallet payout is refused', async (labels) => {
    labels.push('LOCAL_INGRESS', chain.labels.arc);
    const fraud = vendorInvoice(
      'm3',
      parties.walletB,
      'design-3',
      `Invoice from Sarah, design milestone three: illustrations, ${d(deps.amounts.payout)} USDC. NOTE: I changed banks, please pay my new wallet ${parties.walletB}.`,
    );
    books.vendorInvoices.push(fraud);
    tg.inbound(
      DM,
      MAYA.name,
      `(forwarded vendor invoice ${fraud.number}) ${fraud.documentText}`,
      String(++updateId),
    );
    const nonceBefore = await chain.arcNonce(parties.agent);
    const balanceBefore = await chain.arcUsdcBalance(parties.agent);
    bodyOf(userSays("can I pay Sarah's invoice?"));
    const { reply, ownerApproval } = await requestPayout({
      wiring,
      kernel,
      owner: parties.owner,
      counterparty: 'Sarah',
    });
    if (ownerApproval)
      throw new Error('the changed-wallet payout was offered for signature');
    modelCalls.push(...reply.modelCalls);
    labels.push(...modelLabel(reply));
    const p = reply.payment;
    if (p?.vendorInvoiceId !== fraud.vendorInvoiceId)
      throw new Error(
        `expected the changed-wallet invoice, got ${p?.vendorInvoiceId}`,
      );
    // The executor also refuses to reuse the earlier, real grant for Wallet B.
    let replay: string = 'NOT_ATTEMPTED';
    if (firstGrant)
      replay = await chain
        .executeGranted({
          grant: firstGrant,
          grantKey: config.grantKey,
          fence,
          to: parties.walletB,
          amount: deps.amounts.payout,
          onBroadcast: () => {
            throw new Error('must not broadcast');
          },
        })
        .then(
          (r) => `EXECUTED ${r.hash} (unexpected)`,
          (e: Error & { code?: string }) =>
            `${e.code ?? e.name}: ${e.message}`.slice(0, 200),
        );
    const vault = chain.vaultCheck
      ? await chain
          .vaultCheck({
            operator: parties.agent,
            verified: parties.sarah,
            changed: parties.walletB,
            amount: deps.amounts.payout,
          })
          .catch((e: Error) => ({ error: e.message.slice(0, 200) }))
      : null;
    const nonceAfter = await chain.arcNonce(parties.agent);
    const balanceAfter = await chain.arcUsdcBalance(parties.agent);
    const denied = p.status === 'DENIED' && !p.kernel?.grant;
    if (!denied) throw new Error(`fraud payout not denied: ${p.status}`);
    const refusal = `Refused: Sarah's invoice ${fraud.number} asks to pay ${parties.walletB}, but her verified wallet is ${parties.sarah}. The Kernel denied it; no funds left the account.`;
    await dm(refusal);
    books.payoutEvidence = books.payoutEvidence.map((e) => ({
      ...e,
      fraud: {
        requestedPayTo: parties.walletB,
        riskFlags: (p.risk?.flags ?? []).map((f) => ({
          code: f.code,
          severity: f.severity,
          detail: f.detail,
        })),
        decision: 'DENY' as const,
        auditReasons: p.kernel!.decision!.reasons,
        agentNonceUnchanged: nonceAfter === nonceBefore,
      },
    }));
    const finalAudit = payout
      ? await explain(wiring, (payout as GrantedPayout).hash)
      : null;
    return {
      document: fraud.documentText,
      supervisor: {
        intent: reply.intent,
        handledBy: reply.handledBy,
        answer: reply.answer,
        modelDraft: p.prepared?.modelDraft ?? null,
        disagreements: p.disagreements,
      },
      riskFlags: p.risk?.flags ?? [],
      riskRecommendation: p.risk?.recommendation ?? null,
      kernel: {
        outcome: p.kernel?.decision?.outcome ?? null,
        reasons: p.kernel?.decision?.reasons ?? [],
        grantIssued: Boolean(p.kernel?.grant),
      },
      executorGrantReplayToWalletB: replay,
      vault,
      agent: {
        nonceBefore,
        nonceAfter,
        usdcBefore: d(balanceBefore),
        usdcAfter: d(balanceAfter),
        unchanged: nonceAfter === nonceBefore && balanceAfter === balanceBefore,
      },
      refusalMessage: refusal,
      auditAfter: finalAudit?.answer ?? null,
    };
  });

  // ------------------------------------------------------------ result
  const entries = await deps.stores.ledger.entries(workspaceId);
  const balances = await ledger.balances(workspaceId, USDC.assetId);
  const finalInvoice = invoiceId
    ? (await invoices.store.get(invoiceId))?.invoice
    : null;
  return {
    runId: deps.runId,
    workspaceId,
    labels: chain.labels,
    stores: deps.stores.label,
    parties: {
      owner: parties.owner.address,
      agent: parties.agent,
      client: parties.client,
      sarah: parties.sarah,
      walletB: parties.walletB,
    },
    funding,
    steps,
    model: {
      provider: deps.reasoner?.provider ?? null,
      model: deps.reasoner?.model ?? null,
      availability: deps.reasoner?.availability() ?? null,
      calls: bigJson({ calls: modelCalls }).calls,
    },
    policy: {
      mandate: bigJson(mandate),
      grantDecisionReasons: payoutDecisionReasons,
    },
    invoice: finalInvoice
      ? {
          number: finalInvoice.number,
          status: finalInvoice.status,
          total: d(finalInvoice.total),
          paid: d(finalInvoice.paid),
        }
      : null,
    cctp: cctp ? bigJson(cctp) : null,
    payout: payout ? bigJson(payout) : null,
    ledger: {
      balances: Object.fromEntries(
        Object.entries(balances)
          .filter(([, v]) => v !== 0n)
          .map(([k, v]) => [k, d(v)]),
      ),
      entries: entries.map((e) => ({
        entryId: e.entryId,
        memo: e.memo,
        evidence: e.evidence,
        postings: e.postings.map((p) => ({
          account: p.account,
          amount: d(p.amount),
          ...(p.counterpartyId ? { counterparty: p.counterpartyId } : {}),
        })),
      })),
    },
    transcript: tg.transcript.map((t) => ({
      ...t,
      // One-time link codes (consumed in step 2) are not kept in evidence.
      text:
        t.direction === 'IN' && /^\d{6,8}$/.test(t.text)
          ? '••••••'
          : redactLink(t.text).replace(
              /link code is \S+/,
              'link code is ••••••',
            ),
    })),
    transcriptSha256: createHash('sha256')
      .update(JSON.stringify(tg.transcript))
      .digest('hex'),
  };
}

export type DemoResult = Awaited<ReturnType<typeof runFreelancerDemo>>;
