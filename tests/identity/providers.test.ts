import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DynamicAdapter,
  PrivyAdapter,
  ProviderBlockedError,
  canonicalJson,
  evaluateDelegation,
  privyPolicyBody,
  type FetchLike,
} from '../../packages/identity/src/server.js';
import type { DelegationPolicy } from '@synq/schemas';
import { addr, testAusd } from './fixtures.js';

const neverFetch: FetchLike = async () => {
  throw new Error('network must not be touched when blocked');
};

const policy: DelegationPolicy = {
  schemaVersion: 1,
  policyId: 'weekly',
  groupId: 'g' as DelegationPolicy['groupId'],
  delegatePrincipalId: 'privy:x' as DelegationPolicy['delegatePrincipalId'],
  delegatorMemberId: 'm' as DelegationPolicy['delegatorMemberId'],
  asset: testAusd,
  recipient: addr(0xacc),
  maxAmountPerPeriod: '20000000',
  maxAmountPerExecution: '10000000',
  periodSeconds: 604800,
  maxExecutionsPerPeriod: 2,
  minIntervalSeconds: 3600,
  validAfter: 0,
  validUntil: 6048000,
  revokedAt: null,
};
const req = (amount: string, at: number, extra: object = {}) => ({
  amount,
  at,
  token: testAusd.address,
  chainId: 10143,
  recipient: addr(0xacc),
  ...extra,
});

describe('DelegationPolicy evaluator (deterministic, Synq-side)', () => {
  it('enforces per-execution cap, period amount, frequency, interval, window, asset, recipient and revocation', () => {
    expect(evaluateDelegation(policy, [], req('10000000', 10))).toMatchObject({
      allowed: true,
      remainingInPeriod: '10000000',
    });
    expect(evaluateDelegation(policy, [], req('10000001', 10))).toEqual({
      allowed: false,
      reason: 'PER_EXECUTION_CAP_EXCEEDED',
    });
    const used = [{ amount: '10000000', at: 10 }];
    expect(evaluateDelegation(policy, used, req('1', 100))).toEqual({
      allowed: false,
      reason: 'MIN_INTERVAL',
    });
    expect(
      evaluateDelegation(policy, used, req('10000000', 4000)),
    ).toMatchObject({ allowed: true, remainingInPeriod: '0' });
    const two = [...used, { amount: '5000000', at: 4000 }];
    expect(evaluateDelegation(policy, two, req('1', 9000))).toEqual({
      allowed: false,
      reason: 'FREQUENCY_EXCEEDED',
    });
    expect(
      evaluateDelegation(
        { ...policy, maxExecutionsPerPeriod: 5 },
        two,
        req('5000001', 9000),
      ),
    ).toEqual({ allowed: false, reason: 'PERIOD_AMOUNT_EXCEEDED' });
    expect(
      evaluateDelegation(policy, two, req('10000000', 604800)),
    ).toMatchObject({ allowed: true, periodIndex: 1 });
    expect(evaluateDelegation(policy, [], req('1', 6048000))).toEqual({
      allowed: false,
      reason: 'EXPIRED',
    });
    expect(
      evaluateDelegation({ ...policy, validAfter: 50 }, [], req('1', 10)),
    ).toEqual({ allowed: false, reason: 'NOT_YET_VALID' });
    expect(
      evaluateDelegation(policy, [], req('1', 10, { token: addr(9) })),
    ).toEqual({ allowed: false, reason: 'ASSET_MISMATCH' });
    expect(
      evaluateDelegation(policy, [], req('1', 10, { recipient: addr(9) })),
    ).toEqual({ allowed: false, reason: 'RECIPIENT_MISMATCH' });
    expect(
      evaluateDelegation({ ...policy, revokedAt: 5 }, [], req('1', 10)),
    ).toEqual({ allowed: false, reason: 'REVOKED' });
    expect(evaluateDelegation(policy, [], req('0', 10))).toEqual({
      allowed: false,
      reason: 'NON_POSITIVE_AMOUNT',
    });
  });
});

