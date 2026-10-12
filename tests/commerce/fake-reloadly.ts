import type { HttpFetch } from '@synq/plugin-commerce';

/**
 * In-memory Reloadly gift card sandbox shaped after the official OpenAPI
 * document (docs.reloadly.com/assets/api/gift-cards.json): OAuth token,
 * /accounts/balance, /products, /products/{id}, POST /orders,
 * /reports/transactions(?customIdentifier=), /reports/transactions/{id},
 * /orders/transactions/{id}/cards. Error bodies follow the documented
 * {timeStamp, message, path, errorCode} shape.
 */
export class FakeReloadly {
  readonly clientId = 'fixture-client-id';
  readonly clientSecret = 'fixture-client-secret';
  balance = 100.0;
  tokenTtl = 5_184_000;
  tokens = new Set<string>();
  revoked = new Set<string>();
  tokenRequests = 0;
  orders: Record<string, unknown>[] = [];
  calls: string[] = [];
  /** Injected faults keyed by route. */
  faults: {
    order?:
      | 'TIMEOUT_AFTER_COMMIT'
      | '500'
      | 'PENDING'
      | 'OVERCHARGE'
      | 'WRONG_PRODUCT';
    authFail?: boolean;
    reportsLag?: number;
  } = {};
  readonly code = 'SANDBOX-CODE-7Q2X-99';
  readonly pin = '4321';
  private seq = 1000;
  products: Record<string, unknown>[] = [
    {
      productId: 5,
      productName: 'Amazon US',
      global: false,
      status: 'ACTIVE',
      senderFee: 0.5,
      senderFeePercentage: 0,
      discountPercentage: 2.0,
      denominationType: 'FIXED',
      recipientCurrencyCode: 'USD',
      minRecipientDenomination: null,
      maxRecipientDenomination: null,
      senderCurrencyCode: 'USD',
      fixedRecipientDenominations: [10, 25, 50],
      fixedSenderDenominations: [10, 25, 50],
      fixedRecipientToSenderDenominationsMap: {
        '10.00': 10,
        '25.00': 25,
        '50.00': 50,
      },
      brand: { brandId: 2, brandName: 'Amazon' },
      category: { id: 1, name: 'Shopping' },
      country: { isoName: 'US', name: 'United States' },
    },
    {
      productId: 4,
      productName: 'Amazon Spain',
      status: 'ACTIVE',
      senderFee: 0.3,
      senderFeePercentage: 0,
      denominationType: 'RANGE',
      recipientCurrencyCode: 'EUR',
      minRecipientDenomination: 5,
      maxRecipientDenomination: 100,
      recipientCurrencyToSenderCurrencyExchangeRate: 1.12,
      senderCurrencyCode: 'USD',
      fixedRecipientDenominations: [],
      fixedRecipientToSenderDenominationsMap: [],
      brand: { brandId: 2, brandName: 'Amazon' },
      country: { isoName: 'ES', name: 'Spain' },
    },
  ];

  fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    this.calls.push(`${init.method} ${u.host}${u.pathname}`);
    if (u.host === 'auth.reloadly.com' && u.pathname === '/oauth/token') {
      this.tokenRequests++;
      const b = JSON.parse(init.body ?? '{}');
      if (
        this.faults.authFail ||
        b.client_id !== this.clientId ||
        b.client_secret !== this.clientSecret ||
        b.grant_type !== 'client_credentials' ||
        b.audience !== 'https://giftcards-sandbox.reloadly.com'
      )
        return res(401, {
          timeStamp: 'now',
          message: 'Access Denied',
          path: '/oauth/token',
          errorCode: 'INVALID_CREDENTIALS',
        });
      const token = `tok-${++this.seq}`;
      this.tokens.add(token);
      return res(200, {
        access_token: token,
        scope: 'developer',
        expires_in: this.tokenTtl,
        token_type: 'Bearer',
      });
    }
    if (u.host !== 'giftcards-sandbox.reloadly.com')
      return res(404, { message: 'no host' });
    const token = (init.headers.Authorization ?? '').replace(/^Bearer /, '');
    if (!this.tokens.has(token) || this.revoked.has(token))
      return res(401, {
        message: 'Full authentication is required to access this resource',
        path: u.pathname,
        errorCode: 'INVALID_TOKEN',
      });
    if (
      !init.headers.Accept?.startsWith('application/com.reloadly.giftcards-v')
    )
      return res(406, { message: 'bad accept' });
    const p = u.pathname;
    if (p === '/accounts/balance')
      return res(200, {
        balance: this.balance,
        currencyCode: 'USD',
        currencyName: 'US Dollar',
        updatedAt: '2026-10-12 00:00:00',
      });
    if (p === '/products') {
      const cc = u.searchParams.get('countryCode');
      const name = u.searchParams.get('productName')?.toLowerCase();
      return res(200, {
        content: this.products.filter(
          (x) =>
            (!cc || (x.country as { isoName: string }).isoName === cc) &&
            (!name || String(x.productName).toLowerCase().includes(name)),
        ),
        totalElements: 1,
      });
    }
    const prod = /^\/products\/(\d+)$/.exec(p);
    if (prod) {
      const x = this.products.find((q) => q.productId === Number(prod[1]));
      return x
        ? res(200, x)
        : res(400, {
            message:
              'The product was either not found or is no longer available, Please contact support.',
            path: p,
            errorCode: null,
          });
    }
    if (p === '/orders' && init.method === 'POST') {
      const b = JSON.parse(init.body ?? '{}');
      const product = this.products.find((q) => q.productId === b.productId);
      if (!product)
        return res(404, {
          message: 'Product not found',
          errorCode: 'PRODUCT_NOT_FOUND',
        });
      if (this.orders.some((o) => o.customIdentifier === b.customIdentifier))
        return res(400, {
          message: 'Duplicate custom identifier',
          errorCode: 'DUPLICATE_CUSTOM_IDENTIFIER',
        });
      const map = (product.fixedRecipientToSenderDenominationsMap ??
        {}) as Record<string, number>;
      const cost =
        product.denominationType === 'FIXED'
          ? map[Number(b.unitPrice).toFixed(2)]
          : b.unitPrice *
            (product.recipientCurrencyToSenderCurrencyExchangeRate as number);
      if (cost === undefined)
        return res(400, {
          message: 'Invalid price. Please ensure you selected the right price.',
          path: '/orders',
          errorCode: null,
        });
      const amount =
        cost +
        (product.senderFee as number) +
        (this.faults.order === 'OVERCHARGE' ? 5 : 0);
      if (amount > this.balance)
        return res(400, {
          message: 'Insufficient balance',
          errorCode: 'INSUFFICIENT_BALANCE',
        });
      if (this.faults.order === '500')
        return res(500, { message: 'Internal error' });
      this.balance -= amount;
      const order = {
        transactionId: ++this.seq,
        amount,
        discount: 0,
        currencyCode: 'USD',
        fee: product.senderFee,
        smsFee: 0,
        totalFee: product.senderFee,
        preOrdered: false,
        recipientEmail: null,
        customIdentifier: b.customIdentifier,
        status: this.faults.order === 'PENDING' ? 'PENDING' : 'SUCCESSFUL',
        transactionCreatedTime: '2026-10-12 00:00:01',
        product: {
          productId:
            this.faults.order === 'WRONG_PRODUCT' ? 999 : product.productId,
          productName: product.productName,
          countryCode: (product.country as { isoName: string }).isoName,
          quantity: b.quantity,
          unitPrice: b.unitPrice,
          totalPrice: b.unitPrice * b.quantity,
          currencyCode: product.recipientCurrencyCode,
          brand: product.brand,
        },
        balanceInfo: {
          oldBalance: this.balance + amount,
          newBalance: this.balance,
          cost: amount,
          currencyCode: 'USD',
        },
      };
      this.orders.push(order);
      if (this.faults.order === 'TIMEOUT_AFTER_COMMIT')
        throw new Error('network timeout');
      return res(200, order);
    }
    if (p === '/reports/transactions') {
      if (this.faults.reportsLag && this.faults.reportsLag-- > 0)
        return res(200, { content: [] });
      const ci = u.searchParams.get('customIdentifier');
      return res(200, {
        content: this.orders.filter((o) => !ci || o.customIdentifier === ci),
      });
    }
    const tx = /^\/reports\/transactions\/(\d+)$/.exec(p);
    if (tx) {
      const o = this.orders.find((x) => x.transactionId === Number(tx[1]));
      return o
        ? res(200, o)
        : res(404, {
            message: 'Gift Card transaction not found.',
            errorCode: null,
          });
    }
    const cards = /^\/orders\/transactions\/(\d+)\/cards$/.exec(p);
    if (cards) {
      const o = this.orders.find((x) => x.transactionId === Number(cards[1]));
      return o
        ? res(200, [{ cardNumber: this.code, pinCode: this.pin }])
        : res(404, { message: 'Invalid transaction id' });
    }
    return res(404, { message: `no route ${p}` });
  };
}

function res(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}
