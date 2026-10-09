import {
  DelegationPolicySchema,
  IdSchema,
  type DelegationPolicy,
} from '@synq/schemas';
import {
  resolveConfig,
  type IdentityConfig,
  type ResolvedConfig,
} from './config.js';
import {
  evaluateDelegation,
  type DelegationDecision,
  type DelegationRequest,
} from './delegation.js';
import { IdentityError } from './errors.js';
import { activeMembership, requireGroup } from './membership.js';
import type { IdentityStore } from './store.js';

export class DelegationService {
  readonly config: ResolvedConfig;
  constructor(
    readonly store: IdentityStore,
    config: IdentityConfig,
  ) {
    this.config = resolveConfig(config);
  }

  async createPolicy(raw: unknown): Promise<DelegationPolicy> {
    const parsed = DelegationPolicySchema.safeParse(raw);
    if (!parsed.success)
      throw new IdentityError('INVALID_INPUT', 'delegation policy');
    const policy = { ...parsed.data, revokedAt: null };
    return this.store.transaction(async (tx) => {
      const group = await requireGroup(tx, policy.groupId);
      const delegate = await tx.getPrincipal(policy.delegatePrincipalId);
      if (
        !delegate ||
        delegate.kind !== 'PRIVY_DELEGATE' ||
        delegate.status !== 'ACTIVE'
      )
        throw new IdentityError('PRINCIPAL_NOT_ELIGIBLE');
      const delegator = await activeMembership(
        tx,
        group.groupId,
        policy.delegatorMemberId,
      );
      if (!delegator || delegator.role !== 'APPROVER')
        throw new IdentityError('MEMBERSHIP_NOT_FOUND');
      if (policy.asset.chainId !== group.chainId)
        throw new IdentityError('INVALID_INPUT', 'asset chain');
      await tx.insertDelegationPolicy(policy);
      return policy;
    });
  }

  async revokePolicy(policyId: string): Promise<DelegationPolicy> {
    const now = this.config.now();
    return this.store.transaction(async (tx) => {
      await tx.revokeDelegationPolicy(policyId, now);
      const policy = await tx.getDelegationPolicy(policyId);
      if (!policy) throw new IdentityError('INVALID_INPUT', 'unknown policy');
      return policy;
    });
  }

  async authorize(input: {
    policyId: string;
    usageId: string;
    request: Omit<DelegationRequest, 'at'>;
  }): Promise<DelegationDecision & { replayed: boolean }> {
    if (!IdSchema.safeParse(input.usageId).success)
      throw new IdentityError('INVALID_INPUT', 'usageId');
    const at = this.config.now();
    return this.store.transaction(async (tx) => {
      const policy = await tx.getDelegationPolicy(input.policyId, true);
      if (!policy) throw new IdentityError('INVALID_INPUT', 'unknown policy');
      const history = await tx.listDelegationUsage(policy.policyId);
      const previous = history.find((u) => u.usageId === input.usageId);
      if (previous) {
        if (previous.amount !== input.request.amount)
          throw new IdentityError('IDEMPOTENCY_CONFLICT');
        const others = history.filter((u) => u.usageId !== input.usageId);
        return {
          ...evaluateDelegation(policy, others, {
            ...input.request,
            at: previous.at,
          }),
          replayed: true,
        };
      }
      const decision = evaluateDelegation(policy, history, {
        ...input.request,
        at,
      });
      if (!decision.allowed)
        throw new IdentityError('DELEGATION_DENIED', decision.reason);
      await tx.insertDelegationUsage({
        usageId: input.usageId,
        policyId: policy.policyId,
        amount: input.request.amount,
        at,
      });
      return { ...decision, replayed: false };
    });
  }
}