describe('Privy adapter (thin, credential-gated)', () => {
  it('reports BLOCKED with the exact missing variables and never calls the network', async () => {
    const adapter = new PrivyAdapter({}, neverFetch);
    expect(adapter.status()).toEqual({
      provider: 'privy',
      status: 'BLOCKED',
      missing: [
        'PRIVY_APP_ID',
        'PRIVY_APP_SECRET',
        'PRIVY_AUTHORIZATION_PRIVATE_KEY',
      ],
      reason: expect.any(String),
    });
    await expect(adapter.createPolicy(policy)).rejects.toBeInstanceOf(
      ProviderBlockedError,
    );
    await expect(adapter.createPolicy(policy)).rejects.toMatchObject({
      code: 'PROVIDER_BLOCKED',
    });
  });

  it('maps a DelegationPolicy onto Privy policy rules for capped ERC-20 transfers in a time window', () => {
    const body = privyPolicyBody(policy);
    expect(body).toMatchObject({ version: '1.0', chain_type: 'ethereum' });
    expect(body.rules.map((r) => [r.method, r.action])).toEqual([
      ['eth_signTransaction', 'ALLOW'],
      ['eth_sendTransaction', 'ALLOW'],
    ]);
    expect(body.rules[0]!.conditions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: 'to',
          operator: 'eq',
          value: testAusd.address,
        }),
        expect.objectContaining({
          field: 'transfer.recipient',
          operator: 'eq',
          value: addr(0xacc),
        }),
        expect.objectContaining({
          field: 'transfer.amount',
          operator: 'lte',
          value: '0x989680',
        }),
        expect.objectContaining({
          field: 'current_unix_timestamp',
          operator: 'lt',
          value: '6048000',
        }),
      ]),
    );
  });

  it('produces an RFC 8785-canonical P-256 authorization signature verifiable with the owner public key', async () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const encoded = `wallet-auth:${privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64')}`;
    const calls: {
      url: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    const recording: FetchLike = async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { signature: `0x${'1'.repeat(130)}` } }),
      };
    };
    const adapter = new PrivyAdapter(
      {
        PRIVY_APP_ID: 'app',
        PRIVY_APP_SECRET: 'secret',
        PRIVY_AUTHORIZATION_PRIVATE_KEY: encoded,
      },
      recording,
    );
    expect(adapter.status().status).toBe('CONFIGURED');
    await adapter.signTypedData(
      'wallet1',
      {
        domain: { name: 'x' },
        types: {},
        primaryType: 'X',
        message: { n: 1n },
      },
      'idem-1',
    );
    const call = calls[0]!;
    expect(call.url).toBe('https://api.privy.io/v1/wallets/wallet1/rpc');
    expect(call.headers['privy-app-id']).toBe('app');
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from('app:secret').toString('base64')}`,
    );
    const payload = canonicalJson({
      version: 1,
      method: 'POST',
      url: call.url,
      body: JSON.parse(call.body!),
      headers: { 'privy-app-id': 'app', 'privy-idempotency-key': 'idem-1' },
    });
    const publicKey = createPublicKey({
      key: Buffer.from(adapter.authorizationPublicKey(), 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(payload),
        publicKey,
        Buffer.from(call.headers['privy-authorization-signature']!, 'base64'),
      ),
    ).toBe(true);
    expect(JSON.parse(call.body!).params.typed_data).toMatchObject({
      primary_type: 'X',
      message: { n: '1' },
    });
  });

  it('canonicalizes JSON with sorted keys and no whitespace', () => {
    expect(canonicalJson({ b: [2, { d: 1, c: 'x' }], a: null })).toBe(
      '{"a":null,"b":[2,{"c":"x","d":1}]}',
    );
  });
});

describe('Dynamic adapter (thin, credential-gated)', () => {
  it('reports BLOCKED with missing variables and refuses signing without the MPC SDK', async () => {
    const adapter = new DynamicAdapter({}, neverFetch);
    expect(adapter.status()).toMatchObject({
      status: 'BLOCKED',
      missing: ['DYNAMIC_ENVIRONMENT_ID', 'DYNAMIC_API_KEY'],
    });
    await expect(adapter.verifyEnvironment()).rejects.toMatchObject({
      code: 'PROVIDER_BLOCKED',
    });
    expect(() => adapter.signer()).toThrow(ProviderBlockedError);
    const configured = new DynamicAdapter(
      {
        DYNAMIC_ENVIRONMENT_ID: '00000000-0000-4000-8000-000000000000',
        DYNAMIC_API_KEY: 'dyn_x',
      },
      neverFetch,
    );
    expect(configured.status().status).toBe('CONFIGURED');
    expect(() => configured.signer()).toThrow(
      expect.objectContaining({ detail: expect.stringMatching(/MPC SDK/) }),
    );
  });
});
