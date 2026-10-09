import { randomBytes } from 'node:crypto';
import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { z } from 'zod';
import {
  ApprovalSchema,
  ActionIntentSchema,
  MandateSchema,
  type ActionIntent,
  type Approval,
  type Mandate,
} from '../../schemas/src/index.js';
import {
  approvalTypedData,
  approvalDigest,
  intentHash,
  type UnsignedApproval,
} from '../../kernel/src/index.js';

export type IdentityPrincipal =
  | {
      principalId: string;
      kind: 'HUMAN';
      provider: 'mera';
      signer: Address;
      credentialId: string;
      rpId: string;
    }
  | { principalId: string; kind: 'HUMAN'; provider: 'fixture'; signer: Address }
  | {
      principalId: string;
      kind: 'SERVICE';
      provider: 'privy';
      signer: Address;
      delegationId: string;
    }
  | {
      principalId: string;
      kind: 'AGENT';
      provider: 'dynamic';
      signer: Address;
      environmentId: string;
    };
const principalBase = {
  principalId: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/),
  signer: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
};
const PrincipalSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    ...principalBase,
    kind: z.literal('HUMAN'),
    provider: z.literal('mera'),
    credentialId: z.string().min(1),
    rpId: z.string().min(1),
  }),
  z.strictObject({
    ...principalBase,
    kind: z.literal('HUMAN'),
    provider: z.literal('fixture'),
  }),
  z.strictObject({
    ...principalBase,
    kind: z.literal('SERVICE'),
    provider: z.literal('privy'),
    delegationId: z.string().min(1),
  }),
  z.strictObject({
    ...principalBase,
    kind: z.literal('AGENT'),
    provider: z.literal('dynamic'),
    environmentId: z.string().min(1),
  }),
]);
export type ApprovalChallenge = {
  challengeId: string;
  principalId: string;
  membershipBinding: string;
  approval: UnsignedApproval;
  intent: ActionIntent;
  digest: Hex;
  used: boolean;
};

export interface ChallengeStore {
  put(challenge: ApprovalChallenge): Promise<void>;
  get(id: string): Promise<ApprovalChallenge | null>;
  consume(id: string): Promise<boolean>;
}
export class MemoryChallengeStore implements ChallengeStore {
  private records = new Map<string, ApprovalChallenge>();
  async put(challenge: ApprovalChallenge): Promise<void> {
    if (this.records.has(challenge.challengeId))
      throw new Error('Challenge collision');
    this.records.set(challenge.challengeId, structuredClone(challenge));
  }
  async get(id: string): Promise<ApprovalChallenge | null> {
    const value = this.records.get(id);
    return value ? structuredClone(value) : null;
  }
  async consume(id: string): Promise<boolean> {
    const value = this.records.get(id);
    if (!value || value.used) return false;
    value.used = true;
    return true;
  }
}

