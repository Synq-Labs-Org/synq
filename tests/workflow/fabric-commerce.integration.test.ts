import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TestWorkflowEnvironment } from '@temporalio/testing';
import {
  EconomicIntentSchema,
  ProviderCapabilityGraph,
  searchOffers,
  selectOffers,
  type EconomicIntent,
  type OfferProvider,
} from '@synq/offer-exchange';
import {
  LITHIC,
  LITHIC_SANDBOX_HOST,
  LithicSandboxCardPort,
  LithicSandboxClient,
  RELOADLY,
  RELOADLY_SANDBOX_HOST,
  ReloadlyClient,
  ReloadlyGiftCardPort,
  ReloadlyGiftCardProvider,
  SimulatedCardMerchant,
  giftCardSubject,
  lithicProviderCapability,
  reloadlyProviderCapability,
  settlementFabricCapabilities,
} from '@synq/plugin-commerce';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  MemoryProfileStore,
  ProfileDirectory,
} from '@synq/profile-vault';
import { selectExecutionRoute } from '@synq/settlement';
import type { BookingWorkflowState } from '../../workers/workflow/src/workflows/booking.js';
import {
  AUSD,
  USDC,
  fabricBookingWorld,
  usd,
} from '../../scripts/lib/fabric-booking-world.js';
import { FakeReloadly } from '../commerce/fake-reloadly.js';
import { FakeLithic } from '../commerce/fake-lithic.js';
import { startTemporal, testConfig } from './harness/temporal.js';
import { withWorkers } from './harness/worker.js';

const now = () => Math.floor(Date.now() / 1000);
let env: TestWorkflowEnvironment;
beforeAll(async () => {
  env = await startTemporal();
});
afterAll(async () => {
  await env?.teardown();
});

