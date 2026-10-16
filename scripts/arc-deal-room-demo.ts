/**
 * Synq Deal Room: one live run on Arc testnet.
 *
 *   set -a; . ~/.synq/p11.env; set +a     # OPENAI_API_KEY for a LIVE model draft (optional)
 *   node --import tsx scripts/arc-deal-room-demo.ts
 *
 * A client and a freelancer negotiate a tiny project in a Telegram group whose
 * memory is on (consented). `/deal` drafts a versioned agreement from only the
 * messages Synq was permitted to read; the freelancer counteroffers; both
 * parties sign the exact final version (EIP-712, distinct keys); the client's
 * signed mandate + approval lets the Kernel grant the exact escrow `open`; the
 * restricted executor funds SynqMilestoneEscrow on Arc with the signed terms
 * hash. Milestone 1: real GitHub commit evidence + the client's signed
 * attestation release it exactly once (a second release is refused at every
 * layer). Milestone 2: the client disputes; the payer release is refused
 * (Deal Room and chain); the arbiter's signed resolution refunds it to the
 * funder. The books are reconciled with chain balances wallet by wallet.
 *
 * Keys (testnet only, read from files, never printed): ~/.synq/arc-client.key
 * (client), ~/.synq/arc-contractor.key (freelancer), ~/.synq/testnet.key
 * (arbiter: Synq Labs owner). ~/.synq/arc-agent.key is only used as an
 * unrelated third party in refusal simulations (nothing is signed with it).
 *
 * Telegram is NOT live (no Bot API call is made on the real bot): the real
 * TelegramAdapter and ChannelGateway run against a local Bot API transport
 * (LOCAL_INGRESS). Wallet links use test Telegram login proofs (the real
 * verifier) plus real EIP-712 wallet signatures.
 *
 * Postgres: SYNQ_DEALROOM_DEMO_DATABASE_URL or 127.0.0.1:55433/synq_m2_dealroom_demo.
 * Evidence: SYNQ_EVIDENCE_DIR (default /Users/.../synq-v13/bounty-evidence/arc).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import {
  getAddress,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import {
  ChannelGateway,
  ChatContextService,
  MemoryChannelStore,
  MemoryChatContextStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  signTelegramLoginForTest,
  verifyTelegramLogin,
} from '@synq/channels';
import {
  ChannelLinkService,
  MemoryChannelLinkStore,
  channelLinkTypedData,
  type ChannelLinkRecord,
} from '@synq/identity';
import {
  MemoryNonceFence,
  intentApprovalTypedData,
  mandateTypedData,
  type AuthorityConfig,
  type MandateState,
  type PaymentMandate,
  type PaymentPurpose,
} from '@synq/kernel/arc';
import { admitEscrowGrant } from '@synq/kernel/arc-escrow';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import {
  DealRoomService,
  PostgresDealRoomStore,
  acceptsFor,
  attestationTypedData,
  dealDraftPort,
  decimalOf,
  evidenceHashOf,
  fundingMismatches,
  type AttestationKind,
  type ChatDealRequest,
  type DealAsset,
  type Evidence,
  type KernelInputs,
  type Party,
  type Role,
} from '@synq/dealroom';
import {
  OpenAIStructuredReasoner,
  openAIOptionsFromEnv,
} from '@synq/plugin-openai';
import {
  balanceOf,
  connectChain,
  type TransferSigner,
} from '@synq/execution-worker/arc';
import {
  executeEscrowDispute,
  executeEscrowOpen,
  executeEscrowRefund,
  executeEscrowRelease,
  readEscrowDeal,
  simulateEscrow,
  verifyEscrow,
  type EscrowExecution,
} from '@synq/execution-worker/escrow';
import { reconcileWallets } from './lib/freelancer-demo.js';

const runId = randomBytes(4).toString('hex');
let pool: pg.Pool | null = null;
const keyDir = process.env.SYNQ_KEY_DIR ?? `${process.env.HOME}/.synq`;
const load = (f: string) => {
  const k = readFileSync(join(keyDir, f), 'utf8').trim();
  return privateKeyToAccount((k.startsWith('0x') ? k : `0x${k}`) as Hex);
};
const clientKey = load('arc-client.key');
const freelancerKey = load('arc-contractor.key');
const arbiterKey = load('testnet.key');
const thirdParty = load('arc-agent.key').address;
const signerOf = (a: typeof clientKey): TransferSigner => ({
  address: a.address,
  signTransaction: (tx: TransactionSerializableEIP1559 & { chainId: number }) =>
    a.signTransaction(tx),
});

const now = () => Math.floor(Date.now() / 1000);
const USDC = token('arc-testnet', 'USDC');
const ASSET: DealAsset = {
  chainId: USDC.chainId,
  network: USDC.network,
  token: USDC.address,
  symbol: 'USDC',
  decimals: 6,
};
const d6 = (u: bigint) => decimalOf(u, 6);
const evidenceDir =
  process.env.SYNQ_EVIDENCE_DIR ??
  '/Users/kaushikh/Synq/synq-v13/bounty-evidence/arc';
const bigJson = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)),
  );

type Step = {
  n: number;
  title: string;
  labels: string[];
  ok: boolean;
  detail: unknown;
  error?: string;
};
const steps: Step[] = [];
const txs: {
  step: number;
  label: string;
  hash: Hex;
  from: Address;
  block: bigint;
  explorer: string;
}[] = [];
const refusals: {
  step: number;
  what: string;
  layer: string;
  result: string;
}[] = [];
function must(ok: unknown, why: string): asserts ok {
  if (!ok) throw new Error(`invariant failed: ${why}`);
}
async function step(
  n: number,
  title: string,
  labels: string[],
  run: () => Promise<unknown>,
) {
  console.log(`\n=== ${n}. ${title}`);
  try {
    const detail = await run();
    steps.push({ n, title, labels, ok: true, detail: bigJson(detail) });
    console.log(`    ok [${labels.join(', ')}]`);
    return detail;
  } catch (e) {
    steps.push({
      n,
      title,
      labels,
      ok: false,
      detail: null,
      error: String((e as Error).message ?? e),
    });
    console.log(`    FAILED: ${(e as Error).message}`);
    throw e;
  }
}
const refused = async (
  n: number,
  what: string,
  layer: string,
  p: Promise<unknown>,
  expect: RegExp,
) => {
  let result = 'NO_ERROR';
  try {
    const r = await p;
    if (
      r &&
      typeof r === 'object' &&
      'ok' in r &&
      (r as { ok: boolean }).ok === false
    )
      result = (r as unknown as { reason: string }).reason;
    else if (
      r &&
      typeof r === 'object' &&
      'outcome' in r &&
      (r as { outcome: string }).outcome === 'DENY'
    )
      result = `DENY: ${(r as unknown as { reasons: string[] }).reasons.join('; ')}`;
  } catch (e) {
    result =
      `${(e as { code?: string }).code ?? 'ERROR'}: ${(e as Error).message}`.slice(
        0,
        300,
      );
  }
  refusals.push({ step: n, what, layer, result });
  console.log(`    refused (${layer}): ${what} -> ${result}`);
  must(expect.test(result), `${what} was not refused as expected: ${result}`);
  return result;
};
const recordTxs = (n: number, e: EscrowExecution) => {
  for (const t of e.txs) {
    txs.push({
      step: n,
      label: t.label,
      hash: t.hash,
      from: t.from,
      block: t.blockNumber,
      explorer: t.explorer,
    });
    console.log(`    tx ${t.label}: ${t.explorer}`);
  }
};
/**
 * A block that includes every transaction of this run. Public Arc RPC is load
 * balanced, so "latest" may come from a node that lags; balances are read at
 * this explicit block, retried until the serving node has it.
 */
