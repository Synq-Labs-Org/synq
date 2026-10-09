import type {
  ActionKind,
  BoundActionIntent,
  DirectoryMember,
  Mandate,
  MembershipDirectory,
} from '@synq/schemas';
import { requireRule } from './errors.js';

export type { DirectoryMember, MembershipDirectory };

export type DelegationUse = { amount: string; at: number };
export type DelegationRequest = {
  groupId: string;
  mandateId: string;
  memberId: string;
  principalId: string;
  signer: string;
  action: ActionKind;
  token: string;
  chainId: number;
  recipient: string;
  amount: string;
  nativeValue: string;
  at: number;
};
export type DelegationVerdict =
  | { allowed: true; policyId: string }
  | { allowed: false; reason: string };
export interface DelegationEvaluator {
  evaluate(
    request: DelegationRequest,
    history: (policyId: string) => readonly DelegationUse[],
  ): DelegationVerdict | Promise<DelegationVerdict>;
}
export const NO_DELEGATIONS: DelegationEvaluator = {
  evaluate: () => ({ allowed: false, reason: 'NO_DELEGATION_SOURCE' }),
};

export type DelegationState = [string, DelegationUse[]][];

export class DelegationUsage {
  private readonly uses = new Map<string, DelegationUse[]>();
  history(policyId: string): DelegationUse[] {
    return structuredClone(this.uses.get(policyId) ?? []);
  }
  withinScope(
    mandate: Mandate,
    intent: BoundActionIntent,
    policyId: string,
    now: number,
  ): boolean {
    const scope = mandate.delegationScope;
    if (!scope) return false;
    const recent = (this.uses.get(policyId) ?? []).filter(
      (u) => now - u.at < scope.periodSeconds,
    );
    return (
      scope.actions.includes(intent.action) &&
      BigInt(intent.maxInputAmount) <= BigInt(scope.maxInputPerAction) &&
      BigInt(intent.nativeValue) <= BigInt(scope.maxNativePerAction) &&
      recent.length < scope.maxUsesPerPeriod
    );
  }
  record(policyId: string, use: DelegationUse): void {
    this.uses.set(policyId, [...(this.uses.get(policyId) ?? []), use]);
  }
  clone(): DelegationUsage {
    return DelegationUsage.restore(this.export());
  }
  export(): DelegationState {
    return structuredClone([...this.uses]);
  }
  static restore(state: DelegationState): DelegationUsage {
    const usage = new DelegationUsage();
    for (const [id, uses] of state) {
      requireRule(
        !usage.uses.has(id) &&
          uses.every(
            (u) =>
              Number.isSafeInteger(u.at) &&
              u.at >= 0 &&
              /^(0|[1-9][0-9]*)$/.test(u.amount),
          ),
        'SNAPSHOT_INVALID',
      );
      usage.uses.set(id, structuredClone(uses));
    }
    return usage;
  }
}
