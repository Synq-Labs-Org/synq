import { describe, expect, it } from 'vitest';
import { keccak256, zeroAddress, type Address } from 'viem';
import {
  ChannelGateway,
  MemoryChannelStore,
  OutboundLimiter,
  TelegramAdapter,
  TelegramBotApi,
  type ChannelPorts,
} from '@synq/channels';
import {
  ArcCashIndexer,
  ArcChainIndexer,
  Ledger,
  MemoryArcIndexStore,
  MemoryLedgerStore,
  type ArcIndexerConfig,
  type IndexedEvent,
  type IndexerChain,
} from '@synq/ledger';
import { token } from '@synq/chain-registry/arc';
import { searchOffers } from '@synq/offer-exchange';
import {
  MemoryRecourseStore,
  MemoryReservationStore,
  RecourseReconciler,
} from '@synq/settlement';
import { money } from '@synq/domain';
import { connectChain } from '@synq/execution-worker/arc';
import {
  MemoryOutboxStore,
  payOnce,
  recover,
} from '@synq/execution-worker/arc-outbox';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  FakeProvider,
  NOW as OFFER_NOW,
  capability,
  graphOf,
  hang,
  intent,
  offer,
} from '../offer-exchange/fixtures.js';
import { AUSD, T0, req } from '../settlement/reservation-scenarios.js';
import {
  TOKEN,
  TOKEN_CODE,
  forkableChain,
} from '../durable/fake-indexer-chain.js';
import { countingSigner, fakeArc } from '../durable/fake-arc.js';

/**
 * Cross-cutting LOAD rows (X-LOA-*). Each test drives the real package code
 * at volume; the 100k ballot (X-LOA-01) lives in
 * tests/governance/p23-voter-scale.test.ts and the Postgres contention cases
 * in tests/cross-cutting/funds-load.integration.test.ts.
 */

const BOT_TOKEN = '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef';
const SECRET = 'webhook_secret_0123456789';
const NOW = 1_800_000_000;
const noWait = async () => undefined;

/** A fake Bot API that answers guest queries and records each call. */
function botApi() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  let n = 0;
  const f = (async (url: string, init?: RequestInit) => {
    const method = String(url).split('/').at(-1)!;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<
      string,
      unknown
    >;
    calls.push({ method, body });
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ ok: true, result }));
    if (method === 'getMe')
      return ok({
        id: 42,
        is_bot: true,
        first_name: 'Synq',
        username: 'synq_bot',
        can_read_all_group_messages: false,
        supports_guest_queries: true,
      });
    if (method === 'answerGuestQuery')
      return ok({ inline_message_id: `inline-${++n}` });
    if (method === 'sendMessage') return ok({ message_id: ++n });
    return new Response(
      JSON.stringify({ ok: false, error_code: 404, description: 'Not Found' }),
      { status: 404 },
    );
  }) as typeof fetch;
  return { f, calls };
}

