import { ApplicationFailure } from '@temporalio/common';
import type {
  ActionState,
  GrantDraft,
  GrantExecutionObservation,
  TxState,
  VerifiedApproval,
} from '../../../packages/schemas/src/index.js';
import type {
  DecisionView,
  EconomicActivities,
  Hex,
  StateStep,
  TxView,
} from '../../../workers/workflow/src/activities/types.js';

const hex = (n: number, width = 64): Hex =>
  `0x${n.toString(16).padStart(width, '0')}`;
const DIGEST = hex(0xd1);
const GRANT = hex(0x91);
const TX = hex(0x7a);

import { ACTION_MACHINE } from '../../../packages/domain/src/index.js';

const successorsOf = (
  steps: StateStep<ActionState>[],
  start: ActionState,
): ActionState[] => [...ACTION_MACHINE.successors(steps.at(-1)?.to ?? start)];
const KERNEL_PENDING: StateStep<ActionState>[] = [
  { from: 'PROPOSED', to: 'RISKED' },
  { from: 'RISKED', to: 'SIMULATED' },
  { from: 'SIMULATED', to: 'PENDING_APPROVAL' },
];
const TX_PATH: TxState[] = [
  'PREPARED',
  'SIGNED',
  'SUBMITTED',
  'INCLUDED',
  'CONFIRMED',
  'INDEXED',
  'RECONCILED',
  'SETTLED',
];
const ACTION_OF: Record<string, ActionState> = {
  PREPARED: 'PREPARED',
  SIGNED: 'SIGNED',
  SUBMITTED: 'SUBMITTED',
  INCLUDED: 'SUBMITTED',
  CONFIRMED: 'CONFIRMED',
  INDEXED: 'INDEXED',
  RECONCILED: 'RECONCILED',
  SETTLED: 'RECONCILED',
};

export type FakeOptions = {
  requiredApprovals?: number;
  autoAuthorize?: boolean;
  validUntilSeconds?: number;
  confirmFailures?: number;
  submitHangMs?: number;
  submitHangTimes?: number;
  journalOnHang?: boolean;
  revert?: boolean;
  claimLatch?: Promise<void>;
};

