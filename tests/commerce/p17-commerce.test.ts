import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EconomicGrantAuthority,
  economicRequestHash,
  type EconomicGrant,
} from '@synq/kernel';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
  ProviderCapabilityGraph,
  landedTotal,
  revalidateOffer,
  selectOffers,
  type EconomicIntent,
  type EconomicOffer,
} from '@synq/offer-exchange';
import {
  CommerceExecutionRouter,
  CommerceJourney,
  CrossmintCheckoutRoute,
  EbayOrderRoute,
  JourneyTransitionError,
  SearchApiDiscovery,
  checkoutEligibility,
  commerceCapabilities,
  effectiveBudget,
  parseCommerceRequest,
  settlementFabricCapabilities,
  type HttpFetch,
} from '@synq/plugin-commerce';
import {
  EnvVaultKeyProvider,
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
  redactDeep,
} from '@synq/profile-vault';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  SettlementFabric,
  SettlementFabricError,
  receiptStatement,
} from '@synq/settlement';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import { checkArchitecture } from '../../scripts/architecture.mjs';
import { commerceExecution } from '../../workers/workflow/src/activities/commerce.js';
import {
  approval,
  approvalPorts,
  memoryLedger,
} from '../kernel/economic-fixtures.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const T = 1_780_000_000;
const now = () => T;
const KEY = 'searchapi-secret-key-0123456789';
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const fetcher: HttpFetch = async (url) => {
  const engine = new URL(url).searchParams.get('engine');
  return {
    status: 200,
    text: async () =>
      fixture(
        engine === 'amazon_product'
          ? 'searchapi-amazon-product.json'
          : 'searchapi-amazon-search.json',
      ),
  };
};
const code = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === 'function' ? p() : p);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
};

const cable: EconomicIntent = EconomicIntentSchema.parse({
  id: 'cable-1',
  groupId: 'group-1',
  domain: 'COMMERCE',
  objective: 'buy the shared USB-C cable listing',
  subject: {
    kind: 'PRODUCT',
    title: 'Amazon Basics USB-C to USB-C cable',
    brand: 'Amazon Basics',
    condition: 'NEW',
  },
  hardConstraints: [{ kind: 'CONDITION_IN', allowed: ['NEW'] }],
  preferences: [],
  budget: { max: usd(1_000) },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  maxPriceDriftBps: 0,
  validUntil: T + 3_600,
});

/** Amazon offers from recorded live SearchApi.io responses. */
async function amazonOffers(): Promise<EconomicOffer[]> {
  const d = new SearchApiDiscovery('searchapi-amazon', KEY, fetcher, now, {
    evidence: 'MOCKED',
  });
  return (await d.search(cable, AbortSignal.timeout(1_000))).map((o) =>
    EconomicOfferSchema.parse(o),
  );
}

const stagingEnv = {
  SEARCHAPI_KEY: KEY,
  CROSSMINT_API_KEY: 'sk_staging_fixture',
  CROSSMINT_ENV: 'staging',
  LITHIC_API_KEY: 'lithic-sandbox-fixture',
  LITHIC_ENV: 'sandbox',
};
const worldStoreDeprecated =
  'BLOCKED_EXTERNAL: Crossmint WorldStore is deprecated and accepts no orders (HTTP 400)';
function routes(crossmintStatus: 'READY' | 'BLOCKED' = 'BLOCKED') {
  const caps = commerceCapabilities(stagingEnv);
  const c = (id: string) => caps.find((x) => x.providerId === id)!;
  return [
    new EbayOrderRoute(c('ebay-order')),
    new CrossmintCheckoutRoute(
      {
        ...c('crossmint'),
        status: crossmintStatus,
        statusReason: crossmintStatus === 'READY' ? null : worldStoreDeprecated,
      },
      undefined,
      async () => ({ status: 500, text: async () => '' }),
      null,
    ),
  ];
}
const fabricCaps = (lithic = true) =>
  settlementFabricCapabilities(
    lithic ? stagingEnv : { ...stagingEnv, LITHIC_API_KEY: '' },
    {
      crossmint: { health: 'DOWN', reason: worldStoreDeprecated },
      'lithic-sandbox': { health: 'HEALTHY', reason: null },
    },
  );

