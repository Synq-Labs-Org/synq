import {
  ACTION_MACHINE,
  recordTransition,
  verifyHistory,
  type ActionState,
  type PrincipalRef,
  type TransitionRecord,
} from '@synq/domain';
import type { Hash } from './canonical.js';
import {
  PENDING_FAILURES,
  REFRESHABLE_FAILURES,
  RISK_FAILURES,
  SIMULATION_FAILURES,
  requireRule,
  type Failure,
} from './errors.js';

export const KERNEL_SEGMENT_START: ActionState = 'PROPOSED';
export const KERNEL_PRINCIPAL: PrincipalRef = {
  principalId: 'synq-kernel' as PrincipalRef['principalId'],
  kind: 'SERVICE',
};
const AFTER_AUTHORIZATION: readonly ActionState[] = [
  'AUTHORIZED',
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'EXPLAINED',
  'RECONCILIATION_REQUIRED',
];
export type Outcome =
  | { kind: 'AUTHORIZED'; viaApproval: boolean }
  | { kind: 'PENDING' }
  | { kind: 'FAILED'; code: Failure };

export function plannedPath(
  from: ActionState,
  outcome: Outcome,
): ActionState[] {
  if (from === 'PROPOSED') {
    if (outcome.kind === 'AUTHORIZED')
      return outcome.viaApproval
        ? ['RISKED', 'SIMULATED', 'PENDING_APPROVAL', 'AUTHORIZED']
        : ['RISKED', 'SIMULATED', 'AUTHORIZED'];
    if (outcome.kind === 'PENDING')
      return ['RISKED', 'SIMULATED', 'PENDING_APPROVAL'];
    const code = outcome.code;
    if (code === 'AUDIT_UNAVAILABLE') return [];
    if (PENDING_FAILURES.has(code))
      return ['RISKED', 'SIMULATED', 'PENDING_APPROVAL'];
    if (code === 'DRAFT_EXPIRED') return ['RISKED', 'SIMULATED', 'EXPIRED'];
    if (SIMULATION_FAILURES.has(code))
      return ['RISKED', 'SIMULATED', 'RISK_REJECTED'];
    if (RISK_FAILURES.has(code)) return ['RISKED', 'RISK_REJECTED'];
    return ['POLICY_REJECTED'];
  }
  if (from === 'PENDING_APPROVAL') {
    if (outcome.kind === 'AUTHORIZED') return ['AUTHORIZED'];
    if (outcome.kind === 'PENDING') return [];
    const code = outcome.code;
    if (
      PENDING_FAILURES.has(code) ||
      REFRESHABLE_FAILURES.has(code) ||
      RISK_FAILURES.has(code)
    )
      return [];
    return ['POLICY_REJECTED'];
  }
  return [];
}

export class ActionLifecycles {
  private readonly histories = new Map<
    string,
    TransitionRecord<ActionState>[]
  >();
  state(intentId: string): ActionState {
    return this.histories.get(intentId)?.at(-1)?.to ?? KERNEL_SEGMENT_START;
  }
  isAuthorizedOrLater(intentId: string): boolean {
    return AFTER_AUTHORIZATION.includes(this.state(intentId));
  }
  isOpen(intentId: string): boolean {
    const s = this.state(intentId);
    return s === 'PROPOSED' || s === 'PENDING_APPROVAL';
  }
  history(intentId: string): TransitionRecord<ActionState>[] {
    return structuredClone(this.histories.get(intentId) ?? []);
  }
  advance(
    intentId: string,
    path: readonly ActionState[],
    evidenceHash: Hash,
    now: number,
  ): TransitionRecord<ActionState>[] {
    const history = [...(this.histories.get(intentId) ?? [])];
    const at = new Date(now * 1000).toISOString();
    const records: TransitionRecord<ActionState>[] = [];
    for (const to of path) {
      const record = recordTransition(
        ACTION_MACHINE,
        history,
        { actor: KERNEL_PRINCIPAL, at, to, evidenceHash },
        KERNEL_SEGMENT_START,
      );
      history.push(record);
      records.push(record);
    }
    if (records.length) this.histories.set(intentId, history);
    return records;
  }
  clone(): ActionLifecycles {
    return ActionLifecycles.restore(this.export());
  }
  export(): [string, TransitionRecord<ActionState>[]][] {
    return structuredClone([...this.histories]);
  }
  static restore(
    entries: readonly [string, TransitionRecord<ActionState>[]][],
  ): ActionLifecycles {
    const lifecycles = new ActionLifecycles();
    for (const [intentId, history] of entries) {
      requireRule(
        !lifecycles.histories.has(intentId) && history.length > 0,
        'SNAPSHOT_INVALID',
      );
      try {
        verifyHistory(ACTION_MACHINE, history, KERNEL_SEGMENT_START);
      } catch {
        requireRule(false, 'SNAPSHOT_INVALID');
      }
      lifecycles.histories.set(intentId, structuredClone(history));
    }
    return lifecycles;
  }
}
