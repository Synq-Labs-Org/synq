import { describe, expect, it } from 'vitest';
import {
  HedgeGrantAuthority,
  HedgeIntentSchema,
  HedgePolicy,
  type HedgeGrant,
} from '@synq/kernel';
import {
  MarketCatalog,
  PerplRestClient,
  type PerplOrder,
} from '@synq/plugin-perpl';
import { PerplHedgeExecutor } from '@synq/perpl-executor';
import { FakePerplRest, testSigner } from './fake-perpl.js';
import { contextFixture } from './context-fixture.js';
import {
  GRANT_KEY,
  T0,
  factsFor,
  hedgeIntent,
  hedgeMandate,
  parentMandate,
  testnetPerpl,
} from '../risk/hedge-fixtures.js';

const context = contextFixture('testnet');
const catalog = new MarketCatalog(testnetPerpl, context, 0);
const HEAD = 70_000_000;

function grantFor(
  authority: HedgeGrantAuthority,
  overrides: Record<string, unknown> = {},
): HedgeGrant {
  const intent = HedgeIntentSchema.parse(hedgeIntent(overrides));
  const decision = new HedgePolicy().evaluate({
    intent,
    hedgeMandate: hedgeMandate(),
    mandate: parentMandate(),
    facts: factsFor(intent),
  });
  return authority.sign({
    decision,
    intent,
    hedgeMandate: hedgeMandate(),
    mandate: parentMandate(),
    approvers: ['fixture_0', 'fixture_1'],
    now: T0,
  });
}

function exchange(
  opts: {
    forwarding?: boolean;
    noAccount?: boolean;
    fill?: 'full' | 'partial' | 'none' | 'fail34';
    cancelFails?: boolean;
    expireFirst?: boolean;
    staleSameRq?: boolean;
    immediate?: boolean;
  } = {},
) {
  const server = new FakePerplRest(testnetPerpl.chainId, testnetPerpl.restUrl);
  const trade = testSigner('trade');
  server.register(trade);
  const history: PerplOrder[] = [];
  // Venue events become visible one history poll after they happen, as on the
  // live exchange (forwarding settles a block later).
  const visibleAfter = new Map<PerplOrder, number>();
  let historyReads = 0;
  const push = (o: PerplOrder) => {
    history.push(o);
    visibleAfter.set(o, opts.immediate ? historyReads : historyReads + 1);
  };
  const orders: {
    rq: number;
    t: number;
    s: number;
    oid?: number;
    lv?: number;
  }[] = [];
  let lfr = 10;
  let nextOid = 500;
  if (opts.staleSameRq) {
    const old = { b: HEAD - 100, t: Date.now() - 60_000 };
    history.push({ rq: 11, mkt: 64, acc: 1058, t: 5, st: 7, sr: 33, at: old });
    history.push({ rq: 11, mkt: 64, acc: 1058, t: 2, st: 7, sr: 34, at: old });
  }
  server.routes.push((r) => {
    if (r.target === '/v1/trading/wallet')
      return opts.noAccount
        ? { status: 404, body: { error: 'no account' } }
        : {
            status: 200,
            body: {
              mt: 19,
              sn: HEAD,
              addr: '0x6666666666666666666666666666666666666666',
              as: [
                {
                  in: 12,
                  id: 1058,
                  fr: false,
                  fw: opts.forwarding ?? true,
                  lfr,
                  b: '100000000',
                  lb: '0',
                },
              ],
            },
          };
    if (r.target === '/v1/market-data/64/ticker')
      return {
        status: 200,
        body: {
          mt: 9,
          sn: HEAD,
          d: {
            '64': {
              ...context.markets.find((m) => m.id === 64)!.state,
              at: { b: HEAD, t: T0 * 1000 },
            },
          },
        },
      };
    if (r.target === '/v1/trading/orders' && r.method === 'GET')
      return { status: 200, body: { mt: 23, sn: HEAD, d: [] } };
    if (r.target.startsWith('/v1/trading/order-history')) {
      historyReads++;
      return {
        status: 200,
        body: {
          d: history
            .filter((o) => (visibleAfter.get(o) ?? 0) < historyReads)
            .reverse(),
          np: '',
        },
      };
    }
    if (r.target === '/v1/trading/positions')
      return { status: 200, body: { mt: 26, sn: HEAD, d: [] } };
    if (r.target === '/v1/trading/orders' && r.method === 'POST') {
      const spec = (
        JSON.parse(r.body) as {
          d: { rq: number; t: number; s: number; oid?: number; lb: number }[];
        }
      ).d[0]!;
      orders.push(spec);
      if (spec.rq <= lfr && !orders.slice(0, -1).some((o) => o.rq === spec.rq))
        return {
          status: 200,
          body: {
            mt: 31,
            status: { code: 0 },
            statuses: [{ code: 400, error: 'request id too low' }],
          },
        };
      if (orders.filter((o) => o.rq === spec.rq).length > 1)
        return {
          status: 200,
          body: { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] },
        };
      // Orders refused before reaching the chain do not advance lfr.
      if (opts.forwarding !== false && opts.fill !== 'fail34')
        lfr = Math.max(lfr, spec.rq);
      const base = { rq: spec.rq, mkt: 64, acc: 1058, t: spec.t, os: spec.s };
      if (opts.forwarding === false || opts.fill === 'fail34')
        push({ ...base, st: 7, sr: 34, at: { b: HEAD + 1 } });
      else if (opts.expireFirst && orders.length === 1)
        push({
          ...base,
          oid: nextOid++,
          st: 7,
          sr: 14,
          fs: 0,
          at: { b: HEAD + 30 },
        });
      else if (spec.t === 5) {
        // As on the venue: a cancel is reported under its rq with the cancelled order's type.
        push(
          opts.cancelFails
            ? { ...base, oid: spec.oid, st: 7, sr: 33, at: { b: HEAD + 1 } }
            : {
                ...base,
                t: 2,
                oid: spec.oid,
                st: 5,
                sr: 28,
                r: true,
                at: { b: HEAD + 1 },
              },
        );
      } else {
        const oid = nextOid++;
        push({ ...base, oid, st: 2, sr: 35, at: { b: HEAD + 1 } });
        if (opts.fill === 'partial')
          push({
            ...base,
            oid,
            st: 5,
            sr: 16,
            fs: 25,
            fp: 2_401,
            f: '20',
            r: true,
            at: { b: HEAD + 2 },
          });
        else if (opts.fill !== 'none')
          push({
            ...base,
            oid,
            st: 4,
            fs: spec.s,
            fp: 2_401,
            f: '33',
            r: true,
            at: { b: HEAD + 2 },
          });
      }
      return {
        status: 200,
        body: { mt: 31, status: { code: 0 }, statuses: [{ code: 0 }] },
      };
    }
    return undefined;
  });
  const rest = new PerplRestClient({
    network: testnetPerpl,
    signer: trade,
    fetch: server.fetch,
    transport: 'recorded',
    sleep: async () => {},
  });
  return { server, rest, orders, history };
}

