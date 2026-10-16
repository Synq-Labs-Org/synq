import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { getAddress, type Address } from 'viem';
import { Ledger, MemoryLedgerStore } from '@synq/ledger';
import {
  InvoiceService,
  MemoryInvoiceStore,
  issueTypedData,
  verifyPayLink,
} from '@synq/invoices';
import { verifyDealLink } from '@synq/dealroom';
import { InteractiveCardSchema } from '@synq/schemas';
import { invoiceRoutes } from '../../apps/api/src/invoice-routes.js';
import {
  ArcBusiness,
  VAULT,
  parseVendors,
  type ArcReads,
} from '../../apps/demo/src/arc-business.js';
import {
  BUSINESS_LIMITS,
  registerBusinessRoutes,
} from '../../apps/demo/src/business-routes.js';
import {
  FundError,
  type FundService,
} from '../../apps/demo/src/fund-service.js';
import { room, Clock, T0 } from '../dealroom/harness.js';
import { issueMismatches } from '../../apps/web/lib/invoice-issue.js';

const FUND = 'fnd_00000000000000000001';
const OTHER_FUND = 'fnd_00000000000000000002';
const KEY = 'k'.repeat(32);
const OTHER_KEY = 'o'.repeat(32);
/** Test-only keys (never funded anywhere). */
const owner = privateKeyToAccount(`0x${'b1'.repeat(32)}`);
const coOwner = getAddress(`0x${'c2'.repeat(20)}`);
const sarah = getAddress(`0x${'5a'.repeat(20)}`);
const bob = getAddress(`0x${'b0'.repeat(20)}`);
const DEAL_KEY = Buffer.alloc(32, 7);
const PAY_KEY = Buffer.alloc(32, 9);
const WEB = 'https://synq.example';

/** Arc reads with a call log; the port has no write method at all. */
function fakeReads(over: Partial<ArcReads> = {}) {
  const calls: string[] = [];
  const log =
    <A extends unknown[], R>(name: string, f: (...a: A) => R) =>
    (...a: A) => {
      calls.push(name);
      return f(...a);
    };
  const reads: ArcReads = {
    blockNumber: log('blockNumber', async () => 1_000n),
    usdc: log('usdc', async (a: Address) =>
      a === VAULT.safe ? 250_000_000n : 3_500_000n,
    ),
    isRecipient: log('isRecipient', async (a: Address) => a === sarah),
    safeOwners: log('safeOwners', async () => [owner.address, coOwner]),
    vaultPolicy: log('vaultPolicy', async () => ({
      perPaymentCap: 5_000_000n,
      windowCap: 20_000_000n,
      remaining: 18_000_000n,
      paused: false,
    })),
    earnVaults: log('earnVaults', async () => [
      {
        name: 'Circle Earn USDC vault',
        address: `0x${'ea'.repeat(20)}` as Address,
        underlyingOk: true,
        totalAssets: 1_000_000n,
      },
    ]),
    usyc: log('usyc', async () => ({
      status: 'INELIGIBLE' as const,
      explanation: 'INELIGIBLE: not allowlisted',
    })),
    ...over,
  };
  return { reads, calls };
}

function server(
  opts: { deals?: boolean; invoices?: boolean; reads?: ArcReads } = {},
) {
  const clock = new Clock();
  const funds = {
    view: async (fundId: string, key: string) => {
      if (
        (fundId === FUND && key === KEY) ||
        (fundId === OTHER_FUND && key === OTHER_KEY)
      )
        return { fundId } as never;
      throw new FundError('FORBIDDEN', 403);
    },
    ports: { now: clock.now },
  } as unknown as FundService;
  const fake = fakeReads();
  const invoices = new InvoiceService(
    new MemoryInvoiceStore(),
    new Ledger(new MemoryLedgerStore()),
    clock.now,
  );
  const business = new ArcBusiness({
    name: 'Test studio',
    reads: opts.reads ?? fake.reads,
    vendors: parseVendors(`Sarah:${sarah}:${T0 - 30 * 86_400},Bob:${bob}`),
    owner: owner.address,
    now: clock.now,
    webBaseUrl: WEB,
    reasoner: null,
    env: { SECRET_THING: 'do-not-leak' },
    ...(opts.deals
      ? {
          deals: { service: room(undefined, clock).service, linkKey: DEAL_KEY },
        }
      : {}),
    ...(opts.invoices
      ? { invoices: { service: invoices, payLinkKey: PAY_KEY } }
      : {}),
  });
  const app = Fastify();
  registerBusinessRoutes(app, funds, business);
  return { app, clock, calls: fake.calls, invoices };
}

