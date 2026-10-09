import { z } from 'zod';
import {
  HashSchema,
  IsoTimestampSchema,
  PrincipalRefSchema,
  type PrincipalRef,
} from '@synq/schemas';
import { TransitionError, ValidationError, parseOrThrow } from './errors.js';

export const ACTION_STATES = [
  'RECEIVED',
  'NORMALIZED',
  'RESEARCHING',
  'PROPOSED',
  'RISKED',
  'SIMULATED',
  'PENDING_APPROVAL',
  'AUTHORIZED',
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'EXPLAINED',
  'POLICY_REJECTED',
  'RISK_REJECTED',
  'EXPIRED',
  'CANCELLED',
  'PREPARE_FAILED',
  'SUBMIT_FAILED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];
export const TX_STATES = [
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'INCLUDED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'SETTLED',
  'PREPARE_FAILED',
  'SUBMIT_FAILED',
  'RECONCILIATION_REQUIRED',
  'MANUAL_REVIEW',
] as const;
export type TxState = (typeof TX_STATES)[number];

export class StateMachine<S extends string> {
  constructor(
    readonly name: string,
    readonly states: readonly S[],
    private readonly edges: Readonly<Record<S, readonly S[]>>,
    readonly initial: S,
  ) {}
  successors(state: S): readonly S[] {
    return this.edges[state];
  }
  isTerminal(state: S): boolean {
    return this.edges[state].length === 0;
  }
  canTransition(from: S, to: S): boolean {
    return this.edges[from]?.includes(to) ?? false;
  }
  assertTransition(from: S, to: S): S {
    if (!this.canTransition(from, to))
      throw new TransitionError(this.name, from, to);
    return to;
  }
  stateSchema() {
    return z.enum(this.states as [S, ...S[]]);
  }
}

export const ACTION_MACHINE = new StateMachine<ActionState>(
  'action',
  ACTION_STATES,
  {
    RECEIVED: ['NORMALIZED', 'CANCELLED'],
    NORMALIZED: ['RESEARCHING', 'PROPOSED', 'POLICY_REJECTED', 'CANCELLED'],
    RESEARCHING: ['PROPOSED', 'CANCELLED', 'EXPIRED'],
    PROPOSED: ['RISKED', 'POLICY_REJECTED', 'CANCELLED', 'EXPIRED'],
    RISKED: [
      'SIMULATED',
      'RISK_REJECTED',
      'MANUAL_REVIEW',
      'CANCELLED',
      'EXPIRED',
    ],
    SIMULATED: [
      'PENDING_APPROVAL',
      'AUTHORIZED',
      'RISK_REJECTED',
      'CANCELLED',
      'EXPIRED',
    ],
    PENDING_APPROVAL: ['AUTHORIZED', 'CANCELLED', 'EXPIRED', 'POLICY_REJECTED'],
    AUTHORIZED: ['PREPARED', 'CANCELLED', 'EXPIRED', 'PREPARE_FAILED'],
    PREPARED: ['SIGNED', 'PREPARE_FAILED', 'CANCELLED', 'EXPIRED'],
    SIGNED: ['SUBMITTED', 'SUBMIT_FAILED', 'RECONCILIATION_REQUIRED'],
    SUBMITTED: ['CONFIRMED', 'RECONCILIATION_REQUIRED'],
    CONFIRMED: ['INDEXED', 'RECONCILIATION_REQUIRED'],
    INDEXED: ['RECONCILED', 'RECONCILIATION_REQUIRED'],
    RECONCILED: ['EXPLAINED', 'RECONCILIATION_REQUIRED'],
    RECONCILIATION_REQUIRED: [
      'SUBMITTED',
      'CONFIRMED',
      'INDEXED',
      'RECONCILED',
      'SUBMIT_FAILED',
      'MANUAL_REVIEW',
    ],
    MANUAL_REVIEW: ['CANCELLED'],
    EXPLAINED: [],
    POLICY_REJECTED: [],
    RISK_REJECTED: [],
    EXPIRED: [],
    CANCELLED: [],
    PREPARE_FAILED: [],
    SUBMIT_FAILED: [],
  },
  'RECEIVED',
);
export const TX_MACHINE = new StateMachine<TxState>(
  'transaction',
  TX_STATES,
  {
    PREPARED: ['SIGNED', 'PREPARE_FAILED'],
    SIGNED: ['SUBMITTED', 'SUBMIT_FAILED', 'RECONCILIATION_REQUIRED'],
    SUBMITTED: ['INCLUDED', 'RECONCILIATION_REQUIRED'],
    INCLUDED: ['CONFIRMED', 'RECONCILIATION_REQUIRED'],
    CONFIRMED: ['INDEXED', 'RECONCILIATION_REQUIRED'],
    INDEXED: ['RECONCILED', 'RECONCILIATION_REQUIRED'],
    RECONCILED: ['SETTLED', 'RECONCILIATION_REQUIRED'],
    RECONCILIATION_REQUIRED: ['INCLUDED', 'SUBMIT_FAILED', 'MANUAL_REVIEW'],
    SETTLED: [],
    PREPARE_FAILED: [],
    SUBMIT_FAILED: [],
    MANUAL_REVIEW: [],
  },
  'PREPARED',
);
const txProjection: Readonly<Record<TxState, ActionState>> = {
  PREPARED: 'PREPARED',
  SIGNED: 'SIGNED',
  SUBMITTED: 'SUBMITTED',
  INCLUDED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  INDEXED: 'INDEXED',
  RECONCILED: 'RECONCILED',
  SETTLED: 'RECONCILED',
  PREPARE_FAILED: 'PREPARE_FAILED',
  SUBMIT_FAILED: 'SUBMIT_FAILED',
  RECONCILIATION_REQUIRED: 'RECONCILIATION_REQUIRED',
  MANUAL_REVIEW: 'MANUAL_REVIEW',
};
export function actionStateOfTx(state: TxState): ActionState {
  return txProjection[state];
}
export function transition(from: ActionState, to: ActionState): ActionState {
  return ACTION_MACHINE.assertTransition(from, to);
}

export type TransitionRecord<S extends string> = {
  actor: PrincipalRef;
  at: string;
  from: S;
  to: S;
  evidenceHash: `0x${string}`;
};
export function transitionRecordSchema<S extends string>(
  machine: StateMachine<S>,
) {
  const state = machine.stateSchema();
  return z.strictObject({
    actor: PrincipalRefSchema,
    at: IsoTimestampSchema,
    from: state,
    to: state,
    evidenceHash: HashSchema,
  });
}
export type TransitionInput<S extends string> = Omit<
  TransitionRecord<S>,
  'from'
>;
export function currentState<S extends string>(
  machine: StateMachine<S>,
  history: readonly TransitionRecord<S>[],
): S {
  return history.at(-1)?.to ?? machine.initial;
}
export function recordTransition<S extends string>(
  machine: StateMachine<S>,
  history: readonly TransitionRecord<S>[],
  input: TransitionInput<S>,
): TransitionRecord<S> {
  const from = currentState(machine, history);
  machine.assertTransition(from, input.to);
  const record = parseOrThrow(transitionRecordSchema(machine), {
    ...input,
    from,
  });
  const previous = history.at(-1);
  if (previous && Date.parse(record.at) < Date.parse(previous.at))
    throw new ValidationError([
      { path: 'at', message: 'transition time precedes history' },
    ]);
  return {
    actor: record.actor,
    at: record.at,
    from: record.from,
    to: record.to,
    evidenceHash: record.evidenceHash,
  };
}
export function verifyHistory<S extends string>(
  machine: StateMachine<S>,
  history: readonly TransitionRecord<S>[],
): S {
  const replayed: TransitionRecord<S>[] = [];
  for (const record of history) {
    const expected = recordTransition(machine, replayed, record);
    if (expected.from !== record.from)
      throw new TransitionError(machine.name, record.from, record.to);
    replayed.push(expected);
  }
  return currentState(machine, replayed);
}
