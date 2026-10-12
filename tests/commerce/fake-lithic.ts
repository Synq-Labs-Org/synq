import type { HttpFetch } from '@synq/plugin-commerce';

/**
 * In-memory Lithic sandbox shaped after the official API reference
 * (POST /v1/cards, PATCH /v1/cards/{token}, GET /v1/cards?memo=,
 * POST /v1/simulate/{authorize,void,clearing,return}, GET /v1/transactions)
 * and the observed sandbox behaviour (2026-10-12): a declined simulated
 * authorization answers 201 with a token, and the transaction carries
 * status DECLINED / result USER_TRANSACTION_LIMIT.
 */
export class FakeLithic {
  readonly key = 'lithic-sandbox-fixture-key';
  cards = new Map<string, Record<string, unknown>>();
  txs = new Map<string, Record<string, unknown>>();
  calls: { method: string; path: string; body: string | undefined }[] = [];
  idem = new Map<string, string>();
  failNext: { path: RegExp; status: number; throws?: boolean }[] = [];
  private seq = 0;

  private pan() {
    return `4111110000${String(1_000_000 + ++this.seq).slice(1)}`;
  }

  fetch: HttpFetch = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v1/, '');
    this.calls.push({ method: init.method, path, body: init.body });
    const fail = this.failNext.findIndex((f) => f.path.test(path));
    if (fail >= 0) {
      const f = this.failNext.splice(fail, 1)[0]!;
      if (f.throws) throw new Error('socket hang up');
      return res(f.status, { message: `injected ${f.status}` });
    }
    if (init.headers.Authorization !== this.key)
      return res(401, { message: 'User has not been authenticated' });
    const body = init.body ? JSON.parse(init.body) : {};
    if (init.method === 'POST' && path === '/cards') {
      const k = init.headers['Idempotency-Key'];
      if (k && this.idem.has(k))
        return res(200, this.cards.get(this.idem.get(k)!)!);
      const token = `card-${++this.seq}`;
      const pan = this.pan();
      const card = {
        token,
        type: body.type,
        memo: body.memo,
        spend_limit: body.spend_limit,
        spend_limit_duration: body.spend_limit_duration,
        state: body.state ?? 'OPEN',
        pan,
        cvv: '776',
        last_four: pan.slice(-4),
        exp_month: '06',
        exp_year: '2030',
        created: new Date().toISOString(),
        funding: { account_name: 'Sandbox', type: 'DEPOSITORY_CHECKING' },
      };
      this.cards.set(token, card);
      if (k) this.idem.set(k, token);
      return res(200, card);
    }
    if (init.method === 'GET' && path === '/cards') {
      const memo = u.searchParams.get('memo');
      return res(200, {
        data: [...this.cards.values()].filter((c) => !memo || c.memo === memo),
        has_more: false,
      });
    }
    const card = /^\/cards\/([^/]+)$/.exec(path);
    if (card) {
      const c = this.cards.get(card[1]!);
      if (!c) return res(404, { message: 'card not found' });
      if (init.method === 'PATCH') Object.assign(c, body);
      return res(200, c);
    }
    if (path === '/simulate/authorize') {
      const c = [...this.cards.values()].find((x) => x.pan === body.pan);
      const token = `tx-${++this.seq}`;
      let result = 'APPROVED';
      if (!c) result = 'CARD_INVALID';
      else if (c.state !== 'OPEN') result = 'CARD_CLOSED';
      else {
        const spent = [...this.txs.values()]
          .filter(
            (t) =>
              t.card_token === c.token &&
              t.result === 'APPROVED' &&
              t.status !== 'VOIDED',
          )
          .reduce((s, t) => s + (t.amount as number), 0);
        if (spent + body.amount > (c.spend_limit as number))
          result = 'USER_TRANSACTION_LIMIT';
      }
      this.txs.set(token, {
        token,
        card_token: c?.token ?? '',
        status: result === 'APPROVED' ? 'PENDING' : 'DECLINED',
        result,
        amount: body.amount,
        amounts: { hold: { amount: body.amount, currency: 'USD' } },
        merchant: { descriptor: body.descriptor },
        created: new Date().toISOString(),
      });
      return res(201, { token, debugging_request_id: `dbg-${this.seq}` });
    }
    if (path === '/simulate/void' || path === '/simulate/clearing') {
      const t = this.txs.get(body.token);
      if (!t) return res(404, { message: 'transaction not found' });
      t.status = path.endsWith('void') ? 'VOIDED' : 'SETTLED';
      return res(201, { debugging_request_id: `dbg-${++this.seq}` });
    }
    if (path === '/simulate/return') {
      const token = `ret-${++this.seq}`;
      const c = [...this.cards.values()].find((x) => x.pan === body.pan);
      this.txs.set(token, {
        token,
        card_token: c?.token ?? '',
        status: 'SETTLED',
        result: 'APPROVED',
        amount: -body.amount,
        merchant: { descriptor: body.descriptor },
      });
      return res(201, { token, debugging_request_id: `dbg-${this.seq}` });
    }
    if (init.method === 'GET' && path === '/transactions') {
      const ct = u.searchParams.get('card_token');
      return res(200, {
        data: [...this.txs.values()].filter((t) => t.card_token === ct),
        has_more: false,
      });
    }
    const tx = /^\/transactions\/([^/]+)$/.exec(path);
    if (tx) {
      const t = this.txs.get(tx[1]!);
      return t ? res(200, t) : res(404, { message: 'not found' });
    }
    return res(404, { message: `no route ${init.method} ${path}` });
  };
}

function res(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}
