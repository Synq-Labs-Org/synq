import { randomBytes } from 'node:crypto';
import {
  OriginSchema,
  RpIdSchema,
  type IdentityPrincipalKind,
  type ProfileName,
} from '@synq/schemas';
import { IdentityError } from './errors.js';

export type IdentityConfig = {
  profile: ProfileName;
  rpId: string;
  origin: string;
  challengeTtlSeconds?: number;
  now?: () => number;
};
export type ResolvedConfig = Required<IdentityConfig> & {
  randomId: () => string;
  randomNonce: () => `0x${string}`;
};

export function resolveConfig(config: IdentityConfig): ResolvedConfig {
  const ttl = config.challengeTtlSeconds ?? 300;
  if (!Number.isSafeInteger(ttl) || ttl < 10 || ttl > 900)
    throw new IdentityError('INVALID_INPUT', 'challenge ttl');
  return {
    profile: config.profile,
    rpId: RpIdSchema.parse(config.rpId),
    origin: OriginSchema.parse(config.origin),
    challengeTtlSeconds: ttl,
    now: config.now ?? (() => Math.floor(Date.now() / 1000)),
    randomId: () => randomBytes(16).toString('hex'),
    randomNonce: () => `0x${randomBytes(32).toString('hex')}`,
  };
}

export function kindAllowed(
  kind: IdentityPrincipalKind,
  profile: ProfileName,
): boolean {
  return kind !== 'LOCAL_FIXTURE' || profile === 'local/anvil';
}
export function approvalEligible(
  kind: IdentityPrincipalKind,
  profile: ProfileName,
): boolean {
  return (
    (kind === 'MERA_HUMAN' || kind === 'LOCAL_FIXTURE') &&
    kindAllowed(kind, profile)
  );
}