/** In-memory stand-in for the economic Activities with the same idempotency contract. */
export function fakeEconomic(options: FakeOptions = {}) {
  const required = options.requiredApprovals ?? 2;
  const calls: Record<string, number[]> = {};
  const ledger = new Map<string, VerifiedApproval>();
  const state = {
    frozen: false,
    authorized: false,
    grant: 'NONE' as
      | 'NONE'
      | 'RESERVED'
      | 'CONSUMED'
      | 'PREPARED'
      | 'RECONCILED'
      | 'REVERTED'
      | 'RELEASED',
    tx: null as TxState | null,
    broadcasts: 0,
    validUntil: 0,
  };
  const track = (name: string) => {
    (calls[name] ??= []).push(Date.now());
  };
  const kernelLifecycle = (): StateStep<ActionState>[] => {
    const path = options.autoAuthorize
      ? [
          { from: 'PROPOSED', to: 'RISKED' },
          { from: 'RISKED', to: 'SIMULATED' },
          { from: 'SIMULATED', to: 'AUTHORIZED' },
        ]
      : [
          ...KERNEL_PENDING,
          ...(state.authorized
            ? [{ from: 'PENDING_APPROVAL', to: 'AUTHORIZED' }]
            : []),
        ];
    if (['PREPARED', 'RECONCILED', 'REVERTED'].includes(state.grant))
      path.push({ from: 'AUTHORIZED', to: 'PREPARED' });
    return path as StateStep<ActionState>[];
  };
  const txView = (): TxView => {
    const upto = TX_PATH.indexOf(state.tx!);
    const txHistory: StateStep<TxState>[] = [];
    const actionHistory: StateStep<ActionState>[] = [];
    for (let i = 1; i <= upto; i++) {
      txHistory.push({ from: TX_PATH[i - 1]!, to: TX_PATH[i]! });
      const from = ACTION_OF[TX_PATH[i - 1]!]!;
      const to = ACTION_OF[TX_PATH[i]!]!;
      if (from !== to) actionHistory.push({ from, to });
    }
    const included = upto >= TX_PATH.indexOf('INCLUDED');
    return {
      successors: successorsOf(actionHistory, 'PREPARED'),
      grantId: GRANT,
      transactionHash: TX,
      state: state.tx!,
      blockNumber: included ? '42' : null,
      outcome: included ? (options.revert ? 'REVERTED' : 'SUCCESS') : null,
      txHistory,
      actionHistory,
    };
  };
  const draft = () =>
    ({
      digest: DIGEST,
      requiredApprovals: required,
      grant: { validUntil: String(state.validUntil) },
    }) as unknown as GrantDraft;
  const reservation = () =>
    ({
      grantId: GRANT,
      state: state.grant === 'NONE' ? 'RESERVED' : state.grant,
      reservedToken: ['RESERVED', 'CONSUMED', 'PREPARED'].includes(state.grant)
        ? '1000000'
        : '0',
      spentToken: state.grant === 'RECONCILED' ? '1000000' : '0',
      validUntil: state.validUntil,
    }) as const;
  const observation = (): GrantExecutionObservation =>
    ({
      schemaVersion: 1,
      chainId: 31337,
      transactionHash: TX,
      blockNumber: '42',
      receiptStatus: options.revert ? 'reverted' : 'success',
      emitter: null,
      event: null,
    }) as unknown as GrantExecutionObservation;
  let hangs = 0;

  const activities: EconomicActivities = {
    async attestEvidence() {
      track('attestEvidence');
      state.validUntil =
        Math.floor(Date.now() / 1000) + (options.validUntilSeconds ?? 600);
      return { simulation: {} as never };
    },
    async authorize({ approvals }): Promise<DecisionView> {
      track('authorize');
      const enough = options.autoAuthorize || approvals.length >= required;
      if (enough) {
        state.authorized = true;
        if (state.grant === 'NONE') state.grant = 'RESERVED';
        return {
          status: 'AUTHORIZED',
          intentId: 'intent_fake',
          intentHash: hex(0x11),
          grantId: GRANT,
          validUntil: state.validUntil,
          draft: draft(),
          grant: {} as never,
          requiredApprovals: required,
          lifecycle: kernelLifecycle(),
          successors: successorsOf(kernelLifecycle(), 'PROPOSED'),
        };
      }
      return {
        status: 'PENDING_APPROVAL',
        code: 'APPROVALS_REQUIRED',
        intentId: 'intent_fake',
        intentHash: hex(0x11),
        draft: draft(),
        requiredApprovals: required,
        lifecycle: kernelLifecycle(),
        successors: successorsOf(kernelLifecycle(), 'PROPOSED'),
      };
    },
    async registerDraft() {
      track('registerDraft');
      return { draftDigest: DIGEST };
    },
    async readQuorum({ draftDigest }) {
      track('readQuorum');
      const counted = [...ledger.values()];
      return {
        draftDigest,
        draftStatus: 'PENDING',
        required,
        satisfied: counted.length >= required,
        counted,
      };
    },
    async claimAndPrepare() {
      track('claimAndPrepare');
      if (options.claimLatch) await options.claimLatch;
      if (state.grant === 'RESERVED') state.grant = 'PREPARED';
      return {
        grantId: GRANT,
        preparedCallHash: hex(0x99),
        reservation: reservation(),
        lifecycle: kernelLifecycle(),
        successors: successorsOf(kernelLifecycle(), 'PROPOSED'),
      };
    },
    async signAndSubmit() {
      track('signAndSubmit');
      if (state.tx) return txView();
      if (options.submitHangMs && hangs < (options.submitHangTimes ?? 1)) {
        hangs++;
        if (options.journalOnHang) {
          state.tx = 'SIGNED';
          state.broadcasts++;
        }
        await new Promise((r) => setTimeout(r, options.submitHangMs));
      }
      state.tx = 'SUBMITTED';
      state.broadcasts++;
      return txView();
    },
    async checkSubmission() {
      track('checkSubmission');
      if (!state.tx) return { status: 'NOT_SUBMITTED', grantId: GRANT };
      if (state.tx === 'SIGNED') state.tx = 'SUBMITTED';
      return { status: 'JOURNALED', tx: txView() };
    },
    async confirmInclusion() {
      track('confirmInclusion');
      if (
        (calls.confirmInclusion?.length ?? 0) <= (options.confirmFailures ?? 0)
      )
        throw new Error('provider responded HTTP 500');
      if (TX_PATH.indexOf(state.tx!) < TX_PATH.indexOf('CONFIRMED'))
        state.tx = 'CONFIRMED';
      return txView();
    },
    async indexObservation() {
      track('indexObservation');
      if (state.tx === 'CONFIRMED') state.tx = 'INDEXED';
      return { tx: txView(), observation: observation() };
    },
    async reconcileGrant() {
      track('reconcileGrant');
      if (options.revert) state.grant = 'REVERTED';
      else {
        state.grant = 'RECONCILED';
        if (state.tx === 'INDEXED') state.tx = 'RECONCILED';
      }
      return { tx: txView(), reservation: reservation() };
    },
    async settle() {
      track('settle');
      if (state.tx === 'RECONCILED') state.tx = 'SETTLED';
      return {
        tx: txView(),
        reservation: reservation(),
        observation: observation(),
      };
    },
    async reservationStatus() {
      track('reservationStatus');
      return reservation();
    },
    async releaseExpiredReservation() {
      track('releaseExpiredReservation');
      if (
        Date.now() / 1000 >= state.validUntil &&
        ['RESERVED', 'CONSUMED', 'PREPARED'].includes(state.grant)
      )
        state.grant = 'RELEASED';
      return reservation();
    },
    async autonomyStatus() {
      track('autonomyStatus');
      return {
        frozen: state.frozen,
        reason: state.frozen ? 'test freeze' : null,
      };
    },
  };
  return {
    activities,
    calls,
    state,
    count: (name: string) => calls[name]?.length ?? 0,
    approve(memberId: string) {
      ledger.set(memberId, {
        approvalId: `approval_${memberId}`,
        memberId,
        draftDigest: DIGEST,
      } as unknown as VerifiedApproval);
    },
    DIGEST,
    GRANT,
    fail(type: string): never {
      throw ApplicationFailure.nonRetryable(type, type);
    },
  };
}