async function settledBlock(chain: Awaited<ReturnType<typeof connectChain>>) {
  const want = txs.reduce((m, t) => (t.block > m ? t.block : m), 0n);
  for (let i = 0; i < 30; i++) {
    const head = await chain.client.getBlockNumber();
    if (head >= want) return head > want ? head : want;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return want;
}
async function balancesAt(
  chain: Awaited<ReturnType<typeof connectChain>>,
  wallets: Record<string, Address>,
  blockNumber: bigint,
) {
  for (let i = 0; ; i++)
    try {
      return Object.fromEntries(
        await Promise.all(
          Object.entries(wallets).map(
            async ([k, a]) =>
              [
                k,
                await chain.client.getBalance({ address: a, blockNumber }),
              ] as const,
          ),
        ),
      );
    } catch (e) {
      if (i >= 10) throw e;
      await new Promise((r) => setTimeout(r, 1000));
    }
}
const record = (e: EscrowExecution) => ({
  escrowDealId: e.escrowDealId,
  txs: e.txs.map((t) => ({
    label: t.label,
    hash: t.hash,
    from: t.from,
    feeWei: t.feeWei,
  })),
  transfers: e.transfers,
});

async function githubCommit(sha: string): Promise<Evidence> {
  const r = await fetch(
    `https://api.github.com/repos/Synq-Labs-Org/synq/commits/${sha}`,
    {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'synq-dealroom-demo',
      },
    },
  );
  must(r.ok, `GitHub commit ${sha} not readable (${r.status})`);
  const body = (await r.json()) as { sha: string; html_url: string };
  must(body.sha === sha, 'GitHub returned another commit');
  return {
    type: 'GITHUB_COMMIT',
    url: body.html_url,
    repo: 'Synq-Labs-Org/synq',
    commitSha: body.sha,
    prNumber: null,
    sha256: null,
    verifiedBy: 'GITHUB_API',
    checkedAt: now(),
  };
}

