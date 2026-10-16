import { constants, publicEncrypt } from 'node:crypto';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';

const Id = z.string().uuid();
const Name = z.string().trim().min(1).max(80);
export class CircleWalletError extends Error {
  constructor(
    readonly code:
      | 'CREDENTIALS_REQUIRED'
      | 'TESTNET_CREDENTIALS_REQUIRED'
      | 'PROVIDER_UNAVAILABLE'
      | 'INVALID_PROVIDER_RESPONSE',
  ) {
    super(code);
  }
}

/** Provisioning only. Financial signatures remain behind the execution authority chain. */
export class CircleWalletProvisioner {
  constructor(
    private readonly config: {
      apiKey?: string;
      appId?: string;
      entitySecret?: string;
    },
    private readonly doFetch: typeof fetch = fetch,
  ) {}
  capability() {
    if (!this.config.apiKey || !this.config.appId || !this.config.entitySecret)
      return {
        status: 'BLOCKED' as const,
        reason: 'Requires Circle credentials',
      };
    if (
      !/^TEST_API_KEY:[^:]+:[^:]+$/.test(this.config.apiKey) ||
      !/^[0-9a-fA-F]{64}$/.test(this.config.entitySecret) ||
      !Id.safeParse(this.config.appId).success
    )
      return {
        status: 'BLOCKED' as const,
        reason: 'Requires valid testnet Circle credentials',
      };
    return {
      status: 'CONFIGURED_NOT_PROVEN' as const,
      reason:
        'Arc testnet developer-controlled wallet provisioning; service custody, not a user-held key',
    };
  }
  private async request(path: string, body?: unknown) {
    const capability = this.capability();
    if (capability.status === 'BLOCKED')
      throw new CircleWalletError(
        capability.reason === 'Requires Circle credentials'
          ? 'CREDENTIALS_REQUIRED'
          : 'TESTNET_CREDENTIALS_REQUIRED',
      );
    let response: Response;
    try {
      response = await this.doFetch(`https://api.circle.com/v1/w3s${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
      });
    } catch {
      throw new CircleWalletError('PROVIDER_UNAVAILABLE');
    }
    if (!response.ok) throw new CircleWalletError('PROVIDER_UNAVAILABLE');
    try {
      return (await response.json()) as unknown;
    } catch {
      throw new CircleWalletError('INVALID_PROVIDER_RESPONSE');
    }
  }
  private async ciphertext() {
    const response = z
      .looseObject({
        data: z.looseObject({ publicKey: z.string().min(100).max(8192) }),
      })
      .safeParse(await this.request('/config/entity/publicKey'));
    if (!response.success)
      throw new CircleWalletError('INVALID_PROVIDER_RESPONSE');
    try {
      return publicEncrypt(
        {
          key: response.data.data.publicKey,
          padding: constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256',
        },
        Buffer.from(this.config.entitySecret!, 'hex'),
      ).toString('base64');
    } catch {
      throw new CircleWalletError('INVALID_PROVIDER_RESPONSE');
    }
  }
  async createWalletSet(input: { idempotencyKey: string; name: string }) {
    const idempotencyKey = Id.parse(input.idempotencyKey);
    const name = Name.parse(input.name);
    const body = await this.request('/developer/walletSets', {
      idempotencyKey,
      name,
      entitySecretCiphertext: await this.ciphertext(),
    });
    const result = z
      .looseObject({
        data: z.looseObject({
          walletSet: z.looseObject({
            id: Id,
            custodyType: z.literal('DEVELOPER'),
          }),
        }),
      })
      .safeParse(body);
    if (!result.success)
      throw new CircleWalletError('INVALID_PROVIDER_RESPONSE');
    return {
      id: result.data.data.walletSet.id,
      custody: 'DEVELOPER' as const,
      mode: 'PROVIDER_SANDBOX' as const,
    };
  }
  async createWallet(input: {
    idempotencyKey: string;
    walletSetId: string;
    name: string;
  }) {
    const idempotencyKey = Id.parse(input.idempotencyKey);
    const walletSetId = Id.parse(input.walletSetId);
    const name = Name.parse(input.name);
    const body = await this.request('/developer/wallets', {
      idempotencyKey,
      walletSetId,
      blockchains: ['ARC-TESTNET'],
      count: 1,
      accountType: 'EOA',
      metadata: [{ name }],
      entitySecretCiphertext: await this.ciphertext(),
    });
    const result = z
      .looseObject({
        data: z.looseObject({
          wallets: z
            .array(
              z.looseObject({
                id: Id,
                address: z
                  .string()
                  .refine((s) => isAddress(s) && BigInt(s) > 1n),
                blockchain: z.literal('ARC-TESTNET'),
                accountType: z.literal('EOA'),
                walletSetId: z.literal(walletSetId),
                custodyType: z.literal('DEVELOPER'),
                state: z.literal('LIVE'),
              }),
            )
            .length(1),
        }),
      })
      .safeParse(body);
    if (!result.success)
      throw new CircleWalletError('INVALID_PROVIDER_RESPONSE');
    const wallet = result.data.data.wallets[0]!;
    return {
      id: wallet.id,
      address: getAddress(wallet.address),
      chainId: 5042002 as const,
      custody: 'DEVELOPER' as const,
      mode: 'PROVIDER_SANDBOX' as const,
    };
  }
}
