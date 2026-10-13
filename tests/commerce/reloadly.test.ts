import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  EconomicIntentSchema,
  EconomicOfferSchema,
  type EconomicOffer,
} from '@synq/offer-exchange';
import {
  RELOADLY,
  ReloadlyClient,
  ReloadlyEnvironmentError,
  ReloadlyGiftCardPort,
  ReloadlyGiftCardProvider,
  assertReloadlySandbox,
  checkDenomination,
  checkedGiftCardSubject,
  decimalMoney,
  type GiftCodeSealer,
} from '@synq/plugin-commerce';
import {
  EnvVaultKeyProvider,
  GiftCodeVault,
  MemoryProfileStore,
  ProfileDecryptor,
  ProfileDirectory,
} from '@synq/profile-vault';
import { FakeReloadly } from './fake-reloadly.js';

const T = 1_780_000_000;
const now = () => T;

async function setup(opts: { sealer?: boolean } = {}) {
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
  const store = new MemoryProfileStore();
  const directory = new ProfileDirectory(store, keys, now);
  const { ref: recipientRef } = await directory.put({
    groupId: 'g1',
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
  const sealed: string[] = [];
  const vault = new GiftCodeVault(store, keys, now);
  const sealer: GiftCodeSealer = {
    seal: async (i) => {
      const r = await vault.seal(i);
      sealed.push(r.ref);
      return r;
    },
  };
  const port = new ReloadlyGiftCardPort(
    client,
    opts.sealer === false ? null : sealer,
    directory,
  );
  const provider = new ReloadlyGiftCardProvider(client, now, directory);
  const decryptor = new ProfileDecryptor(store, keys, now, 'delivery-worker');
  return {
    fake,
    client,
    port,
    provider,
    recipientRef,
    sealed,
    decryptor,
    directory,
  };
}

const intentFor = (recipientRef: string, over: Record<string, string> = {}) =>
  EconomicIntentSchema.parse({
    id: 'gift-intent-1',
    groupId: 'g1',
    domain: 'COMMERCE',
    objective: 'buy a $10 gift card',
    subject: {
      kind: 'PRODUCT',
      title: 'Amazon US gift card $10',
      quantity: 1,
      attributes: {
        giftProduct: 'Amazon',
        country: 'US',
        faceCurrency: 'USD',
        denominationCents: '1000',
        recipientRef,
        ...over,
      },
    },
    hardConstraints: [],
    preferences: [],
    budget: { max: { amount: '2500', currency: 'USD', decimals: 2 } },
    autonomy: { execution: 'QUORUM', substitution: 'NONE' },
    validUntil: T + 3_600,
  });

async function giftOffer(
  w: Awaited<ReturnType<typeof setup>>,
): Promise<EconomicOffer> {
  const offers = await w.provider.search(intentFor(w.recipientRef));
  expect(offers).toHaveLength(1);
  return EconomicOfferSchema.parse(offers[0]);
}

describe('Reloadly gift card sandbox adapter', () => {
  it('RLD-001 accepts only the gift card sandbox', () => {
    const base = { clientId: 'a', clientSecret: 'b' };
    expect(() =>
      assertReloadlySandbox({ ...base, environment: 'production' }),
    ).toThrow(ReloadlyEnvironmentError);
    expect(() =>
      assertReloadlySandbox({
        ...base,
        environment: 'sandbox',
        baseUrl: 'https://giftcards.reloadly.com',
      }),
    ).toThrow(ReloadlyEnvironmentError);
    expect(() =>
      assertReloadlySandbox({
        clientId: '',
        clientSecret: '',
        environment: 'sandbox',
      }),
    ).toThrow();
  });

  it('RLD-002 discovers a priced offer that binds product, denomination, currency, country and recipient', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    expect(offer.providerRef).toBe('reloadly:5:US:1000:USD');
    expect(offer.fulfillmentProviderId).toBe(RELOADLY);
    expect(offer.price.base).toEqual({
      amount: '1000',
      currency: 'USD',
      decimals: 2,
    });
    expect(offer.price.fees).toEqual({
      amount: '50',
      currency: 'USD',
      decimals: 2,
    });
    expect(
      offer.subject.kind === 'PRODUCT' && offer.subject.attributes,
    ).toMatchObject({
      reloadlyProductId: '5',
      country: 'US',
      denominationCents: '1000',
      faceCurrency: 'USD',
      recipientRef: w.recipientRef,
    });
    expect(offer.evidence).toBe('PROVIDER_SANDBOX');
  });

  it('RLD-003 orders once with the idempotency key as customIdentifier and seals the code privately', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-1' });
    expect(out.status).toBe('CONFIRMED');
    if (out.status !== 'CONFIRMED') return;
    expect(out.charged).toEqual({
      amount: '1050',
      currency: 'USD',
      decimals: 2,
    });
    expect(w.fake.orders).toHaveLength(1);
    expect(w.fake.orders[0]!.customIdentifier).toBe(
      ReloadlyGiftCardPort.customIdentifier('synq-gift-1'),
    );
    expect(w.fake.orders[0]!.customIdentifier).toMatch(/^synq-[0-9a-f]{40}$/);
    expect(w.fake.orders[0]!.recipientEmail).toBeNull();
    expect(w.sealed).toHaveLength(1);
    expect(JSON.stringify(out)).not.toContain(w.fake.code);
    const opened = await w.decryptor.resolve({
      groupId: 'g1',
      ref: w.sealed[0]!,
      kind: 'GIFT_CODE',
      purpose: 'deliver-to-recipient',
      fields: ['codes'],
    });
    expect(opened.codes[0]!.cardNumber).toBe(w.fake.code);
  });

  it('RLD-004 an invalid product fails before any order', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    w.fake.products = w.fake.products.filter((p) => p.productId !== 5);
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-2' });
    expect(out.status).toBe('FAILED');
    expect(w.fake.orders).toHaveLength(0);
  });

  it('RLD-005 unsupported country, unsupported currency and invalid denomination are refused', async () => {
    const w = await setup();
    const product = await w.client.product(5);
    const want = {
      countryCode: 'US',
      recipientCurrency: 'USD',
      unitPrice: 10,
      senderCurrency: 'USD',
    };
    expect(
      checkDenomination(product, { ...want, countryCode: 'GB' }),
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_COUNTRY' });
    expect(
      checkDenomination(product, { ...want, recipientCurrency: 'EUR' }),
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_CURRENCY' });
    expect(
      checkDenomination(product, { ...want, senderCurrency: 'NGN' }),
    ).toMatchObject({ ok: false, code: 'UNSUPPORTED_CURRENCY' });
    expect(
      checkDenomination(product, { ...want, unitPrice: 12 }),
    ).toMatchObject({ ok: false, code: 'INVALID_DENOMINATION' });
    const range = await w.client.product(4);
    expect(
      checkDenomination(range, {
        countryCode: 'ES',
        recipientCurrency: 'EUR',
        unitPrice: 200,
        senderCurrency: 'USD',
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_DENOMINATION' });
    const ok = checkDenomination(range, {
      countryCode: 'ES',
      recipientCurrency: 'EUR',
      unitPrice: 10,
      senderCurrency: 'USD',
    });
    expect(ok.ok && ok.senderCost.amount).toBe('1120');
    expect(
      await w.provider.search(intentFor(w.recipientRef, { country: 'FR' })),
    ).toHaveLength(0);
    expect(
      await w.provider.search(
        intentFor(w.recipientRef, { denominationCents: '1200' }),
      ),
    ).toHaveLength(0);
  });

  it('RLD-006 insufficient sandbox balance fails before any order', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    w.fake.balance = 5;
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-3' });
    expect(out).toEqual({
      status: 'FAILED',
      reason: 'INSUFFICIENT_SANDBOX_BALANCE',
    });
    expect(w.fake.orders).toHaveLength(0);
  });

  it('RLD-007 an expired token is refreshed once; failed auth is a definitive failure', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    for (const t of w.fake.tokens) w.fake.revoked.add(t);
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-4' });
    expect(out.status).toBe('CONFIRMED');
    expect(w.fake.tokenRequests).toBe(2);
    const bad = await setup();
    const badOffer = await giftOffer(bad);
    bad.fake.faults.authFail = true;
    for (const t of bad.fake.tokens) bad.fake.revoked.add(t);
    const failed = await bad.port.book({
      offer: badOffer,
      idempotencyKey: 'synq-gift-5',
    });
    expect(failed.status).toBe('FAILED');
    expect(JSON.stringify(failed)).not.toContain(bad.fake.clientSecret);
    expect(bad.fake.orders).toHaveLength(0);
  });

  it('RLD-008 a duplicate request never orders twice', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    const a = await w.port.book({ offer, idempotencyKey: 'synq-gift-6' });
    const b = await w.port.book({ offer, idempotencyKey: 'synq-gift-6' });
    expect(a.status).toBe('CONFIRMED');
    expect(b).toEqual(a);
    expect(w.fake.orders).toHaveLength(1);
  });

  it('RLD-009 a timeout after the provider committed is UNKNOWN and reconciles idempotently', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    w.fake.faults.order = 'TIMEOUT_AFTER_COMMIT';
    w.fake.faults.reportsLag = 1;
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-7' });
    expect(out.status).toBe('UNKNOWN');
    expect(
      await w.port.find({ offer, idempotencyKey: 'synq-gift-7' }),
    ).toBeNull();
    const r1 = await w.port.find({ offer, idempotencyKey: 'synq-gift-7' });
    const r2 = await w.port.find({ offer, idempotencyKey: 'synq-gift-7' });
    expect(r1!.status).toBe('CONFIRMED');
    expect(r2).toEqual(r1);
    expect(w.fake.orders).toHaveLength(1);
  });

  it('RLD-010 partial failures: a 500 and a PENDING order stay UNKNOWN; code retrieval failure keeps the order', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    w.fake.faults.order = '500';
    expect(
      (await w.port.book({ offer, idempotencyKey: 'synq-gift-8' })).status,
    ).toBe('UNKNOWN');
    w.fake.faults.order = 'PENDING';
    expect(
      (await w.port.book({ offer, idempotencyKey: 'synq-gift-9' })).status,
    ).toBe('UNKNOWN');
    const v = await setup();
    const vOffer = await giftOffer(v);
    const broken: GiftCodeSealer = {
      seal: async () => {
        throw new Error('vault down');
      },
    };
    const port = new ReloadlyGiftCardPort(v.client, broken, v.directory);
    const out = await port.book({
      offer: vOffer,
      idempotencyKey: 'synq-gift-10',
    });
    expect(out.status).toBe('CONFIRMED');
  });

  it('RLD-011 an inconsistent amount or product is held as UNKNOWN for recourse', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    w.fake.faults.order = 'OVERCHARGE';
    const out = await w.port.book({ offer, idempotencyKey: 'synq-gift-11' });
    expect(out.status).toBe('UNKNOWN');
    expect(out.status === 'UNKNOWN' && out.reason).toMatch(
      /INCONSISTENT_AMOUNT/,
    );
    w.fake.faults.order = 'WRONG_PRODUCT';
    const out2 = await w.port.book({ offer, idempotencyKey: 'synq-gift-12' });
    expect(out2.status === 'UNKNOWN' && out2.reason).toMatch(/product differs/);
  });

  it('RLD-012 a tampered offer subject is refused before contacting the provider', async () => {
    const w = await setup();
    const offer = await giftOffer(w);
    const tampered = EconomicOfferSchema.parse({
      ...offer,
      providerRef: 'reloadly:5:US:5000:USD',
    });
    const calls = w.fake.calls.length;
    expect(
      (await w.port.book({ offer: tampered, idempotencyKey: 'synq-gift-13' }))
        .status,
    ).toBe('FAILED');
    expect(w.fake.calls.length).toBe(calls);
  });

  it('RLD-013 without a sealer the redeem codes are never fetched', async () => {
    const w = await setup({ sealer: false });
    const offer = await giftOffer(w);
    expect(
      (await w.port.book({ offer, idempotencyKey: 'synq-gift-14' })).status,
    ).toBe('CONFIRMED');
    expect(w.fake.calls.some((c) => c.includes('/cards'))).toBe(false);
  });

  it('RLD-014 float amounts are converted to cents rounding up', () => {
    expect(decimalMoney(10.56, 'USD').amount).toBe('1056');
    expect(decimalMoney(60553.3575, 'USD').amount).toBe('6055336');
    expect(decimalMoney(0.1 + 0.2, 'USD').amount).toBe('30');
  });
});

