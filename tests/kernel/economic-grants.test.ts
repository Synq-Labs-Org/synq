import { describe, expect, it } from 'vitest';
import {
  EconomicGrantAuthority,
  economicRequestHash,
  type EconomicAuthorizationRequest,
  type EconomicExecution,
  type EconomicGrant,
} from '@synq/kernel';
import {
  approval,
  reservationsWith,
  approvalPorts,
  memoryLedger,
} from './economic-fixtures.js';

const T = 1_780_000_000;
const KEY = new Uint8Array(32).fill(7);
const ASSET = 'eip155:10143/erc20:ausd';
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const mandate = {
  mandateId: 'web2-1',
  groupId: 'group-1',
  version: 1,
  status: 'ACTIVE' as const,
  domains: ['STAY' as const, 'COMMERCE' as const, 'DATA' as const],
  providers: ['duffel-stays', 'crossmint'],
  hosts: ['api.duffel.com', 'staging.crossmint.com'],
  perActionCap: usd(50_000),
  cumulativeBudget: usd(60_000),
  autoApproveMax: usd(1_000),
  quorum: 2,
  members: ['alice', 'bob', 'carol'],
  approverKinds: ['LOCAL_FIXTURE' as const],
  maxQuoteAgeSeconds: 120,
  grantTtlSeconds: 300,
  environment: 'SANDBOX' as const,
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
  reservedAssetId: ASSET,
  reservedAmount: '300000000',
  settlementPlanHash: '0xplan',
  recipientRef: null,
  payAsset: null,
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
  ...over,
});
const holds = ['res-1', 'res-2', 'res-3', 'res-4'].map((reservationId) => ({
  reservationId,
  amount: '300000000',
  planHash: '0xplan',
  expiresAt: T + 3_600,
}));
async function authority(m: object = mandate) {
  const reservations = await reservationsWith('group-1', ASSET, holds, T);
  const a = new EconomicGrantAuthority({
    key: KEY,
    reservations,
    ledger: memoryLedger(),
    approvals: approvalPorts(['alice', 'bob', 'carol']),
  });
  await a.install(m as typeof mandate);
  return { a, reservations };
}
const M = { mandateId: 'web2-1' };
const quorum = async (r: EconomicAuthorizationRequest) => [
  await approval('alice', economicRequestHash(r), M),
  await approval('bob', economicRequestHash(r), M),
];
async function grantOf(
  a: EconomicGrantAuthority,
  r = request(),
): Promise<EconomicGrant> {
  const d = await a.authorize(r, await quorum(r), T);
  if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
  return d.grant;
}

