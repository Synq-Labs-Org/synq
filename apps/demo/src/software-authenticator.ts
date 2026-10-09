import { createHmac, randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { Address } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { WebAuthnClient } from '@category-labs/mera';
import type { MeraCredential } from '@synq/identity/mera-browser';

/**
 * Evidence tier for principals backed by this client: the real Mera SDK derives
 * the account from a WebAuthn PRF output, but the PRF is computed in software
 * from a secret held in a mode-600 file outside the repository. It is not a
 * hardware authenticator and not a human ceremony.
 */
export const SOFTWARE_PRF_TIER =
  'injected-webauthn-software-prf (Mera SDK, PRF = HMAC-SHA256(secret, salt); not real humans, not hardware passkeys)';

const Hex32 = z.string().regex(/^[0-9a-f]{64}$/);
const StoreSchema = z.strictObject({
  version: z.literal(1),
  authenticators: z.array(
    z.strictObject({
      label: z.string().min(1),
      rpId: z.string().min(1),
      credentialId: z.string().min(1),
      secret: Hex32,
    }),
  ),
  recipientKey: Hex32.optional(),
  records: z.array(
    z.strictObject({
      label: z.string().min(1),
      record: z.custom<MeraCredential>(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          (v as { provider?: unknown }).provider === 'mera',
      ),
    }),
  ),
});
type Store = z.output<typeof StoreSchema>;

export class SoftwareAuthenticatorError extends Error {
  constructor(
    readonly code: 'STORE_PERMISSIONS' | 'UNKNOWN_CREDENTIAL' | 'STORE_INVALID',
  ) {
    super(code);
    this.name = 'SoftwareAuthenticatorError';
  }
}

export function defaultAuthenticatorStore(): string {
  return join(homedir(), '.synq', 'e2e', 'mera-authenticators.json');
}

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');

export class SoftwareAuthenticatorStore {
  private store: Store;
  constructor(readonly path: string = defaultAuthenticatorStore()) {
    mkdirSync(join(path, '..'), { recursive: true, mode: 0o700 });
    chmodSync(join(path, '..'), 0o700);
    if (existsSync(path)) {
      const parsed = StoreSchema.safeParse(
        JSON.parse(readFileSync(path, 'utf8')),
      );
      if (!parsed.success)
        throw new SoftwareAuthenticatorError('STORE_INVALID');
      this.store = parsed.data;
    } else this.store = { version: 1, authenticators: [], records: [] };
  }
  private persist(): void {
    const temporary = `${this.path}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.store, null, 2) + '\n', {
      mode: 0o600,
    });
    renameSync(temporary, this.path);
    chmodSync(this.path, 0o600);
  }
  record(label: string): MeraCredential | null {
    return this.store.records.find((r) => r.label === label)?.record ?? null;
  }
  saveRecord(label: string, record: MeraCredential): void {
    this.store.records = [
      ...this.store.records.filter((r) => r.label !== label),
      { label, record },
    ];
    this.persist();
  }
  /** Dedicated transfer recipient whose key stays in this store, so test funds remain recoverable. */
  recipient(): Address {
    if (!this.store.recipientKey) {
      this.store.recipientKey = randomBytes(32).toString('hex');
      this.persist();
    }
    return privateKeyToAccount(
      `0x${this.store.recipientKey}`,
    ).address.toLowerCase() as Address;
  }
  private prf(secret: string, salt: Uint8Array): Uint8Array {
    return new Uint8Array(
      createHmac('sha256', Buffer.from(secret, 'hex')).update(salt).digest(),
    );
  }
  /** A WebAuthn client for one labelled principal; creation registers a new software credential. */
  client(label: string): WebAuthnClient {
    return {
      createCredential: async (request) => {
        const credentialId = randomBytes(16);
        const secret = randomBytes(32).toString('hex');
        this.store.authenticators.push({
          label,
          rpId: request.rp.id,
          credentialId: b64url(credentialId),
          secret,
        });
        this.persist();
        return {
          credentialId: new Uint8Array(credentialId),
          transports: ['internal'],
          prfEnabled: true,
          prfOutput: this.prf(secret, request.prfSalt),
        };
      },
      getCredential: async (request) => {
        const wanted = request.allowCredential
          ? b64url(request.allowCredential.credentialId)
          : null;
        const found = this.store.authenticators.find(
          (a) =>
            a.label === label &&
            a.rpId === request.rpId &&
            (wanted === null || a.credentialId === wanted),
        );
        if (!found) throw new SoftwareAuthenticatorError('UNKNOWN_CREDENTIAL');
        return {
          credentialId: new Uint8Array(
            Buffer.from(found.credentialId, 'base64url'),
          ),
          prfOutput: this.prf(found.secret, request.prfSalt),
        };
      },
    };
  }
}