async function main() {
  const chain = await connectChain('arc-testnet');
  const escrow = await verifyEscrow(chain);
  const wallets = {
    client: clientKey.address,
    freelancer: freelancerKey.address,
    arbiter: arbiterKey.address,
    escrow: getAddress(escrow.address),
  };
  const out: Record<string, unknown> = {
    kind: 'synq-deal-room-demo',
    runId,
    network: {
      chain: 'arc-testnet',
      chainId: chain.profile.chainId,
      explorer: chain.profile.explorer,
    },
    escrow: {
      address: escrow.address,
      codeHash: escrow.codeHash,
      token: escrow.token,
      registryKind: 'SYNQ_MILESTONE_ESCROW',
      contractChanged: false,
    },
    wallets,
  };

  // ------------------------------------------------------------ 0 balances
  const baseline = (await step(
    0,
    'Balances first (no top-up needed unless the client is short)',
    ['LIVE_ARC_TESTNET'],
    async () => {
      const usdc = Object.fromEntries(
        await Promise.all(
          Object.entries(wallets).map(
            async ([k, a]) =>
              [k, (await balanceOf(chain, USDC, a)).baseUnits] as const,
          ),
        ),
      );
      must(
        usdc.client! >= 100_000n,
        `client has ${d6(usdc.client!)} USDC; top up from the owner first`,
      );
      must(
        usdc.freelancer! >= 10_000n && usdc.arbiter! >= 10_000n,
        'freelancer/arbiter need gas',
      );
      const block = await chain.client.getBlockNumber();
      const native = Object.fromEntries(
        await Promise.all(
          Object.entries(wallets).map(
            async ([k, a]) =>
              [
                k,
                await chain.client.getBalance({
                  address: a,
                  blockNumber: block,
                }),
              ] as const,
          ),
        ),
      );
      const nonces = Object.fromEntries(
        await Promise.all(
          Object.entries(wallets).map(
            async ([k, a]) =>
              [
                k,
                await chain.client.getTransactionCount({
                  address: a,
                  blockNumber: block,
                }),
              ] as const,
          ),
        ),
      );
      return {
        block,
        usdc: Object.fromEntries(
          Object.entries(usdc).map(([k, v]) => [k, d6(v)]),
        ),
        native,
        nonces,
      };
    },
  )) as {
    block: bigint;
    native: Record<string, bigint>;
    nonces: Record<string, number>;
  };

  // ------------------------------------------------------------ stores
  pool = new pg.Pool({
    connectionString:
      process.env.SYNQ_DEALROOM_DEMO_DATABASE_URL ??
      'postgresql://postgres@127.0.0.1:55433/synq_m2_dealroom_demo',
    max: 4,
  });
  {
    const admin = new pg.Client({
      connectionString: 'postgresql://postgres@127.0.0.1:55433/postgres',
    });
    if (!process.env.SYNQ_DEALROOM_DEMO_DATABASE_URL) {
      await admin.connect();
      const exists = await admin.query(
        "SELECT 1 FROM pg_database WHERE datname='synq_m2_dealroom_demo'",
      );
      if (!exists.rows.length)
        await admin.query('CREATE DATABASE synq_m2_dealroom_demo');
      await admin.end();
    }
  }
  const store = new PostgresDealRoomStore(pool);
  await store.migrate();
  await migrateFinance(pool);
  const workspaceId = `wsp_dealroom_${runId}`;
  const ledger = new Ledger(new PostgresLedgerStore(pool));
  const service = new DealRoomService(store, {
    now,
    chainName: 'arc-testnet',
    asset: ASSET,
    escrow: escrow.address,
    settings: {
      disputePeriodSeconds: 30 * 86_400,
      refundGraceSeconds: 7 * 86_400,
      offerTtlSeconds: 3 * 86_400,
    },
    books: { ledger, workspaceId },
  });

  // ------------------------------------------------------------ 1 identity
  const TG_TOKEN = '7000000002:LOCAL_INGRESS_dealroom_transport_token';
  const people = {
    CLIENT: { tg: 70_101, name: 'Dana (client)', key: clientKey },
    FREELANCER: { tg: 70_102, name: 'Maya (freelancer)', key: freelancerKey },
    ARBITER: { tg: 70_103, name: 'Synq Labs (arbiter)', key: arbiterKey },
  } as const;
  const linkStore = new MemoryChannelLinkStore();
  let delivered = '';
  const links = new ChannelLinkService(linkStore, {
    verifiers: {
      telegram: (raw, at) => {
        const id = verifyTelegramLogin(raw, TG_TOKEN, at);
        return id ? { channelUserId: id } : null;
      },
    },
    deliverCode: async ({ code }) => {
      delivered = code;
    },
    now,
  });
  const partyOf: Partial<Record<Role, Party>> = {};
  const linkRecords: Record<string, ChannelLinkRecord> = {};
  await step(
    1,
    'Each party links a wallet: Telegram login proof + DM code + EIP-712 wallet signature',
    ['TEST_TELEGRAM_PROOF', 'LOCAL_EIP712'],
    async () => {
      for (const role of ['CLIENT', 'FREELANCER', 'ARBITER'] as const) {
        const p = people[role];
        const challenge = await links.requestLink({
          workspaceId,
          channel: 'telegram',
          channelProof: signTelegramLoginForTest(
            { id: p.tg, first_name: p.name, auth_date: now() },
            TG_TOKEN,
          ),
          wallet: p.key.address,
        });
        const rec = await links.completeLink({
          challengeId: challenge.challengeId,
          channelCode: delivered,
          signature: await p.key.signTypedData(channelLinkTypedData(challenge)),
        });
        linkRecords[role] = rec;
        partyOf[role] = {
          role,
          displayName: p.name,
          principalId: `prn_${role.toLowerCase()}_${runId}`,
          wallet: rec.wallet,
          verification: {
            method: 'CHANNEL_LINK',
            reference: rec.linkId,
            channel: 'telegram',
            channelUserId: rec.channelUserId,
            verifiedAt: rec.linkedAt,
          },
        };
      }
      return Object.fromEntries(
        Object.entries(linkRecords).map(([r, l]) => [
          r,
          {
            linkId: l.linkId,
            wallet: l.wallet,
            channelUserId: l.channelUserId,
          },
        ]),
      );
    },
  );

  // ------------------------------------------------------------ 2 chat + draft
  const CHAT = '-1002040013';
  const GROUP = `grp_dealroom_${runId}`;
  const transcript: {
    dir: 'IN' | 'OUT';
    from: string;
    text: string;
    ref: string;
  }[] = [];
  const tgCalls: string[] = [];
  let mid = 1000;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    tgCalls.push(method);
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe')
      return ok({
        id: 7_000_000_002,
        is_bot: true,
        first_name: 'Synq',
        username: 'asksynqbot',
        can_read_all_group_messages: true,
        supports_guest_queries: true,
      });
    if (method === 'sendMessage') {
      const ref = String(++mid);
      transcript.push({
        dir: 'OUT',
        from: '@asksynqbot',
        text: String(body.text),
        ref,
      });
      return ok({ message_id: Number(ref), date: now() });
    }
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }),
      { status: 404 },
    );
  }) as typeof fetch;
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({ token: TG_TOKEN, fetch: fetchImpl }),
    webhookSecret: 'local_dealroom_webhook_secret_0123',
    limiter: new OutboundLimiter({ perChatIntervalMs: 0, globalIntervalMs: 0 }),
    maxAttempts: 1,
    transport: 'WEBHOOK_SECRET_TOKEN',
  });
  await adapter.init();
  const channelStore = new MemoryChannelStore();
  const k = (...p: string[]) => p.join('\u0000');
  channelStore.groups.set(k('telegram', CHAT), {
    channel: 'telegram',
    externalGroupId: CHAT,
    groupId: GROUP,
    linkedByPrincipalId: partyOf.CLIENT!.principalId,
    linkedAt: now() - 3600,
    status: 'ACTIVE',
  });
  for (const role of ['CLIENT', 'FREELANCER'] as const)
    channelStore.users.set(k('telegram', CHAT, String(people[role].tg)), {
      channel: 'telegram',
      externalGroupId: CHAT,
      externalUserId: String(people[role].tg),
      principalId: partyOf[role]!.principalId,
      linkedAt: now() - 3600,
      status: 'ACTIVE',
      chatAdmin: role === 'CLIENT',
      confirmTokenHash: null,
    });
  const memory = new MemoryChatContextStore();
  const reasonerOpts = openAIOptionsFromEnv(process.env);
  const live =
    reasonerOpts.mode === 'LIVE'
      ? new OpenAIStructuredReasoner(reasonerOpts)
      : null;
  const linkKey = randomBytes(32);
  const portFor = (reasoner: OpenAIStructuredReasoner | null) =>
    dealDraftPort({
      service,
      workspaceId,
      resolveParty: async ({ principalId, role }) => {
        const found = (Object.values(partyOf) as Party[]).find(
          (p) => p.principalId === principalId,
        );
        return found && found.role === role
          ? found
          : found
            ? { ...found, role }
            : null;
      },
      arbiter: partyOf.ARBITER!,
      webBaseUrl: 'https://synq.example',
      linkKey,
      reasoner,
    });
  const draftAttempts: unknown[] = [];
  const gateway = new ChannelGateway({
    store: channelStore,
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: `${chain.profile.explorer}/tx/`,
    now,
    botUsernames: { telegram: 'asksynqbot' },
    brainCooldownSeconds: 0,
    context: new ChatContextService(memory),
    ports: {
      activeMember: async (g, p) =>
        g === GROUP &&
        [partyOf.CLIENT!.principalId, partyOf.FREELANCER!.principalId].includes(
          p,
        )
          ? { memberId: p }
          : null,
      treasury: async () => null,
      mandates: async () => [],
      approvals: async () => [],
      receipts: async () => [],
      deal: async (input: ChatDealRequest) => {
        if (live) {
          const r = await portFor(live)(input).catch((e: Error) => ({
            status: 'REFUSED' as const,
            reason: e.message,
          }));
          draftAttempts.push({
            mode: 'LIVE_MODEL',
            model: live.model,
            result: r.status === 'DRAFTED' ? 'DRAFTED' : r.reason,
          });
          if (r.status === 'DRAFTED') return r;
        }
        const r = await portFor(null)(input);
        draftAttempts.push({
          mode: 'DETERMINISTIC',
          result: r.status === 'DRAFTED' ? 'DRAFTED' : r.reason,
        });
        return r;
      },
    },
  });
  const say = async (role: 'CLIENT' | 'FREELANCER', text: string) => {
    const ref = String(++mid);
    transcript.push({ dir: 'IN', from: people[role].name, text, ref });
    const update = {
      update_id: Number(ref),
      message: {
        message_id: Number(ref),
        date: now(),
        chat: {
          id: Number(CHAT),
          type: 'supergroup',
          title: 'Landing page rebuild',
        },
        from: {
          id: people[role].tg,
          is_bot: false,
          first_name: people[role].name,
        },
        text,
        entities: text.startsWith('/')
          ? [
              {
                type: 'bot_command',
                offset: 0,
                length: text.split(' ')[0]!.length,
              },
            ]
          : [],
      },
    };
    const outcomes = [];
    for (const e of adapter.normalize(update, 'WEBHOOK_SECRET_TOKEN'))
      outcomes.push(await gateway.handle(e));
    return { ref, outcomes };
  };
  const dealId = await step(
    2,
    'Consented chat memory, then /deal drafts from authorized messages only',
    ['LOCAL_INGRESS', live ? 'LIVE_MODEL' : 'DETERMINISTIC_DRAFT', 'POSTGRES'],
    async () => {
      const policy = await memory.enroll({
        channel: 'telegram',
        externalGroupId: CHAT,
        groupId: GROUP,
        retentionSeconds: 7 * 86_400,
        purpose: 'GROUP_FINANCIAL_PROPOSALS',
        visibility: 'ALL_MESSAGES',
        enrolledByPrincipalId: partyOf.CLIENT!.principalId,
        enrolledAt: now(),
      });
      // Said before the memory notice was posted: Synq never keeps it.
      const early = await say(
        'FREELANCER',
        'Off the record: I once quoted 5 USDC total for a page like this.',
      );
      await memory.markDisclosed('telegram', CHAT, policy.version, now());
      for (const role of ['CLIENT', 'FREELANCER'] as const)
        await memory.grantConsent({
          channel: 'telegram',
          externalGroupId: CHAT,
          externalUserId: String(people[role].tg),
          principalId: partyOf[role]!.principalId,
          policyVersion: policy.version,
          consentedAt: now(),
        });
      await new Promise((r) => setTimeout(r, 1100));
      const m1 = await say(
        'CLIENT',
        'We need the Synq landing page rebuilt: hero section, pricing table and docs links.',
      );
      const m2 = await say(
        'FREELANCER',
        'Happy to. 0.03 USDC total: 0.01 USDC when the hero section PR is merged, 0.02 USDC on final delivery of pricing and docs.',
      );
      const m3 = await say(
        'CLIENT',
        'Deal. Hero within 7 days, the rest within 14 days. Synq Labs arbitrates if we disagree.',
      );
      const stored = await memory.messages('telegram', CHAT, now(), 50);
      must(
        !stored.some((m) => m.messageId === early.ref),
        'pre-disclosure message was stored',
      );
      const cmd = await say('CLIENT', '/deal landing page rebuild');
      must(
        cmd.outcomes[0]?.code === 'DEAL_DRAFTED',
        `deal not drafted: ${cmd.outcomes[0]?.code} ${JSON.stringify(draftAttempts)}`,
      );
      const card = transcript.filter((t) => t.dir === 'OUT').at(-1)!;
      const id = /Deal draft (deal_[0-9a-f]+)/.exec(card.text)![1]!;
      const view = await service.view(id);
      const cited = [
        ...new Set(
          Object.values(view.current.provenance)
            .flat()
            .filter((p) => p.kind === 'ORIGINAL_MESSAGE')
            .map((p) => (p as { messageId: string }).messageId),
        ),
      ];
      must(!cited.includes(early.ref), 'pre-disclosure message cited');
      must(
        cited.every((c) => [m1.ref, m2.ref, m3.ref, cmd.ref].includes(c)),
        'citation outside the authorized context',
      );
      return {
        dealId: id,
        authorizedMessageIds: Object.keys(view.deal.origin.messages),
        preDisclosureMessage: { id: early.ref, stored: false, cited: false },
        cited,
        draftAttempts,
        termsHash: view.current.termsHash,
        terms: {
          total: d6(view.current.terms.total),
          milestones: view.current.terms.milestones.map((m) => ({
            title: m.title,
            amount: d6(m.amount),
            deadline: m.deadline,
          })),
        },
        provenance: Object.fromEntries(
          Object.entries(view.current.provenance).map(([k2, v]) => [
            k2,
            v.map((p) => p.kind),
          ]),
        ),
        ambiguities: view.current.ambiguities,
        card: card.text,
        telegramMethodsCalled: [...new Set(tgCalls)],
      };
    },
  ).then((d) => (d as { dealId: string }).dealId);

  // ------------------------------------------------------------ 3 negotiate + sign
  await step(
    3,
    'Negotiate: client signs v1, freelancer counteroffers v2, both sign the exact v2',
    ['LOCAL_EIP712', 'POSTGRES'],
    async () => {
      let view = await service.view(dealId);
      const v1 = view.current;
      await service.sign({
        dealId,
        version: 1,
        role: 'CLIENT',
        signature: await clientKey.signTypedData(service.typedData(v1)),
      });
      const terms = {
        ...v1.terms,
        // The freelancer moves milestone 2 out by 3 days, and the parties fix
        // the evidence to a public commit (URL + hash) for both milestones,
        // whatever the draft proposed.
        milestones: v1.terms.milestones.map((m) => ({
          ...m,
          evidenceType: 'GITHUB_COMMIT' as const,
          deadline: m.index === 1 ? m.deadline + 3 * 86_400 : m.deadline,
        })),
      };
      const prep = await service.prepareCounteroffer({
        dealId,
        baseVersion: 1,
        by: 'FREELANCER',
        terms,
      });
      view = await service.counteroffer({
        dealId,
        baseVersion: 1,
        by: 'FREELANCER',
        terms,
        signature: await freelancerKey.signTypedData(prep.typedData),
      });
      must(
        view.deal.status === 'NEGOTIATING',
        'counteroffer did not reopen negotiation',
      );
      const v1ClientSig = acceptsFor(view.signatures, v1).CLIENT!.signature;
      await refused(
        3,
        "client's v1 signature presented for v2 (P13-03)",
        'DEAL_ROOM',
        service.sign({
          dealId,
          version: 2,
          role: 'CLIENT',
          signature: v1ClientSig,
        }),
        /WRONG_SIGNER/,
      );
      await refused(
        3,
        'funding before the client signs v2 (P13-03)',
        'DEAL_ROOM',
        service.fundingCall(dealId),
        /NOT_FULLY_SIGNED/,
      );
      await refused(
        3,
        'third party signs as the client',
        'DEAL_ROOM',
        service.sign({
          dealId,
          version: 2,
          role: 'CLIENT',
          signature: await arbiterKey.signTypedData(
            service.typedData(view.current),
          ),
        }),
        /WRONG_SIGNER/,
      );
      view = await service.sign({
        dealId,
        version: 2,
        role: 'CLIENT',
        signature: await clientKey.signTypedData(
          service.typedData(view.current),
        ),
      });
      must(view.deal.status === 'ACCEPTED', 'not accepted');
      const a = acceptsFor(view.signatures, view.current);
      must(a.CLIENT!.signer !== a.FREELANCER!.signer, 'signers not distinct');
      return {
        v1: v1.termsHash,
        v2: view.current.termsHash,
        parentOfV2: view.current.parentTermsHash,
        signatures: view.signatures.map((s) => ({
          version: s.version,
          role: s.role,
          signer: s.signer,
          decision: s.decision,
          termsHash: s.termsHash,
          signature: s.signature,
        })),
        status: view.deal.status,
        changedTermProvenance: {
          'milestones.1.deadline':
            view.current.provenance['milestones.1.deadline'],
          'milestones.0.evidenceType':
            view.current.provenance['milestones.0.evidenceType'],
          'milestones.0.amount': view.current.provenance['milestones.0.amount'],
        },
      };
    },
  );

  // ------------------------------------------------------------ 4 fund
  const kernelConfig: AuthorityConfig = {
    grantKey: randomBytes(32),
    operator: 'dealroom-executor',
    grantTtlSeconds: 600,
    riskRequiredAbove: 1_000_000n,
  };
  const fence = new MemoryNonceFence();
  const mandate = async (
    owner: typeof clientKey,
    id: string,
    payer: Address,
    recipients: Address[],
    purposes: PaymentPurpose[],
    cap: bigint,
    budget: bigint,
  ) => {
    const m: PaymentMandate = {
      mandateId: `${id}_${runId}`,
      version: 1,
      workspaceId,
      owner: owner.address,
      chainId: USDC.chainId,
      token: USDC.address,
      payer,
      recipients,
      purposes,
      perActionCap: cap,
      periodBudget: budget,
      periodSeconds: 30 * 86_400,
      validFrom: now() - 60,
      validUntil: now() + 30 * 86_400,
    };
    return {
      mandate: m,
      signature: await owner.signTypedData(mandateTypedData(m)),
    };
  };
  const kin = (
    m: Awaited<ReturnType<typeof mandate>>,
    state: MandateState = { revoked: false, spends: [] },
  ): KernelInputs => ({
    config: kernelConfig,
    mandate: m.mandate,
    mandateSignature: m.signature,
    state,
    risk: { flags: [], available: true },
    simulationOk: true,
  });
  let escrowDealId = 0n;
  await step(
    4,
    'Client mandate + approval -> Kernel grant -> executor funds the escrow (P13-04)',
    ['LIVE_ARC_TESTNET', 'LOCAL_EIP712'],
    async () => {
      const view = await service.view(dealId);
      const t = view.current.terms;
      const fm = await mandate(
        clientKey,
        'mnd_fund',
        clientKey.address,
        [escrow.address],
        ['ESCROW_FUNDING'],
        t.total,
        t.total,
      );
      const first = await service.authorizeFunding(dealId, {
        ...kin(fm),
        requireOwnerApproval: true,
      });
      must(
        first.decision.outcome === 'REQUIRE_OWNER_APPROVAL',
        `expected approval request, got ${first.decision.outcome}`,
      );
      // The client approves exactly this intent (its id is the escrow call hash) in its wallet.
      const terms = first.decision.approval;
      const approval = {
        ...terms,
        signature: await clientKey.signTypedData(
          intentApprovalTypedData(first.intent, terms),
        ),
      };
      const auth = await service.authorizeFunding(dealId, {
        ...kin(fm),
        requireOwnerApproval: true,
        ownerApproval: approval,
      });
      must(
        auth.decision.outcome === 'ALLOW',
        `funding not granted: ${'reasons' in auth.decision ? auth.decision.reasons.join(';') : ''}`,
      );
      const grant = auth.decision.grant;
      // The grant names the exact call: a changed split is refused before signing.
      await refused(
        4,
        'executor given a different milestone split under the same grant',
        'EXECUTOR',
        admitEscrowGrant({
          grantKey: kernelConfig.grantKey,
          grant,
          call: { ...auth.call, amounts: [20_000n, 10_000n] },
          now: now(),
          mandateRevoked: false,
          fence: new MemoryNonceFence(),
        }),
        /GRANT_MISMATCH/,
      );
      let exec: EscrowExecution;
      try {
        exec = await executeEscrowOpen({
          chain,
          signer: signerOf(clientKey),
          call: auth.call,
          grant,
          grantKey: kernelConfig.grantKey,
          fence,
          mandateRevoked: false,
          now: now(),
        });
      } catch (e) {
        await service.fundingFailed(dealId, (e as Error).message);
        throw e;
      }
      recordTxs(4, exec);
      escrowDealId = exec.escrowDealId;
      const chainDeal = await readEscrowDeal(
        chain,
        escrow.address,
        exec.escrowDealId,
      );
      const facts = {
        token: escrow.token,
        payer: chainDeal.payer,
        payee: chainDeal.payee,
        arbiter: chainDeal.arbiter,
        refundAfter: chainDeal.refundAfter,
        termsHash: chainDeal.termsHash,
        milestones: chainDeal.milestones,
      };
      const mismatches = fundingMismatches(
        t,
        view.current.termsHash,
        facts,
        record(exec),
      );
      must(mismatches.length === 0, mismatches.join('; '));
      const funded = await service.recordFunded({
        dealId,
        execution: record(exec),
        chain: facts,
      });
      must(funded.deal.status === 'FUNDED', 'not funded');
      await refused(
        4,
        'replaying the funding grant',
        'EXECUTOR',
        admitEscrowGrant({
          grantKey: kernelConfig.grantKey,
          grant,
          call: auth.call,
          now: now(),
          mandateRevoked: false,
          fence,
        }),
        /GRANT_REPLAYED/,
      );
      return {
        mandate: {
          id: fm.mandate.mandateId,
          owner: fm.mandate.owner,
          signature: fm.signature,
        },
        ownerApproval: {
          nonce: approval.nonce,
          deadline: approval.deadline,
          signature: approval.signature,
        },
        grant: {
          grantId: grant.grantId,
          intentId: grant.intentId,
          actionHash: grant.actionHash,
        },
        escrowDealId: exec.escrowDealId,
        onChain: {
          ...facts,
          milestones: facts.milestones.map((m) => ({
            amount: d6(m.amount),
            status: m.status,
          })),
        },
        agreement: {
          asset: t.asset.token,
          total: d6(t.total),
          amounts: t.milestones.map((m) => d6(m.amount)),
          termsHash: view.current.termsHash,
        },
        p13_04: {
          assetMatches:
            facts.token.toLowerCase() === t.asset.token.toLowerCase(),
          termsHashMatches:
            facts.termsHash.toLowerCase() === view.current.termsHash,
          fundedExactly: exec.transfers.map((x) => ({
            from: x.from,
            to: x.to,
            value: d6(x.value),
          })),
          mismatches,
        },
      };
    },
  );

  // ------------------------------------------------------------ 5 milestone 1
  const nonce = () => `0x${randomBytes(32).toString('hex')}` as Hex;
  const attest = async (
    milestone: number,
    kind: AttestationKind,
    role: Role,
    evidence: Evidence | null,
    by: typeof clientKey,
  ) => {
    const v = (await service.view(dealId)).current;
    const n = nonce();
    const deadline = now() + 3_600;
    const signature = await by.signTypedData(
      attestationTypedData({
        chainId: v.terms.asset.chainId,
        escrow: v.terms.escrow,
        dealId,
        version: v.version,
        termsHash: v.termsHash,
        milestone,
        kind,
        role,
        evidenceHash: evidenceHashOf(evidence),
        nonce: n,
        deadline,
      }),
    );
    const input = {
      dealId,
      milestone,
      kind,
      role,
      evidence,
      nonce: n,
      deadline,
      signature,
    };
    const view = await service.attest(input);
    return { input, view, signature };
  };
  const COMMIT_1 = 'fbe3136afb520947ec01737b6373dcc4e6a06bdb';
  await step(
    5,
    'Milestone 1: GitHub commit evidence + client attestation -> release exactly once (P13-05)',
    ['LIVE_ARC_TESTNET', 'LIVE_GITHUB_API', 'LOCAL_EIP712'],
    async () => {
      const evidence = await githubCommit(COMMIT_1);
      const delivered = await attest(
        0,
        'DELIVERED',
        'FREELANCER',
        evidence,
        freelancerKey,
      );
      await refused(
        5,
        'release on evidence alone (no client attestation)',
        'DEAL_ROOM',
        service.releaseCall(dealId, 0),
        /WRONG_STATE/,
      );
      const accepted = await attest(
        0,
        'ACCEPT_RELEASE',
        'CLIENT',
        evidence,
        clientKey,
      );
      await refused(
        5,
        'the same signed attestation replayed',
        'DEAL_ROOM',
        service.attest(accepted.input),
        /WRONG_STATE|REPLAYED/,
      );
      const rm = await mandate(
        clientKey,
        'mnd_release',
        escrow.address,
        [freelancerKey.address],
        ['ESCROW_RELEASE'],
        20_000n,
        30_000n,
      );
      const auth = await service.authorizeRelease(dealId, 0, kin(rm));
      must(auth.decision.outcome === 'ALLOW', 'release not granted');
      const exec = await executeEscrowRelease({
        chain,
        signer: signerOf(clientKey),
        call: auth.call,
        grant: auth.decision.grant,
        grantKey: kernelConfig.grantKey,
        fence,
        mandateRevoked: false,
        now: now(),
      });
      recordTxs(5, exec);
      const after = await service.recordReleased({
        dealId,
        milestone: 0,
        execution: record(exec),
      });
      must(
        after.deal.milestones[0]!.status === 'SETTLED',
        'milestone 1 not settled',
      );
      // A second release, at every layer.
      await refused(
        5,
        'second release requested from the Deal Room',
        'DEAL_ROOM',
        service.releaseCall(dealId, 0),
        /WRONG_STATE/,
      );
      await refused(
        5,
        'release grant replayed at the executor',
        'EXECUTOR',
        admitEscrowGrant({
          grantKey: kernelConfig.grantKey,
          grant: auth.decision.grant,
          call: auth.call,
          now: now(),
          mandateRevoked: false,
          fence,
        }),
        /GRANT_REPLAYED/,
      );
      await refused(
        5,
        'second grant for the same milestone',
        'KERNEL',
        service
          .authorize(
            auth.call,
            {
              obligationRef: `deal:${dealId}:m0:release`,
              evidenceHash: delivered.view.deal.milestones[0]!.evidenceHash!,
              proposedBy: 'replay',
            },
            kin(rm, {
              revoked: false,
              spends: [{ amount: 10_000n, at: now() }],
              settledObligations: [`deal:${dealId}:m0:release`],
            }),
          )
          .then((r) => r.decision),
        /DENY/,
      );
      await refused(
        5,
        'client calls release(m1) again on chain (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(chain, clientKey.address, 'release', escrowDealId, 0),
        /WrongStatus\(3\)/,
      );
      await refused(
        5,
        'payee withdraws m1 twice on chain (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(
          chain,
          freelancerKey.address,
          'withdraw',
          escrowDealId,
          0,
        ),
        /WrongStatus\(3\)/,
      );
      return {
        evidence,
        evidenceHash: evidenceHashOf(evidence),
        deliveredBy: delivered.input.signature,
        acceptedBy: accepted.signature,
        grantId: auth.decision.grant.grantId,
        txs: exec.txs.map((t) => t.hash),
        paid: exec.transfers.map((x) => ({
          from: x.from,
          to: x.to,
          value: d6(x.value),
        })),
      };
    },
  );

  // ------------------------------------------------------------ 6 milestone 2 dispute
  const COMMIT_2 = (
    (await (
      await fetch(
        'https://api.github.com/repos/Synq-Labs-Org/synq/commits?per_page=2',
        { headers: { 'user-agent': 'synq-dealroom-demo' } },
      )
    ).json()) as { sha: string }[]
  )[1]!.sha;
  await step(
    6,
    'Milestone 2: delivered, client disputes -> automatic (payer) release refused (P13-06)',
    ['LIVE_ARC_TESTNET', 'LIVE_GITHUB_API', 'LOCAL_EIP712'],
    async () => {
      const evidence = await githubCommit(COMMIT_2);
      await attest(1, 'DELIVERED', 'FREELANCER', evidence, freelancerKey);
      const disputed = await attest(1, 'DISPUTE', 'CLIENT', null, clientKey);
      must(disputed.view.deal.status === 'DISPUTED', 'not disputed');
      const exec = await executeEscrowDispute({
        chain,
        signer: signerOf(clientKey),
        escrowDealId,
      });
      recordTxs(6, exec);
      await service.recordDispute({ dealId, execution: record(exec) });
      await refused(
        6,
        'release of the disputed milestone',
        'DEAL_ROOM',
        service.releaseCall(dealId, 1),
        /MILESTONE_DISPUTED/,
      );
      await refused(
        6,
        'client accepts its way out of the dispute',
        'DEAL_ROOM',
        attest(1, 'ACCEPT_RELEASE', 'CLIENT', evidence, clientKey),
        /WRONG_STATE/,
      );
      await refused(
        6,
        'payer release(m2) on chain while disputed (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(chain, clientKey.address, 'release', escrowDealId, 1),
        /DealDisputed/,
      );
      await refused(
        6,
        'third-party timeout refund while disputed (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(chain, thirdParty, 'refund', escrowDealId, 1),
        /RefundNotYetAllowed|DealDisputed/,
      );
      const state = await readEscrowDeal(chain, escrow.address, escrowDealId);
      must(
        state.disputeActive && state.milestones[1]!.status === 'Funded',
        'milestone 2 not held',
      );
      return {
        evidence,
        disputeTx: exec.txs[0]!.hash,
        onChain: {
          disputeActive: state.disputeActive,
          disputedBy: state.disputedBy,
          disputeDeadline: state.disputeDeadline,
          milestones: state.milestones.map((m) => ({
            amount: d6(m.amount),
            status: m.status,
          })),
        },
      };
    },
  );

  // ------------------------------------------------------------ 7 arbiter refund
  await step(
    7,
    "Arbiter's signed resolution refunds milestone 2 to the funder (P13-07)",
    ['LIVE_ARC_TESTNET', 'LOCAL_EIP712'],
    async () => {
      await refused(
        7,
        'client signs an arbiter refund',
        'DEAL_ROOM',
        attest(1, 'ARBITER_REFUND', 'ARBITER', null, clientKey),
        /WRONG_SIGNER/,
      );
      const resolved = await attest(
        1,
        'ARBITER_REFUND',
        'ARBITER',
        null,
        arbiterKey,
      );
      const xm = await mandate(
        arbiterKey,
        'mnd_arbiter',
        escrow.address,
        [clientKey.address],
        ['ESCROW_REFUND'],
        20_000n,
        30_000n,
      );
      const auth = await service.authorizeRefund(dealId, 1, kin(xm));
      must(auth.decision.outcome === 'ALLOW', 'refund not granted');
      await refused(
        7,
        'refund grant redirected to the freelancer',
        'EXECUTOR',
        admitEscrowGrant({
          grantKey: kernelConfig.grantKey,
          grant: auth.decision.grant,
          call: { ...auth.call, funder: freelancerKey.address },
          now: now(),
          mandateRevoked: false,
          fence: new MemoryNonceFence(),
        }),
        /GRANT_MISMATCH/,
      );
      const wrongM = await mandate(
        arbiterKey,
        'mnd_arbiter_wrong',
        escrow.address,
        [freelancerKey.address],
        ['ESCROW_REFUND'],
        20_000n,
        30_000n,
      );
      await refused(
        7,
        'refund mandate that pays the freelancer',
        'KERNEL',
        service.authorizeRefund(dealId, 1, kin(wrongM)).then((r) => r.decision),
        /DENY/,
      );
      const exec = await executeEscrowRefund({
        chain,
        signer: signerOf(arbiterKey),
        call: auth.call,
        grant: auth.decision.grant,
        grantKey: kernelConfig.grantKey,
        fence,
        mandateRevoked: false,
        now: now(),
      });
      recordTxs(7, exec);
      const after = await service.recordRefunded({
        dealId,
        milestone: 1,
        execution: record(exec),
      });
      await refused(
        7,
        'refund(m2) again on chain (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(chain, arbiterKey.address, 'refund', escrowDealId, 1),
        /WrongStatus\(4\)/,
      );
      await refused(
        7,
        'release(m2) after refund by the arbiter (eth_call)',
        'ARC_ESCROW',
        simulateEscrow(chain, arbiterKey.address, 'release', escrowDealId, 1),
        /WrongStatus\(4\)/,
      );
      const state = await readEscrowDeal(chain, escrow.address, escrowDealId);
      return {
        arbiterAttestation: resolved.signature,
        refunded: exec.transfers.map((x) => ({
          from: x.from,
          to: x.to,
          value: d6(x.value),
        })),
        dealStatus: after.deal.status,
        milestoneStates: after.deal.milestones.map((m) => m.status),
        onChain: state.milestones.map((m) => ({
          amount: d6(m.amount),
          status: m.status,
        })),
      };
    },
  );

  // ------------------------------------------------------------ 8 reconcile
  await step(
    8,
    'Books reconcile with chain balances, wallet by wallet, to the wei',
    ['LIVE_ARC_TESTNET', 'POSTGRES'],
    async () => {
      const block = await settledBlock(chain);
      const after = await balancesAt(chain, wallets, block);
      const nonces = Object.fromEntries(
        await Promise.all(
          Object.entries(wallets).map(
            async ([k2, a]) =>
              [
                k2,
                await chain.client.getTransactionCount({
                  address: a,
                  blockNumber: block,
                }),
              ] as const,
          ),
        ),
      );
      const ours = {
        client: txs.filter((t) => t.from === clientKey.address).length,
        freelancer: 0,
        arbiter: txs.filter((t) => t.from === arbiterKey.address).length,
        escrow: 0,
      };
      const concurrent = Object.entries(ours)
        .filter(([k2, n]) => nonces[k2]! - baseline.nonces[k2]! !== n)
        .map(([k2]) => k2);
      const entries = await ledger.store.entries(workspaceId);
      const rec = reconcileWallets({
        wallets,
        before: baseline.native,
        after,
        entries,
      });
      const bal = await ledger.balances(workspaceId, USDC.assetId);
      must(
        rec.status === 'RECONCILED',
        `${rec.detail}${concurrent.length ? ` (other activity on: ${concurrent.join(',')})` : ''}`,
      );
      return {
        fromBlock: baseline.block,
        toBlock: block,
        ...rec,
        nonceCheck: { ours, concurrentActivity: concurrent },
        ledgerBalances: Object.fromEntries(
          Object.entries(bal).filter(([, v]) => v !== 0n),
        ),
        entries: entries.length,
      };
    },
  );

  const final = await service.view(dealId);
  out.deal = {
    dealId,
    status: final.deal.status,
    versions: final.versions.map((v) => ({
      version: v.version,
      termsHash: v.termsHash,
      parent: v.parentTermsHash,
      proposedBy: v.proposedBy,
    })),
    milestones: final.deal.milestones,
    escrow: final.deal.escrow,
    transitions: final.transitions.map((t) => ({
      kind: t.kind,
      from: t.from,
      to: t.to,
      actor: t.actor,
    })),
    provenance: Object.fromEntries(
      Object.entries(service.provenance(final)).map(([k2, v]) => [
        k2,
        v.map((p) => p.kind),
      ]),
    ),
  };
  out.transcript = transcript;
  return out;
}

