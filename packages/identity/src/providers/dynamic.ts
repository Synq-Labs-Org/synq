import { z } from 'zod';
import { IdentityError } from '../errors.js';
import {
  missingEnv,
  providerJson,
  ProviderBlockedError,
  type FetchLike,
  type ProviderStatus,
} from './common.js';

export const DYNAMIC_ENV = [
  'DYNAMIC_ENVIRONMENT_ID',
  'DYNAMIC_API_KEY',
] as const;
export const DYNAMIC_API = 'https://app.dynamicauth.com/api/v0';
const EnvironmentSchema = z.object({ id: z.string().min(1) }).passthrough();

export interface DynamicOperatorSigner {
  readonly address: `0x${string}`;
  readonly walletId: string;
  signTypedData(typedData: {
    domain: unknown;
    types: unknown;
    primaryType: string;
    message: unknown;
  }): Promise<`0x${string}`>;
}

export class DynamicAdapter {
  private readonly missing: string[];
  private readonly environmentId: string | null;
  private readonly apiKey: string | null;
  constructor(
    env: Record<string, string | undefined>,
    private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike,
    private readonly operatorSigner: DynamicOperatorSigner | null = null,
  ) {
    this.missing = missingEnv(env, DYNAMIC_ENV);
    this.environmentId = this.missing.length
      ? null
      : env.DYNAMIC_ENVIRONMENT_ID!.trim();
    this.apiKey = this.missing.length ? null : env.DYNAMIC_API_KEY!.trim();
    if (this.environmentId && !/^[0-9a-fA-F-]{36}$/.test(this.environmentId))
      throw new IdentityError(
        'INVALID_INPUT',
        'DYNAMIC_ENVIRONMENT_ID must be a UUID',
      );
  }

  status(): ProviderStatus {
    return this.environmentId
      ? { provider: 'dynamic', status: 'CONFIGURED' }
      : {
          provider: 'dynamic',
          status: 'BLOCKED',
          missing: this.missing,
          reason: 'Dynamic environment id and API token are not configured',
        };
  }

  async verifyEnvironment(): Promise<{ environmentId: string }> {
    if (!this.environmentId || !this.apiKey)
      throw new ProviderBlockedError(
        'dynamic',
        this.missing,
        'credentials not configured',
      );
    const response = await this.fetchImpl(
      `${DYNAMIC_API}/environments/${this.environmentId}`,
      { method: 'GET', headers: { authorization: `Bearer ${this.apiKey}` } },
    );
    const env = EnvironmentSchema.parse(
      await providerJson('dynamic', response),
    );
    if (env.id !== this.environmentId)
      throw new IdentityError('PROVIDER_ERROR', 'environment mismatch');
    return { environmentId: env.id };
  }

  signer(): DynamicOperatorSigner {
    if (!this.environmentId)
      throw new ProviderBlockedError(
        'dynamic',
        this.missing,
        'credentials not configured',
      );
    if (!this.operatorSigner)
      throw new ProviderBlockedError(
        'dynamic',
        [],
        'server-wallet signing requires the Dynamic Node MPC SDK and operator key-share custody',
      );
    return this.operatorSigner;
  }
}