const executor = (
  rest: PerplRestClient,
  grants: HedgeGrantAuthority,
  extra = {},
) =>
  new PerplHedgeExecutor({
    rest,
    grants,
    catalog,
    mode: 'SIMULATION',
    now: () => (T0 + 1) * 1000,
    sleep: async () => {},
    maxPolls: 3,
    ...extra,
  });

describe('Perpl hedge executor', () => {
  it('places exactly the granted IOC short, reconciles the fill and consumes the grant', async () => {
    const { rest, orders } = exchange();
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const grant = grantFor(grants);
    const receipt = await executor(rest, grants).execute(grant);
    expect(orders).toEqual([
      {
        rq: 11,
        mkt: 64,
        acc: 1058,
        t: 2,
        p: 2_400,
        s: 40,
        fl: 4,
        lv: 100,
        lb: 0,
      },
    ]);
    expect(receipt).toMatchObject({
      submitted: true,
      reconciliation: 'SETTLED',
      finalStatus: 4,
      filledSize: '40',
      avgFillPrice: '2401',
      orderId: 500,
      rq: 11,
    });
    await expect(executor(rest, grants).execute(grant)).rejects.toThrow(
      /GRANT_CONSUMED/,
    );
    expect(orders).toHaveLength(1);
  });

  it('regression: an order failed with ExceedsLastExecutionBlock (sr:14) is retried once with a new rq under the same grant', async () => {
    const { rest, orders } = exchange({ expireFirst: true });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const receipt = await executor(rest, grants).execute(
      grantFor(grants, {
        kind: 'CLOSE',
        leverageHundredths: 0,
        collateral: '0',
        limitPrice: '2500',
      }),
    );
    expect(orders.map((o) => o.rq)).toEqual([11, 12]);
    expect(orders.every((o) => o.t === 4 && o.lv === 0)).toBe(true);
    expect(receipt.attempts).toEqual([
      { rq: 11, status: 7, reason: 14 },
      { rq: 12, status: 4, reason: null },
    ]);
    expect(receipt).toMatchObject({ rq: 12, reconciliation: 'SETTLED' });
  });

  it('a forwarding refusal (sr:34) is not retried with a new rq', async () => {
    const { rest, orders } = exchange({ fill: 'fail34' });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    await executor(rest, grants).execute(grantFor(grants));
    expect(orders).toHaveLength(1);
  });

  it('regression: stale events of a reused rq (pre-chain refusal) are not mistaken for the new order', async () => {
    const { rest, orders } = exchange({ staleSameRq: true });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const receipt = await executor(rest, grants).execute(grantFor(grants));
    expect(orders.map((o) => o.rq)).toEqual([11]);
    expect(receipt).toMatchObject({
      reconciliation: 'SETTLED',
      finalStatus: 4,
      filledSize: '40',
    });
  });

  it('regression: request ids stay strictly increasing across executions even when lfr does not advance', async () => {
    const { rest, orders } = exchange({ forwarding: false });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const requestIds = new Map<number, number>();
    await executor(rest, grants, { requestIds }).execute(grantFor(grants));
    await executor(rest, grants, { requestIds }).execute(
      grantFor(grants, { intentId: 'hedge_intent_2' }),
    );
    expect(orders.map((o) => o.rq)).toEqual([11, 12]);
  });

  it('order forwarding disabled: the exchange answers st:7 sr:34 and nothing settles', async () => {
    const { rest } = exchange({ forwarding: false });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const receipt = await executor(rest, grants).execute(grantFor(grants));
    expect(receipt).toMatchObject({
      reconciliation: 'FAILED',
      finalStatus: 7,
      statusReason: 34,
    });
  });

  it('account missing fails before anything is signed for trading', async () => {
    const { rest, orders } = exchange({ noAccount: true });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    await expect(
      executor(rest, grants).execute(grantFor(grants)),
    ).rejects.toMatchObject({ code: 'ACCOUNT_MISSING' });
    expect(orders).toHaveLength(0);
  });

  it('partial fill: reconciles the actual filled size, not the requested size', async () => {
    const { rest } = exchange({ fill: 'partial' });
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const receipt = await executor(rest, grants).execute(grantFor(grants));
    expect(receipt).toMatchObject({
      reconciliation: 'SETTLED',
      finalStatus: 5,
      filledSize: '25',
    });
  });

  it('submit timeout: reconciles by rq first and never resubmits an order it finds', async () => {
    const { rest, server, orders } = exchange({ immediate: true });
    const inner = server.fetch;
    let dropped = false;
    server.fetch = async (url, init) => {
      const res = await inner(url, init);
      if (!dropped && init.method === 'POST') {
        dropped = true;
        throw Object.assign(new Error('socket hang up'), {
          name: 'TimeoutError',
        });
      }
      return res;
    };
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const client = new PerplRestClient({
      network: testnetPerpl,
      signer: testSigner('trade'),
      fetch: server.fetch,
      transport: 'recorded',
      sleep: async () => {},
    });
    const receipt = await executor(client, grants).execute(grantFor(grants));
    expect(orders).toHaveLength(1);
    expect(receipt.reconciliation).toBe('SETTLED');
    void rest;
  });

  it('submit timeout with no trace of the order resends the same rq (at-most-once), not a new one', async () => {
    const { server, orders } = exchange();
    const inner = server.fetch;
    let dropped = false;
    server.fetch = async (url, init) => {
      if (!dropped && init.method === 'POST') {
        dropped = true;
        throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      }
      return inner(url, init);
    };
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const client = new PerplRestClient({
      network: testnetPerpl,
      signer: testSigner('trade'),
      fetch: server.fetch,
      transport: 'recorded',
      sleep: async () => {},
    });
    const receipt = await executor(client, grants).execute(grantFor(grants));
    expect(orders.map((o) => o.rq)).toEqual([11]);
    expect(receipt.submitted).toBe(true);
  });

  it('duplicate cancel: the second cancel needs its own grant and is reported as failed by the exchange', async () => {
    const grants = new HedgeGrantAuthority(GRANT_KEY);
    const cancel = {
      kind: 'CANCEL',
      orderId: '500',
      size: '0',
      leverageHundredths: 0,
      collateral: '0',
    };
    const first = exchange();
    const g1 = grantFor(grants, cancel);
    expect((await executor(first.rest, grants).execute(g1)).finalStatus).toBe(
      5,
    );
    await expect(executor(first.rest, grants).execute(g1)).rejects.toThrow(
      /GRANT_CONSUMED/,
    );
    const second = exchange({ cancelFails: true });
    const g2 = grantFor(grants, { ...cancel, intentId: 'hedge_cancel_again' });
    expect(await executor(second.rest, grants).execute(g2)).toMatchObject({
      reconciliation: 'FAILED',
      statusReason: 33,
    });
  });

  it('refuses to run with a read-scoped key', () => {
    const server = new FakePerplRest(
      testnetPerpl.chainId,
      testnetPerpl.restUrl,
    );
    const rest = new PerplRestClient({
      network: testnetPerpl,
      signer: testSigner('read'),
      fetch: server.fetch,
      transport: 'recorded',
    });
    expect(() => executor(rest, new HedgeGrantAuthority(GRANT_KEY))).toThrow(
      /SCOPE_INSUFFICIENT/,
    );
  });
});
