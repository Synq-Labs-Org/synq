import { z } from 'zod';
import type { MeraCredential } from '@synq/identity/mera-browser';

const KEY = 'synq.mera.credential.v1';
const StoredSchema = z.strictObject({
  provider: z.literal('mera'),
  principalId: z.string(),
  rpId: z.string(),
  credential: z.strictObject({
    credentialId: z.string(),
    transports: z.array(z.string()).optional(),
  }),
  signer: z.string().regex(/^0x[0-9a-f]{40}$/),
  derivation: z.literal('bip44-ethereum-0-v1'),
});

export function loadCredential(): MeraCredential | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = StoredSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as MeraCredential) : null;
  } catch {
    return null;
  }
}

export function saveCredential(record: MeraCredential): void {
  window.localStorage.setItem(KEY, JSON.stringify(StoredSchema.parse(record)));
}

export function clearCredential(): void {
  window.localStorage.removeItem(KEY);
}

export const relyingParty = () => ({
  rpId: window.location.hostname,
  origin: window.location.origin,
  rpName: 'Synq',
});