describe('EconomicGrantAuthority', () => {
  it('requires quorum of identity-verified approvals bound to the request hash', async () => {
    const { a } = await authority();
    const r = request();
    const h = economicRequestHash(r);
    const bob = await approval('bob', h, M);
    expect(
      await a.authorize(r, [await approval('alice', h, M)], T),
    ).toMatchObject({
      status: 'PENDING_APPROVAL',
      requiredApprovals: 2,
      requestHash: h,
    });
    expect(await a.authorize(r, ['alice', 'bob'], T)).toMatchObject({
      status: 'PENDING_APPROVAL',
      approvals: [],
    });
    const other = economicRequestHash(request({ quoteExpiresAt: T + 601 }));
    expect(
      await a.authorize(
        r,
        [await approval('alice', other, M), await approval('bob', other, M)],
        T,
      ),
    ).toMatchObject({ status: 'PENDING_APPROVAL', approvals: [] });
    expect(
      await a.authorize(
        r,
        [await approval('alice', h, { ...M, groupId: 'group-2' }), bob],
        T,
      ),
    ).toMatchObject({ approvals: ['bob'] });
    expect(
      await a.authorize(
        r,
        [
          await approval('alice', h, {
            ...M,
            principalKind: 'DYNAMIC_OPERATOR',
          }),
          bob,
        ],
        T,
      ),
    ).toMatchObject({ approvals: ['bob'] });
    expect(
      await a.authorize(r, [await approval('mallory', h, M), bob], T),
    ).toMatchObject({ code: 'APPROVER_NOT_MEMBER' });
    expect((await a.authorize(r, await quorum(r), T)).status).toBe(
      'AUTHORIZED',
    );
    const small = request(
      { intentId: 'small' },
      execution({ maxAmount: usd(900), reservationId: 'res-2' }),
    );
    expect((await a.authorize(small, [], T)).status).toBe('AUTHORIZED');
  });
  it('regression: approvals must carry a real member signature, current epoch, active membership and identity consumption', async () => {
    const r = request();
    const h = economicRequestHash(r);
    const reservations = await reservationsWith('group-1', ASSET, holds, T);
    const make = async (ports: ReturnType<typeof approvalPorts>) => {
      const a = new EconomicGrantAuthority({
        key: KEY,
        reservations,
        ledger: memoryLedger(),
        approvals: ports,
      });
      await a.install(mandate);
      return a;
    };
    const a = await make(approvalPorts(['alice', 'bob', 'carol']));
    const alice = await approval('alice', h, M);
    const dummy = { ...alice, signature: `0x${'11'.repeat(65)}` };
    expect(
      await a.authorize(r, [dummy, await approval('bob', h, M)], T),
    ).toMatchObject({ approvals: ['bob'] });
    const forged = await approval('alice', h, { ...M, signAs: 'mallory' });
    expect(
      await a.authorize(r, [forged, await approval('bob', h, M)], T),
    ).toMatchObject({ approvals: ['bob'] });
    expect(
      await a.authorize(r, [alice, { ...alice, approvalId: 'apr-x' }], T),
    ).toMatchObject({ approvals: ['alice'] });
    const stale = await make(
      approvalPorts(['alice', 'bob', 'carol'], { epoch: 2 }),
    );
    expect(
      await stale.authorize(r, [alice, await approval('bob', h, M)], T),
    ).toMatchObject({ approvals: [] });
    const inactive = await make(
      approvalPorts(['alice', 'bob', 'carol'], { inactive: ['alice'] }),
    );
    expect(
      await inactive.authorize(r, [alice, await approval('bob', h, M)], T),
    ).toMatchObject({ approvals: ['bob'] });
    const unconsumed = await make(
      approvalPorts(['alice', 'bob', 'carol'], {
        consumed: (x) => x.memberId !== 'alice',
      }),
    );
    expect(
      await unconsumed.authorize(r, [alice, await approval('bob', h, M)], T),
    ).toMatchObject({ approvals: ['bob'] });
    expect(
      () => new EconomicGrantAuthority({ key: KEY, reservations } as never),
    ).toThrow(/PORTS_REQUIRED/);
  });
  it('reads the reservation itself: missing, released, mismatched or under-funded holds are refused', async () => {
    const { a, reservations } = await authority();
    const code = async (r: EconomicAuthorizationRequest) => {
      const d = await a.authorize(r, await quorum(r), T);
      return d.status === 'REJECTED' ? d.code : d.status;
    };
    expect(await code(request({}, execution({ reservationId: 'nope' })))).toBe(
      'RESERVATION_MISSING',
    );
    expect(
      await code(request({}, execution({ settlementPlanHash: '0xother' }))),
    ).toBe('RESERVATION_MISMATCH');
    expect(
      await code(request({}, execution({ reservedAmount: '300000001' }))),
    ).toBe('RESERVATION_MISMATCH');
    expect(
      await code(
        request({}, execution({ reservedAssetId: 'eip155:1/erc20:x' })),
      ),
    ).toBe('RESERVATION_MISMATCH');
    await reservations.release('res-1', 'gone', T);
    expect(await code(request())).toBe('RESERVATION_MISMATCH');
  });
  it('refuses unrevalidated, expired and out-of-mandate requests', async () => {
    const { a } = await authority();
    const code = async (r: EconomicAuthorizationRequest) => {
      const d = await a.authorize(r, await quorum(r), T);
      return d.status === 'REJECTED' ? d.code : d.status;
    };
    expect(await code(request({ revalidatedAt: null }))).toBe(
      'QUOTE_NOT_REVALIDATED',
    );
    expect(await code(request({ revalidatedAt: T - 121 }))).toBe(
      'QUOTE_NOT_REVALIDATED',
    );
    expect(await code(request({ quoteExpiresAt: T }))).toBe('QUOTE_EXPIRED');
    expect(
      await code(request({}, execution({ host: 'evil.example.com' }))),
    ).toBe('HOST_FORBIDDEN');
    expect(await code(request({}, execution({ providerId: 'expedia' })))).toBe(
      'PROVIDER_FORBIDDEN',
    );
    expect(await code(request({}, execution({ domain: 'FLIGHT' })))).toBe(
      'DOMAIN_FORBIDDEN',
    );
    expect(await code(request({}, execution({ maxAmount: usd(50_001) })))).toBe(
      'PER_ACTION_CAP',
    );
    expect(
      await code(
        request(
          {},
          execution({
            maxAmount: { amount: '1', currency: 'EUR', decimals: 2 },
          }),
        ),
      ),
    ).toBe('CURRENCY_MISMATCH');
    expect(await code(request({ groupId: 'group-2' }))).toBe('GROUP_MISMATCH');
  });
  it('regression: a consumed intent can never be re-granted and every issuance is charged', async () => {
    const { a } = await authority();
    const g1 = await grantOf(a);
    expect((await grantOf(a)).grantId).toBe(g1.grantId);
    expect(await a.spentFor('web2-1')).toBe(30_000n);
    await a.consume(g1, execution(), T);
    expect(
      await a.authorize(request(), await quorum(request()), T),
    ).toMatchObject({
      code: 'INTENT_ALREADY_EXECUTED',
    });
    const r2 = request(
      { intentId: 'intent-2' },
      execution({ reservationId: 'res-2' }),
    );
    const g2 = await grantOf(a, r2);
    expect(await a.spentFor('web2-1')).toBe(60_000n);
    const r2b = request(
      { intentId: 'intent-2' },
      execution({ reservationId: 'res-2', maxAmount: usd(29_999) }),
    );
    expect(await a.authorize(r2b, await quorum(r2b), T)).toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
    await a.consume(g2, execution({ reservationId: 'res-2' }), T);
    const r3 = request(
      { intentId: 'intent-3' },
      execution({ reservationId: 'res-3', maxAmount: usd(20_000) }),
    );
    expect(await a.authorize(r3, await quorum(r3), T)).toMatchObject({
      code: 'BUDGET_EXHAUSTED',
    });
    expect(await a.spentFor('web2-1')).toBe(60_000n);
  });
  it('consumes a grant once and only for the exact bound execution', async () => {
    const { a } = await authority();
    const g = await grantOf(a);
    await expect(a.consume(g, execution({ quantity: 2 }), T)).rejects.toThrow(
      /GRANT_BINDING: quantity/,
    );
    await expect(
      a.consume(g, execution({ host: 'api.duffel.co' }), T),
    ).rejects.toThrow(/merchant host/);
    await expect(
      a.consume(g, execution({ maxAmount: usd(30_001) }), T),
    ).rejects.toThrow(/GRANT_BINDING: amount/);
    await expect(
      a.consume(g, execution({ recipientRef: 'addr-2' }), T),
    ).rejects.toThrow(/recipient/);
    await expect(
      a.consume(g, execution({ subjectHash: `0x${'cd'.repeat(32)}` }), T),
    ).rejects.toThrow(/item/);
    await expect(
      a.consume(
        g,
        execution({
          payAsset: {
            chainId: 10143,
            address: `0x${'12'.repeat(20)}`,
            decimals: 6,
          },
        }),
        T,
      ),
    ).rejects.toThrow(/pay asset/);
    await a.consume(g, execution({ maxAmount: usd(29_000) }), T);
    await expect(a.consume(g, execution(), T)).rejects.toThrow(
      /GRANT_CONSUMED/,
    );
  });
  it('rejects tampered, foreign, expired and revoked-mandate grants; mandate versions only move forward', async () => {
    const { a, reservations } = await authority();
    const g = await grantOf(a);
    await expect(
      a.consume(
        { ...g, execution: { ...g.execution, quantity: 5 } },
        execution({ quantity: 5 }),
        T,
      ),
    ).rejects.toThrow(/GRANT_INVALID/);
    const other = new EconomicGrantAuthority({
      key: new Uint8Array(32).fill(9),
      reservations,
      ledger: memoryLedger(),
      approvals: approvalPorts(['alice', 'bob', 'carol']),
    });
    await other.install(mandate);
    await expect(other.consume(g, execution(), T)).rejects.toThrow(/GRANT_MAC/);
    await expect(a.verify(g, execution(), g.expiresAt)).rejects.toThrow(
      /GRANT_EXPIRED/,
    );
    await expect(a.install(mandate)).rejects.toThrow(
      /MANDATE_VERSION_NOT_NEWER/,
    );
    await a.revoke('web2-1');
    await expect(a.verify(g, execution(), T)).rejects.toThrow(
      /mandate changed/,
    );
    expect(
      () =>
        new EconomicGrantAuthority({
          key: new Uint8Array(8),
          reservations,
          ledger: memoryLedger(),
          approvals: approvalPorts(['alice', 'bob', 'carol']),
        }),
    ).toThrow();
  });
});
