import { describe, expect, it } from 'vitest';
import {
  BitrefillClient,
  RealMoneyGate,
  lifecycleOf,
  settlementFabricCapabilities,
  treasuryCanPay,
  validateBitrefillPurchase,
  type HttpFetch,
  type RealMoneyApproval,
} from '@synq/plugin-commerce';
import { selectExecutionRoute } from '@synq/settlement';

/** Response bodies shaped after the Bitrefill v2 API reference examples. */
const PRODUCT = {
  id: 'test-gift-card-code',
  name: 'Test Gift Card Code',
  country_code: 'US',
  currency: 'USD',
  in_stock: true,
  packages: [{ id: 'test-gift-card-code<&>10', value: 10, price: 12 }],
  range: { min: 10, max: 100, step: 10, price_rate: 1.2 },
};
function fake() {
  const calls: { method: string; url: string; auth: string; body?: string }[] =
    [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push({
      method: init.method,
      url,
      auth: init.headers.Authorization ?? '',
      ...(init.body ? { body: init.body } : {}),
    });
    const u = new URL(url);
    const body =
      u.pathname === '/v2/ping'
        ? { meta: {}, data: { message: 'pong' } }
        : u.pathname === '/v2/products/search'
          ? { meta: { q: u.searchParams.get('q') }, data: [PRODUCT] }
          : u.pathname.startsWith('/v2/products/')
            ? { meta: {}, data: PRODUCT }
            : u.pathname === '/v2/invoices' && init.method === 'POST'
              ? {
                  data: {
                    id: 'inv-1',
                    status: 'unpaid',
                    payment: {
                      method: JSON.parse(init.body!).payment_method,
                      price: 0.00012,
                      currency: 'BTC',
                    },
                    orders: [{ id: 'o1', status: 'created' }],
                  },
                }
              : u.pathname === '/v2/invoices/inv-1'
                ? {
                    data: {
                      id: 'inv-1',
                      status: 'complete',
                      payment: {
                        method: 'usdc_base',
                        price: 12,
                        currency: 'USDC',
                      },
                      orders: [{ id: 'o1', status: 'delivered' }],
                    },
                  }
                : null;
    return {
      status: body ? 200 : 404,
      text: async () => JSON.stringify(body ?? { message: 'not found' }),
    };
  };
  return { calls, fetch };
}

