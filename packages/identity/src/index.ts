import { randomInt } from 'node:crypto';
import { type Address } from 'viem';
import { z } from 'zod';
import type { IdentityPrincipalKind, ProfileName } from '@synq/schemas';

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
const KIND_BY_PROVIDER: Record<
  IdentityPrincipal['provider'],
  IdentityPrincipalKind
> = {
  mera: 'MERA_HUMAN',
  fixture: 'LOCAL_FIXTURE',
  privy: 'PRIVY_DELEGATE',
  dynamic: 'DYNAMIC_OPERATOR',
};
export type DirectoryMember = {
  groupId: string;
  memberId: string;
  principalId: string;
  principalKind: IdentityPrincipalKind;
  role: 'APPROVER' | 'OPERATOR';
  signer: Address;
  membershipEpoch: number;
  ownerOfAccount: boolean;
};

export class PrincipalRegistry {
  private principals = new Map<string, IdentityPrincipal>();
  private signers = new Set<string>();
  private memberships = new Map<string, Map<string, string>>();
  private epochs = new Map<string, number>();
  private readonly epochBase = randomInt(1, 2 ** 40);
  constructor(
    readonly profile: ProfileName,
    private readonly owners: (groupId: string) => readonly string[] = () => [],
  ) {}
  register(principal: IdentityPrincipal): void {
    PrincipalSchema.parse(principal);
    if (principal.provider === 'fixture' && this.profile !== 'local/anvil')
      throw new Error('Fixture principal forbidden outside local profile');
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
    this.bump(groupId);
  }
  revokeMembership(groupId: string, memberId: string): void {
    this.memberships.get(groupId)?.delete(memberId);
    this.bump(groupId);
  }
  private bump(groupId: string): void {
    this.epochs.set(groupId, (this.epochs.get(groupId) ?? this.epochBase) + 1);
  }
  async membershipEpoch(groupId: string): Promise<number | null> {
    return this.epochs.get(groupId) ?? null;
  }
  async activeMember(
    groupId: string,
    memberId: string,
  ): Promise<DirectoryMember | null> {
    const id = this.memberships.get(groupId)?.get(memberId);
    const principal = id ? this.principals.get(id) : undefined;
    if (!principal) return null;
    const signer = principal.signer.toLowerCase() as Address;
    return {
      groupId,
      memberId,
      principalId: principal.principalId,
      principalKind: KIND_BY_PROVIDER[principal.provider],
      role: 'APPROVER',
      signer,
      membershipEpoch: this.epochs.get(groupId)!,
      ownerOfAccount: this.owners(groupId).some(
        (o) => o.toLowerCase() === signer,
      ),
    };
  }
}
