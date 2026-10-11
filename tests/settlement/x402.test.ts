import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { officialAssets } from '@synq/chain-registry';
import { EconomicGrantAuthority } from '@synq/kernel';
import { X402AuthorizationSigner } from '@synq/execution-worker';
import {
  MemoryReservationStore,
  payForResource,
  type X402Fetch,
} from '@synq/settlement';

const T = 1_780_000_000;
const USDC = officialAssets.testnetUSDC;
const PAY_TO = '0x00000000000000000000000000000000000da7a5';
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const requirement = (over: Record<string, unknown> = {}) => ({
  scheme: 'exact',
  network: 'eip155:10143',
  amount: '10000',
  asset: USDC.address,
  payTo: PAY_TO,
  maxTimeoutSeconds: 120,
  extra: { name: 'USDC', version: '2' },
  ...over,
});
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64');

function server(opts: { accepts?: unknown[]; settle?: boolean } = {}) {
  const payments: { header: Record<string, unknown>; signer: string }[] = [];
  const f: X402Fetch = async (url, init) => {
    if (url.includes('/redirect'))
      return {
        status: 302,
        headers: {
          get: (n: string) =>
            n === 'location' ? 'https://evil.example.com/steal' : null,
        },
        text: async () => '',
      };
    const reply = (
      status: number,
      body: string,
      headers: Record<string, string> = {},
    ) => ({
      status,
      headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
      text: async () => body,
    });
    const sig = init.headers['PAYMENT-SIGNATURE'];
    if (!sig)
      return reply(402, '{}', {
        'payment-required': b64({
          x402Version: 2,
          resource: { url },
          accepts: opts.accepts ?? [requirement()],
        }),
      });
    const p = JSON.parse(Buffer.from(sig, 'base64').toString()) as {
      accepted: ReturnType<typeof requirement>;
      payload: {
        signature: `0x${string}`;
        authorization: Record<string, string>;
      };
    };
    const a = p.payload.authorization;
    const signer = await recoverTypedDataAddress({
      domain: {
        name: 'USDC',
        version: '2',
        chainId: 10143,
        verifyingContract: p.accepted.asset as `0x${string}`,
      },
      types: {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      },
      primaryType: 'TransferWithAuthorization',
      message: {
        from: a.from as `0x${string}`,
        to: a.to as `0x${string}`,
        value: BigInt(a.value!),
        validAfter: BigInt(a.validAfter!),
        validBefore: BigInt(a.validBefore!),
        nonce: a.nonce as `0x${string}`,
      },
      signature: p.payload.signature,
    });
    payments.push({ header: p as unknown as Record<string, unknown>, signer });
    if (opts.settle === false)
      return reply(402, '{}', {
        'payment-response': b64({
          success: false,
          errorReason: 'insufficient_funds',
        }),
      });
    return reply(200, '{"price":"1.00"}', {
      'payment-response': b64({
        success: true,
        transaction: `0x${'ab'.repeat(32)}`,
        network: 'eip155:10143',
      }),
    });
  };
  return { f, payments };
}

const ASSETS = [{ chainId: 10143, address: USDC.address, decimals: 6 }];
const NETWORKS = new Map([['eip155:10143', 10143]]);