describe('Bitrefill read-only adapter', () => {
  it('BRF-001 authenticates per API kind and reads catalog, product and invoice state', async () => {
    const f = fake();
    const personal = new BitrefillClient(
      { kind: 'PERSONAL', apiKey: 'pk_x' },
      f.fetch,
    );
    expect(await personal.ping()).toBe(true);
    expect(f.calls[0]!.auth).toBe('Bearer pk_x');
    const business = new BitrefillClient(
      { kind: 'BUSINESS', apiId: 'id', apiSecret: 'sec' },
      f.fetch,
    );
    await business.ping();
    expect(f.calls[1]!.auth).toBe(
      `Basic ${Buffer.from('id:sec').toString('base64')}`,
    );
    const [p] = await personal.searchProducts('test');
    expect(p!.packages[0]!.id).toBe('test-gift-card-code<&>10');
    const inv = await personal.invoice('inv-1');
    expect(inv.lifecycle).toBe('DELIVERED');
    expect(
      () =>
        new BitrefillClient(
          { kind: 'PERSONAL', apiKey: 'k', baseUrl: 'https://evil.example/v2' },
          f.fetch,
        ),
    ).toThrow();
  });

  it('BRF-002 validates country, currency and denomination (packages and stepped ranges)', () => {
    const p = {
      id: 'x',
      name: 'x',
      countryCode: 'US',
      currency: 'USD',
      inStock: true,
      packages: [{ id: 'x<&>10', value: 10, price: 12 }],
      range: { min: 10, max: 100, step: 10, priceRate: 1.2 },
    };
    const want = { countryCode: 'US', currency: 'USD', value: 10 };
    expect(validateBitrefillPurchase(p, want)).toMatchObject({
      ok: true,
      packageId: 'x<&>10',
    });
    expect(validateBitrefillPurchase(p, { ...want, value: 30 })).toMatchObject({
      ok: true,
      packageId: null,
    });
    expect(validateBitrefillPurchase(p, { ...want, value: 35 })).toMatchObject({
      code: 'INVALID_DENOMINATION',
    });
    expect(
      validateBitrefillPurchase(p, { ...want, countryCode: 'DE' }),
    ).toMatchObject({ code: 'UNSUPPORTED_COUNTRY' });
    expect(
      validateBitrefillPurchase(p, { ...want, currency: 'EUR' }),
    ).toMatchObject({ code: 'UNSUPPORTED_CURRENCY' });
    expect(
      validateBitrefillPurchase({ ...p, inStock: false }, want),
    ).toMatchObject({ code: 'OUT_OF_STOCK' });
  });

  it('BRF-003 maps documented invoice/order statuses to the lifecycle', () => {
    expect(lifecycleOf('unpaid')).toBe('AWAITING_PAYMENT');
    expect(lifecycleOf('payment_detected')).toBe('PAYMENT_DETECTED');
    expect(lifecycleOf('payment_confirmed')).toBe('PAYMENT_CONFIRMED');
    expect(lifecycleOf('pending')).toBe('FULFILLING');
    expect(lifecycleOf('complete', ['delivered'])).toBe('DELIVERED');
    expect(lifecycleOf('complete', ['delivered', 'processing'])).toBe(
      'UNKNOWN_OUTCOME',
    );
    expect(lifecycleOf('denied')).toBe('REJECTED');
    expect(lifecycleOf('payment_error')).toBe('PAYMENT_ERROR');
    expect(lifecycleOf('complete', ['refunded'])).toBe('REFUNDED');
    expect(lifecycleOf('something-new')).toBe('UNKNOWN_OUTCOME');
  });

  it('BRF-004 the router checks the invoice network/asset; Monad AUSD is not payable', () => {
    const monad = [{ chain: 'monad-testnet', asset: 'AUSD' }];
    expect(treasuryCanPay('usdc_base', monad)).toBe(false);
    expect(
      treasuryCanPay('balance', [
        { chain: 'bitrefill-account', asset: 'ACCOUNT_BALANCE' },
      ]),
    ).toBe(false);
    expect(
      treasuryCanPay('usdc_base', [{ chain: 'base', asset: 'USDC' }]),
    ).toBe(true);
    const caps = settlementFabricCapabilities({ BITREFILL_API_KEY: 'k' });
    const d = selectExecutionRoute(
      {
        intentId: 'i',
        product: 'GIFT_CARD',
        currency: 'USD',
        requiredChain: { chain: 'monad-testnet', asset: 'AUSD' },
        allowedModes: ['MAINNET_READ_ONLY', 'REAL_MONEY_APPROVAL_REQUIRED'],
        categories: ['CRYPTO_COMMERCE_REAL'],
      },
      caps,
    );
    expect(d.status).toBe('UNAVAILABLE');
    const bitrefill = caps.find((c) => c.providerId === 'bitrefill')!;
    expect(bitrefill.partnerGated).toBe(true);
    expect(bitrefill.statusReason).toMatch(/PARTNER_GATED/);
  });

  it('BRF-005 invoice preview is off by default and never uses balance or auto_pay', async () => {
    const f = fake();
    const off = new BitrefillClient({ kind: 'PERSONAL', apiKey: 'k' }, f.fetch);
    await expect(
      off.previewInvoice({
        productId: 'x',
        packageId: null,
        value: 10,
        paymentMethod: 'bitcoin',
      }),
    ).rejects.toThrow(/INVOICE_PREVIEW_DISABLED/);
    const on = new BitrefillClient({ kind: 'PERSONAL', apiKey: 'k' }, f.fetch, {
      allowInvoicePreview: true,
    });
    await expect(
      on.previewInvoice({
        productId: 'x',
        packageId: null,
        value: 10,
        paymentMethod: 'balance',
      }),
    ).rejects.toThrow(/crypto/);
    const inv = await on.previewInvoice({
      productId: 'test-gift-card-code',
      packageId: 'test-gift-card-code<&>10',
      value: 10,
      paymentMethod: 'bitcoin',
    });
    expect(inv.invoiceId).toBe('inv-1');
    const sent = JSON.parse(f.calls.at(-1)!.body!);
    expect(sent.auto_pay).toBe(false);
    expect(sent.payment_method).toBe('bitcoin');
  });

  it('BRF-006 paying an invoice is denied by default and has no broadcast path even when approved', async () => {
    const f = fake();
    const c = new BitrefillClient({ kind: 'PERSONAL', apiKey: 'k' }, f.fetch);
    const approval: RealMoneyApproval = {
      approvalId: 'a1',
      invoiceId: 'inv-1',
      approvedBy: 'human:alice',
      humanVerified: true,
      capMinor: 1_200n,
      currency: 'USD',
      expiresAt: 2_000,
    };
    const base = {
      invoiceId: 'inv-1',
      amountMinor: 1_000n,
      currency: 'USD',
      approval,
      now: 1_000,
    };
    const before = f.calls.length;
    const denied = new RealMoneyGate({});
    await expect(
      c.payInvoice({
        gate: denied,
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        ...base,
      }),
    ).rejects.toThrow(/REAL_MONEY_DENIED: SYNQ_ALLOW_MAINNET_BROADCAST/);
    const g = new RealMoneyGate({ SYNQ_ALLOW_MAINNET_BROADCAST: 'true' });
    expect(g.authorize({ mode: 'PROVIDER_SANDBOX', ...base }).allowed).toBe(
      false,
    );
    expect(
      g.authorize({
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        ...base,
        approval: null,
      }).allowed,
    ).toBe(false);
    expect(
      g.authorize({
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        ...base,
        amountMinor: 1_201n,
      }).allowed,
    ).toBe(false);
    expect(
      g.authorize({ mode: 'REAL_MONEY_APPROVAL_REQUIRED', ...base, now: 2_000 })
        .allowed,
    ).toBe(false);
    expect(
      g.authorize({
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        ...base,
        approval: { ...approval, humanVerified: false },
      }).allowed,
    ).toBe(false);
    await expect(
      c.payInvoice({ gate: g, mode: 'REAL_MONEY_APPROVAL_REQUIRED', ...base }),
    ).rejects.toThrow(/NO_BROADCAST_PATH/);
    expect(
      g.authorize({ mode: 'REAL_MONEY_APPROVAL_REQUIRED', ...base }).allowed,
    ).toBe(false);
    expect(f.calls.length).toBe(before);
  });

  it('BRF-007 fabric capabilities: Crossmint is MERCHANT_CHECKOUT and blocked; production keys are never executable', () => {
    const caps = settlementFabricCapabilities({
      CROSSMINT_API_KEY: 'sk_staging_x',
      CROSSMINT_PRODUCTION_API_KEY: 'sk_production_x',
      LITHIC_API_KEY: 'k',
    });
    const cm = caps.find((c) => c.providerId === 'crossmint')!;
    expect(cm.category).toBe('MERCHANT_CHECKOUT');
    expect(cm.health).toBe('DOWN');
    expect(cm.statusReason).toMatch(/BLOCKED_EXTERNAL/);
    const prod = settlementFabricCapabilities({
      CROSSMINT_API_KEY: 'sk_production_x',
    });
    expect(prod.find((c) => c.providerId === 'crossmint')!.credentials).toBe(
      'REFUSED_NON_SANDBOX',
    );
    expect(
      caps.find((c) => c.providerId === 'reloadly-sandbox')!.credentials,
    ).toBe('MISSING');
    expect(
      caps.find((c) => c.providerId === 'lithic-sandbox')!.credentials,
    ).toBe('PRESENT');
    expect(
      settlementFabricCapabilities({
        LITHIC_API_KEY: 'k',
        LITHIC_ENV: 'production',
      }).find((c) => c.providerId === 'lithic-sandbox')!.credentials,
    ).toBe('REFUSED_NON_SANDBOX');
  });
});
