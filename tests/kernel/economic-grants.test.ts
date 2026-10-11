import { describe, expect, it } from 'vitest';
import {
  EconomicGrantAuthority,
  type EconomicAuthorizationRequest,
  type EconomicExecution,
  type EconomicGrant,
} from '@synq/kernel';

const T = 1_780_000_000;
const KEY = new Uint8Array(32).fill(7);
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const mandate = {
  mandateId: 'web2-1',
  groupId: 'group-1',
  version: 1,
  status: 'ACTIVE',
  domains: ['STAY', 'COMMERCE', 'DATA'],
  providers: ['duffel-stays', 'crossmint'],
  hosts: ['api.duffel.com', 'staging.crossmint.com'],
  perActionCap: usd(50_000),
  cumulativeBudget: usd(80_000),
  autoApproveMax: usd(1_000),
  quorum: 2,
  members: ['alice', 'bob', 'carol'],
  maxQuoteAgeSeconds: 120,
  grantTtlSeconds: 300,
  environment: 'SANDBOX',
  validUntil: T + 86_400,
};
const execution = (
  over: Partial<EconomicExecution> = {},
): EconomicExecution => ({
  domain: 'STAY',
  providerId: 'duffel-stays',
  host: 'api.duffel.com',
  offerId: 'quo_1',
  subjectHash: `0x${'ab'.repeat(32)}`,
  quantity: 1,
  maxAmount: usd(30_000),
  reservationId: 'res-1',
  settlementPlanHash: '0xplan',
  recipientRef: null,
  ...over,
});
const request = (
  over: Partial<EconomicAuthorizationRequest> = {},
  x = execution(),
): EconomicAuthorizationRequest => ({
  intentId: 'intent-1',
  groupId: 'group-1',
  mandateId: 'web2-1',
  execution: x,
  quoteExpiresAt: T + 600,
  revalidatedAt: T - 5,
  reservationHeld: true,
  ...over,
});
const authority = () => {
  const a = new EconomicGrantAuthority(KEY);
  a.install(mandate);
  return a;
};
const grantOf = (a: EconomicGrantAuthority, r = request()): EconomicGrant => {
  const d = a.authorize(r, ['alice', 'bob'], T);
  if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
  return d.grant;
};

describe('EconomicGrantAuthority', () => {
  it('requires quorum above the auto limit and none below', () => {
    const a = authority();
    expect(a.authorize(request(), ['alice'], T)).toMatchObject({
      status: 'PENDING_APPROVAL',
      requiredApprovals: 2,
    });
    const small = a.authorize(
      request({ intentId: 'small' }, execution({ maxAmount: usd(900) })),
      [],
      T,
    );
    expect(small.status).toBe('AUTHORIZED');
  });
  it('refuses unrevalidated, expired, unreserved and out-of-mandate requests', () => {
    const a = authority();
    const code = (r: EconomicAuthorizationRequest) => {
      const d = a.authorize(r, ['alice', 'bob'], T);
      return d.status === 'REJECTED' ? d.code : d.status;
    };
    expect(code(request({ revalidatedAt: null }))).toBe(
      'QUOTE_NOT_REVALIDATED',
    );
    expect(code(request({ revalidatedAt: T - 121 }))).toBe(
      'QUOTE_NOT_REVALIDATED',
    );
    expect(code(request({ quoteExpiresAt: T }))).toBe('QUOTE_EXPIRED');
    expect(code(request({ reservationHeld: false }))).toBe(
      'RESERVATION_MISSING',
    );
    expect(code(request({}, execution({ host: 'evil.example.com' })))).toBe(
      'HOST_FORBIDDEN',
    );
    expect(code(request({}, execution({ providerId: 'expedia' })))).toBe(
      'PROVIDER_FORBIDDEN',
    );
    expect(code(request({}, execution({ domain: 'FLIGHT' })))).toBe(
      'DOMAIN_FORBIDDEN',
    );
    expect(code(request({}, execution({ maxAmount: usd(50_001) })))).toBe(
      'PER_ACTION_CAP',
    );
    expect(
      code(
        request(
          {},
          execution({
            maxAmount: { amount: '1', currency: 'EUR', decimals: 2 },
          }),
        ),
      ),
    ).toBe('CURRENCY_MISMATCH');
    expect(code(request({ groupId: 'group-2' }))).toBe('GROUP_MISMATCH');
    expect(a.authorize(request(), ['alice', 'mallory'], T)).toMatchObject({
      code: 'APPROVER_NOT_MEMBER',
    });
  });
  it('enforces the cumulative budget but re-issues the same request idempotently', () => {
    const a = authority();
    const g1 = grantOf(a);
    expect(grantOf(a).grantId).toBe(g1.grantId);
    grantOf(a, request({ intentId: 'intent-2' }));
    expect(
      a.authorize(request({ intentId: 'intent-3' }), ['alice', 'bob'], T),
    ).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(a.spentFor('web2-1')).toBe(60_000n);
  });
  it('consumes a grant once and only for the exact bound execution', () => {
    const a = authority();
    const g = grantOf(a);
    expect(() => a.consume(g, execution({ quantity: 2 }), T)).toThrow(
      /GRANT_BINDING: quantity/,
    );
    expect(() => a.consume(g, execution({ host: 'api.duffel.co' }), T)).toThrow(
      /GRANT_BINDING: merchant host/,
    );
    expect(() =>
      a.consume(g, execution({ maxAmount: usd(30_001) }), T),
    ).toThrow(/GRANT_BINDING: amount/);
    expect(() =>
      a.consume(g, execution({ recipientRef: 'addr-2' }), T),
    ).toThrow(/GRANT_BINDING: recipient/);
    expect(() =>
      a.consume(g, execution({ subjectHash: `0x${'cd'.repeat(32)}` }), T),
    ).toThrow(/item/);
    a.consume(g, execution({ maxAmount: usd(29_000) }), T);
    expect(() => a.consume(g, execution(), T)).toThrow(/GRANT_CONSUMED/);
  });
  it('rejects tampered, foreign, expired and revoked-mandate grants', () => {
    const a = authority();
    const g = grantOf(a);
    expect(() =>
      a.consume(
        { ...g, execution: { ...g.execution, quantity: 5 } },
        execution({ quantity: 5 }),
        T,
      ),
    ).toThrow(/GRANT_INVALID/);
    const other = new EconomicGrantAuthority(new Uint8Array(32).fill(9));
    other.install(mandate);
    expect(() => other.consume(g, execution(), T)).toThrow(/GRANT_MAC/);
    expect(() => a.verify(g, execution(), g.expiresAt)).toThrow(
      /GRANT_EXPIRED/,
    );
    a.revoke('web2-1');
    expect(() => a.verify(g, execution(), T)).toThrow(/mandate changed/);
    expect(() => new EconomicGrantAuthority(new Uint8Array(8))).toThrow();
  });
});
