import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  EconomicOfferSchema,
  EconomicIntentSchema,
} from '@synq/offer-exchange';
import {
  CardSecret,
  LithicEnvironmentError,
  LithicSandboxCardPort,
  LithicSandboxClient,
  MemoryWebhookDeduper,
  SimulatedCardMerchant,
  assertLithicSandbox,
  lithicCardMemo,
  lithicIdempotencyKey,
  redactCardData,
  verifyLithicWebhook,
} from '@synq/plugin-commerce';
import { FakeLithic } from './fake-lithic.js';

const T = 1_780_000_000;
const noSleep = async () => undefined;
function setup() {
  const fake = new FakeLithic();
  const client = new LithicSandboxClient(
    { apiKey: fake.key, environment: 'sandbox' },
    fake.fetch,
    { sleep: noSleep },
  );
  return { fake, client, port: new LithicSandboxCardPort(client) };
}
const intent = EconomicIntentSchema.parse({
  id: 'card-intent-1',
  groupId: 'g1',
  domain: 'COMMERCE',
  objective: 'team lunch',
  subject: { kind: 'PRODUCT', title: 'Team lunch', quantity: 1 },
  hardConstraints: [],
  preferences: [],
  budget: { max: { amount: '2500', currency: 'USD', decimals: 2 } },
  autonomy: { execution: 'QUORUM', substitution: 'NONE' },
  validUntil: T + 3_600,
});
const offer = (cents: number) =>
  EconomicOfferSchema.parse(
    new SimulatedCardMerchant(
      { descriptor: 'SYNQ TEST CAFE', title: 'Team lunch', priceCents: cents },
      () => T,
    ).offer(intent),
  );

