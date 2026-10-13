import { describe, expect, it } from 'vitest';
import {
  BITREFILL,
  CROSSMINT,
  LITHIC,
  RELOADLY,
  type GiftCodeSealer,
  type GiftRecipientDirectory,
  type HttpFetch,
} from '@synq/plugin-commerce';
import { commerceProvidersFromEnv } from '../../workers/workflow/src/commerce/providers.js';
import { unconfiguredBooking } from '../../workers/workflow/src/commerce/runtime.js';

const calls: string[] = [];
const fetch: HttpFetch = async (url) => {
  calls.push(url);
  return { status: 500, text: async () => '{}' };
};
const sealer: GiftCodeSealer = { seal: async () => ({ ref: 'gc_x' }) };
const recipients: GiftRecipientDirectory = {
  summary: async () => ({ kind: 'RECIPIENT', expired: false }),
};
const build = (
  env: Record<string, string>,
  giftCodes: GiftCodeSealer | null = sealer,
) =>
  commerceProvidersFromEnv(env, {
    fetch,
    now: () => 1_790_000_000,
    giftCodes,
    recipients: giftCodes ? recipients : null,
  });
const statusOf = (p: ReturnType<typeof build>) =>
  Object.fromEntries(p.status.map((s) => [s.providerId, s]));

describe('commerce providers from env (I4)', () => {
  it('CPR-001 no credentials: every provider is BLOCKED_EXTERNAL, no port or rail is usable, nothing is called', () => {
    const p = build({});
    expect(p.status.map((s) => [s.providerId, s.status])).toEqual([
      [RELOADLY, 'BLOCKED_EXTERNAL'],
      [LITHIC, 'BLOCKED_EXTERNAL'],
      [CROSSMINT, 'BLOCKED_EXTERNAL'],
      [BITREFILL, 'BLOCKED_EXTERNAL'],
    ]);
    expect(p.ports).toEqual({});
    expect(p.providers).toEqual({});
    expect(p.rails.every((r) => r.status === 'MISSING_CREDENTIALS')).toBe(true);
    expect(p.bitrefill).toBeNull();
    expect(p.crossmint).toBeNull();
    expect(calls).toEqual([]);
  });

  it('CPR-002 sandbox credentials install sandbox ports with honest labels; Bitrefill is read-only, Crossmint has no payer', () => {
    const p = build({
      RELOADLY_CLIENT_ID: 'rid',
      RELOADLY_CLIENT_SECRET: 'rsecret-value',
      LITHIC_API_KEY: 'lithic-key-value',
      SYNQ_LITHIC_SIM_MERCHANT: JSON.stringify({
        descriptor: 'SYNQ TEST CAFE',
        title: 'Team lunch',
        priceCents: 1_840,
      }),
      CROSSMINT_API_KEY: 'sk_staging_value',
      BITREFILL_API_KEY: 'brf-key-value',
    });
    const s = statusOf(p);
    expect(s[RELOADLY]).toMatchObject({
      status: 'READY',
      label: 'PROVIDER_SANDBOX',
    });
    expect(s[LITHIC]).toMatchObject({
      status: 'READY',
      label: 'PROVIDER_SANDBOX',
    });
    expect(s[CROSSMINT]).toMatchObject({
      status: 'BLOCKED_EXTERNAL',
      label: 'REAL_TESTNET',
    });
    expect(s[BITREFILL]).toMatchObject({
      status: 'READ_ONLY',
      label: 'MAINNET_READ_ONLY',
    });
    expect(Object.keys(p.ports).sort()).toEqual([LITHIC, RELOADLY].sort());
    expect(p.ports[BITREFILL]).toBeUndefined();
    expect(p.crossmint?.sandboxReady()).toBe(false);
    expect(
      p.rails.every((r) => r.status === 'READY' && r.environment === 'SANDBOX'),
    ).toBe(true);
    for (const port of Object.values(p.ports))
      expect(port.settlement?.economicEffect).toBe('NONE_SANDBOX');
    expect(p.graph.usable(RELOADLY, 'PURCHASE', 1_790_000_000)).toBe(true);
    expect(calls).toEqual([]);
  });

  it('CPR-003 refused configurations are UNAVAILABLE, never crash, and never echo a secret', () => {
    const env = {
      RELOADLY_CLIENT_ID: 'rid',
      RELOADLY_CLIENT_SECRET: 'rsecret-value',
      RELOADLY_ENV: 'production',
      LITHIC_API_KEY: 'lithic-key-value',
      LITHIC_ENV: 'production',
      CROSSMINT_API_KEY: 'sk_production_value',
      BITREFILL_API_KEY: 'brf-key-value',
    };
    const p = build(env);
    const s = statusOf(p);
    expect(s[RELOADLY]!.status).toBe('UNAVAILABLE');
    expect(s[RELOADLY]!.reason).toMatch(/RELOADLY_NOT_SANDBOX/);
    expect(s[LITHIC]!.status).toBe('UNAVAILABLE');
    expect(s[LITHIC]!.reason).toMatch(/LITHIC_NOT_SANDBOX/);
    expect(s[CROSSMINT]!.status).toBe('UNAVAILABLE');
    expect(s[CROSSMINT]!.reason).toMatch(/CROSSMINT_NOT_STAGING/);
    expect(p.ports).toEqual({});
    const text = JSON.stringify(p.status);
    for (const secret of [
      'rsecret-value',
      'lithic-key-value',
      'sk_production_value',
      'brf-key-value',
    ])
      expect(text).not.toContain(secret);
    // Credentials without the supporting pieces stay uninstalled.
    const partial = statusOf(
      build(
        {
          RELOADLY_CLIENT_ID: 'rid',
          RELOADLY_CLIENT_SECRET: 's',
          LITHIC_API_KEY: 'k',
        },
        null,
      ),
    );
    expect(partial[RELOADLY]!.status).toBe('UNAVAILABLE');
    expect(partial[RELOADLY]!.reason).toMatch(/SYNQ_PROFILE_VAULT_KEY/);
    expect(partial[LITHIC]!.status).toBe('UNAVAILABLE');
    expect(partial[LITHIC]!.reason).toMatch(/SYNQ_LITHIC_SIM_MERCHANT/);
  });

  it('CPR-004 without the Kernel grant key every booking Activity refuses non-retryably', async () => {
    const a = unconfiguredBooking('SYNQ_ECONOMIC_GRANT_KEY not set');
    expect(Object.keys(a)).toHaveLength(11);
    for (const fn of Object.values(a))
      await expect((fn as () => Promise<unknown>)()).rejects.toMatchObject({
        type: 'NOT_CONFIGURED',
        nonRetryable: true,
      });
  });
});