async function guestWorld() {
  const api = botApi();
  const adapter = new TelegramAdapter({
    api: new TelegramBotApi({ token: BOT_TOKEN, fetch: api.f }),
    webhookSecret: SECRET,
    sleep: noWait,
    limiter: new OutboundLimiter({
      perChatIntervalMs: 0,
      globalIntervalMs: 0,
      sleep: noWait,
    }),
    transport: 'WEBHOOK_SECRET_TOKEN',
  });
  await adapter.init();
  const store = new MemoryChannelStore();
  const touched: string[] = [];
  const guestCalls: string[] = [];
  const ports: ChannelPorts = {
    activeMember: async () => (touched.push('activeMember'), null),
    treasury: async () => (touched.push('treasury'), null),
    mandates: async () => (touched.push('mandates'), []),
    approvals: async () => (touched.push('approvals'), []),
    receipts: async () => (touched.push('receipts'), []),
    brain: async () => {
      touched.push('brain');
      return { text: 'no', proposals: [] };
    },
    guest: async (input) => {
      guestCalls.push(input.text);
      return { text: 'Draft only.' };
    },
  };
  const gateway = new ChannelGateway({
    store,
    ports,
    adapters: [adapter],
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://explorer.example/tx/',
    now: () => NOW,
    botUsernames: { telegram: 'synq_bot' },
    // Production default: one guest answer per caller per 5 seconds.
  });
  let updateId = 10_000;
  const guestUpdate = (from: number, query: string) => ({
    update_id: ++updateId,
    guest_message: {
      message_id: updateId,
      date: NOW,
      chat: { id: -100_500, type: 'supergroup', title: 'Elsewhere' },
      from: { id: from, is_bot: false, first_name: `G${from}` },
      text: '@synq_bot approve the payout and send 500 USDC',
      entities: [{ type: 'mention', offset: 0, length: 9 }],
      guest_query_id: query,
    },
  });
  return { api, adapter, store, gateway, guestUpdate, touched, guestCalls };
}

describe('X-LOA-02 10k concurrent Telegram guest pings are rate limited', () => {
  it('X-LOA-02 10,000 concurrent guest pings from 100 callers get one answer per caller, no mutation and an explicit reason for the rest', async () => {
    const w = await guestWorld();
    const callers = 100;
    const perCaller = 100;
    const events = [];
    for (let i = 0; i < callers * perCaller; i++) {
      const from = 7_000 + (i % callers);
      events.push(
        ...w.adapter.normalize(
          w.guestUpdate(from, `gq-${from}-${i}`),
          'WEBHOOK_SECRET_TOKEN',
        ),
      );
    }
    expect(events).toHaveLength(10_000);
    const outcomes = await Promise.all(events.map((e) => w.gateway.handle(e)));
    const by = new Map<string, number>();
    for (const o of outcomes) {
      const k = `${o.status}:${o.code ?? ''}`;
      by.set(k, (by.get(k) ?? 0) + 1);
    }
    const answered = w.api.calls.filter((c) => c.method === 'answerGuestQuery');
    // Exactly one answer per caller inside the cooldown window.
    expect(answered).toHaveLength(callers);
    expect(
      new Set(
        answered.map((c) =>
          String(c.body.guest_query_id).split('-').slice(0, 2).join('-'),
        ),
      ).size,
    ).toBe(callers);
    expect(Object.fromEntries(by)).toEqual({
      'HANDLED:GUEST_ANSWERED': callers,
      'REFUSED:GUEST_RATE_LIMITED': callers * (perCaller - 1),
    });
    // A guest can never reach members, treasury, mandates, approvals or the Brain.
    expect(w.touched).toEqual([]);
    expect(w.api.calls.filter((c) => c.method === 'sendMessage')).toEqual([]);
  }, 120_000);
});

const USDC = token('arc-testnet', 'USDC');
const me = '0x00000000000000000000000000000000000000a1' as Address;
const them = '0x00000000000000000000000000000000000000b2' as Address;

const indexerCfg = (
  over: Partial<ArcIndexerConfig> = {},
): ArcIndexerConfig => ({
  stream: 'arc:x-loa-03',
  chainId: 5042002,
  token: { address: TOKEN, codeHash: keccak256(TOKEN_CODE) },
  memo: null,
  wallets: [me],
  startBlock: 1n,
  confirmations: 0,
  batchSize: 20n,
  ...over,
});

function cashSink(ledger: Ledger, workspaceId: string) {
  const cash = new ArcCashIndexer(ledger, {
    workspaceId,
    wallet: me,
    assetId: USDC.assetId,
    token: TOKEN,
    chainId: 5042002,
    classify: (l) => ({
      counterAccount:
        l.from.toLowerCase() === zeroAddress
          ? 'CCTP_IN_FLIGHT'
          : 'UNAPPLIED_RECEIPTS',
      memo: 'indexed',
    }),
  });
  return (e: IndexedEvent) =>
    cash.ingest({
      chainId: e.chainId,
      blockNumber: e.blockNumber,
      blockHash: e.blockHash,
      txHash: e.txHash,
      logIndex: e.logIndex,
      removed: e.removed,
      token: e.emitter,
      from: e.data.from as Address,
      to: e.data.to as Address,
      value: BigInt(e.data.value!),
    });
}