function productOffer(
  id: string,
  subject: Partial<Extract<EconomicOffer['subject'], { kind: 'PRODUCT' }>>,
  base = 999,
): EconomicOffer {
  return EconomicOfferSchema.parse({
    offerId: id,
    intentId: 'monitor-1',
    domain: 'COMMERCE',
    discoveryProviderId: 'searchapi-amazon',
    fulfillmentProviderId: 'crossmint',
    providerRef: `amazon:${subject.asin ?? 'B000000000'}`,
    subject: {
      kind: 'PRODUCT',
      title: 'Anker USB-C cable 6ft',
      asin: 'B088NRLMPV',
      brand: 'Anker',
      variant: { color: 'Black', size: '6 ft' },
      condition: 'NEW',
      quantity: 1,
      ...subject,
    },
    price: {
      quoteId: `q-${id}`,
      base: usd(base),
      shipping: usd(0),
      tax: usd(0),
      fees: usd(0),
      fx: [],
      quotedAt: T,
      expiresAt: T + 900,
      revalidatedAt: null,
    },
    cancellation: {
      kind: 'UNKNOWN',
      refundable: false,
      freeUntil: null,
      penalty: null,
      changeable: false,
    },
    settlement: {
      accepts: [{ rail: 'STABLECOIN_CHECKOUT', currency: 'USD' }],
      payee: null,
    },
    execution: {
      mode: 'STABLECOIN_CHECKOUT',
      requiresQuote: true,
      requiresKyc: false,
      requiresStepUp: false,
      piiFields: ['SHIPPING_ADDRESS'],
    },
    environment: 'PRODUCTION',
    evidence: 'MOCKED',
    retrievedAt: T,
    executable: false,
  });
}
const exactIntent = EconomicIntentSchema.parse({
  ...cable,
  id: 'monitor-1',
  subject: {
    kind: 'PRODUCT',
    title: 'Anker USB-C cable 6ft',
    asin: 'B088NRLMPV',
    brand: 'Anker',
    variant: { color: 'Black', size: '6 ft' },
    condition: 'NEW',
  },
});