describe('Lithic sandbox card adapter', () => {
  it('LIT-001 refuses any non-sandbox environment or base URL', () => {
    for (const c of [
      { apiKey: 'k', environment: 'production' },
      {
        apiKey: 'k',
        environment: 'sandbox',
        baseUrl: 'https://api.lithic.com/v1',
      },
      {
        apiKey: 'k',
        environment: 'sandbox',
        baseUrl: 'http://sandbox.lithic.com/v1',
      },
      {
        apiKey: 'k',
        environment: 'sandbox',
        baseUrl: 'https://sandbox.lithic.com.evil.io/v1',
      },
      { apiKey: '', environment: 'sandbox' },
    ])
      expect(() => assertLithicSandbox(c)).toThrow(LithicEnvironmentError);
    expect(assertLithicSandbox({ apiKey: 'k', environment: 'sandbox' })).toBe(
      'https://sandbox.lithic.com/v1',
    );
  });

  it('LIT-002 issues a virtual card whose spend limit is the granted amount and approves the merchant authorization', async () => {
    const { fake, port } = setup();
    const out = await port.book({
      offer: offer(1840),
      idempotencyKey: 'synq-k1',
    });
    expect(out.status).toBe('CONFIRMED');
    const card = [...fake.cards.values()][0]!;
    expect(card.spend_limit).toBe(1840);
    expect(card.spend_limit_duration).toBe('FOREVER');
    expect(card.type).toBe('VIRTUAL');
    const create = fake.calls.find(
      (c) => c.path === '/cards' && c.method === 'POST',
    )!;
    expect(JSON.parse(create.body!).memo).toBe(lithicCardMemo('synq-k1'));
    expect(JSON.parse(create.body!).memo).toMatch(/^synq:[0-9a-f]{40}$/);
    if (out.status === 'CONFIRMED') {
      expect(out.charged).toEqual({
        amount: '1840',
        currency: 'USD',
        decimals: 2,
      });
      expect(fake.txs.get(out.providerRef)!.result).toBe('APPROVED');
    }
  });

  it('LIT-003 a second, over-mandate authorization on the same card is declined by the issuer', async () => {
    const { fake, client, port } = setup();
    const out = await port.book({
      offer: offer(1840),
      idempotencyKey: 'synq-k2',
    });
    expect(out.status).toBe('CONFIRMED');
    if (out.status !== 'CONFIRMED') return;
    const { secret } = await client.getCard(out.reference!);
    const second = await client.simulateAuthorization(secret!, {
      amountCents: 1000,
      descriptor: 'SYNQ TEST CAFE',
    });
    expect(second.approved).toBe(false);
    expect(second.message).toBe('USER_TRANSACTION_LIMIT');
    expect(fake.txs.get(second.transactionToken!)!.status).toBe('DECLINED');
  });

  it('LIT-004 void, clearing and return are simulated and read back', async () => {
    const { client } = setup();
    const { card, secret } = await client.createCard({
      spendLimitCents: 5000,
      duration: 'FOREVER',
      memo: 'synq:x',
      idempotencyKey: lithicIdempotencyKey('x'),
    });
    const a = await client.simulateAuthorization(secret!, {
      amountCents: 1000,
      descriptor: 'M1',
    });
    const b = await client.simulateAuthorization(secret!, {
      amountCents: 500,
      descriptor: 'M2',
    });
    await client.simulateVoid(a.transactionToken!);
    await client.simulateClearing(b.transactionToken!);
    const ret = await client.simulateReturn(secret!, {
      amountCents: 500,
      descriptor: 'M2',
    });
    expect((await client.getTransaction(a.transactionToken!)).status).toBe(
      'VOIDED',
    );
    expect((await client.getTransaction(b.transactionToken!)).status).toBe(
      'SETTLED',
    );
    expect(ret).toBeTruthy();
    expect((await client.listTransactions(card.token)).length).toBe(3);
    expect((await client.setCardState(card.token, 'PAUSED')).state).toBe(
      'PAUSED',
    );
    expect((await client.setCardState(card.token, 'CLOSED')).state).toBe(
      'CLOSED',
    );
  });

  it('LIT-005 never exposes PAN or CVV through results, JSON, inspection or errors', async () => {
    const { fake, client, port } = setup();
    const out = await port.book({
      offer: offer(1200),
      idempotencyKey: 'synq-k5',
    });
    const card = [...fake.cards.values()][0]!;
    const pan = card.pan as string;
    const { card: view, secret } = await client.getCard(card.token as string);
    const dumped = [
      JSON.stringify(out),
      JSON.stringify(view),
      JSON.stringify({ secret }),
      String(secret),
      inspect(secret),
      inspect(view),
    ].join('\n');
    expect(dumped).not.toContain(pan);
    expect(dumped).not.toContain('776');
    expect(() => secret!.reveal({} as LithicSandboxClient)).toThrow();
    expect(redactCardData(`pan ${pan} "cvv":"776"`)).toBe(
      'pan [PAN] "cvv":"[REDACTED]"',
    );
    fake.failNext.push({ path: /^\/cards$/, status: 400 });
    const failed = await port.book({
      offer: offer(1200),
      idempotencyKey: 'synq-k5b',
    });
    expect(JSON.stringify(failed)).not.toContain(fake.key);
    expect(() => new CardSecret('12', '0000')).toThrow();
  });

  it('LIT-006 rate limits are retried; a timeout on create is an unknown outcome reconciled by memo', async () => {
    const { fake, port } = setup();
    fake.failNext.push({ path: /^\/simulate\/authorize$/, status: 429 });
    expect(
      (await port.book({ offer: offer(900), idempotencyKey: 'synq-k6' }))
        .status,
    ).toBe('CONFIRMED');
    fake.failNext.push({
      path: /^\/simulate\/authorize$/,
      status: 0,
      throws: true,
    });
    const unknown = await port.book({
      offer: offer(900),
      idempotencyKey: 'synq-k7',
    });
    expect(unknown.status).toBe('UNKNOWN');
    const found = await port.find({
      offer: offer(900),
      idempotencyKey: 'synq-k7',
    });
    expect(found!.status).toBe('UNKNOWN');
    expect(
      await port.find({ offer: offer(900), idempotencyKey: 'never' }),
    ).toBeNull();
    const ok = await port.find({
      offer: offer(900),
      idempotencyKey: 'synq-k6',
    });
    expect(ok!.status).toBe('CONFIRMED');
  });

  it('LIT-007 a duplicate request reuses the same card via the idempotency key', async () => {
    const { fake, port } = setup();
    await port.book({ offer: offer(700), idempotencyKey: 'synq-dup' });
    await port.book({ offer: offer(700), idempotencyKey: 'synq-dup' });
    expect(fake.cards.size).toBe(1);
    const keys = fake.calls
      .filter((c) => c.path === '/cards' && c.method === 'POST')
      .map(() => lithicIdempotencyKey('synq-dup'));
    expect(new Set(keys).size).toBe(1);
  });

  it('LIT-008 an unauthorized key fails definitively; cancel voids and closes', async () => {
    const fake = new FakeLithic();
    const bad = new LithicSandboxCardPort(
      new LithicSandboxClient(
        { apiKey: 'wrong', environment: 'sandbox' },
        fake.fetch,
        {
          sleep: noSleep,
        },
      ),
    );
    expect(
      (await bad.book({ offer: offer(700), idempotencyKey: 'k' })).status,
    ).toBe('FAILED');
    const { port, fake: f2 } = setup();
    const out = await port.book({
      offer: offer(700),
      idempotencyKey: 'synq-c',
    });
    if (out.status !== 'CONFIRMED') throw new Error('expected confirm');
    const c = await port.cancel({
      offer: offer(700),
      providerRef: out.providerRef,
    });
    expect(c.confirmed).toBe(true);
    expect(c.refund).toBeNull();
    expect(f2.txs.get(out.providerRef)!.status).toBe('VOIDED');
    expect(f2.cards.get(out.reference!)!.state).toBe('CLOSED');
  });
});

