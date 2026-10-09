import { createHmac } from 'node:crypto';
import type { WebAuthnClient } from '@category-labs/mera';
import { privateKeyToAccount } from 'viem/accounts';
import { officialAsset } from '@synq/chain-registry';
import type { GrantDraft } from '@synq/schemas';
import { grantDigest } from '../../packages/identity/src/grant.js';

export type AuthenticatorMode = {
  prfOnCreate?: boolean;
  prfSupported?: boolean;
};

export class DeterministicAuthenticator implements WebAuthnClient {
  readonly credentials = new Map<string, { rpId: string }>();
  calls = { create: 0, get: 0 };
  private counter = 0;
  constructor(
    private readonly secret: string,
    private readonly mode: AuthenticatorMode = {},
  ) {}
  private prf(credentialId: Uint8Array, salt: Uint8Array): Uint8Array {
    return new Uint8Array(
      createHmac('sha256', this.secret)
        .update(credentialId)
        .update(salt)
        .digest(),
    );
  }
  private id(): Uint8Array {
    this.counter++;
    return new Uint8Array(
      createHmac('sha256', this.secret).update(`cred:${this.counter}`).digest(),
    ).slice(0, 16);
  }
  readonly createCredential: WebAuthnClient['createCredential'] = async (
    request,
  ) => {
    this.calls.create++;
    const credentialId = this.id();
    this.credentials.set(Buffer.from(credentialId).toString('base64url'), {
      rpId: request.rp.id,
    });
    const prfSupported = this.mode.prfSupported ?? true;
    return {
      credentialId,
      transports: ['internal'],
      prfEnabled: prfSupported,
      ...(prfSupported && (this.mode.prfOnCreate ?? true)
        ? { prfOutput: this.prf(credentialId, request.prfSalt) }
        : {}),
    };
  };
  readonly getCredential: WebAuthnClient['getCredential'] = async (request) => {
    this.calls.get++;
    const known = [...this.credentials.entries()].filter(
      ([, v]) => v.rpId === request.rpId,
    );
    const wanted = request.allowCredential
      ? Buffer.from(request.allowCredential.credentialId).toString('base64url')
      : known[0]?.[0];
    const match = known.find(([id]) => id === wanted);
    if (!match) throw new Error('NotAllowedError');
    const credentialId = new Uint8Array(Buffer.from(match[0], 'base64url'));
    return {
      credentialId,
      ...((this.mode.prfSupported ?? true)
        ? { prfOutput: this.prf(credentialId, request.prfSalt) }
        : {}),
    };
  };
  adopt(other: DeterministicAuthenticator): void {
    for (const [id, v] of other.credentials) this.credentials.set(id, v);
  }
}

export const testAusd = officialAsset('testnetAUSD');
export const word = (n: number) =>
  `0x${n.toString(16).padStart(64, '0')}` as const;
export const addr = (n: number) =>
  `0x${n.toString(16).padStart(40, '0')}` as const;
export const fixtureAccounts = [11, 12, 13, 14, 15].map((n) =>
  privateKeyToAccount(word(n)),
);

export function makeDraft(
  overrides: Partial<GrantDraft['grant']> = {},
  extra: Partial<Omit<GrantDraft, 'grant' | 'digest'>> = {},
): GrantDraft {
  const base: Omit<GrantDraft, 'digest'> = {
    schemaVersion: 1,
    groupId: word(0xa1) as GrantDraft['groupId'],
    domain: {
      name: 'SynqExecutionModule',
      version: '1',
      chainId: 10143,
      verifyingContract: addr(0x5151),
    },
    grant: {
      groupId: word(0xa1),
      account: addr(0xacc),
      mandateId: word(0x3a),
      mandateVersion: '1',
      executor: addr(0xe1),
      pluginId: word(0x91),
      chainId: '10143',
      target: testAusd.address,
      selector: '0xa9059cbb',
      calldataHash: word(0xca11),
      token: testAusd.address,
      maxInputAmount: '12500000',
      nativeValue: '0',
      minOutputAmount: '12500000',
      recipient: addr(0xbeef),
      validAfter: '1000',
      validUntil: '999999999999',
      nonce: '7',
      intentHash: word(0x1d),
      ...overrides,
    },
    requiredApprovals: 2,
    createdAt: 1000,
    ...extra,
  };
  return { ...base, digest: grantDigest({ ...base, digest: word(0) }) };
}