export class ApprovalService {
  private principals = new Map<string, IdentityPrincipal>();
  private signers = new Set<string>();
  private memberships = new Map<string, Map<string, string>>();
  private membershipBindings = new Map<string, string>();
  constructor(
    readonly store: ChallengeStore,
    readonly profile: 'local' | 'testnet' = 'testnet',
  ) {}
  register(principal: IdentityPrincipal): void {
    PrincipalSchema.parse(principal);
    if (principal.provider === 'fixture' && this.profile !== 'local')
      throw new Error('Fixture principal forbidden outside local profile');
    if (!/^0x[0-9a-fA-F]{40}$/.test(principal.signer) || !principal.principalId)
      throw new Error('Invalid principal');
    if (
      principal.provider === 'mera' &&
      (!principal.credentialId || !principal.rpId)
    )
      throw new Error('Missing passkey binding');
    if (
      this.principals.has(principal.principalId) ||
      this.signers.has(principal.signer.toLowerCase())
    )
      throw new Error('Duplicate principal/signer');
    this.principals.set(principal.principalId, structuredClone(principal));
    this.signers.add(principal.signer.toLowerCase());
  }
  bindMembership(groupId: string, memberId: string, principalId: string): void {
    const principal = this.principals.get(principalId);
    if (!principal || principal.kind !== 'HUMAN')
      throw new Error('Only human principals may own membership');
    const members = this.memberships.get(groupId) ?? new Map<string, string>();
    if (members.has(memberId) || [...members.values()].includes(principalId))
      throw new Error('Duplicate membership');
    members.set(memberId, principalId);
    this.memberships.set(groupId, members);
    this.membershipBindings.set(
      JSON.stringify([groupId, memberId]),
      randomBytes(32).toString('hex'),
    );
  }
  revokeMembership(groupId: string, memberId: string): void {
    this.memberships.get(groupId)?.delete(memberId);
    this.membershipBindings.delete(JSON.stringify([groupId, memberId]));
  }
  async issue(
    rawIntent: ActionIntent,
    rawMandate: Mandate,
    memberId: string,
    now: number,
    ttlSeconds = 120,
  ): Promise<ApprovalChallenge> {
    const intent = ActionIntentSchema.parse(rawIntent),
      mandate = MandateSchema.parse(rawMandate);
    if (
      !Number.isSafeInteger(now) ||
      now < 0 ||
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > 300
    )
      throw new Error('Invalid challenge lifetime');
    this.validateScope(intent, mandate);
    const principal = this.member(intent.groupId, memberId, mandate);
    const expiresAt = Math.min(
      now + ttlSeconds,
      intent.validUntil,
      mandate.validUntil,
    );
    if (expiresAt <= now) throw new Error('Expired intent/mandate');
    const approval: UnsignedApproval = {
      schemaVersion: 1,
      groupId: intent.groupId,
      mandateId: intent.mandateId,
      mandateVersion: intent.mandateVersion,
      intentHash: intentHash(intent),
      memberId,
      signer: principal.signer.toLowerCase() as Address,
      expiresAt,
      nonce: BigInt(`0x${randomBytes(32).toString('hex')}`).toString(),
    };
    const challenge: ApprovalChallenge = {
      challengeId: randomBytes(32).toString('hex'),
      principalId: principal.principalId,
      membershipBinding: this.membershipBindings.get(
        JSON.stringify([intent.groupId, memberId]),
      )!,
      approval,
      intent,
      digest: approvalDigest(intent, approval),
      used: false,
    };
    await this.store.put(challenge);
    return structuredClone(challenge);
  }
  async submit(
    challengeId: string,
    raw: Approval,
    rawIntent: ActionIntent,
    rawMandate: Mandate,
    now: number,
  ): Promise<Approval> {
    const intent = ActionIntentSchema.parse(rawIntent),
      mandate = MandateSchema.parse(rawMandate),
      approval = ApprovalSchema.parse(raw);
    const challenge = await this.store.get(challengeId);
    if (!challenge || challenge.used)
      throw new Error('Unknown/consumed challenge');
    this.validateScope(intent, mandate);
    if (!Number.isSafeInteger(now) || now < 0 || approval.expiresAt <= now)
      throw new Error('Expired challenge');
    const principal = this.member(intent.groupId, approval.memberId, mandate);
    this.validateMembershipBinding(challenge, mandate);
    if (
      principal.principalId !== challenge.principalId ||
      intentHash(intent) !== intentHash(challenge.intent) ||
      approvalDigest(intent, approval) !== challenge.digest
    )
      throw new Error('Challenge binding mismatch');
    const recovered = await recoverTypedDataAddress({
      ...approvalTypedData(intent, approval),
      signature: approval.signature,
    });
    if (recovered.toLowerCase() !== principal.signer.toLowerCase())
      throw new Error('Signature/principal mismatch');
    this.validateMembershipBinding(challenge, mandate);
    if (!(await this.store.consume(challengeId)))
      throw new Error('Challenge replay');
    this.validateMembershipBinding(challenge, mandate);
    return approval;
  }
  private validateMembershipBinding(
    challenge: ApprovalChallenge,
    mandate: Mandate,
  ): void {
    const { groupId, memberId } = challenge.approval;
    const binding = this.membershipBindings.get(
      JSON.stringify([groupId, memberId]),
    );
    if (
      !binding ||
      binding !== challenge.membershipBinding ||
      this.member(groupId, memberId, mandate).principalId !==
        challenge.principalId
    )
      throw new Error('Membership binding changed/revoked');
  }
  private validateScope(intent: ActionIntent, mandate: Mandate): void {
    if (intent.network.profile !== this.profile)
      throw new Error('Identity profile mismatch');
    if (
      intent.groupId !== mandate.groupId ||
      intent.mandateId !== mandate.mandateId ||
      intent.mandateVersion !== mandate.version ||
      intent.account !== mandate.account ||
      intent.chainId !== mandate.network.chainId ||
      mandate.status !== 'ACTIVE'
    )
      throw new Error('Wrong group/mandate/version/account/chain');
  }
  private member(
    groupId: string,
    memberId: string,
    mandate: Mandate,
  ): IdentityPrincipal {
    const id = this.memberships.get(groupId)?.get(memberId),
      principal = id ? this.principals.get(id) : undefined;
    const member = mandate.members.find(
      (x) => x.memberId === memberId && x.active,
    );
    if (
      !principal ||
      principal.kind !== 'HUMAN' ||
      !member ||
      principal.signer.toLowerCase() !== member.signer.toLowerCase()
    )
      throw new Error('Inactive/unbound membership');
    return principal;
  }
}
