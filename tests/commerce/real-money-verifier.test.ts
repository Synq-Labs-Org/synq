import { describe, expect, it } from 'vitest';
import {
  EconomicGrantAuthority,
  MemoryEconomicGrantLedger,
  type EconomicGrant,
} from '@synq/kernel';
import {
  BITREFILL,
  BitrefillClient,
  LITHIC,
  bitrefillInvoiceOfferId,
  type HttpFetch,
} from '@synq/plugin-commerce';
import {
  KernelGrantRealMoneyVerifier,
  bitrefillRealMoneyGate,
} from '../../workers/workflow/src/commerce/real-money.js';
import {
  approvalPorts,
  reservationsWith,
} from '../kernel/economic-fixtures.js';

const NOW = 1_790_000_000;
const usd = (cents: number) => ({
  amount: String(cents),
  currency: 'USD',
  decimals: 2,
});
const HASH = `0x${'ab'.repeat(32)}` as const;

async function world() {
  const reservations = await reservationsWith(
    'group-1',
    'ausd',
    [
      {
        reservationId: 'r-1',
        amount: '50000000',
        planHash: 'plan-1',
        expiresAt: NOW + 3_600,
      },
      {
        reservationId: 'r-2',
        amount: '50000000',
        planHash: 'plan-2',
        expiresAt: NOW + 3_600,
      },
    ],
    NOW,
  );
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(32).fill(7),
    reservations,
    ledger: new MemoryEconomicGrantLedger(),
    approvals: approvalPorts(['alice', 'bob']),
  });
  await authority.install({
    mandateId: 'gift-real',
    groupId: 'group-1',
    version: 1,
    status: 'ACTIVE',
    domains: ['COMMERCE'],
    providers: [BITREFILL, LITHIC],
    hosts: ['api.bitrefill.com', 'sandbox.lithic.com'],
    perActionCap: usd(5_000),
    cumulativeBudget: usd(20_000),
    autoApproveMax: usd(5_000),
    quorum: 1,
    members: ['alice', 'bob'],
    // TESTNET mandates take human passkey approvers only; these grants auto-approve.
    approverKinds: ['MERA_HUMAN'],
    maxQuoteAgeSeconds: 900,
    grantTtlSeconds: 900,
    environment: 'TESTNET',
    validUntil: NOW + 86_400,
  });
  const grantFor = async (input: {
    intentId: string;
    providerId: string;
    host: string;
    offerId: string;
    cents: number;
    reservationId: string;
    planHash: string;
  }): Promise<EconomicGrant> => {
    const d = await authority.authorize(
      {
        intentId: input.intentId,
        groupId: 'group-1',
        mandateId: 'gift-real',
        execution: {
          domain: 'COMMERCE',
          providerId: input.providerId,
          host: input.host,
          offerId: input.offerId,
          subjectHash: HASH,
          quantity: 1,
          maxAmount: usd(input.cents),
          reservationId: input.reservationId,
          reservedAssetId: 'ausd',
          reservedAmount: '10000000',
          settlementPlanHash: input.planHash,
          recipientRef: null,
          payAsset: null,
        },
        quoteExpiresAt: NOW + 600,
        revalidatedAt: NOW,
      },
      [],
      NOW,
    );
    if (d.status !== 'AUTHORIZED') throw new Error(JSON.stringify(d));
    return d.grant;
  };
  return { authority, grantFor };
}

const ref = (id: string) => ({ kind: 'KERNEL_GRANT' as const, id });