const cashOf = async (ledger: Ledger, workspaceId: string) =>
  (await ledger.store.entries(workspaceId))
    .flatMap((e) => e.postings)
    .filter((p) => p.account === 'CASH_ARC_USDC')
    .reduce((n, p) => n + p.amount, 0n);

describe('X-LOA-03 RPC outage while backfill is running', () => {
  it('X-LOA-03 a 300-block backfill through a total outage and a mid-step failure never skips, duplicates or double-books a transfer', async () => {
    const { chain, api } = forkableChain();
    let expected = 0n;
    for (let i = 1; i <= 300; i++) {
      const value = BigInt(i) * 1_000n;
      expected += value;
      api.mine([{ from: them, to: me, value, sender: them }]);
    }
    // Outage modes, switched per step by the loop below.
    let mode: 'UP' | 'DOWN' | 'COVERAGE_FAILS' = 'UP';
    const down = () => {
      if (mode === 'DOWN') throw new Error('503 Service Unavailable');
    };
    const flaky: IndexerChain = {
      ...chain,
      chainId: async () => (down(), chain.chainId()),
      finalized: async () => (down(), chain.finalized()),
      latest: async () => (down(), chain.latest()),
      block: async (n) => (down(), chain.block(n)),
      logs: async (q) => (down(), chain.logs(q)),
      code: async (a) => (down(), chain.code(a)),
      // Logs were read, then the coverage proof fails: mid-step failure.
      hasBlock: async (h) => {
        down();
        if (mode === 'COVERAGE_FAILS') throw new Error('socket hang up');
        return chain.hasBlock(h);
      },
    };
    const store = new MemoryArcIndexStore();
    const ix = new ArcChainIndexer(flaky, store, indexerCfg());
    const errors: string[] = [];
    let idle = false;
    for (let step = 0; step < 100 && !idle; step++) {
      mode =
        step >= 4 && step < 10
          ? 'DOWN'
          : step >= 12 && step < 15
            ? 'COVERAGE_FAILS'
            : 'UP';
      try {
        idle = (await ix.step()).idle;
      } catch (e) {
        errors.push((e as { code?: string }).code ?? (e as Error).message);
      }
      // After every step, success or not: the cursor never passes a block it did not store.
      const cursor = await store.cursor('arc:x-loa-03');
      const stored = new Set(store.rows.map((r) => r.blockNumber));
      for (let n = 1n; n <= (cursor?.block ?? 0n); n++)
        expect(stored.has(n)).toBe(true);
      for (const r of store.rows)
        expect(r.blockNumber <= (cursor?.block ?? 0n)).toBe(true);
    }
    expect(idle).toBe(true);
    expect(errors.length).toBe(9);
    expect(new Set(errors)).toEqual(new Set(['PROVIDER_FAILED']));
    expect((await store.cursor('arc:x-loa-03'))!.block).toBe(300n);
    expect(store.rows).toHaveLength(300);
    // Effects (cash postings) run from stored events: exactly once, even if re-run.
    const ledger = new Ledger(new MemoryLedgerStore());
    const sink = cashSink(ledger, 'wsp_loa03');
    await ix.applyEffects({ TRANSFER: sink });
    await ix.applyEffects({ TRANSFER: sink });
    for (const r of store.rows) await sink(r); // a full replay after a lost effect marker
    expect(await cashOf(ledger, 'wsp_loa03')).toBe(expected);
  });
});

