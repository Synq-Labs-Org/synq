import {
  ACTION_MACHINE,
  TX_MACHINE,
  type ActionState,
  type StateMachine,
  type TxState,
} from '@synq/domain';
import type { StateStep } from '../activities/types.js';

/** Mirrors an authoritative history (Kernel lifecycle or execution journal) and refuses any walk the canonical machine forbids. */
export class MirroredHistory<S extends string> {
  private steps: StateStep<S>[] = [];
  constructor(
    private readonly machine: StateMachine<S>,
    private readonly start: S,
  ) {}
  get state(): S {
    return this.steps.at(-1)?.to ?? this.start;
  }
  get history(): StateStep<S>[] {
    return this.steps.map((s) => ({ ...s }));
  }
  /** Accepts a full authoritative history; it must extend what was already mirrored. */
  sync(full: readonly StateStep<S>[]): S {
    if (full.length < this.steps.length)
      throw new Error(`${this.machine.name.toUpperCase()}_HISTORY_REGRESSED`);
    let current = this.start;
    full.forEach((step, i) => {
      const known = this.steps[i];
      if (known && (known.from !== step.from || known.to !== step.to))
        throw new Error(`${this.machine.name.toUpperCase()}_HISTORY_DIVERGED`);
      if (step.from !== current)
        throw new Error(`${this.machine.name.toUpperCase()}_HISTORY_GAP`);
      this.machine.assertTransition(step.from, step.to);
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
    ACTION_MACHINE,
    KERNEL_SEGMENT_START,
  );
  readonly journalAction = new MirroredHistory<ActionState>(
    ACTION_MACHINE,
    'PREPARED',
  );
  readonly tx = new MirroredHistory<TxState>(TX_MACHINE, TX_MACHINE.initial);
  private terminal: ActionState | null = null;
  get actionState(): ActionState {
    if (this.terminal) return this.terminal;
    return this.journalAction.history.length
      ? this.journalAction.state
      : this.kernel.state;
  }
  get txState(): TxState | null {
    return this.tx.history.length ? this.tx.state : null;
  }
  /** Workflow-level terminal outcomes (cancel, expiry) still follow the canonical edges. */
  close(to: ActionState): ActionState {
    ACTION_MACHINE.assertTransition(this.actionState, to);
    this.terminal = to;
    return to;
  }
  canClose(to: ActionState): boolean {
    return ACTION_MACHINE.canTransition(this.actionState, to);
  }
}