describe('P17 commerce, Amazon search and the real checkout boundary', () => {
  it('P17-01 an Amazon listing (even revalidated) carries no order authority; the journey hands off', async () => {
    const parsed = parseCommerceRequest(
      '@Synq, find this product on Amazon https://www.amazon.com/dp/B01GGKZ1VA and buy it under $25 within my approved budget',
    )!;
    expect(parsed).toMatchObject({
      marketplace: 'AMAZON',
      asin: 'B01GGKZ1VA',
      statedCapCents: 2_500,
      wantsPurchase: true,
    });
    // Chat can only lower the signed mandate budget, never raise it.
    expect(effectiveBudget(usd(1_500), parsed)).toEqual(usd(1_500));
    expect(effectiveBudget(usd(4_000), parsed)).toEqual(usd(2_500));

    const offers = await amazonOffers();
    expect(offers.length).toBeGreaterThan(3);
    expect(offers.every((o) => !o.executable)).toBe(true);
    const caps = commerceCapabilities(stagingEnv);
    expect(
      caps.find((c) => c.providerId === 'searchapi-amazon')!.verbs,
    ).not.toContain('PURCHASE');

    // A revalidated, executable quote is still not order authority at the merchant.
    const first = offers[0]!;
    const offer: EconomicOffer = {
      ...first,
      executable: true,
      price: { ...first.price, revalidatedAt: T },
    };
    const e = checkoutEligibility({
      offer,
      routes: routes(),
      allowed: ['NATIVE_API', 'STABLECOIN_CHECKOUT'],
      fabric: fabricCaps(),
    });
    expect(e.listing.orderAuthority).toBe(false);
    expect(e.listing.merchant).toBe('amazon');
    expect(e.path).toBe('HUMAN_HANDOFF');
    expect(
      e.considered.find((c) => c.providerId === 'crossmint')!.verdict,
    ).toContain('WorldStore');
    expect(e.statement).toMatch(/no entitled checkout/i);
    expect(e.statement).not.toMatch(/paid with (USDC|AUSD)|order placed/i);
  });

  it('P17-02 variant, condition and identity mismatches are excluded from the comparison', async () => {
    const offers = [
      productOffer('exact', {}, 999),
      productOffer('used', { condition: 'USED' }, 599),
      productOffer('refurb', { condition: 'REFURBISHED' }, 699),
      productOffer('white', { variant: { color: 'White', size: '6 ft' } }, 899),
      productOffer('short', { variant: { color: 'Black', size: '3 ft' } }, 799),
      productOffer(
        'other-asin',
        { asin: 'B09LCJPZ1P', title: 'Anker USB-C cable 6ft 2-pack' },
        499,
      ),
    ];
    const sel = selectOffers({
      intent: exactIntent,
      search: { offers, coverage: [] } as unknown as Parameters<
        typeof selectOffers
      >[0]['search'],
      now: T,
    });
    expect(sel.ranked.map((r) => r.offer.offerId)).toEqual(['exact']);
    expect(sel.selected!.match).toMatchObject({
      level: 'EXACT_MATCH',
      basis: 'ASIN',
    });
    // Cheaper but different variant/condition offers are never ranked or auto-substituted.
    expect(sel.recommendations.map((r) => r.offer.offerId).sort()).toEqual([
      'refurb',
      'short',
      'used',
      'white',
    ]);
    expect(sel.rejected.map((r) => r.offerId)).toEqual(['other-asin']);
    // A revalidated quote whose condition changed is a mismatch, not an executable offer.
    const r = await revalidateOffer({
      intent: exactIntent,
      candidate: sel.selected!,
      provider: {
        providerId: 'crossmint',
        search: async () => [],
        revalidate: async (o) => ({
          price: { ...o.price, revalidatedAt: T },
          subject: {
            ...(o.subject as Extract<
              EconomicOffer['subject'],
              { kind: 'PRODUCT' }
            >),
            condition: 'REFURBISHED',
          },
          available: true,
          providerRef: o.providerRef,
        }),
      },
      graph: new ProviderCapabilityGraph([
        {
          ...commerceCapabilities(stagingEnv).find(
            (c) => c.providerId === 'crossmint',
          )!,
          status: 'READY',
        },
      ]),
      approvedMax: usd(999),
      now,
    });
    expect(r).toMatchObject({ status: 'MISMATCH' });
  });

  it('P17-03 a price increase after approval invalidates the old grant', async () => {
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'group-1',
      assetId: 'arc:usdc',
      confirmed: 10n ** 12n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'res-1',
        groupId: 'group-1',
        assetId: 'arc:usdc',
        amount: '10000000',
        intentId: 'monitor-1',
        purpose: 'COMMERCE',
        settlementPlanHash: '0xplan',
        expiresAt: T + 3_600,
      },
      T,
    );
    const authority = new EconomicGrantAuthority({
      key: new Uint8Array(32).fill(7),
      reservations,
      ledger: memoryLedger(),
      approvals: approvalPorts(['alice', 'bob']),
    });
    await authority.install({
      mandateId: 'shopping',
      groupId: 'group-1',
      version: 1,
      status: 'ACTIVE',
      domains: ['COMMERCE'],
      providers: ['lithic-sandbox'],
      hosts: ['sandbox.lithic.com'],
      perActionCap: usd(2_000),
      cumulativeBudget: usd(5_000),
      autoApproveMax: usd(0),
      quorum: 2,
      members: ['alice', 'bob'],
      approverKinds: ['LOCAL_FIXTURE'],
      maxQuoteAgeSeconds: 300,
      grantTtlSeconds: 300,
      environment: 'SANDBOX',
      validUntil: T + 86_400,
    });
    const quoted = {
      ...productOffer('exact', {}, 999),
      executable: true,
      price: { ...productOffer('exact', {}, 999).price, revalidatedAt: T },
    };
    const reservation = {
      reservationId: 'res-1',
      planHash: '0xplan',
      reservedAssetId: 'arc:usdc',
      reservedAmount: '10000000',
    };
    const exec = (o: EconomicOffer) =>
      commerceExecution({
        offer: o,
        host: 'sandbox.lithic.com',
        providerId: 'lithic-sandbox',
        maxAmount: landedTotal(o, usd(0)),
        reservation,
        recipientRef: 'pv_ship_ref',
      });
    const req = {
      intentId: 'monitor-1',
      groupId: 'group-1',
      mandateId: 'shopping',
      execution: exec(quoted),
      quoteExpiresAt: quoted.price.expiresAt,
      revalidatedAt: T,
    };
    const hash = economicRequestHash(req);
    const d = await authority.authorize(
      req,
      [
        await approval('alice', hash, { mandateId: 'shopping' }),
        await approval('bob', hash, { mandateId: 'shopping' }),
      ],
      T,
    );
    expect(d.status).toBe('AUTHORIZED');
    const grant = (d as { grant: EconomicGrant }).grant;
    // The merchant reprices from 9.99 to 10.49 before checkout.
    const repriced = {
      ...quoted,
      price: { ...quoted.price, base: usd(1_049) },
    };
    const fresh = await revalidateOffer({
      intent: exactIntent,
      candidate: {
        offer: quoted,
        landed: usd(999),
        match: { level: 'EXACT_MATCH', basis: 'ASIN', reasons: [] },
      },
      provider: {
        providerId: 'crossmint',
        search: async () => [],
        revalidate: async () => ({
          price: repriced.price,
          subject: quoted.subject,
          available: true,
          providerRef: quoted.providerRef,
        }),
      },
      graph: new ProviderCapabilityGraph([
        {
          ...commerceCapabilities(stagingEnv).find(
            (c) => c.providerId === 'crossmint',
          )!,
          status: 'READY',
        },
      ]),
      approvedMax: usd(999),
      now,
    });
    expect(fresh).toMatchObject({ status: 'PRICE_DRIFT' });
    // The old grant cannot be spent on the higher price…
    expect(await code(authority.consume(grant, exec(repriced), T + 5))).toBe(
      'GRANT_BINDING',
    );
    expect(await authority.isConsumed(grant.grantId)).toBe(false);
    // …and the journey must go back through approval.
    const j = new CommerceJourney('j-1', now);
    for (const s of [
      'DISCOVERED',
      'MATCHED',
      'REVALIDATED',
      'PROVIDERS_IDENTIFIED',
      'APPROVAL_PENDING',
      'APPROVED',
    ] as const)
      j.advance(s, s);
    expect(() => j.advance('CHECKOUT_PLACED', 'skip rail')).toThrow(
      JourneyTransitionError,
    );
    j.advance(
      'REVALIDATED',
      'price changed 999 -> 1049; fresh approval required',
    );
    expect(() => j.advance('RAIL_SELECTED', 'reuse old grant')).toThrow(
      JourneyTransitionError,
    );
    // The unchanged price still consumes once.
    expect((await authority.consume(grant, exec(quoted), T + 5)).grantId).toBe(
      grant.grantId,
    );
  });

  it('P17-04 a gift or card sandbox order never debits the real Arc cash ledger', async () => {
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'g1',
      assetId: 'arc:usdc',
      confirmed: 50_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'res-gift',
        groupId: 'g1',
        assetId: 'arc:usdc',
        amount: '10000000',
        intentId: 'gift-1',
        purpose: 'GIFT_CARD',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    const arcCash = new Ledger(new MemoryLedgerStore());
    const store = new MemorySettlementFabricStore();
    const fabric = new SettlementFabric(store, reservations, () => T + 10);
    const order = await fabric.openOrder({
      intentId: 'gift-1',
      groupId: 'g1',
      providerId: 'reloadly-sandbox',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'synq-gift-key-1',
      amount: usd(1_000),
    });
    // A sandbox order can never become a settled merchant order or a testnet settlement.
    expect(
      await code(
        fabric
          .transition(order.providerOrderId, 'SUBMITTED')
          .then(() =>
            fabric.transition(order.providerOrderId, 'MERCHANT_SETTLED'),
          ),
      ),
    ).toBe('SANDBOX_IS_NOT_MERCHANT_SETTLEMENT');
    const receipt = await fabric.settleSandboxOrder({
      providerOrderId: order.providerOrderId,
      providerRefs: { transactionId: 'sandbox-tx-1' },
      category: 'DIGITAL_GOODS_SANDBOX',
      providerName: 'Reloadly',
      reservationIds: ['res-gift'],
      charged: usd(1_000),
    });
    expect(receipt).toMatchObject({
      label: 'PROVIDER_SANDBOX',
      treasuryEffect: 'NONE',
      mode: 'PROVIDER_SANDBOX',
    });
    expect(receipt.statement).toContain('no money moved');
    const totals = await store.ledgerTotals('g1');
    expect(totals.SIMULATED_PROVIDER_OBLIGATION).toEqual({ 'USD/2': '1000' });
    expect(totals.REAL_OFFCHAIN_OBLIGATION).toEqual({});
    // The Arc treasury reservation is released, not captured, and the Arc cash books are untouched.
    expect((await reservations.get('res-gift'))!.state).toBe('RELEASED');
    expect((await reservations.free('g1', 'arc:usdc')).free).toBe('50000000');
    expect(
      Object.values(await arcCash.balances('g1', 'arc:usdc')).every(
        (v) => v === 0n,
      ),
    ).toBe(true);
    expect(
      await code(
        fabric.settleTestnetOrder({
          providerOrderId: order.providerOrderId,
          providerRefs: {},
          category: 'DIGITAL_GOODS_SANDBOX',
          providerName: 'Reloadly',
          charged: null,
        }),
      ),
    ).not.toBeNull();
    expect(() =>
      receiptStatement({
        category: 'DIGITAL_GOODS_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
        providerName: 'paid with USDC',
      }),
    ).toThrow(SettlementFabricError);
  });

  it('P17-05 an unentitled merchant checkout returns a transparent handoff, never a simulated order', async () => {
    const offer = productOffer('exact', {}, 999);
    // eBay Order is partner gated; Crossmint WorldStore refuses orders.
    const plain = checkoutEligibility({
      offer,
      routes: routes(),
      allowed: ['NATIVE_API', 'STABLECOIN_CHECKOUT'],
      fabric: fabricCaps(),
    });
    expect(plain.path).toBe('HUMAN_HANDOFF');
    expect(plain.route).toBeNull();
    // The fixture router would have labelled it SIMULATE; the live journey never does.
    expect(
      new CommerceExecutionRouter(routes()).decide(offer, [
        'STABLECOIN_CHECKOUT',
      ]).kind,
    ).toBe('SIMULATE');
    expect(
      new CommerceExecutionRouter(routes(), { fallback: 'HANDOFF' }).decide(
        offer,
        ['STABLECOIN_CHECKOUT'],
      ).kind,
    ).toBe('HANDOFF');
    // Even a READY Crossmint capability without sandbox access is a handoff.
    expect(
      checkoutEligibility({
        offer,
        routes: routes('READY'),
        allowed: ['STABLECOIN_CHECKOUT'],
        fabric: [],
      }).path,
    ).toBe('HUMAN_HANDOFF');
    // With a consented card path the human checks out with a scoped sandbox card.
    const card = checkoutEligibility({
      offer,
      routes: routes(),
      allowed: ['STABLECOIN_CHECKOUT', 'SCOPED_CARD'],
      fabric: fabricCaps(),
    });
    expect(card).toMatchObject({
      path: 'SCOPED_CARD_HANDOFF',
      cardProvider: { providerId: 'lithic-sandbox', mode: 'PROVIDER_SANDBOX' },
    });
    expect(card.statement).toMatch(
      /no amazon order is placed and no merchant is charged/,
    );
    expect(
      checkoutEligibility({
        offer,
        routes: routes(),
        allowed: ['SCOPED_CARD'],
        fabric: fabricCaps(false),
      }).path,
    ).toBe('HUMAN_HANDOFF');
  });

  it('P17-06 a refund accepted by the provider is not settled until the money arrives', async () => {
    const reservations = new MemoryReservationStore();
    await reservations.setConfirmedBalance({
      groupId: 'g1',
      assetId: 'arc:usdc',
      confirmed: 50_000_000n,
      asOf: T,
    });
    await reservations.reserve(
      {
        reservationId: 'res-t',
        groupId: 'g1',
        assetId: 'arc:usdc',
        amount: '10000000',
        intentId: 'buy-1',
        purpose: 'COMMERCE',
        settlementPlanHash: 'plan',
        expiresAt: T + 600,
      },
      T,
    );
    await reservations.capture('res-t', 10_000_000n, T + 1);
    const store = new MemorySettlementFabricStore();
    const fabric = new SettlementFabric(store, reservations, () => T + 10);
    const order = await fabric.openOrder({
      intentId: 'buy-1',
      groupId: 'g1',
      providerId: 'merchant-testnet',
      mode: 'TESTNET',
      economicEffect: 'TESTNET_TOKENS',
      idempotencyKey: 'synq-buy-key-1',
      amount: usd(1_000),
    });
    const j = new CommerceJourney('j-refund', now);
    for (const s of [
      'DISCOVERED',
      'MATCHED',
      'REVALIDATED',
      'PROVIDERS_IDENTIFIED',
      'APPROVAL_PENDING',
      'APPROVED',
      'RAIL_SELECTED',
      'CHECKOUT_PLACED',
      'RECONCILED',
      'DELIVERY_PENDING',
    ] as const)
      j.advance(s, s);
    // The merchant accepts the return: a claim, not money.
    const accepted = await fabric.recordProviderRefund({
      providerOrderId: order.providerOrderId,
      refundId: 'prr-1',
      amount: usd(1_000),
      providerRef: 'rma-1',
    });
    expect(accepted).toMatchObject({
      ledger: 'PROVIDER_REPORTED_REFUND',
      treasuryCredit: false,
      onchain: null,
    });
    j.advance('REFUND_ACCEPTED', 'provider accepted the return', {
      rma: 'rma-1',
    });
    const free = (await reservations.free('g1', 'arc:usdc')).free;
    expect(
      await code(
        fabric.confirmRefund({
          providerOrderId: order.providerOrderId,
          refundId: 'cfr-1',
          amount: usd(1_000),
          onchain: null,
          reservationId: 'res-t',
          coreAmount: 10_000_000n,
          observedCoreAmount: 10_000_000n,
        }),
      ),
    ).toBe('REFUND_EVIDENCE_REQUIRED');
    // The refund tx exists but less arrived than promised: recorded, not credited.
    const short = await fabric.confirmRefund({
      providerOrderId: order.providerOrderId,
      refundId: 'cfr-2',
      amount: usd(500),
      onchain: { chainId: 5042002, txHash: `0x${'d'.repeat(64)}` },
      reservationId: 'res-t',
      coreAmount: 5_000_000n,
      observedCoreAmount: 4_000_000n,
    });
    expect(short.treasuryCredit).toBe(false);
    expect((await reservations.free('g1', 'arc:usdc')).free).toBe(free);
    const full = await fabric.confirmRefund({
      providerOrderId: order.providerOrderId,
      refundId: 'cfr-3',
      amount: usd(500),
      onchain: { chainId: 5042002, txHash: `0x${'e'.repeat(64)}` },
      reservationId: 'res-t',
      coreAmount: 5_000_000n,
      observedCoreAmount: 5_000_000n,
    });
    expect(full.treasuryCredit).toBe(true);
    j.advance('REFUND_SETTLED', 'refund observed on chain', {
      tx: `0x${'e'.repeat(64)}`,
    });
    expect(() => j.advance('REFUND_ACCEPTED', 'again')).toThrow(
      JourneyTransitionError,
    );
    // A sandbox (card/gift) refund can never be settled into the treasury.
    const sandbox = await fabric.openOrder({
      intentId: 'card-1',
      groupId: 'g1',
      providerId: 'lithic-sandbox',
      mode: 'PROVIDER_SANDBOX',
      economicEffect: 'NONE_SANDBOX',
      idempotencyKey: 'synq-card-key-1',
      amount: usd(1_000),
    });
    expect(
      await code(
        fabric.confirmRefund({
          providerOrderId: sandbox.providerOrderId,
          refundId: 'cfr-s',
          amount: usd(500),
          onchain: { chainId: 5042002, txHash: `0x${'f'.repeat(64)}` },
          reservationId: 'res-t',
          coreAmount: 1n,
          observedCoreAmount: 1n,
        }),
      ),
    ).toBe('SANDBOX_REFUND_NOT_TREASURY_CREDIT');
  });

  it('P17-07 ProfileVault keeps the shipping address away from the agent and model prompts', async () => {
    const keys = new EnvVaultKeyProvider({
      SYNQ_PROFILE_VAULT_KEY: Buffer.alloc(32, 9).toString('base64'),
    });
    const store = new MemoryProfileStore();
    const directory = new ProfileDirectory(store, keys, now);
    const address = {
      name: 'Rosa Quintero',
      line1: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'OR',
      postalCode: '97403',
      country: 'US',
      email: 'rosa.quintero@example.org',
      phone: '+15415550199',
    };
    const { ref, summary } = await directory.put({
      groupId: 'group-1',
      kind: 'SHIPPING',
      data: address,
    });
    const secrets = [
      address.name,
      address.line1,
      'Springfield',
      address.postalCode,
      address.email,
      address.phone,
    ];
    // The agent side only ever holds an opaque ref and a redacted summary.
    for (const s of secrets) expect(summary).not.toContain(s);
    const sealed = JSON.stringify(await store.get(ref));
    for (const s of secrets) expect(sealed).not.toContain(s);
    const j = new CommerceJourney('j-pii', now);
    j.advance('DISCOVERED', 'listing found', { recipientRef: ref });
    expect(() =>
      j.advance('MATCHED', 'x', { recipient: address.line1 }),
    ).toThrow(/UNSAFE_REF/);
    const agentText = JSON.stringify(j.agentView());
    for (const s of secrets) expect(agentText).not.toContain(s);
    // Free text that slips into traces is redacted before any model or log sees it.
    expect(
      JSON.stringify(
        redactDeep({ note: `ship to ${address.email} call ${address.phone}` }),
      ),
    ).not.toMatch(/rosa|5550199/);
    // Only the execution worker decrypts, only the requested fields, for its group, and every access is audited.
    const worker = new ProfileDecryptor(store, keys, now, 'execution-worker');
    expect(
      await code(
        worker.resolve({
          groupId: 'group-2',
          ref,
          kind: 'SHIPPING',
          purpose: 'checkout',
          fields: ['line1'],
        }),
      ),
    ).toBeTruthy();
    const got = await worker.resolve({
      groupId: 'group-1',
      ref,
      kind: 'SHIPPING',
      purpose: 'checkout:monitor-1',
      fields: ['line1', 'postalCode'],
    });
    expect(Object.keys(got).sort()).toEqual(['line1', 'postalCode']);
    expect(worker.audit.map((a) => a.outcome)).toEqual(['DENIED', 'GRANTED']);
    // The Brain zone (agent runtime, model plugins) may not import ProfileVault at all.
    const dir = mkdtempSync(join(tmpdir(), 'synq-p17-'));
    try {
      const files: Record<string, string> = {
        'packages/agent-runtime/package.json': JSON.stringify({
          name: '@synq/agent-runtime',
          exports: './index.ts',
        }),
        'packages/agent-runtime/index.ts':
          "import { ProfileDecryptor } from '@synq/profile-vault';\nexport const x = ProfileDecryptor;\n",
        'packages/profile-vault/package.json': JSON.stringify({
          name: '@synq/profile-vault',
          exports: './index.ts',
        }),
        'packages/profile-vault/index.ts': 'export class ProfileDecryptor {}\n',
      };
      for (const [p, c] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        writeFileSync(join(dir, p), c);
      }
      expect(
        checkArchitecture(dir).some((e: string) => e.includes('ProfileVault')),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
