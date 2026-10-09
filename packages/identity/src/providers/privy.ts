import {
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
} from 'node:crypto';
import { z } from 'zod';
import {
  AddressSchema,
  DelegationPolicySchema,
  type DelegationPolicy,
} from '@synq/schemas';
import { IdentityError } from '../errors.js';
import {
  canonicalJson,
  missingEnv,
  providerJson,
  ProviderBlockedError,
  type FetchLike,
  type ProviderStatus,
} from './common.js';

export const PRIVY_ENV = [
  'PRIVY_APP_ID',
  'PRIVY_APP_SECRET',
  'PRIVY_AUTHORIZATION_PRIVATE_KEY',
] as const;
export const PRIVY_API = 'https://api.privy.io';
export const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { internalType: 'address', name: 'recipient', type: 'address' },
      { internalType: 'uint256', name: 'amount', type: 'uint256' },
    ],
    name: 'transfer',
    outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

type PrivyCredentials = {
  appId: string;
  appSecret: string;
  authorizationKey: string;
};
const PolicyResponseSchema = z.object({ id: z.string().min(1) });
const WalletResponseSchema = z.object({
  id: z.string().min(1),
  address: AddressSchema,
});
const SignResponseSchema = z.object({
  data: z.object({ signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/) }),
});

export function privyPolicyBody(raw: DelegationPolicy) {
  const p = DelegationPolicySchema.parse(raw);
  const hex = (v: string | number) => `0x${BigInt(v).toString(16)}`;
  const conditions = [
    {
      field_source: 'ethereum_transaction',
      field: 'to',
      operator: 'eq',
      value: p.asset.address,
    },
    {
      field_source: 'ethereum_transaction',
      field: 'chain_id',
      operator: 'eq',
      value: String(p.asset.chainId),
    },
    {
      field_source: 'ethereum_calldata',
      field: 'transfer.recipient',
      operator: 'eq',
      value: p.recipient,
      abi: ERC20_TRANSFER_ABI,
    },
    {
      field_source: 'ethereum_calldata',
      field: 'transfer.amount',
      operator: 'lte',
      value: hex(p.maxAmountPerExecution),
      abi: ERC20_TRANSFER_ABI,
    },
    {
      field_source: 'system',
      field: 'current_unix_timestamp',
      operator: 'gte',
      value: String(p.validAfter),
    },
    {
      field_source: 'system',
      field: 'current_unix_timestamp',
      operator: 'lt',
      value: String(p.validUntil),
    },
  ];
  return {
    version: '1.0',
    name: `synq-${p.policyId}`.slice(0, 50),
    chain_type: 'ethereum',
    rules: (['eth_signTransaction', 'eth_sendTransaction'] as const).map(
      (method) => ({
        name: `capped ${p.asset.symbol} transfer ${method}`.slice(0, 50),
        method,
        action: 'ALLOW',
        conditions,
      }),
    ),
  };
}

export class PrivyAdapter {
  private readonly credentials: PrivyCredentials | null;
  private readonly missing: string[];
  constructor(
    env: Record<string, string | undefined>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
  ) {
    this.missing = missingEnv(env, PRIVY_ENV);
    this.credentials = this.missing.length
      ? null
      : {
          appId: env.PRIVY_APP_ID!.trim(),
          appSecret: env.PRIVY_APP_SECRET!.trim(),
          authorizationKey: env.PRIVY_AUTHORIZATION_PRIVATE_KEY!.trim(),
        };
  }

  status(): ProviderStatus {
    return this.credentials
      ? { provider: 'privy', status: 'CONFIGURED' }
      : {
          provider: 'privy',
          status: 'BLOCKED',
          missing: this.missing,
          reason:
            'Privy app credentials and authorization key are not configured',
        };
  }

  private creds(): PrivyCredentials {
    if (!this.credentials)
      throw new ProviderBlockedError(
        'privy',
        this.missing,
        'credentials not configured',
      );
    return this.credentials;
  }

  private authorizationKeyObject() {
    const der = Buffer.from(
      this.creds().authorizationKey.replace(/^wallet-auth:/, ''),
      'base64',
    );
    return createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  }

  authorizationPublicKey(): string {
    return createPublicKey(this.authorizationKeyObject())
      .export({ type: 'spki', format: 'der' })
      .toString('base64');
  }