const SECRETS = [
  DEAL_KEY.toString('hex'),
  PAY_KEY.toString('hex'),
  DEAL_KEY.toString('base64url'),
  PAY_KEY.toString('base64url'),
  'do-not-leak',
];
const noSecrets = (body: string) => {
  for (const s of SECRETS) expect(body).not.toContain(s);
  expect(body).not.toMatch(/"grant"|grantId|mac"|privateKey/i);
};

describe('Arc business routes for the Messages app', () => {
  it('needs the fund key and says which features this server has', async () => {
    const { app } = server();
    const bad = await app.inject(
      `/v1/funds/${FUND}/business/capabilities?k=${OTHER_KEY}`,
    );
    expect(bad.statusCode).toBe(403);
    expect(
      (await app.inject(`/v1/funds/nope/business/capabilities?k=${KEY}`))
        .statusCode,
    ).toBe(400);
    const r = await app.inject(
      `/v1/funds/${FUND}/business/capabilities?k=${KEY}`,
    );
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const caps = r.json();
    expect(caps).toMatchObject({ network: 'Arc testnet', chainId: 5042002 });
    expect(caps.features.deals.enabled).toBe(false);
    expect(caps.features.deals.reason).toMatch(/SYNQ_DEALROOM_LINK_KEY/);
    expect(caps.features.invoices.enabled).toBe(false);
    expect(caps.features.team.enabled).toBe(true);
    const off = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/invoices`,
      payload: { key: KEY, payer: 'Priya', amount: '120', description: 'Logo' },
    });
    expect(off.statusCode).toBe(503);
    expect(off.json().error).toBe('NOT_ENABLED');
    const on = server({ deals: true, invoices: true });
    const all = (
      await on.app.inject(`/v1/funds/${FUND}/business/capabilities?k=${KEY}`)
    ).json();
    expect(all.features.deals.enabled && all.features.invoices.enabled).toBe(
      true,
    );
  });

  it('treasury and vendors only read Arc, with exact amounts', async () => {
    const { app, calls } = server();
    const t = await app.inject(`/v1/funds/${FUND}/business/treasury?k=${KEY}`);
    expect(t.statusCode).toBe(200);
    const body = t.json();
    expect(body.mode).toBe('LIVE_ARC_TESTNET');
    expect(body.accounts[0]).toMatchObject({
      label: 'Governed vault',
      address: VAULT.safe,
      usdc: '250.00',
    });
    expect(body.accounts[1]).toMatchObject({
      address: owner.address,
      usdc: '3.50',
    });
    expect(body.vaultPolicy).toMatchObject({
      perPaymentCap: '5.00',
      paused: false,
    });
    expect(body.earn[0].apy).toBeNull();
    expect(body.usyc.status).toBe('INELIGIBLE');
    noSecrets(t.body);
    const v = (
      await app.inject(`/v1/funds/${FUND}/business/vendors?k=${KEY}`)
    ).json();
    expect(v.vendors).toEqual([
      expect.objectContaining({
        name: 'Sarah',
        address: sarah,
        verified: true,
      }),
      expect.objectContaining({ name: 'Bob', address: bob, verified: false }),
    ]);
    expect(new Set(calls)).toEqual(
      new Set([
        'blockNumber',
        'usdc',
        'safeOwners',
        'vaultPolicy',
        'earnVaults',
        'usyc',
        'isRecipient',
      ]),
    );
  });

  it('an unreachable Arc RPC is an honest 502, not a guess', async () => {
    const { reads } = fakeReads({
      usdc: async () => {
        throw new Error('fetch failed');
      },
    });
    const { app } = server({ reads });
    const r = await app.inject(`/v1/funds/${FUND}/business/treasury?k=${KEY}`);
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toBe('ARC_UNAVAILABLE');
  });

  it('split preview is labelled PREVIEW and conserves the amount', async () => {
    const { app } = server();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/splits/preview`,
      payload: { key: KEY, amount: '1500' },
    });
    expect(r.statusCode).toBe(200);
    const p = r.json();
    expect(p).toMatchObject({
      label: 'PREVIEW',
      mode: 'PREVIEW',
      amount: '1500.00',
    });
    expect(p.summary.taxReserve).toBe('375.00');
    const units = (d: string) => {
      const [w, f = ''] = d.split('.');
      return BigInt(w!) * 1_000_000n + BigInt(f.padEnd(6, '0'));
    };
    const sum = p.legs.reduce(
      (a: bigint, l: { amount: string }) => a + units(l.amount),
      0n,
    );
    expect(sum).toBe(1_500_000_000n);
    expect(p.headline).toMatch(/^Preview: if 1500.00 USDC arrived/);
    expect(p.notes.join(' ')).toMatch(/nothing is reserved or sent/);
    expect(p.forecast.map((f: { days: number }) => f.days)).toEqual([
      30, 60, 90,
    ]);
    const bad = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/splits/preview`,
      payload: { key: KEY, amount: '1.1234567' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('the council answers read-only: never submitted, no grant, no approval link', async () => {
    const { app } = server();
    const r = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/team/ask`,
      payload: {
        key: KEY,
        text: 'Ask CFO and Risk whether we should pay Sarah 2 USDC',
      },
    });
    expect(r.statusCode).toBe(200);
    const t = r.json();
    expect(t.readOnly).toBe(true);
    expect(t.status).toBe('ANSWERED');
    expect(t.sections.map((s: { persona: string }) => s.persona)).toEqual(
      expect.arrayContaining(['CFO', 'RISK']),
    );
    expect(
      t.sections.some((s: { persona: string }) => s.persona === 'DECISION'),
    ).toBe(false);
    expect(t.decision.status).toBe('NOT_SUBMITTED');
    expect(t.decision.outcome).toBeNull();
    expect(t.approvalUrl).toBeNull();
    expect(t).not.toHaveProperty('kernel');
    expect(t).not.toHaveProperty('intent');
    if (t.card)
      expect(InteractiveCardSchema.parse(t.card).type).toBe(
        'AGENT_RECOMMENDATION',
      );
    noSecrets(r.body);
  });

  it('rate limits the council per fund, like the Ask route', async () => {
    const { app } = server();
    const ask = (key: string, fund = FUND) =>
      app.inject({
        method: 'POST',
        url: `/v1/funds/${fund}/business/team/ask`,
        payload: { key, text: 'what can you do right now?' },
      });
    for (let i = 0; i < BUSINESS_LIMITS.team; i++)
      expect((await ask(KEY)).statusCode).toBe(200);
    const limited = await ask(KEY);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error).toBe('RATE_LIMITED');
    expect((await ask(OTHER_KEY, OTHER_FUND)).statusCode).toBe(200);
  });

  it('drafts a deal for a verified contractor and returns a view-only review link', async () => {
    const { app, clock } = server({ deals: true });
    const r = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/deals`,
      payload: {
        key: KEY,
        text: 'Draft a deal with Sarah: we need a logo and brand kit. 300 USDC total: 100 USDC when concepts are delivered, 200 USDC when final files are delivered within 14 days.',
      },
    });
    expect(r.statusCode).toBe(200);
    const d = r.json();
    expect(d.status).toBe('DRAFTED');
    expect(d).toMatchObject({
      total: '300',
      symbol: 'USDC',
      freelancer: 'Sarah',
      client: 'Test studio',
    });
    expect(d.milestones).toHaveLength(2);
    const url = new URL(d.reviewUrl);
    expect(url.origin).toBe(WEB);
    expect(
      verifyDealLink(DEAL_KEY, d.dealId, url.searchParams.get('t')!, {
        now: clock.now(),
        epoch: 0,
      }),
    ).toBe(true);
    noSecrets(r.body);
    const refused = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/deals`,
      payload: { key: KEY, text: 'Draft a deal with Bob for 50 USDC total' },
    });
    expect(refused.json()).toMatchObject({ status: 'REFUSED' });
    expect(refused.json().reason).toMatch(/Bob is not on the vault allowlist/);
    const unnamed = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/deals`,
      payload: { key: KEY, text: 'Draft a deal with Carol for 50 USDC total' },
    });
    expect(unnamed.json()).toMatchObject({ status: 'REFUSED' });
    expect(unnamed.json().reason).toMatch(
      /Name one verified contractor: Sarah/,
    );
  });

  it('invoices: draft, issuer signs on the page, then a checkout link; scoped to the fund', async () => {
    const { app, clock, invoices } = server({ invoices: true });
    const created = await app.inject({
      method: 'POST',
      url: `/v1/funds/${FUND}/business/invoices`,
      payload: { key: KEY, payer: 'Priya', amount: '120', description: 'Logo' },
    });
    expect(created.statusCode).toBe(200);
    const inv = created.json();
    expect(inv).toMatchObject({
      status: 'DRAFT',
      total: '120.00',
      payer: 'Priya',
      payTo: VAULT.safe,
      payUrl: null,
    });
    expect(inv.issueUrl).toMatch(
      new RegExp(`^${WEB}/invoice/${inv.invoiceId}\\?t=`),
    );
    noSecrets(created.body);
    // Another fund cannot read it back.
    const other = await app.inject(
      `/v1/funds/${OTHER_FUND}/business/invoices/${inv.invoiceId}?k=${OTHER_KEY}`,
    );
    expect(other.statusCode).toBe(404);
    // The issuer page: view, then the owner's EIP-712 signature issues it.
    const page = Fastify();
    await page.register(invoiceRoutes, {
      invoices,
      payLinkKey: PAY_KEY,
      client: {} as never,
      memoContract: `0x${'00'.repeat(20)}`,
      now: clock.now,
    });
    const t = new URL(inv.issueUrl).searchParams.get('t')!;
    const view = await page.inject(
      `/v1/invoices/${inv.invoiceId}/issue?t=${encodeURIComponent(t)}`,
    );
    expect(view.statusCode).toBe(200);
    expect(view.json().issuerWallet).toBe(owner.address);
    // The page refuses to sign typed data that differs from what it shows.
    expect(issueMismatches(view.json())).toEqual([]);
    expect(issueMismatches({ ...view.json(), total: '121.00' })).toEqual([
      'total',
    ]);
    expect(
      (
        await page.inject(
          `/v1/invoices/${inv.invoiceId}/issue?t=1.${'x'.repeat(32)}`,
        )
      ).statusCode,
    ).toBe(404);
    const stored = (await invoices.store.get(inv.invoiceId))!.invoice;
    const wrong = await privateKeyToAccount(
      `0x${'99'.repeat(32)}`,
    ).signTypedData(issueTypedData(stored));
    const refused = await page.inject({
      method: 'POST',
      url: `/v1/invoices/${inv.invoiceId}/issue?t=${encodeURIComponent(t)}`,
      payload: { signature: wrong },
    });
    expect(refused.statusCode).toBe(409);
    const signature = await owner.signTypedData(issueTypedData(stored));
    const issued = await page.inject({
      method: 'POST',
      url: `/v1/invoices/${inv.invoiceId}/issue?t=${encodeURIComponent(t)}`,
      payload: { signature },
    });
    expect(issued.statusCode).toBe(200);
    expect(issued.json().status).toBe('ISSUED');
    const after = (
      await app.inject(
        `/v1/funds/${FUND}/business/invoices/${inv.invoiceId}?k=${KEY}`,
      )
    ).json();
    expect(after.status).toBe('ISSUED');
    expect(after.issueUrl).toBeNull();
    const token = after.payUrl.slice(`${WEB}/pay/`.length);
    const now = (await invoices.store.get(inv.invoiceId))!.invoice;
    expect(() => verifyPayLink(PAY_KEY, token, now, clock.now())).not.toThrow();
    expect(InteractiveCardSchema.parse(after.card).type).toBe('INVOICE');
  });
});
