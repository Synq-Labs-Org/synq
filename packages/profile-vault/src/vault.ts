import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { z } from 'zod';

const text = (max: number) => z.string().min(1).max(max);
export const ShippingProfileSchema = z.strictObject({
  name: text(120),
  line1: text(200),
  line2: z.string().max(200).optional(),
  city: text(100),
  state: z.string().max(100).optional(),
  postalCode: text(20),
  country: z.string().regex(/^[A-Z]{2}$/),
  email: z.email(),
  phone: z
    .string()
    .regex(/^\+[1-9][0-9]{6,14}$/)
    .optional(),
});
export const TravelerProfileSchema = z.strictObject({
  givenName: text(80),
  familyName: text(80),
  bornOn: z.iso.date(),
  email: z.email(),
  phone: z.string().regex(/^\+[1-9][0-9]{6,14}$/),
  title: z.enum(['mr', 'ms', 'mrs', 'miss', 'dr']).optional(),
  gender: z.enum(['m', 'f']).optional(),
  passportNumber: z
    .string()
    .regex(/^[A-Z0-9]{6,12}$/)
    .optional(),
  passportCountry: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .optional(),
  passportExpiry: z.iso.date().optional(),
});
export const PROFILE_SCHEMAS = {
  SHIPPING: ShippingProfileSchema,
  RECIPIENT: ShippingProfileSchema,
  TRAVELER: TravelerProfileSchema,
} as const;
export type ProfileKind = keyof typeof PROFILE_SCHEMAS;
export type ProfileData<K extends ProfileKind> = z.output<
  (typeof PROFILE_SCHEMAS)[K]
>;

/** KMS-shaped key port: returns 32-byte data keys by id. */
export interface VaultKeyProvider {
  readonly activeKeyId: string;
  dataKey(keyId: string): Promise<Uint8Array>;
}

export class EnvVaultKeyProvider implements VaultKeyProvider {
  readonly activeKeyId: string;
  private readonly key: Uint8Array;
  constructor(
    env: Readonly<Record<string, string | undefined>>,
    variable = 'SYNQ_PROFILE_VAULT_KEY',
  ) {
    const raw = env[variable] ?? '';
    const key = Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error('PROFILE_VAULT_KEY_INVALID');
    this.key = new Uint8Array(key);
    this.activeKeyId = `env:${variable}`;
  }
  async dataKey(keyId: string) {
    if (keyId !== this.activeKeyId)
      throw new Error('PROFILE_VAULT_KEY_UNKNOWN');
    return this.key;
  }
}

export type SealedProfile = {
  ref: string;
  groupId: string;
  kind: ProfileKind;
  keyId: string;
  iv: string;
  ciphertext: string;
  tag: string;
  summary: string;
  expiresAt: number | null;
  createdAt: number;
};

export interface ProfileStore {
  put(record: SealedProfile): Promise<void>;
  get(ref: string): Promise<SealedProfile | null>;
  delete(ref: string): Promise<void>;
}

export class MemoryProfileStore implements ProfileStore {
  readonly records = new Map<string, SealedProfile>();
  async put(r: SealedProfile) {
    if (this.records.has(r.ref)) throw new Error('PROFILE_REF_EXISTS');
    this.records.set(r.ref, structuredClone(r));
  }
  async get(ref: string) {
    const r = this.records.get(ref);
    return r ? structuredClone(r) : null;
  }
  async delete(ref: string) {
    this.records.delete(ref);
  }
}

export type DecryptAudit = {
  ref: string;
  groupId: string;
  kind: ProfileKind;
  purpose: string;
  fields: string[];
  worker: string;
  at: number;
  outcome: 'GRANTED' | 'DENIED';
  reason: string | null;
};

export class ProfileAccessError extends Error {
  constructor(
    readonly code:
      | 'NOT_FOUND'
      | 'WRONG_GROUP'
      | 'EXPIRED'
      | 'FIELD_NOT_ALLOWED'
      | 'TAMPERED'
      | 'INVALID_PROFILE',
    detail = '',
  ) {
    super(detail ? `PROFILE_${code}: ${detail}` : `PROFILE_${code}`);
    this.name = 'ProfileAccessError';
  }
}

const aad = (r: Pick<SealedProfile, 'ref' | 'groupId' | 'kind' | 'keyId'>) =>
  Buffer.from(JSON.stringify([r.ref, r.groupId, r.kind, r.keyId]));

function summarize(kind: ProfileKind, data: Record<string, unknown>): string {
  if (kind === 'TRAVELER')
    return `traveler ${String(data.givenName).slice(0, 1)}. ${String(data.familyName).slice(0, 1)}.`;
  return `${kind.toLowerCase()} ${String(data.name).slice(0, 1)}. · ${String(data.city).slice(0, 1)}*** · ${String(data.country)}`;
}