describe('Lithic reconcile with long (bytes32 group) keys', () => {
  it('LIT-011 memos are fixed-length hashes of the full key: distinct per booking and found exactly on reconcile', async () => {
    const { fake, port, client } = setup();
    const g = `0x${'ab'.repeat(32)}`;
    const keyA = `synq:${g}:booking-A:workflow-${'x'.repeat(40)}`;
    const keyB = `synq:${g}:booking-B:workflow-${'x'.repeat(40)}`;
    expect(lithicCardMemo(keyA)).not.toBe(lithicCardMemo(keyB));
    expect(lithicCardMemo(keyA).length).toBeLessThanOrEqual(120);
    fake.failNext.push({
      path: /^\/simulate\/authorize$/,
      status: 0,
      throws: true,
    });
    expect(
      (await port.book({ offer: offer(900), idempotencyKey: keyA })).status,
    ).toBe('UNKNOWN');
    expect(
      await port.find({ offer: offer(900), idempotencyKey: keyB }),
    ).toBeNull();
    const a = await port.find({ offer: offer(900), idempotencyKey: keyA });
    expect(a!.status).toBe('UNKNOWN');
    expect(
      (await port.book({ offer: offer(900), idempotencyKey: keyB })).status,
    ).toBe('CONFIRMED');
    const b = await port.find({ offer: offer(900), idempotencyKey: keyB });
    expect(b!.status).toBe('CONFIRMED');
    expect(fake.cards.size).toBe(2);
    await expect(
      client.createCard({
        spendLimitCents: 1,
        duration: 'FOREVER',
        memo: 'm'.repeat(121),
        idempotencyKey: 'x',
      }),
    ).rejects.toThrow(/memo too long/);
  });
});

describe('Lithic webhook verification', () => {
  const secret = `whsec_${Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')}`;
  const sign = (id: string, ts: number, body: string) =>
    `v1,${createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
      .update(`${id}.${ts}.${body}`)
      .digest('base64')}`;
  const body = JSON.stringify({
    event_type: 'card_transaction.updated',
    payload: {},
  });

  it('LIT-009 accepts a valid signature (also among rotated signatures) and dedupes redeliveries', async () => {
    const headers = {
      'Webhook-Id': 'msg_1',
      'Webhook-Timestamp': String(T),
      'Webhook-Signature': `v1,AAAA ${sign('msg_1', T, body)}`,
    };
    const v = verifyLithicWebhook({
      rawBody: body,
      headers,
      secret,
      now: T + 10,
    });
    expect(v.id).toBe('msg_1');
    const d = new MemoryWebhookDeduper();
    expect(await d.firstSeen(v.id)).toBe(true);
    expect(await d.firstSeen(v.id)).toBe(false);
  });

  it('LIT-010 rejects tampered bodies, wrong secrets, stale timestamps and missing headers', () => {
    const good = {
      'webhook-id': 'msg_2',
      'webhook-timestamp': String(T),
      'webhook-signature': sign('msg_2', T, body),
    };
    expect(() =>
      verifyLithicWebhook({
        rawBody: `${body} `,
        headers: good,
        secret,
        now: T,
      }),
    ).toThrow(/signature/);
    expect(() =>
      verifyLithicWebhook({
        rawBody: body,
        headers: good,
        secret: `whsec_${Buffer.from('x'.repeat(32)).toString('base64')}`,
        now: T,
      }),
    ).toThrow(/signature/);
    expect(() =>
      verifyLithicWebhook({
        rawBody: body,
        headers: good,
        secret,
        now: T + 301,
      }),
    ).toThrow(/tolerance/);
    expect(() =>
      verifyLithicWebhook({
        rawBody: body,
        headers: { 'webhook-id': 'x' },
        secret,
        now: T,
      }),
    ).toThrow(/missing/);
  });
});