async function setup(
  over: {
    maxPerRequest?: bigint;
    budget?: string;
    hosts?: string[];
    confirmed?: bigint;
  } = {},
) {
  const reservations = new MemoryReservationStore();
  await reservations.setConfirmedBalance({
    groupId: 'g',
    assetId: USDC.canonicalAssetId,
    confirmed: over.confirmed ?? 100_000n,
    asOf: T,
  });
  const authority = new EconomicGrantAuthority({
    key: new Uint8Array(32).fill(8),
    reservations,
  });
  const unit = { currency: 'USDC', decimals: 6 };
  await authority.install({
    mandateId: 'paid-data',
    groupId: 'g',
    version: 1,
    status: 'ACTIVE',
    domains: ['DATA'],
    providers: ['x402'],
    hosts: ['data.example.com'],
    perActionCap: { ...unit, amount: over.budget ?? '50000' },
    cumulativeBudget: { ...unit, amount: over.budget ?? '100000' },
    autoApproveMax: { ...unit, amount: '50000' },
    quorum: 1,
    members: ['alice'],
    maxQuoteAgeSeconds: 60,
    grantTtlSeconds: 120,
    environment: 'TESTNET',
    validUntil: T + 86_400,
  });
  const signer = new X402AuthorizationSigner(
    account,
    authority,
    NETWORKS,
    ASSETS,
  );
  return {
    authority,
    reservations,
    deps: (f: X402Fetch) => ({
      fetch: f,
      authority,
      reservations,
      signer,
      groupId: 'g',
      mandateId: 'paid-data',
      edgeAssetId: USDC.canonicalAssetId,
      label: 'MOCKED' as const,
      now: () => T,
      allowance: {
        hosts: over.hosts ?? ['data.example.com'],
        networks: NETWORKS,
        assets: ASSETS,
        payTo: [PAY_TO],
        maxPerRequest: over.maxPerRequest ?? 20_000n,
      },
    }),
  };
}

const exec = (over: Record<string, unknown> = {}) => ({
  domain: 'DATA' as const,
  providerId: 'x402',
  host: 'data.example.com',
  offerId: 'u',
  subjectHash: `0x${'aa'.repeat(32)}` as `0x${string}`,
  quantity: 1,
  maxAmount: { amount: '10000', currency: 'USDC', decimals: 6 },
  reservationId: 'r',
  reservedAssetId: USDC.canonicalAssetId,
  reservedAmount: '10000',
  settlementPlanHash: 'p',
  recipientRef: PAY_TO,
  payAsset: {
    chainId: 10143,
    address: USDC.address.toLowerCase() as `0x${string}`,
    decimals: 6,
  },
  ...over,
});

