import type { Hex } from 'viem';
import {
  AddressSchema,
  IdentityChallengeSchema,
  PasskeyCredentialSchema,
  PrincipalViewSchema,
  RpIdSchema,
  OriginSchema,
  SignatureSchema,
  type IdentityChallenge,
  type IdentityPrincipalKind,
  type MembershipView,
  type PasskeyCredential,
  type PrincipalView,
} from '@synq/schemas';
import { recoverIdentityChallengeSigner } from './challenge.js';
import {
  kindAllowed,
  resolveConfig,
  type IdentityConfig,
  type ResolvedConfig,
} from './config.js';
import { IdentityError } from './errors.js';
import type { IdentityStore, PrincipalRecord } from './store.js';

const PREFIX: Record<IdentityPrincipalKind, string> = {
  MERA_HUMAN: 'mera',
  LOCAL_FIXTURE: 'fixture',
  PRIVY_DELEGATE: 'privy',
  DYNAMIC_OPERATOR: 'dynamic',
};
export const principalIdFor = (kind: IdentityPrincipalKind, signer: string) =>
  `${PREFIX[kind]}:${signer.toLowerCase()}`;

export function principalView(p: PrincipalRecord): PrincipalView {
  return PrincipalViewSchema.parse({
    principalId: p.principalId,
    kind: p.kind,
    signer: p.signer,
    rpId: p.rpId,
    credential: p.credential,
    status: p.status,
    enrolledAt: p.enrolledAt,
  });
}

export async function verifyChallengeSignature(
  challenge: IdentityChallenge,
  rawSignature: string,
): Promise<void> {
  const signature = SignatureSchema.safeParse(rawSignature);
  if (!signature.success) throw new IdentityError('SIGNATURE_MISMATCH');
  let recovered: string;
  try {
    recovered = await recoverIdentityChallengeSigner(
      challenge,
      signature.data as Hex,
    );
  } catch {
    throw new IdentityError('SIGNATURE_MISMATCH');
  }
  if (recovered !== challenge.signer)
    throw new IdentityError('SIGNATURE_MISMATCH');
}

export type EnrollmentRequest = {
  kind: IdentityPrincipalKind;
  signer: string;
  rpId: string;
  origin: string;
  credential?: PasskeyCredential;
  providerRef?: string;
};

export class PrincipalService {
  readonly config: ResolvedConfig;
  constructor(
    readonly store: IdentityStore,
    config: IdentityConfig,
  ) {
    this.config = resolveConfig(config);
  }

  private checkRelyingParty(rpId: string, origin: string): void {
    if (
      RpIdSchema.safeParse(rpId).data !== this.config.rpId ||
      OriginSchema.safeParse(origin).data !== this.config.origin
    )
      throw new IdentityError('ORIGIN_MISMATCH');
  }

  async issueEnrollmentChallenge(
    request: EnrollmentRequest,
  ): Promise<IdentityChallenge> {
    const signer = AddressSchema.safeParse(request.signer);
    if (!signer.success) throw new IdentityError('INVALID_INPUT', 'signer');
    if (!kindAllowed(request.kind, this.config.profile))
      throw new IdentityError('PRINCIPAL_KIND_FORBIDDEN');
    this.checkRelyingParty(request.rpId, request.origin);
    let credentialId = '';
    let transports: string[] = [];
    if (request.kind === 'MERA_HUMAN') {
      const credential = PasskeyCredentialSchema.safeParse(request.credential);
      if (!credential.success)
        throw new IdentityError('INVALID_INPUT', 'credential');
      credentialId = credential.data.credentialId;
      transports = credential.data.transports ?? [];
    } else if (request.credential)
      throw new IdentityError('INVALID_INPUT', 'credential');
    if (
      request.kind === 'PRIVY_DELEGATE' ||
      request.kind === 'DYNAMIC_OPERATOR'
    ) {
      if (
        !request.providerRef ||
        !/^[A-Za-z0-9_.:-]{1,128}$/.test(request.providerRef)
      )
        throw new IdentityError('INVALID_INPUT', 'providerRef');
      credentialId = request.providerRef;
    }
    const now = this.config.now();
    const challenge = IdentityChallengeSchema.parse({
      schemaVersion: 1,
      challengeId: this.config.randomId(),
      purpose: 'ENROLL',
      principalId: principalIdFor(request.kind, signer.data),
      principalKind: request.kind,
      signer: signer.data,
      rpId: this.config.rpId,
      origin: this.config.origin,
      credentialId,
      transports,
      groupId: '',
      memberId: '',
      membershipEpoch: 0,
      nonce: this.config.randomNonce(),
      issuedAt: now,
      expiresAt: now + this.config.challengeTtlSeconds,
    });
    await this.store.transaction(async (tx) => {
      if (await tx.getPrincipal(challenge.principalId))
        throw new IdentityError('PRINCIPAL_EXISTS');
      await tx.insertChallenge(challenge);
    });
    return challenge;
  }

