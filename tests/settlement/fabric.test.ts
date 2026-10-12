import { describe, expect, it } from 'vitest';
import {
  MemoryReservationStore,
  MemorySettlementFabricStore,
  idempotencyUuid,
  receiptStatement,
  selectExecutionRoute,
  settlementIdempotencyKey,
  type ExecutionNeed,
  type ProviderExecutionCapability,
} from '@synq/settlement';
import { fabricScenarios } from './fabric-scenarios.js';

fabricScenarios('memory', async () => ({
  store: new MemorySettlementFabricStore(),
  reservations: new MemoryReservationStore(),
}));

const cap = (
  over: Partial<ProviderExecutionCapability> &
    Pick<ProviderExecutionCapability, 'providerId' | 'category' | 'mode'>,
): ProviderExecutionCapability => ({
  displayName: over.providerId,
  products: ['GIFT_CARD'],
  currencies: ['USD'],
  chains: [],
  sandbox: { available: true },
  live: { available: false, reason: null },
  credentials: 'PRESENT',
  credentialEnv: [],
  identityChecks: ['NONE'],
  identitySatisfied: true,
  funding: 'PREFUNDED_PROVIDER_BALANCE',
  economicEffect: 'NONE_SANDBOX',
  cancel: { supported: false },
  refund: { supported: false },
  health: 'HEALTHY',
  partnerGated: false,
  statusReason: null,
  sourceRefs: [],
  ...over,
});
const gift: ExecutionNeed = {
  intentId: 'i1',
  product: 'GIFT_CARD',
  currency: 'USD',
  requiredChain: null,
  allowedModes: ['PROVIDER_SANDBOX', 'TESTNET'],
  categories: [
    'DIGITAL_GOODS_SANDBOX',
    'CRYPTO_COMMERCE_REAL',
    'MERCHANT_CHECKOUT',
    'HUMAN_HANDOFF',
  ],
};

describe('SettlementRouter v1.3 capability selection', () => {
  it('RTR-001 selects the executable sandbox provider and labels it PROVIDER_SANDBOX', () => {
    const d = selectExecutionRoute(gift, [
      cap({
        providerId: 'bitrefill',
        category: 'CRYPTO_COMMERCE_REAL',
        mode: 'MAINNET_READ_ONLY',
        economicEffect: 'NONE_READ_ONLY',
      }),
      cap({
        providerId: 'reloadly-sandbox',
        category: 'DIGITAL_GOODS_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
      }),
    ]);
    expect(d.status).toBe('SELECTED');
    if (d.status !== 'SELECTED') return;
    expect(d.provider.providerId).toBe('reloadly-sandbox');
    expect(d.label).toBe('PROVIDER_SANDBOX');
    expect(
      d.considered.find((c) => c.providerId === 'bitrefill')!.verdict,
    ).toMatch(/read-only/);
  });

  it('RTR-002 falls back to human handoff when credentials are missing, and never auto-selects real money', () => {
    const d = selectExecutionRoute(gift, [
      cap({
        providerId: 'reloadly-sandbox',
        category: 'DIGITAL_GOODS_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
        credentials: 'MISSING',
      }),
      cap({
        providerId: 'bitrefill',
        category: 'CRYPTO_COMMERCE_REAL',
        mode: 'REAL_MONEY_APPROVAL_REQUIRED',
        economicEffect: 'REAL_MONEY',
      }),
    ]);
    expect(d.status).toBe('HUMAN_HANDOFF');
    expect(d.considered.map((c) => c.verdict).join('|')).toMatch(
      /credentials MISSING.*real money/,
    );
  });

  it('RTR-003 requires the invoice network/asset to be accepted (Monad AUSD is not assumed payable)', () => {
    const d = selectExecutionRoute(
      {
        ...gift,
        allowedModes: ['MAINNET_SIMULATION'],
        requiredChain: { chain: 'monad-testnet', asset: 'AUSD' },
      },
      [
        cap({
          providerId: 'bitrefill',
          category: 'CRYPTO_COMMERCE_REAL',
          mode: 'MAINNET_SIMULATION',
          economicEffect: 'NONE_READ_ONLY',
          chains: [{ chain: 'base', asset: 'USDC' }],
        }),
      ],
    );
    expect(d.status).toBe('HUMAN_HANDOFF');
    expect(d.considered[0]!.verdict).toMatch(/not accepted/);
  });

  it('RTR-004 skips down, partner-gated, KYC-unmet and wrong-currency providers', () => {
    const base = {
      category: 'DIGITAL_GOODS_SANDBOX' as const,
      mode: 'PROVIDER_SANDBOX' as const,
    };
    const d = selectExecutionRoute(
      { ...gift, categories: ['DIGITAL_GOODS_SANDBOX'] },
      [
        cap({ ...base, providerId: 'a', health: 'DOWN' }),
        cap({ ...base, providerId: 'b', partnerGated: true }),
        cap({
          ...base,
          providerId: 'c',
          identityChecks: ['ACCOUNT_KYB'],
          identitySatisfied: false,
        }),
        cap({ ...base, providerId: 'd', currencies: ['EUR'] }),
      ],
    );
    expect(d.status).toBe('UNAVAILABLE');
    expect(d.considered.map((c) => c.verdict)).toEqual([
      'provider down',
      'partner gated',
      'identity checks unmet: ACCOUNT_KYB',
      'currency USD not supported',
    ]);
  });

  it('RTR-005 idempotency keys are deterministic and UUID keys are well formed', () => {
    const k = settlementIdempotencyKey({
      groupId: 'g',
      intentId: 'i',
      providerId: 'p',
      subject: 's',
    });
    expect(k).toBe(
      settlementIdempotencyKey({
        groupId: 'g',
        intentId: 'i',
        providerId: 'p',
        subject: 's',
      }),
    );
    expect(k).not.toBe(
      settlementIdempotencyKey({
        groupId: 'g',
        intentId: 'i',
        providerId: 'p',
        subject: 's',
        attempt: 1,
      }),
    );
    expect(idempotencyUuid(k)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('RTR-006 receipt statements never claim an AUSD payment for sandbox card authorizations', () => {
    expect(
      receiptStatement({
        category: 'CARD_NETWORK_SANDBOX',
        mode: 'PROVIDER_SANDBOX',
        providerName: 'Lithic',
      }),
    ).toBe(
      'Synq authorized a simulated card payment using an actual card-issuing sandbox',
    );
  });
});