/**
 * `--cancel-deal <dealId>`: the payee cancels every still-funded milestone of
 * a funded deal (signed CANCEL_REFUND), and the Kernel-granted refunds return
 * the funds to the funder named in the signed terms (P13-07, live).
 */
async function cancelMode(dealId: string) {
  evidencePrefix = 'deal-room-cancel';
  const chain = await connectChain('arc-testnet');
  const escrow = await verifyEscrow(chain);
  pool = new pg.Pool({
    connectionString:
      process.env.SYNQ_DEALROOM_DEMO_DATABASE_URL ??
      'postgresql://postgres@127.0.0.1:55433/synq_m2_dealroom_demo',
    max: 4,
  });
  const store = new PostgresDealRoomStore(pool);
  const head = await store.get(dealId);
  must(head?.escrow, `deal ${dealId} is not funded`);
  const ledger = new Ledger(new PostgresLedgerStore(pool));
  const service = new DealRoomService(store, {
    now,
    chainName: 'arc-testnet',
    asset: ASSET,
    escrow: escrow.address,
    settings: {
      disputePeriodSeconds: 30 * 86_400,
      refundGraceSeconds: 7 * 86_400,
      offerTtlSeconds: 3 * 86_400,
    },
    books: { ledger, workspaceId: head.workspaceId },
  });
  const view0 = await service.view(dealId);
  const t = view0.current.terms;
  must(
    t.freelancer.wallet === freelancerKey.address &&
      t.client.wallet === clientKey.address,
    'keys do not match the signed parties',
  );
  const wallets = {
    client: clientKey.address,
    freelancer: freelancerKey.address,
    escrow: getAddress(escrow.address),
  };
  const block0 = await chain.client.getBlockNumber();
  const before = Object.fromEntries(
    await Promise.all(
      Object.entries(wallets).map(
        async ([k, a]) =>
          [
            k,
            await chain.client.getBalance({ address: a, blockNumber: block0 }),
          ] as const,
      ),
    ),
  );
  const entries0 = new Set(
    (await ledger.store.entries(head.workspaceId)).map((e) => e.entryId),
  );
  const escrowDealId = BigInt(head.escrow.escrowDealId);
  const kernelConfig: AuthorityConfig = {
    grantKey: randomBytes(32),
    operator: 'dealroom-executor',
    grantTtlSeconds: 600,
    riskRequiredAbove: 1_000_000n,
  };
  const fence = new MemoryNonceFence();
  const m: PaymentMandate = {
    mandateId: `mnd_cancel_${runId}`,
    version: 1,
    workspaceId: head.workspaceId,
    owner: freelancerKey.address,
    chainId: USDC.chainId,
    token: USDC.address,
    payer: escrow.address,
    recipients: [clientKey.address],
    purposes: ['ESCROW_REFUND'],
    perActionCap: t.total,
    periodBudget: t.total,
    periodSeconds: 30 * 86_400,
    validFrom: now() - 60,
    validUntil: now() + 86_400,
  };
  const k: KernelInputs = {
    config: kernelConfig,
    mandate: m,
    mandateSignature: await freelancerKey.signTypedData(mandateTypedData(m)),
    state: { revoked: false, spends: [] },
    risk: { flags: [], available: true },
    simulationOk: true,
  };
  const out: Record<string, unknown> = {
    kind: 'synq-deal-room-cancel',
    runId,
    dealId,
    escrowDealId,
    termsHash: view0.current.termsHash,
  };
  await step(
    1,
    'Payee cancels each funded milestone; refunds go to the funder in the signed terms (P13-07)',
    ['LIVE_ARC_TESTNET', 'LOCAL_EIP712'],
    async () => {
      const done = [];
      for (const ms of view0.deal.milestones.filter(
        (x) => x.status === 'FUNDED',
      )) {
        const v = (await service.view(dealId)).current;
        const n = `0x${randomBytes(32).toString('hex')}` as Hex;
        const deadline = now() + 3_600;
        const sig = await freelancerKey.signTypedData(
          attestationTypedData({
            chainId: v.terms.asset.chainId,
            escrow: v.terms.escrow,
            dealId,
            version: v.version,
            termsHash: v.termsHash,
            milestone: ms.index,
            kind: 'CANCEL_REFUND',
            role: 'FREELANCER',
            evidenceHash: evidenceHashOf(null),
            nonce: n,
            deadline,
          }),
        );
        await service.attest({
          dealId,
          milestone: ms.index,
          kind: 'CANCEL_REFUND',
          role: 'FREELANCER',
          evidence: null,
          nonce: n,
          deadline,
          signature: sig,
        });
        const auth = await service.authorizeRefund(dealId, ms.index, k);
        must(auth.decision.outcome === 'ALLOW', 'refund not granted');
        must(
          auth.call.funder === clientKey.address,
          'refund not to the funder',
        );
        await refused(
          1,
          `refund of m${ms.index + 1} redirected to the payee`,
          'EXECUTOR',
          admitEscrowGrant({
            grantKey: kernelConfig.grantKey,
            grant: auth.decision.grant,
            call: { ...auth.call, funder: freelancerKey.address },
            now: now(),
            mandateRevoked: false,
            fence: new MemoryNonceFence(),
          }),
          /GRANT_MISMATCH/,
        );
        const exec = await executeEscrowRefund({
          chain,
          signer: signerOf(freelancerKey),
          call: auth.call,
          grant: auth.decision.grant,
          grantKey: kernelConfig.grantKey,
          fence,
          mandateRevoked: false,
          now: now(),
        });
        recordTxs(1, exec);
        await service.recordRefunded({
          dealId,
          milestone: ms.index,
          execution: record(exec),
        });
        done.push({
          milestone: ms.index,
          refunded: exec.transfers.map((x) => ({
            from: x.from,
            to: x.to,
            value: d6(x.value),
          })),
          tx: exec.txs[0]!.hash,
        });
      }
      const state = await readEscrowDeal(chain, escrow.address, escrowDealId);
      const view = await service.view(dealId);
      return {
        done,
        dealStatus: view.deal.status,
        onChain: state.milestones.map((x) => ({
          amount: d6(x.amount),
          status: x.status,
        })),
      };
    },
  );
  await step(
    2,
    'Books reconcile with chain balances for this run, to the wei',
    ['LIVE_ARC_TESTNET', 'POSTGRES'],
    async () => {
      const block = await settledBlock(chain);
      const after = await balancesAt(chain, wallets, block);
      const entries = (await ledger.store.entries(head.workspaceId)).filter(
        (e) => !entries0.has(e.entryId),
      );
      const rec = reconcileWallets({ wallets, before, after, entries });
      must(rec.status === 'RECONCILED', rec.detail);
      return {
        fromBlock: block0,
        toBlock: block,
        ...rec,
        entries: entries.length,
      };
    },
  );
  return out;
}