describe('x402 paid data through the Kernel', () => {
  it('challenge -> allowance -> reservation -> grant -> EIP-3009 signature -> paid data -> receipt', async () => {
    const s = await setup();
    const srv = server();
    const r = await payForResource(
      s.deps(srv.f),
      'https://data.example.com/v1/price',
    );
    expect(r).toMatchObject({
      status: 'PAID',
      label: 'MOCKED',
      amount: '10000',
      body: '{"price":"1.00"}',
    });
    expect(srv.payments[0]!.signer).toBe(account.address);
    expect(await s.authority.isConsumed(r.grantId!)).toBe(true);
    expect(await s.reservations.free('g', USDC.canonicalAssetId)).toMatchObject(
      { held: '10000', free: '90000' },
    );
    expect((await s.reservations.get(r.reservationId!))?.state).toBe(
      'CAPTURED',
    );
  });
  it('refuses disallowed hosts, redirects, networks, payees and amounts before any signature', async () => {
    const s = await setup();
    expect(
      (await payForResource(s.deps(server().f), 'https://evil.example.com/x'))
        .reason,
    ).toBe('HOST_NOT_ALLOWED');
    expect(
      (
        await payForResource(
          s.deps(server().f),
          'https://data.example.com/redirect',
        )
      ).reason,
    ).toBe('HOST_NOT_ALLOWED');
    for (const accepts of [
      [requirement({ network: 'eip155:8453' })],
      [requirement({ payTo: '0x000000000000000000000000000000000000beef' })],
      [requirement({ asset: '0x000000000000000000000000000000000000dead' })],
    ]) {
      const srv = server({ accepts });
      expect(
        (await payForResource(s.deps(srv.f), 'https://data.example.com/x'))
          .reason,
      ).toBe('NO_ALLOWED_REQUIREMENT');
      expect(srv.payments).toHaveLength(0);
    }
    const big = server({ accepts: [requirement({ amount: '20001' })] });
    expect(
      (await payForResource(s.deps(big.f), 'https://data.example.com/x'))
        .reason,
    ).toBe('OVER_ALLOWANCE');
  });
  it('the Kernel budget and the free edge balance both bound repeated payments', async () => {
    const s = await setup({ budget: '20000' });
    const srv = server();
    await payForResource(s.deps(srv.f), 'https://data.example.com/a');
    await payForResource(s.deps(srv.f), 'https://data.example.com/b');
    const third = await payForResource(
      s.deps(srv.f),
      'https://data.example.com/c',
    );
    expect(third.reason).toBe('KERNEL_BUDGET_EXHAUSTED');
    expect(srv.payments).toHaveLength(2);
    const poor = await setup({ confirmed: 5_000n });
    expect(
      (
        await payForResource(
          poor.deps(server().f),
          'https://data.example.com/a',
        )
      ).reason,
    ).toBe('INSUFFICIENT_FREE_BALANCE');
  });
  it('a failed settlement holds the reservation for recourse; the sweep never frees it', async () => {
    const s = await setup();
    const r = await payForResource(
      s.deps(server({ settle: false }).f),
      'https://data.example.com/a',
    );
    expect(r.status).toBe('UNSETTLED');
    await s.reservations.expireDue(T + 10_000);
    expect((await s.reservations.get(r.reservationId!))?.state).toBe('HELD');
  });
  it('approvals come only from the identity verifier, bound to the request hash', async () => {
    const s = await setup({ maxPerRequest: 20_000n });
    const seen: string[] = [];
    const r = await payForResource(
      { ...s.deps(server().f), approvals: async (h) => (seen.push(h), []) },
      'https://data.example.com/a',
    );
    expect(r.status).toBe('PAID');
    expect(seen[0]).toMatch(/^0x[0-9a-f]{64}$/);
  });
  it('the signer refuses foreign networks, mainnet, unbound assets, decimal mismatches and invalid grants', async () => {
    const s = await setup();
    await expect(
      new X402AuthorizationSigner(account, s.authority, new Map(), ASSETS).sign(
        {
          grant: {} as never,
          execution: {} as never,
          requirement: requirement() as never,
          now: T,
        },
      ),
    ).rejects.toThrow(/NETWORK_NOT_ALLOWED/);
    const mainnet = new X402AuthorizationSigner(
      account,
      s.authority,
      new Map([['eip155:143', 143]]),
      [{ chainId: 143, address: USDC.address, decimals: 6 }],
    );
    await expect(
      mainnet.sign({
        grant: {} as never,
        execution: exec() as never,
        requirement: requirement({ network: 'eip155:143' }) as never,
        now: T,
      }),
    ).rejects.toThrow(/MAINNET_BROADCAST_DISABLED/);
    const ok = new X402AuthorizationSigner(
      account,
      s.authority,
      NETWORKS,
      ASSETS,
    );
    await expect(
      ok.sign({
        grant: {} as never,
        execution: exec({ payAsset: null }) as never,
        requirement: requirement() as never,
        now: T,
      }),
    ).rejects.toThrow(/ASSET_BINDING_MISMATCH/);
    await expect(
      ok.sign({
        grant: {} as never,
        execution: exec({
          payAsset: {
            chainId: 10143,
            address: USDC.address.toLowerCase(),
            decimals: 18,
          },
        }) as never,
        requirement: requirement() as never,
        now: T,
      }),
    ).rejects.toThrow(/ASSET_BINDING_MISMATCH/);
    await expect(
      ok.sign({
        grant: {} as never,
        execution: exec({
          maxAmount: { amount: '10000', currency: 'USDC', decimals: 18 },
        }) as never,
        requirement: requirement() as never,
        now: T,
      }),
    ).rejects.toThrow(/ASSET_BINDING_MISMATCH/);
    const wrongDecimals = new X402AuthorizationSigner(
      account,
      s.authority,
      NETWORKS,
      [{ chainId: 10143, address: USDC.address, decimals: 18 }],
    );
    await expect(
      wrongDecimals.sign({
        grant: {} as never,
        execution: exec() as never,
        requirement: requirement() as never,
        now: T,
      }),
    ).rejects.toThrow(/ASSET_BINDING_MISMATCH/);
    await expect(
      ok.sign({
        grant: { grantId: 'x' } as never,
        execution: exec() as never,
        requirement: requirement() as never,
        now: T,
      }),
    ).rejects.toThrow(/GRANT_INVALID/);
  });
});