describe('Reloadly identifiers and gift-code custody (security re-check)', () => {
  const G = `0x${'8241ac62'.repeat(8)}`;
  async function world() {
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
    const store = new MemoryProfileStore();
    const dir = new ProfileDirectory(store, keys, now);
    const person = (name: string) => ({
      name,
      line1: '1 Main St',
      city: 'Austin',
      postalCode: '73301',
      country: 'US',
      email: `${name.toLowerCase()}@example.com`,
    });
    const ra = (
      await dir.put({ groupId: G, kind: 'RECIPIENT', data: person('Ann') })
    ).ref;
    const rb = (
      await dir.put({ groupId: G, kind: 'RECIPIENT', data: person('Ben') })
    ).ref;
    const other = (
      await dir.put({
        groupId: 'other-group',
        kind: 'RECIPIENT',
        data: person('Eve'),
      })
    ).ref;
    const traveler = (
      await dir.put({
        groupId: G,
        kind: 'TRAVELER',
        data: {
          givenName: 'T',
          familyName: 'R',
          bornOn: '1990-01-01',
          email: 't@example.com',
          phone: '+14155550100',
        },
      })
    ).ref;
    const vault = new GiftCodeVault(store, keys, now);
    const port = new ReloadlyGiftCardPort(client, vault, dir);
    const provider = new ReloadlyGiftCardProvider(client, now, dir);
    const decryptor = new ProfileDecryptor(store, keys, now, 'delivery-worker');
    const offerFor = async (id: string, recipientRef: string) => {
      const intent = EconomicIntentSchema.parse({
        ...intentFor(recipientRef),
        id,
        groupId: G,
      });
      return EconomicOfferSchema.parse((await provider.search(intent))[0]);
    };
    const search = (id: string, recipientRef: string) =>
      provider.search(
        EconomicIntentSchema.parse({
          ...intentFor(recipientRef),
          id,
          groupId: G,
        }),
      );
    return {
      fake,
      store,
      vault,
      port,
      ra,
      rb,
      other,
      traveler,
      dir,
      offerFor,
      search,
      decryptor,
    };
  }

  it('SEC-H1 two bookings in a bytes32 group get distinct identifiers; B never adopts A’s order or codes', async () => {
    const w = await world();
    const keyA = `synq:${G}:booking-A:booking-booking-A-${'9'.repeat(12)}`;
    const keyB = `synq:${G}:booking-B:booking-booking-B-${'9'.repeat(12)}`;
    const idA = ReloadlyGiftCardPort.customIdentifier(keyA);
    const idB = ReloadlyGiftCardPort.customIdentifier(keyB);
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^synq-[0-9a-f]{40}$/);
    const offerA = await w.offerFor('gift-A', w.ra);
    const offerB = await w.offerFor('gift-B', w.rb);
    const a = await w.port.book({ offer: offerA, idempotencyKey: keyA });
    expect(a.status).toBe('CONFIRMED');
    // Booking B's pre-submit lookup must not see A's transaction.
    expect(
      await w.port.find({ offer: offerB, idempotencyKey: keyB }),
    ).toBeNull();
    const b = await w.port.book({ offer: offerB, idempotencyKey: keyB });
    expect(b.status).toBe('CONFIRMED');
    if (a.status !== 'CONFIRMED' || b.status !== 'CONFIRMED') return;
    expect(b.providerRef).not.toBe(a.providerRef);
    expect(w.fake.orders.map((o) => o.customIdentifier)).toEqual([idA, idB]);
    const sealed = [...w.store.records.values()].filter(
      (r) => r.kind === 'GIFT_CODE',
    );
    expect(sealed).toHaveLength(2);
    const open = (ref: string) =>
      w.decryptor.resolve({
        groupId: G,
        ref,
        kind: 'GIFT_CODE',
        purpose: 'deliver',
        fields: ['recipientRef', 'transactionId'],
      });
    const opened = await Promise.all(sealed.map((r) => open(r.ref)));
    expect(opened.map((o) => [o.transactionId, o.recipientRef]).sort()).toEqual(
      [
        [a.providerRef, w.ra],
        [b.providerRef, w.rb],
      ].sort(),
    );
    // Reconciling A again re-uses A's sealed record; it never re-seals to B.
    expect(
      (await w.port.find({ offer: offerA, idempotencyKey: keyA }))!.status,
    ).toBe('CONFIRMED');
    expect(
      [...w.store.records.values()].filter((r) => r.kind === 'GIFT_CODE'),
    ).toHaveLength(2);
    await expect(
      w.vault.seal({
        provider: 'reloadly',
        transactionId: a.providerRef,
        groupId: G,
        recipientRef: w.rb,
        codes: [{ cardNumber: 'x' }],
      }),
    ).rejects.toThrow(/TAMPERED/);
  });

  it('SEC-M1 gift codes seal only to a RECIPIENT/SHIPPING record of the ordering group', async () => {
    const w = await world();
    const codes = [{ cardNumber: 'c' }];
    await expect(
      w.vault.seal({
        provider: 'reloadly',
        transactionId: '1',
        groupId: G,
        recipientRef: w.other,
        codes,
      }),
    ).rejects.toThrow(/WRONG_GROUP/);
    await expect(
      w.vault.seal({
        provider: 'reloadly',
        transactionId: '2',
        groupId: G,
        recipientRef: w.traveler,
        codes,
      }),
    ).rejects.toThrow(/FIELD_NOT_ALLOWED/);
    const offer = await w.offerFor('gift-X', w.ra);
    // An offer without its group binding is refused before contacting the provider.
    const unbound = EconomicOfferSchema.parse({
      ...offer,
      subject: {
        ...offer.subject,
        attributes: {
          ...(offer.subject.kind === 'PRODUCT' ? offer.subject.attributes : {}),
          groupId: '',
        },
      },
    });
    expect(
      (await w.port.book({ offer: unbound, idempotencyKey: 'k-unbound' }))
        .status,
    ).toBe('FAILED');
  });

  it('SEC-N3 a recipient outside the ordering group never reaches the provider', async () => {
    const w = await world();
    // Offer creation: no offer, and no catalog call, for a foreign or non-recipient ref.
    const before = w.fake.calls.length;
    expect(await w.search('gift-other', w.other)).toEqual([]);
    expect(await w.search('gift-traveler', w.traveler)).toEqual([]);
    expect(await w.search('gift-missing', 'pv_' + '0'.repeat(32))).toEqual([]);
    expect(w.fake.calls.length).toBe(before);
    // Booking: an offer rewritten to another recipient fails before any provider call.
    const offer = await w.offerFor('gift-N3', w.ra);
    const attrs =
      offer.subject.kind === 'PRODUCT' ? offer.subject.attributes : {};
    const calls = w.fake.calls.length;
    for (const recipientRef of [w.other, w.traveler]) {
      const forged = EconomicOfferSchema.parse({
        ...offer,
        subject: { ...offer.subject, attributes: { ...attrs, recipientRef } },
      });
      const out = await w.port.book({
        offer: forged,
        idempotencyKey: `synq:${G}:n3:${recipientRef}`,
      });
      expect(out).toMatchObject({
        status: 'FAILED',
        reason: expect.stringMatching(/^RECIPIENT_INVALID/),
      });
    }
    expect(w.fake.calls.length).toBe(calls);
    expect(w.fake.orders).toHaveLength(0);
    expect(
      [...w.store.records.values()].filter((r) => r.kind === 'GIFT_CODE'),
    ).toHaveLength(0);
  });

  it('SEC-N3 intent subjects are built only for the group recipient records', async () => {
    const w = await world();
    const input = {
      brand: 'Amazon',
      countryCode: 'US',
      recipientCurrency: 'USD',
      unitPriceCents: 1000,
    };
    await expect(
      checkedGiftCardSubject(w.dir, G, { ...input, recipientRef: w.ra }),
    ).resolves.toMatchObject({ attributes: { recipientRef: w.ra } });
    await expect(
      checkedGiftCardSubject(w.dir, G, { ...input, recipientRef: w.other }),
    ).rejects.toThrow(/RECIPIENT_INVALID/);
    await expect(
      checkedGiftCardSubject(w.dir, G, { ...input, recipientRef: w.traveler }),
    ).rejects.toThrow(/RECIPIENT_INVALID/);
  });
});