describe('X-LOA-04 worker killed before/outside the side-effect boundary', () => {
  type Kill = 'NONE' | 'BEFORE_SIGN' | 'AFTER_RECORD' | 'AFTER_BROADCAST';
  const KILLS: Kill[] = [
    'NONE',
    'BEFORE_SIGN',
    'AFTER_RECORD',
    'AFTER_BROADCAST',
  ];

  it('X-LOA-04 payouts killed at every boundary (before signing, after the durable record, after broadcast) are each paid exactly once after restart', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const payee = '0x00000000000000000000000000000000000beef1' as Address;
    const arc = fakeArc();
    arc.setPayer(payer.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const signer = countingSigner(payer);
    // The durable store outlives every "process"; each restart recovers first.
    const store = new MemoryOutboxStore();
    const realSend = arc.client.sendRawTransaction.bind(arc.client);
    let t = 1_800_000_000;
    const now = () => t++;
    const keys: string[] = [];
    let signedBefore = 0;
    let n = 0;
    for (let round = 0; round < 10; round++)
      for (const kill of KILLS) {
        const key = `payout:x-loa-04:${++n}`;
        keys.push(key);
        const transfer = {
          from: payer.address,
          to: payee,
          amount: money(USDC, BigInt(10_000 + n)),
        };
        const killer = {
          signTransaction: async (
            tx: Parameters<typeof signer.signTransaction>[0],
          ) => {
            if (kill === 'BEFORE_SIGN')
              throw new Error('worker killed before signing');
            return signer.signTransaction(tx);
          },
          address: signer.address,
        };
        (
          arc.client as { sendRawTransaction: typeof realSend }
        ).sendRawTransaction =
          kill === 'AFTER_BROADCAST'
            ? async (a) => {
                await realSend(a);
                throw new Error('worker killed after broadcast');
              }
            : realSend;
        const killed = await payOnce({
          store,
          key,
          chain,
          signer: killer,
          transfer,
          now,
          afterRecord: () => {
            if (kill === 'AFTER_RECORD')
              throw new Error('worker killed after record');
          },
        }).then(
          () => false,
          () => true,
        );
        expect(killed).toBe(kill !== 'NONE');
        (
          arc.client as { sendRawTransaction: typeof realSend }
        ).sendRawTransaction = realSend;
        if (killed) {
          // Restart: recover every in-flight record before taking new work,
          // then the workflow retries the same activity with the same key.
          for (const k of keys) {
            const r = await store.get(k);
            if (r && r.state === 'SIGNED') await recover(store, chain, r, now);
          }
          const again = await payOnce({
            store,
            key,
            chain,
            signer,
            transfer,
            now,
          });
          expect(again.record.state).toBe('CONFIRMED');
        }
        // Signed at most once per key, ever.
        expect(signer.count - signedBefore).toBe(1);
        signedBefore = signer.count;
      }
    expect(keys).toHaveLength(40);
    for (const k of keys) expect((await store.get(k))!.state).toBe('CONFIRMED');
    // Exactly one mined transaction per payout key, none twice.
    expect(arc.mined.size).toBe(keys.length);
    const hashes = new Set(
      await Promise.all(keys.map(async (k) => (await store.get(k))!.hash)),
    );
    expect(hashes.size).toBe(keys.length);
    for (const h of hashes) expect(arc.mined.has(h)).toBe(true);
  });
});