  async enroll(input: {
    challengeId: string;
    signature: string;
  }): Promise<PrincipalView> {
    const now = this.config.now();
    const stored = await this.store.transaction((tx) =>
      tx.getChallenge(input.challengeId),
    );
    if (!stored || stored.challenge.purpose !== 'ENROLL')
      throw new IdentityError('CHALLENGE_NOT_FOUND');
    await verifyChallengeSignature(stored.challenge, input.signature);
    const principal = await this.store.transaction(async (tx) => {
      const c = await tx.consumeChallenge(input.challengeId, now);
      const record: PrincipalRecord = {
        principalId: c.principalId,
        kind: c.principalKind,
        signer: c.signer,
        rpId: c.principalKind === 'MERA_HUMAN' ? c.rpId : null,
        credential:
          c.principalKind === 'MERA_HUMAN'
            ? {
                credentialId: c.credentialId,
                ...(c.transports.length ? { transports: c.transports } : {}),
              }
            : null,
        providerRef:
          c.principalKind === 'PRIVY_DELEGATE' ||
          c.principalKind === 'DYNAMIC_OPERATOR'
            ? { walletRef: c.credentialId }
            : null,
        status: 'ACTIVE',
        enrolledAt: now,
        lastRecoveredAt: null,
      };
      await tx.insertPrincipal(record);
      return record;
    });
    return principalView(principal);
  }

  async issueRecoveryChallenge(request: {
    signer: string;
    credentialId: string;
    rpId: string;
    origin: string;
  }): Promise<IdentityChallenge> {
    const signer = AddressSchema.safeParse(request.signer);
    if (!signer.success) throw new IdentityError('INVALID_INPUT', 'signer');
    this.checkRelyingParty(request.rpId, request.origin);
    const principalId = principalIdFor('MERA_HUMAN', signer.data);
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      const principal = await tx.getPrincipal(principalId);
      if (!principal || principal.status !== 'ACTIVE')
        throw new IdentityError('PRINCIPAL_NOT_FOUND');
      if (principal.credential?.credentialId !== request.credentialId)
        throw new IdentityError('CHALLENGE_MISMATCH', 'credential');
      const challenge = IdentityChallengeSchema.parse({
        schemaVersion: 1,
        challengeId: this.config.randomId(),
        purpose: 'RECOVER',
        principalId,
        principalKind: principal.kind,
        signer: principal.signer,
        rpId: this.config.rpId,
        origin: this.config.origin,
        credentialId: request.credentialId,
        transports: principal.credential?.transports ?? [],
        groupId: '',
        memberId: '',
        membershipEpoch: 0,
        nonce: this.config.randomNonce(),
        issuedAt: now,
        expiresAt: now + this.config.challengeTtlSeconds,
      });
      await tx.insertChallenge(challenge);
      return challenge;
    });
  }

  async recover(input: {
    challengeId: string;
    signature: string;
  }): Promise<{ principal: PrincipalView; memberships: MembershipView[] }> {
    const now = this.config.now();
    const stored = await this.store.transaction((tx) =>
      tx.getChallenge(input.challengeId),
    );
    if (!stored || stored.challenge.purpose !== 'RECOVER')
      throw new IdentityError('CHALLENGE_NOT_FOUND');
    await verifyChallengeSignature(stored.challenge, input.signature);
    return this.store.transaction(async (tx) => {
      const c = await tx.consumeChallenge(input.challengeId, now);
      const principal = await tx.getPrincipal(c.principalId);
      if (
        !principal ||
        principal.signer !== c.signer ||
        principal.status !== 'ACTIVE'
      )
        throw new IdentityError('PRINCIPAL_NOT_FOUND');
      await tx.markRecovered(principal.principalId, now);
      const memberships = (
        await tx.listPrincipalMemberships(principal.principalId)
      ).filter((m) => m.status === 'ACTIVE');
      return { principal: principalView(principal), memberships };
    });
  }

  async get(principalId: string): Promise<PrincipalView> {
    const p = await this.store.transaction((tx) =>
      tx.getPrincipal(principalId),
    );
    if (!p) throw new IdentityError('PRINCIPAL_NOT_FOUND');
    return principalView(p);
  }
}