describe('Kernel-grant real-money verifier (L4)', () => {
  it('RMV-001 accepts only a Kernel grant for exactly this Bitrefill invoice, amount and currency, once', async () => {
    const w = await world();
    const grant = await w.grantFor({
      intentId: 'intent-brf-1',
      providerId: BITREFILL,
      host: 'api.bitrefill.com',
      offerId: bitrefillInvoiceOfferId('inv-1'),
      cents: 1_000,
      reservationId: 'r-1',
      planHash: 'plan-1',
    });
    const v = new KernelGrantRealMoneyVerifier(w.authority);
    const call = (o: Partial<Parameters<typeof v.verifyAndConsume>[0]> = {}) =>
      v.verifyAndConsume({
        reference: ref(grant.grantId),
        invoiceId: 'inv-1',
        amountMinor: 1_000n,
        currency: 'USD',
        now: NOW + 5,
        ...o,
      });
    expect(
      await call({ reference: { kind: 'MERA_APPROVAL', id: grant.grantId } }),
    ).toBe(false);
    expect(await call({ reference: ref(`0x${'00'.repeat(32)}`) })).toBe(false);
    expect(await call({ invoiceId: 'inv-2' })).toBe(false);
    expect(await call({ amountMinor: 999n })).toBe(false);
    expect(await call({ amountMinor: 1_001n })).toBe(false);
    expect(await call({ currency: 'EUR' })).toBe(false);
    expect(await call({ currency: 'BTC' })).toBe(false);
    expect(await call({ now: grant.expiresAt })).toBe(false);
    expect(await w.authority.isConsumed(grant.grantId)).toBe(false);
    expect(await call()).toBe(true);
    expect(await w.authority.isConsumed(grant.grantId)).toBe(true);
    expect(await call()).toBe(false);
  });

  it('RMV-002 a grant for another provider or a revoked mandate never approves real money', async () => {
    const w = await world();
    const lithic = await w.grantFor({
      intentId: 'intent-lithic',
      providerId: LITHIC,
      host: 'sandbox.lithic.com',
      offerId: bitrefillInvoiceOfferId('inv-1'),
      cents: 1_000,
      reservationId: 'r-1',
      planHash: 'plan-1',
    });
    const v = new KernelGrantRealMoneyVerifier(w.authority);
    const input = {
      invoiceId: 'inv-1',
      amountMinor: 1_000n,
      currency: 'USD',
      now: NOW + 5,
    };
    expect(
      await v.verifyAndConsume({ ...input, reference: ref(lithic.grantId) }),
    ).toBe(false);
    const brf = await w.grantFor({
      intentId: 'intent-brf-2',
      providerId: BITREFILL,
      host: 'api.bitrefill.com',
      offerId: bitrefillInvoiceOfferId('inv-1'),
      cents: 1_000,
      reservationId: 'r-2',
      planHash: 'plan-2',
    });
    await w.authority.revoke('gift-real');
    expect(
      await v.verifyAndConsume({ ...input, reference: ref(brf.grantId) }),
    ).toBe(false);
    expect(await w.authority.isConsumed(brf.grantId)).toBe(false);
  });

  it('RMV-003 default wiring is deny-all; even a valid grant with every flag set reaches NO_BROADCAST_PATH', async () => {
    const w = await world();
    const grant = await w.grantFor({
      intentId: 'intent-brf-3',
      providerId: BITREFILL,
      host: 'api.bitrefill.com',
      offerId: bitrefillInvoiceOfferId('inv-9'),
      cents: 1_000,
      reservationId: 'r-1',
      planHash: 'plan-1',
    });
    expect(bitrefillRealMoneyGate({}, w.authority).verifier).toBe('DENY_ALL');
    expect(
      bitrefillRealMoneyGate({ SYNQ_BITREFILL_APPROVALS: 'kernel-grant' }, null)
        .verifier,
    ).toBe('DENY_ALL');
    const calls: string[] = [];
    const fetch: HttpFetch = async (url) => {
      calls.push(url);
      return { status: 500, text: async () => '{}' };
    };
    const client = new BitrefillClient(
      { kind: 'PERSONAL', apiKey: 'k' },
      fetch,
    );
    const pay = (env: Record<string, string>) =>
      client.payInvoice({
        gate: bitrefillRealMoneyGate(env, w.authority).gate,
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        invoiceId: 'inv-9',
        amountMinor: 1_000n,
        currency: 'USD',
        approval: {
          approvalId: 'a-1',
          reference: ref(grant.grantId),
          invoiceId: 'inv-9',
          capMinor: 1_000n,
          currency: 'USD',
          expiresAt: NOW + 600,
        },
        now: NOW + 5,
      });
    // Shipped defaults: broadcast off, canary 0. Denied before the Kernel is asked.
    await expect(
      pay({
        SYNQ_BITREFILL_APPROVALS: 'kernel-grant',
        SYNQ_ALLOW_MAINNET_BROADCAST: 'false',
        SYNQ_MAINNET_CANARY_MAX_USD: '0',
      }),
    ).rejects.toThrow(/REAL_MONEY_DENIED: SYNQ_ALLOW_MAINNET_BROADCAST/);
    await expect(
      pay({
        SYNQ_BITREFILL_APPROVALS: 'kernel-grant',
        SYNQ_ALLOW_MAINNET_BROADCAST: 'true',
        SYNQ_MAINNET_CANARY_MAX_USD: '0',
      }),
    ).rejects.toThrow(/REAL_MONEY_DENIED: SYNQ_MAINNET_CANARY_MAX_USD/);
    expect(await w.authority.isConsumed(grant.grantId)).toBe(false);
    // Explicitly configured: the grant is verified and consumed, and still nothing pays.
    await expect(
      pay({
        SYNQ_BITREFILL_APPROVALS: 'kernel-grant',
        SYNQ_ALLOW_MAINNET_BROADCAST: 'true',
        SYNQ_MAINNET_CANARY_MAX_USD: '20',
      }),
    ).rejects.toThrow(/NO_BROADCAST_PATH/);
    expect(await w.authority.isConsumed(grant.grantId)).toBe(true);
    expect(calls).toEqual([]);
  });
});