async function giftWorld(groupId = 'group-1') {
  const fake = new FakeReloadly();
  const client = new ReloadlyClient(
    {
      clientId: fake.clientId,
      clientSecret: fake.clientSecret,
      environment: 'sandbox',
    },
    fake.fetch,
    now,
  );
  const keys = new EnvVaultKeyProvider({
    SYNQ_PROFILE_VAULT_KEY: randomBytes(32).toString('base64'),
  });
  const profiles = new MemoryProfileStore();
  const directory = new ProfileDirectory(profiles, keys, now);
  const { ref: recipientRef } = await directory.put({
    groupId,
    kind: 'RECIPIENT',
    data: {
      name: 'Bea Recipient',
      line1: '1 Main St',
      city: 'Austin',
      postalCode: '73301',
      country: 'US',
      email: 'bea@example.com',
    },
  });
  const sealer = new GiftCodeVault(profiles, keys, now);
  const provider = new ReloadlyGiftCardProvider(client, now, directory);
  const port = new ReloadlyGiftCardPort(client, sealer, directory);
  const credsEnv = { RELOADLY_CLIENT_ID: 'x', RELOADLY_CLIENT_SECRET: 'y' };
  const world = await fabricBookingWorld({
    groupId,
    mandateId: 'gift-mandate',
    providerId: RELOADLY,
    host: RELOADLY_SANDBOX_HOST,
    capability: reloadlyProviderCapability(credsEnv),
    provider,
    port,
    rail: {
      railId: 'reloadly-sandbox-balance',
      rail: 'PROVIDER_BALANCE',
      chainId: null,
      assetId: null,
      currency: 'USD',
      auth: 'PROVIDER_API_KEY',
      kycRequired: false,
      kycSatisfied: false,
      environment: 'SANDBOX',
      status: 'READY',
    },
    perActionCapCents: 2_500,
    now,
  });
  const intent = EconomicIntentSchema.parse({
    id: `gift-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    groupId,
    domain: 'COMMERCE',
    objective: 'buy a $10 gift card',
    subject: giftCardSubject({
      brand: 'Amazon',
      countryCode: 'US',
      recipientCurrency: 'USD',
      unitPriceCents: 1000,
      recipientRef,
    }),
    hardConstraints: [],
    preferences: [],
    budget: { max: usd(2_500) },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: now() + 3_600,
  });
  return {
    fake,
    provider,
    world,
    intent,
    profiles,
    credsEnv,
    graphEnv: credsEnv,
  };
}

async function candidates(
  intent: EconomicIntent,
  provider: OfferProvider,
  graph: ProviderCapabilityGraph,
) {
  const search = await searchOffers({
    intent,
    providers: [provider],
    graph,
    now,
  });
  const sel = selectOffers({ intent, search, now: now() });
  if (process.env.DEBUG_FAB)
    console.log(
      JSON.stringify({
        invalid: search.invalid,
        outcomes: search.outcomes,
        rejected: sel.rejected,
      }).slice(0, 1500),
    );
  return sel.ranked.map((r) => ({ offer: r.offer, landed: r.landed }));
}

async function run(
  activities: Parameters<typeof withWorkers>[2],
  input: Record<string, unknown> & { groupId?: string },
  approve = ['alice', 'bob'],
) {
  const config = testConfig('fabric');
  return withWorkers(env, config, activities, async () => {
    const handle = await env.client.workflow.start('BookingWorkflow', {
      taskQueue: config.taskQueues.economic,
      workflowId: `fabric-${input.bookingId}-${process.pid}`,
      args: [
        {
          groupId: input.groupId ?? 'group-1',
          travelerRefs: [],
          approvalTimeoutSeconds: 30,
          reconcileIntervalSeconds: 1,
          reconcileAttempts: 3,
          ...input,
        },
      ],
    });
    const state = () => handle.query<BookingWorkflowState>('bookingState');
    let hash: string | null = null;
    for (let i = 0; i < 300 && !hash; i++) {
      const s = await state();
      if (s.state === 'FAILED') break;
      hash = s.requestHash;
      if (!hash) await new Promise((r) => setTimeout(r, 100));
    }
    if (hash)
      for (const m of approve)
        await handle.signal('bookingApproval', {
          token: `fixture-verified:${m}:${hash}`,
        });
    return (await handle.result()) as BookingWorkflowState;
  });
}

describe('v1.3 settlement fabric through the Temporal booking workflow', () => {
  it('WF-FAB-001 group gift card: router → reservation → grant → Reloadly sandbox order → sealed code → ledgered receipt', async () => {
    const g = await giftWorld();
    const route = selectExecutionRoute(
      {
        intentId: g.intent.id,
        product: 'GIFT_CARD',
        currency: 'USD',
        requiredChain: null,
        allowedModes: ['PROVIDER_SANDBOX'],
        categories: [
          'DIGITAL_GOODS_SANDBOX',
          'CRYPTO_COMMERCE_REAL',
          'MERCHANT_CHECKOUT',
          'HUMAN_HANDOFF',
        ],
      },
      settlementFabricCapabilities(g.credsEnv),
    );
    expect(route.status === 'SELECTED' && route.provider.providerId).toBe(
      RELOADLY,
    );
    const graph = new ProviderCapabilityGraph([
      reloadlyProviderCapability(g.credsEnv),
    ]);
    const cands = await candidates(g.intent, g.provider, graph);
    expect(cands).toHaveLength(1);
    const before = await g.world.reservations.free(
      'group-1',
      AUSD.canonicalAssetId,
    );
    const s = await run(g.world.activities, {
      bookingId: `gift-${process.pid}-a`,
      mandateId: 'gift-mandate',
      intent: g.intent,
      candidates: cands,
      approvedMax: usd(2_500),
    });
    expect(s.state).toBe('RECONCILED');
    expect(g.fake.orders).toHaveLength(1);
    const order = await g.world.fabric.store.findOrder(
      RELOADLY,
      s.idempotencyKey,
    );
    expect(order!.state).toBe('SANDBOX_FULFILLED');
    expect(order!.providerRef).toBe(s.providerRef);
    const receipt = await g.world.fabric.store.getReceipt(
      `sr-${order!.providerOrderId}`,
    );
    expect(receipt!.treasuryEffect).toBe('NONE');
    expect(receipt!.label).toBe('PROVIDER_SANDBOX');
    expect(receipt!.statement).toMatch(/Reloadly sandbox/);
    expect((await g.world.reservations.get(s.reservationId!))!.state).toBe(
      'RELEASED',
    );
    const after = await g.world.reservations.free(
      'group-1',
      AUSD.canonicalAssetId,
    );
    expect(after.free).toBe(before.free);
    const totals = await g.world.fabric.store.ledgerTotals('group-1');
    expect(totals.SIMULATED_PROVIDER_OBLIGATION['USD/2']).toBe('1050');
    const codes = [...g.profiles.records.values()].filter(
      (r) => r.kind === 'GIFT_CODE',
    );
    expect(codes).toHaveLength(1);
    const visible = JSON.stringify({ s, receipt, receipts: g.world.receipts });
    expect(visible).not.toContain(g.fake.code);
    expect(visible).not.toContain(g.fake.pin);
  });

  it('WF-FAB-002 a timeout after the provider committed reconciles to one order, never a second', async () => {
    const g = await giftWorld();
    g.fake.faults.order = 'TIMEOUT_AFTER_COMMIT';
    g.fake.faults.reportsLag = 2;
    const graph = new ProviderCapabilityGraph([
      reloadlyProviderCapability(g.credsEnv),
    ]);
    const s = await run(g.world.activities, {
      bookingId: `gift-${process.pid}-b`,
      mandateId: 'gift-mandate',
      intent: g.intent,
      candidates: await candidates(g.intent, g.provider, graph),
      approvedMax: usd(2_500),
    });
    expect(s.history.map((h) => h.to)).toContain('UNKNOWN_PROVIDER_OUTCOME');
    expect(s.state).toBe('RECONCILED');
    expect(g.fake.orders).toHaveLength(1);
    const order = await g.world.fabric.store.findOrder(
      RELOADLY,
      s.idempotencyKey,
    );
    expect(order!.state).toBe('SANDBOX_FULFILLED');
  });

  it('WF-FAB-003 insufficient sandbox balance fails cleanly and releases the reservation', async () => {
    const g = await giftWorld();
    g.fake.balance = 1;
    const graph = new ProviderCapabilityGraph([
      reloadlyProviderCapability(g.credsEnv),
    ]);
    const s = await run(g.world.activities, {
      bookingId: `gift-${process.pid}-c`,
      mandateId: 'gift-mandate',
      intent: g.intent,
      candidates: await candidates(g.intent, g.provider, graph),
      approvedMax: usd(2_500),
    });
    expect(s.state).toBe('FAILED');
    expect(s.notes.join(' ')).toMatch(/INSUFFICIENT_SANDBOX_BALANCE/);
    expect(g.fake.orders).toHaveLength(0);
    expect((await g.world.reservations.get(s.reservationId!))!.state).toBe(
      'RELEASED',
    );
  });

  it('WF-FAB-004 group-approved card payment: Lithic sandbox card capped at the grant, approved once, over-mandate declined', async () => {
    const fake = new FakeLithic();
    const client = new LithicSandboxClient(
      { apiKey: fake.key, environment: 'sandbox' },
      fake.fetch,
      { sleep: async () => undefined },
    );
    const merchant = new SimulatedCardMerchant(
      { descriptor: 'SYNQ TEST CAFE', title: 'Team lunch', priceCents: 1_840 },
      now,
    );
    const lithicEnv = { LITHIC_API_KEY: 'x' };
    const world = await fabricBookingWorld({
      groupId: 'group-1',
      mandateId: 'card-mandate',
      providerId: LITHIC,
      host: LITHIC_SANDBOX_HOST,
      capability: lithicProviderCapability(lithicEnv),
      provider: merchant,
      port: new LithicSandboxCardPort(client),
      rail: {
        railId: 'lithic-sandbox-card',
        rail: 'SCOPED_CARD',
        chainId: null,
        assetId: null,
        currency: 'USD',
        auth: 'PROVIDER_API_KEY',
        kycRequired: false,
        kycSatisfied: false,
        environment: 'SANDBOX',
        status: 'READY',
      },
      perActionCapCents: 2_500,
      now,
    });
    const route = selectExecutionRoute(
      {
        intentId: 'card',
        product: 'VIRTUAL_CARD_AUTHORIZATION',
        currency: 'USD',
        requiredChain: null,
        allowedModes: ['PROVIDER_SANDBOX'],
        categories: ['CARD_NETWORK_SANDBOX', 'HUMAN_HANDOFF'],
      },
      settlementFabricCapabilities(lithicEnv),
    );
    expect(route.status === 'SELECTED' && route.provider.providerId).toBe(
      LITHIC,
    );
    const intent = EconomicIntentSchema.parse({
      id: `card-${process.pid}`,
      groupId: 'group-1',
      domain: 'COMMERCE',
      objective: 'pay for team lunch up to $25',
      subject: {
        kind: 'PRODUCT',
        title: 'Team lunch',
        brand: 'SYNQ TEST CAFE',
        model: 'merchant-payment',
        quantity: 1,
      },
      hardConstraints: [],
      preferences: [],
      budget: { max: usd(2_500) },
      autonomy: { execution: 'QUORUM', substitution: 'NONE' },
      validUntil: now() + 3_600,
    });
    const graph = new ProviderCapabilityGraph([
      lithicProviderCapability(lithicEnv),
    ]);
    const s = await run(world.activities, {
      bookingId: `card-${process.pid}`,
      mandateId: 'card-mandate',
      intent,
      candidates: await candidates(intent, merchant, graph),
      approvedMax: usd(2_500),
    });
    expect(s.state).toBe('RECONCILED');
    const card = fake.cards.get(s.reference!)!;
    expect(card.spend_limit).toBe(1_840);
    expect(fake.txs.get(s.providerRef!)!.result).toBe('APPROVED');
    const { secret } = await client.getCard(s.reference!);
    const second = await client.simulateAuthorization(secret!, {
      amountCents: 1_000,
      descriptor: 'SYNQ TEST CAFE',
    });
    expect(second.approved).toBe(false);
    const order = await world.fabric.store.findOrder(LITHIC, s.idempotencyKey);
    const receipt = await world.fabric.store.getReceipt(
      `sr-${order!.providerOrderId}`,
    );
    expect(receipt!.statement).toBe(
      'Synq authorized a simulated card payment using an actual card-issuing sandbox',
    );
    expect(receipt!.treasuryEffect).toBe('NONE');
    expect((await world.reservations.get(s.reservationId!))!.state).toBe(
      'RELEASED',
    );
    expect(
      (await world.reservations.free('group-1', USDC.canonicalAssetId)).held,
    ).toBe('0');
    expect(JSON.stringify(s)).not.toContain(card.pan as string);
  });

  it('WF-FAB-005 two gift bookings in a bytes32 group place two orders and seal each code to its own recipient', async () => {
    const G = `0x${'8241ac62'.repeat(8)}`;
    const g = await giftWorld(G);
    const graph = new ProviderCapabilityGraph([
      reloadlyProviderCapability(g.credsEnv),
    ]);
    const states: BookingWorkflowState[] = [];
    for (const suffix of ['a', 'b']) {
      const intent = EconomicIntentSchema.parse({
        ...g.intent,
        id: `${g.intent.id}-${suffix}`,
      });
      states.push(
        await run(g.world.activities, {
          groupId: G,
          bookingId: `gift-${process.pid}-${suffix}-bytes32`,
          mandateId: 'gift-mandate',
          intent,
          candidates: await candidates(intent, g.provider, graph),
          approvedMax: usd(2_500),
        }),
      );
    }
    expect(states.map((s) => s.state)).toEqual(['RECONCILED', 'RECONCILED']);
    expect(g.fake.orders).toHaveLength(2);
    expect(states[0]!.providerRef).not.toBe(states[1]!.providerRef);
    expect(new Set(g.fake.orders.map((o) => o.customIdentifier)).size).toBe(2);
    expect(
      [...g.profiles.records.values()].filter((r) => r.kind === 'GIFT_CODE'),
    ).toHaveLength(2);
  });
});