describe('X-LOA-05 duplicate webhook storm of 1000 callbacks', () => {
  it('X-LOA-05 1000 concurrent copies of one provider refund webhook record the refund once and leave free cash untouched', async () => {
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: AUSD,
      confirmed: 10_000n,
      asOf: T0,
    });
    const r = await reservations.reserve(req({ amount: '1000' }), T0);
    await reservations.capture(r.reservationId, 800n, T0);
    const before = await reservations.free('group-1', AUSD);
    const TREASURY = '0x00000000000000000000000000000000000a11ce';
    const rec = new RecourseReconciler(
      new MemoryRecourseStore(),
      reservations,
      async () => TREASURY,
      () => T0 + 10,
    );
    const event = {
      eventId: `evt-storm-${r.reservationId}`,
      providerId: 'duffel-stays',
      providerRef: `bok-${r.reservationId}`,
      reservationId: r.reservationId,
      providerUpdatedAt: T0 + 1,
      kind: 'REFUND_ISSUED' as const,
      refundId: `rf-${r.reservationId}`,
      refundCore: '300',
      refundDestination: TREASURY,
    };
    const outcomes = await Promise.all(
      Array.from({ length: 1_000 }, () => rec.apply({ ...event })),
    );
    const by = new Map<string, number>();
    for (const o of outcomes) by.set(o, (by.get(o) ?? 0) + 1);
    expect(Object.fromEntries(by)).toEqual({
      REFUND_PENDING: 1,
      DUPLICATE: 999,
    });
    const after = await reservations.free('group-1', AUSD);
    // A promised refund is not cash: free is unchanged, the refund is pending once.
    expect(after.free).toBe(before.free);
    expect(after.pendingRefunds).toBe('300');
  });

  it('X-LOA-05 1000 redeliveries of one Telegram update answer once', async () => {
    const w = await guestWorld();
    const update = w.guestUpdate(9_001, 'gq-storm');
    const outcomes = await Promise.all(
      Array.from({ length: 1_000 }, () =>
        Promise.all(
          w.adapter
            .normalize(structuredClone(update), 'WEBHOOK_SECRET_TOKEN')
            .map((e) => w.gateway.handle(e)),
        ),
      ),
    );
    const flat = outcomes.flat().map((o) => o.status);
    expect(flat.filter((s) => s === 'HANDLED')).toHaveLength(1);
    expect(flat.filter((s) => s === 'DUPLICATE')).toHaveLength(999);
    expect(
      w.api.calls.filter((c) => c.method === 'answerGuestQuery'),
    ).toHaveLength(1);
  });
});

describe('X-LOA-06 20 providers time out during offer fan-out', () => {
  it('X-LOA-06 twenty hung providers time out in bounded time; the healthy offers survive, nothing becomes executable', async () => {
    const hungIds = Array.from({ length: 20 }, (_, i) => `hung-${i}`);
    const aborted: string[] = [];
    const hung = hungIds.map(
      (id) =>
        ({
          providerId: id,
          search: (_i: unknown, signal: AbortSignal) =>
            new Promise<never>((_, reject) =>
              signal.addEventListener('abort', () => {
                aborted.push(id);
                reject(new Error('aborted'));
              }),
            ),
        }) as unknown as FakeProvider,
    );
    const graph = graphOf(
      capability('fast-a'),
      capability('fast-b'),
      capability('never'),
      ...hungIds.map((id) => capability(id)),
    );
    const started = Date.now();
    const r = await searchOffers({
      intent: intent(),
      providers: [
        new FakeProvider('fast-a', [offer('a', 'fast-a', 900)]),
        ...hung,
        new FakeProvider('never', hang),
        new FakeProvider('fast-b', [offer('b', 'fast-b', 950)]),
      ],
      graph,
      now: () => OFFER_NOW,
      timeoutMs: 100,
    });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2_000);
    expect(r.offers.map((o) => o.offerId).sort()).toEqual(['a', 'b']);
    expect(r.offers.every((o) => o.executable === false)).toBe(true);
    expect(r.outcomes.filter((o) => o.status === 'TIMEOUT')).toHaveLength(21);
    expect(r.coverage.label).toBe('2/23 providers healthy');
    // Each hung provider's request was aborted, not left running.
    expect(aborted.sort()).toEqual([...hungIds].sort());
    for (const id of hungIds)
      expect(
        graph.health(OFFER_NOW).find((h) => h.providerId === id)?.status,
      ).toBe('DEGRADED');
  });
});