/**
 * Agent-safe side of the vault: it encrypts on write and returns only opaque
 * refs and redacted summaries. It cannot decrypt.
 */
export class ProfileDirectory {
  constructor(
    private readonly store: ProfileStore,
    private readonly keys: VaultKeyProvider,
    private readonly now: () => number,
  ) {}

  async put<K extends ProfileKind>(input: {
    groupId: string;
    kind: K;
    data: ProfileData<K>;
    expiresAt?: number;
  }): Promise<{ ref: string; summary: string }> {
    const parsed = PROFILE_SCHEMAS[input.kind].safeParse(input.data);
    if (!parsed.success)
      throw new ProfileAccessError(
        'INVALID_PROFILE',
        parsed.error.issues[0]?.path.join('.') ?? '',
      );
    const ref = `pv_${randomBytes(16).toString('hex')}`;
    const keyId = this.keys.activeKeyId;
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      await this.keys.dataKey(keyId),
      iv,
    );
    cipher.setAAD(
      aad({ ref, groupId: input.groupId, kind: input.kind, keyId }),
    );
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(parsed.data), 'utf8'),
      cipher.final(),
    ]);
    const summary = summarize(
      input.kind,
      parsed.data as Record<string, unknown>,
    );
    await this.store.put({
      ref,
      groupId: input.groupId,
      kind: input.kind,
      keyId,
      iv: iv.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      summary,
      expiresAt: input.expiresAt ?? null,
      createdAt: this.now(),
    });
    return { ref, summary };
  }

  async summary(
    groupId: string,
    ref: string,
  ): Promise<{ kind: ProfileKind; summary: string; expired: boolean } | null> {
    const r = await this.store.get(ref);
    if (!r || r.groupId !== groupId) return null;
    return {
      kind: r.kind,
      summary: r.summary,
      expired: r.expiresAt !== null && r.expiresAt <= this.now(),
    };
  }
}

/**
 * Execution-worker side: decrypts only the requested fields for a purpose,
 * enforces group and expiry, and audits every attempt.
 */
export class ProfileDecryptor {
  readonly audit: DecryptAudit[] = [];
  constructor(
    private readonly store: ProfileStore,
    private readonly keys: VaultKeyProvider,
    private readonly now: () => number,
    private readonly worker: string,
    private readonly sink?: (a: DecryptAudit) => Promise<void> | void,
  ) {}

  private async record(a: Omit<DecryptAudit, 'worker' | 'at'>) {
    const entry = { ...a, worker: this.worker, at: this.now() };
    this.audit.push(entry);
    await this.sink?.(entry);
  }

  async resolve<
    K extends ProfileKind,
    F extends keyof ProfileData<K> & string,
  >(input: {
    groupId: string;
    ref: string;
    kind: K;
    purpose: string;
    fields: readonly F[];
  }): Promise<Pick<ProfileData<K>, F>> {
    const r = await this.store.get(input.ref);
    const deny = async (
      code: ProfileAccessError['code'],
      kind: ProfileKind = input.kind,
    ) => {
      await this.record({
        ref: input.ref,
        groupId: input.groupId,
        kind,
        purpose: input.purpose,
        fields: [...input.fields],
        outcome: 'DENIED',
        reason: code,
      });
      return new ProfileAccessError(code);
    };
    if (!r) throw await deny('NOT_FOUND');
    if (r.groupId !== input.groupId) throw await deny('WRONG_GROUP', r.kind);
    if (r.kind !== input.kind) throw await deny('FIELD_NOT_ALLOWED', r.kind);
    if (r.expiresAt !== null && r.expiresAt <= this.now())
      throw await deny('EXPIRED', r.kind);
    const allowed = Object.keys(
      (PROFILE_SCHEMAS[input.kind] as z.ZodObject).shape,
    );
    if (input.fields.some((f) => !allowed.includes(f)))
      throw await deny('FIELD_NOT_ALLOWED', r.kind);
    let plain: Record<string, unknown>;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        await this.keys.dataKey(r.keyId),
        Buffer.from(r.iv, 'base64'),
      );
      decipher.setAAD(aad(r));
      decipher.setAuthTag(Buffer.from(r.tag, 'base64'));
      plain = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(r.ciphertext, 'base64')),
          decipher.final(),
        ]).toString('utf8'),
      ) as Record<string, unknown>;
    } catch {
      throw await deny('TAMPERED', r.kind);
    }
    await this.record({
      ref: input.ref,
      groupId: input.groupId,
      kind: r.kind,
      purpose: input.purpose,
      fields: [...input.fields],
      outcome: 'GRANTED',
      reason: null,
    });
    const out: Record<string, unknown> = {};
    for (const f of input.fields) if (plain[f] !== undefined) out[f] = plain[f];
    return out as Pick<ProfileData<K>, F>;
  }
}
