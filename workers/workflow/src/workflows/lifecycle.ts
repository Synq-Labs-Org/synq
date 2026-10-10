import type { ActionState, TxState } from '@synq/schemas';
import type { StateStep } from '../activities/types.js';

/**
 * Mirrors an authoritative history (Kernel lifecycle or execution journal). Those histories are built
 * and verified against @synq/domain's ACTION_MACHINE and TX_MACHINE by the Kernel, the journal and the
 * Activities; the workflow only refuses histories that regress, diverge or have gaps.
 */
export class MirroredHistory<S extends string> {
  private steps: StateStep<S>[] = [];
  constructor(
    private readonly name: string,
    private readonly start: S,
  ) {}
  get state(): S {
    return this.steps.at(-1)?.to ?? this.start;
  }
  get history(): StateStep<S>[] {
    return this.steps.map((s) => ({ ...s }));
  }
  sync(full: readonly StateStep<S>[]): S {
    if (full.length < this.steps.length)
      throw new Error(`${this.name}_HISTORY_REGRESSED`);
    let current = this.start;
    full.forEach((step, i) => {
      const known = this.steps[i];
      if (known && (known.from !== step.from || known.to !== step.to))
        throw new Error(`${this.name}_HISTORY_DIVERGED`);
      if (step.from !== current) throw new Error(`${this.name}_HISTORY_GAP`);
      current = step.to;
    });
    this.steps = full.map((s) => ({ from: s.from, to: s.to }));
    return this.state;
  }
}

/** Proposals reach the Kernel already PROPOSED; the Kernel segment starts there (as in @synq/kernel). */
export const KERNEL_SEGMENT_START: ActionState = 'PROPOSED';

/** The intent's ACTION_MACHINE walk is the Kernel segment (PROPOSED..PREPARED) followed by the journal segment (PREPARED..). */
export class ActionLifecycle {
  readonly kernel = new MirroredHistory<ActionState>(
    'ACTION',
    KERNEL_SEGMENT_START,
  );
  readonly journalAction = new MirroredHistory<ActionState>(
    'ACTION',
    'PREPARED',
  );
  readonly tx = new MirroredHistory<TxState>('TRANSACTION', 'PREPARED');
  private terminal: ActionState | null = null;
  /** Successors of the current state as ACTION_MACHINE reported them in the latest Activity result. */
  successors: readonly ActionState[] = [];
  get actionState(): ActionState {
    if (this.terminal) return this.terminal;
    return this.journalAction.history.length
      ? this.journalAction.state
      : this.kernel.state;
  }
  get txState(): TxState | null {
    return this.tx.history.length ? this.tx.state : null;
  }
  canClose(to: ActionState): boolean {
    return this.terminal === null && this.successors.includes(to);
  }
  /** Workflow-level terminal outcomes (cancel, expiry) only follow an edge the canonical machine offered. */
  close(to: ActionState): boolean {
    if (!this.canClose(to)) return false;
    this.terminal = to;
    return true;
  }
}