let evidencePrefix = 'deal-room';
const started = new Date().toISOString();
const cancelArg = process.argv.indexOf('--cancel-deal');
(cancelArg > 0 ? cancelMode(process.argv[cancelArg + 1]!) : main())
  .then((out) => finish(out, true))
  .catch((e) => finish({ error: String((e as Error).stack ?? e) }, false));

function finish(out: Record<string, unknown>, ok: boolean) {
  const firstTx =
    txs.find((t) => t.label === 'escrow open')?.hash ??
    txs.find((t) => t.label.startsWith('escrow refund'))?.hash ??
    txs[0]?.hash ??
    `0x${runId}`;
  const short = firstTx.slice(2, 10);
  const evidence = bigJson({
    ...out,
    label: ok ? 'LIVE_ARC_TESTNET' : 'FAILED_RUN',
    labels: {
      chain: 'LIVE_ARC_TESTNET (every tx hash below is on Arc testnet 5042002)',
      telegram:
        'LOCAL_INGRESS (real TelegramAdapter + ChannelGateway, local Bot API transport; the live bot was not called)',
      walletLinks: 'TEST_TELEGRAM_PROOF + real EIP-712 wallet signatures',
      signatures:
        'LOCAL_EIP712 (each party signs with its own key, as its wallet does on /deal/[id])',
      github: 'LIVE_GITHUB_API (public commits of Synq-Labs-Org/synq)',
      postgres: 'LOCAL Postgres 14 (synq_m2_dealroom_demo)',
    },
    startedAt: started,
    finishedAt: new Date().toISOString(),
    ok,
    steps,
    txs,
    refusals,
    gate:
      ok && evidencePrefix === 'deal-room'
        ? {
            distinctSignatures: true,
            fundedTestnetEscrow: true,
            acceptedMilestoneReleasedOnce: true,
            disputedMilestoneHeld: true,
            refundToFunder: true,
          }
        : null,
  });
  mkdirSync(evidenceDir, { recursive: true });
  const file = join(evidenceDir, `${evidencePrefix}-${short}.json`);
  writeFileSync(file, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nEvidence: ${file}`);
  if (!ok) {
    console.error(out.error);
    process.exitCode = 1;
  }
  void pool?.end().catch(() => undefined);
}