  authorizationSignature(input: {
    method: 'POST' | 'PATCH' | 'DELETE' | 'PUT';
    url: string;
    body: unknown;
    headers: Record<string, string>;
  }): string {
    const key = this.authorizationKeyObject();
    const payload = canonicalJson({
      version: 1,
      method: input.method,
      url: input.url.replace(/\/$/, ''),
      body: input.body,
      headers: Object.fromEntries(
        Object.entries(input.headers).filter(([k]) => k.startsWith('privy-')),
      ),
    });
    return sign('sha256', Buffer.from(payload), key).toString('base64');
  }

  private async request(
    path: string,
    body: unknown,
    signed: boolean,
    idempotencyKey: string,
    method: 'POST' | 'PATCH' = 'POST',
  ) {
    const { appId, appSecret } = this.creds();
    const url = `${PRIVY_API}${path}`;
    const privyHeaders: Record<string, string> = {
      'privy-app-id': appId,
      'privy-idempotency-key': idempotencyKey,
    };
    const headers: Record<string, string> = {
      ...privyHeaders,
      authorization: `Basic ${Buffer.from(`${appId}:${appSecret}`).toString('base64')}`,
      'content-type': 'application/json',
    };
    if (signed)
      headers['privy-authorization-signature'] = this.authorizationSignature({
        method,
        url,
        body,
        headers: privyHeaders,
      });
    const response = await this.fetchImpl(url, {
      method,
      headers,
      body: JSON.stringify(body),
    });
    return providerJson('privy', response);
  }

  async createPolicy(
    policy: DelegationPolicy,
    idempotencyKey: string = randomUUID(),
  ): Promise<string> {
    const body = privyPolicyBody(policy);
    return PolicyResponseSchema.parse(
      await this.request('/v1/policies', body, false, idempotencyKey),
    ).id;
  }

  async createDelegateWallet(
    input: { externalId: string },
    idempotencyKey: string = randomUUID(),
  ): Promise<{ walletId: string; address: `0x${string}` }> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.externalId))
      throw new IdentityError('INVALID_INPUT', 'externalId');
    const wallet = WalletResponseSchema.parse(
      await this.request(
        '/v1/wallets',
        {
          chain_type: 'ethereum',
          owner: { public_key: this.authorizationPublicKey() },
          external_id: input.externalId,
        },
        false,
        idempotencyKey,
      ),
    );
    return { walletId: wallet.id, address: wallet.address };
  }

  async attachPolicy(
    walletId: string,
    policyId: string,
    idempotencyKey: string = randomUUID(),
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,64}$/.test(walletId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(policyId)
    )
      throw new IdentityError('INVALID_INPUT', 'privy id');
    WalletResponseSchema.parse(
      await this.request(
        `/v1/wallets/${walletId}`,
        { policy_ids: [policyId] },
        true,
        idempotencyKey,
        'PATCH',
      ),
    );
  }

  async signErc20Transfer(
    walletId: string,
    input: { chainId: number; token: `0x${string}`; data: `0x${string}` },
    idempotencyKey: string = randomUUID(),
  ): Promise<string> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(walletId))
      throw new IdentityError('INVALID_INPUT', 'walletId');
    const body = {
      method: 'eth_signTransaction',
      params: {
        transaction: {
          to: input.token,
          data: input.data,
          value: '0x0',
          chain_id: input.chainId,
        },
      },
    };
    const result = z
      .object({
        data: z.object({ signed_transaction: z.string().min(1) }).passthrough(),
      })
      .parse(
        await this.request(
          `/v1/wallets/${walletId}/rpc`,
          body,
          true,
          idempotencyKey,
        ),
      );
    return result.data.signed_transaction;
  }

  async signTypedData(
    walletId: string,
    typedData: {
      domain: unknown;
      types: unknown;
      primaryType: string;
      message: unknown;
    },
    idempotencyKey: string = randomUUID(),
  ): Promise<`0x${string}`> {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(walletId))
      throw new IdentityError('INVALID_INPUT', 'walletId');
    const jsonSafe = JSON.parse(
      JSON.stringify(typedData, (_k, v: unknown) =>
        typeof v === 'bigint' ? v.toString() : v,
      ),
    ) as { domain: unknown; types: Record<string, unknown>; message: unknown };
    const body = {
      method: 'eth_signTypedData_v4',
      params: {
        typed_data: {
          domain: jsonSafe.domain,
          types: jsonSafe.types,
          message: jsonSafe.message,
          primary_type: typedData.primaryType,
        },
      },
    };
    const result = SignResponseSchema.parse(
      await this.request(
        `/v1/wallets/${walletId}/rpc`,
        body,
        true,
        idempotencyKey,
      ),
    );
    return result.data.signature.toLowerCase() as `0x${string}`;
  }
}
