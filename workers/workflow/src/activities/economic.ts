import { Context } from '@temporalio/activity';
import { ApplicationFailure } from '@temporalio/common';
import {
  encodeFunctionData,
  keccak256,
  type Address,
  type TransactionSerializableEIP1559,
} from 'viem';
import {
  BoundActionIntentSchema,
  RiskPacketSchema,
  type ActionState,
  type Asset,
  type BoundActionIntent,
  type ExecutionGrant,
  type GrantDraft,
  type GrantExecutionObservation,
  type QuorumView,
  type Simulation,
} from '@synq/schemas';
import { SynqError, type TransitionRecord } from '@synq/domain';
import {
  KernelError,
  artifactHash,
  canonicalIntentId,
  type GrantClaim,
  type Kernel,
} from '@synq/kernel';
import type { DurableKernel } from '@synq/api/kernel-runtime';
import {
  chainGrant,
  observeGrantExecution,
  packSafeSignatures,
  prepareModuleCall,
  signGrantBoundTransaction,
  submitGrantTransaction,
  type ExecutorSigner,
  type JournalEntry,
  type JournaledBroadcaster,
} from '@synq/execution-worker';
import { moduleAbi } from '@synq/execution-worker/abi';
import { assertBroadcastAllowed } from './guard.js';
import { NO_FAULTS, type FaultHooks } from './faults.js';
import type {
  DecisionView,
  EconomicActivities,
  Hex,
  PreparedView,
  QuorumSummary,
  ReservationView,
  StateStep,
  SubmissionCheck,
  TxView,
} from './types.js';

export type FullReceipt = {
  status: 'success' | 'reverted';
  transactionHash: Hex;
  blockNumber: bigint;
  logs: readonly { address: Address; data: Hex; topics: readonly Hex[] }[];
};

/** Chain-facing port the economic Activities need; RPC transport, fees and nonces live behind it. */
export interface EconomicChainPort {
  readonly chainId: number;
  now(): Promise<number>;
  buildTransaction(
    call: { to: Address; data: Hex },
    from: Address,
  ): Promise<TransactionSerializableEIP1559>;
  receipt(hash: Hex): Promise<FullReceipt | null>;
  transactionKnown(hash: Hex): Promise<boolean>;
  sendRawTransaction(raw: Hex): Promise<Hex>;
}

export interface ApprovalLedgerPort {
  registerKernelDraft(draft: GrantDraft): Promise<unknown>;
  quorum(draftDigest: string): Promise<QuorumView>;
}
export interface SimulationPort {
  simulate(intent: BoundActionIntent, calldata: Hex): Promise<Simulation>;
}
/** The read model must show the GrantExecuted event before an execution counts as INDEXED. */
export interface IndexPort {
  grantIndexed(grantId: Hex, transactionHash: Hex): Promise<boolean>;
}
export interface AutonomyFreezePort {
  status(
    groupId: string,
  ): Promise<{ frozen: boolean; reason: string | null; since: number | null }>;
  freeze(
    groupId: string,
    reason: string,
    incidentId: string,
  ): Promise<{ since: number }>;
  unfreeze(groupId: string, incidentId: string): Promise<void>;
}

export type EconomicRuntime = {
  chainId: number;
  allowMainnetBroadcast: boolean;
  kernel: DurableKernel;
  approvals: ApprovalLedgerPort;
  simulator: SimulationPort;
  index: IndexPort;
  chain: EconomicChainPort;
  broadcaster: JournaledBroadcaster;
  executor: ExecutorSigner;
  module: Address;
  localAssets: readonly Asset[];
  workerId: string;
  freeze: AutonomyFreezePort;
  faults?: FaultHooks;
  pollIntervalMs?: number;
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
const CONFIRMED_OR_LATER = ['CONFIRMED', 'INDEXED', 'RECONCILED', 'SETTLED'];

const steps = <S extends string>(
  history: readonly TransitionRecord<S>[],
): StateStep<S>[] => history.map((t) => ({ from: t.from, to: t.to }));

function refused(code: string, detail?: string): never {
  throw ApplicationFailure.nonRetryable(
    detail ? `${code}: ${detail}` : code,
    'KERNEL_REFUSED',
  );
}
function invalid(detail: string): never {
  throw ApplicationFailure.nonRetryable(detail, 'INVALID_INPUT');
}

/** Maps deterministic refusals to non-retryable failures; anything else (RPC, IO) stays retryable. */
async function classify<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ApplicationFailure) throw error;
    if (error instanceof KernelError) refused(error.code);
    if (error instanceof SynqError) {
      if (error.code === 'GRANT_REPREPARATION_FORBIDDEN')
        throw ApplicationFailure.nonRetryable(
          error.message,
          'GRANT_REPREPARATION_FORBIDDEN',
        );
      if (
        [
          'MAINNET_DISABLED',
          'PREPARED_CALL_MISMATCH',
          'GRANT_SIGNING_REFUSED',
          'SIGNATURE_PACKING_INVALID',
        ].includes(error.code)
      )
        refused(error.code, error.message);
    }
    throw error;
  }
}

export function createEconomicActivities(
  rt: EconomicRuntime,
): EconomicActivities {
  const faults = rt.faults ?? NO_FAULTS;
  const poll = rt.pollIntervalMs ?? 500;
  const journal = rt.broadcaster.journal;
  const raw = (): Kernel => rt.kernel.kernel;
  const heartbeat = (detail?: string) => {
    try {
      Context.current().heartbeat(detail);
    } catch {
      return;
    }
  };
  const guard = () =>
    assertBroadcastAllowed(rt.chainId, rt.allowMainnetBroadcast);
  const assertActive = async (groupId: string) => {
    const status = await rt.freeze.status(groupId);
    if (status.frozen)
      throw ApplicationFailure.nonRetryable(
        `autonomy frozen for ${groupId}: ${status.reason ?? 'emergency pause'}`,
        'AUTONOMY_FROZEN',
      );
  };
  const reservation = (grantId: Hex): ReservationView => {
    const record = raw().grantState(grantId);
    const budget = raw().accounting(
      record.grant.groupId,
      record.grant.mandateId,
    );
    return {
      grantId,
      state: record.state,
      reservedToken: budget.reservedToken,
      spentToken: budget.spentToken,
      validUntil: record.grant.validUntil,
    };
  };
  const txView = (entry: JournalEntry): TxView => ({
    grantId: entry.grantId,
    transactionHash: entry.transactionHash,
    state: entry.state,
    blockNumber: entry.blockNumber,
    outcome: entry.outcome ?? null,
    txHistory: steps(journal.history(entry.grantId)),
    actionHistory: steps(journal.actionHistory(entry.grantId)),
  });
  const entryOf = (grantId: Hex): JournalEntry => {
    const entry = journal.get(grantId);
    if (!entry) throw invalid(`no journal entry for ${grantId}`);
    return entry;
  };
  const moduleCall = (grant: ExecutionGrant, calldata: Hex): Hex =>
    encodeFunctionData({
      abi: moduleAbi,
      functionName: 'execute',
      args: [
        chainGrant(grant, [...rt.localAssets]),
        calldata,
        packSafeSignatures(grant.approvals, grant.draft),
      ],
    });
  const findGrant = (intentId: string): ExecutionGrant | null => {
    const grant = raw()
      .snapshot()
      .grants.find((g) => g.grant.intentId === intentId)?.grant;
    return grant ? raw().grantState(grant.grantId).grant : null;
  };
  const lifecycle = (intentId: string | null) =>
    intentId ? steps(raw().lifecycle(intentId)) : [];

  /** Re-sends the journaled bytes only when the node has never seen them; identical bytes cannot execute twice. */
  const reconcileJournaled = async (grantId: Hex): Promise<JournalEntry> => {
    let entry = await rt.broadcaster.reconcile(grantId);
    if (
      ['SIGNED', 'SUBMITTED', 'RECONCILIATION_REQUIRED'].includes(entry.state)
    ) {
      if (!(await rt.chain.transactionKnown(entry.transactionHash))) {
        guard();
        try {
          await rt.chain.sendRawTransaction(entry.rawTransaction);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          if (
            !/already known|nonce too low|already imported|known transaction/i.test(
              message,
            )
          )
            throw error;
        }
      }
      entry = await rt.broadcaster.reconcile(grantId);
    }
    return entry;
  };

  return {
    async attestEvidence({ intent: rawIntent, risk: rawRisk, calldata }) {
      return classify(async () => {
        const intent = BoundActionIntentSchema.parse(rawIntent);
        const risk = RiskPacketSchema.parse(rawRisk);
        if (artifactHash(risk) !== intent.riskPacketHash)
          invalid('risk packet hash mismatch');
        if (artifactHash(risk.evidence) !== intent.evidenceHash)
          invalid('evidence hash mismatch');
        if (keccak256(calldata) !== intent.calldataHash)
          invalid('calldata hash mismatch');
        const simulation = await rt.simulator.simulate(intent, calldata);
        await rt.kernel.mutate((k) =>
          k.attestEvidence({
            riskPacketHashes: [artifactHash(risk)],
            simulationHashes: [artifactHash(simulation)],
          }),
        );
        return { simulation };
      });
    },

    async authorize({ intent, risk, simulation, approvals }) {
      return classify(async (): Promise<DecisionView> => {
        const intentId = canonicalIntentId(
          BoundActionIntentSchema.parse(intent),
        );
        const state = raw().lifecycle(intentId).at(-1)?.to;
        if (state && AFTER_AUTHORIZATION.includes(state)) {
          const grant = findGrant(intentId);
          if (!grant)
            refused('NONCE_REPLAY', 'authorized intent without a grant');
          return {
            status: 'AUTHORIZED',
            intentId,
            intentHash: grant.intentHash,
            grantId: grant.grantId,
            validUntil: grant.validUntil,
            draft: grant.draft,
            grant,
            requiredApprovals: grant.draft.requiredApprovals,
            lifecycle: lifecycle(intentId),
          };
        }
        const decision = await rt.kernel.authorize({
          intent,
          risk,
          simulation,
          approvals,
        });
        const base = {
          intentId: decision.intentId,
          intentHash: decision.intentHash,
          lifecycle: lifecycle(decision.intentId),
        };
        if (decision.status === 'AUTHORIZED')
          return {
            ...base,
            status: 'AUTHORIZED',
            intentId: decision.intentId!,
            intentHash: decision.intentHash!,
            grantId: decision.grant.grantId,
            validUntil: decision.grant.validUntil,
            draft: decision.draft,
            grant: decision.grant,
            requiredApprovals: decision.requiredApprovals,
          };
        if (decision.status === 'PENDING_APPROVAL')
          return {
            ...base,
            status: 'PENDING_APPROVAL',
            code: decision.code,
            draft: decision.draft,
            requiredApprovals: decision.requiredApprovals,
          };
        return { ...base, status: decision.status, code: decision.code };
      });
    },

    async registerDraft({ draft }) {
      try {
        await rt.approvals.registerKernelDraft(draft);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== 'DRAFT_EXISTS') {
          if (code === 'DRAFT_INVALID')
            invalid(String((error as Error).message));
          throw error;
        }
        const existing = await rt.approvals.quorum(draft.digest);
        if (existing.draftStatus !== 'PENDING') refused('DRAFT_INVALIDATED');
      }
      return { draftDigest: draft.digest };
    },

    async readQuorum({ draftDigest }): Promise<QuorumSummary> {
      const q = await rt.approvals.quorum(draftDigest);
      return {
        draftDigest: q.draftDigest,
        draftStatus: q.draftStatus,
        required: q.required,
        satisfied: q.satisfied,
        counted: q.counted,
      };
    },

    async claimAndPrepare({ grantId, intent, calldata }) {
      await faults.reach('before-activity', grantId);
      guard();
      return classify(async (): Promise<PreparedView> => {
        let record = raw().grantState(grantId);
        await assertActive(record.grant.groupId);
        if (keccak256(calldata) !== record.grant.calldataHash)
          invalid('calldata does not match grant');
        if (record.state === 'RESERVED')
          await rt.kernel.mutate((k) =>
            k.claimForExecution(record.grant, intent, rt.workerId),
          );
        record = raw().grantState(grantId);
        if (record.state === 'CONSUMED') {
          const claim = record.claim!;
          await rt.kernel.mutate((k) =>
            prepareModuleCall(k, claim, calldata, [...rt.localAssets]),
          );
          record = raw().grantState(grantId);
        }
        if (
          record.state === 'PREPARED' &&
          record.preparedCallHash !==
            keccak256(moduleCall(record.grant, calldata))
        )
          refused('PREPARED_CALL_MISMATCH');
        return {
          grantId,
          preparedCallHash: record.preparedCallHash ?? ('0x' as Hex),
          reservation: reservation(grantId),
          lifecycle: lifecycle(record.grant.intentId),
        };
      });
    },

    async signAndSubmit({ grantId, calldata }) {
      guard();
      return classify(async () => {
        if (journal.get(grantId))
          return txView(await reconcileJournaled(grantId));
        const record = raw().grantState(grantId);
        await assertActive(record.grant.groupId);
        if (record.state !== 'PREPARED' || !record.claim)
          refused('GRANT_NOT_PREPARED', record.state);
        const claim: GrantClaim = record.claim;
        const data = moduleCall(record.grant, calldata);
        if (keccak256(data) !== record.preparedCallHash)
          refused('PREPARED_CALL_MISMATCH');
        heartbeat('building');
        const tx = await rt.chain.buildTransaction(
          { to: rt.module, data },
          rt.executor.address,
        );
        const signed = await signGrantBoundTransaction(
          record.grant,
          tx,
          rt.executor,
          await rt.chain.now(),
          [...rt.localAssets],
        );
        const transactionHash = keccak256(signed);
        await rt.kernel.mutate((k) =>
          k.recordSubmission(claim, transactionHash),
        );
        heartbeat('submitting');
        const entry = await rt.kernel.mutate((k) =>
          submitGrantTransaction(k, claim, rt.broadcaster, {
            schemaVersion: 1,
            grantId,
            transactionHash,
            rawTransaction: signed,
            state: 'SIGNED',
            chainId: rt.chainId as JournalEntry['chainId'],
            blockNumber: null,
          }),
        );
        return txView(entry);
      });
    },

    async checkSubmission({ grantId }): Promise<SubmissionCheck> {
      return classify(async () => {
        if (!journal.get(grantId)) return { status: 'NOT_SUBMITTED', grantId };
        guard();
        return {
          status: 'JOURNALED',
          tx: txView(await reconcileJournaled(grantId)),
        };
      });
    },

    async confirmInclusion({ grantId }) {
      guard();
      return classify(async () => {
        const started = Date.now();
        const budget = Context.current().info.startToCloseTimeoutMs * 0.8;
        for (;;) {
          heartbeat('confirming');
          const entry = await reconcileJournaled(grantId);
          if (CONFIRMED_OR_LATER.includes(entry.state)) {
            await faults.reach('after-confirm-before-db', grantId);
            return txView(entry);
          }
          if (Date.now() - started > budget) return txView(entry);
          await new Promise((r) => setTimeout(r, poll));
        }
      });
    },

    async indexObservation({ grantId }) {
      return classify(async () => {
        const entry = entryOf(grantId);
        if (!CONFIRMED_OR_LATER.includes(entry.state))
          invalid(`not confirmed: ${entry.state}`);
        const receipt = await rt.chain.receipt(entry.transactionHash);
        if (!receipt) throw new Error('RECEIPT_UNAVAILABLE');
        const observation = observeGrantExecution(
          receipt,
          rt.module,
          rt.chainId,
        );
        if (!(await rt.index.grantIndexed(grantId, entry.transactionHash)))
          throw ApplicationFailure.retryable(
            'GrantExecuted not yet in the read model',
            'NOT_YET_INDEXED',
          );
        const indexed =
          entry.state === 'CONFIRMED'
            ? journal.update(grantId, {
                state: 'INDEXED',
                blockNumber: entry.blockNumber,
                ...(entry.outcome ? { outcome: entry.outcome } : {}),
              })
            : entry;
        return { tx: txView(indexed), observation };
      });
    },

    async reconcileGrant({ grantId, observation }) {
      await faults.reach('before-reconciliation', grantId);
      return classify(async () => {
        const entry = entryOf(grantId);
        const receipt = await rt.chain.receipt(entry.transactionHash);
        if (!receipt) throw new Error('RECEIPT_UNAVAILABLE');
        const observed: GrantExecutionObservation = observeGrantExecution(
          receipt,
          rt.module,
          rt.chainId,
        );
        if (observed.transactionHash !== observation.transactionHash)
          throw ApplicationFailure.nonRetryable(
            'observation does not match the journal',
            'RECONCILIATION_MISMATCH',
          );
        const state = raw().grantState(grantId).state;
        if (
          state !== 'RECONCILED' &&
          !(state === 'REVERTED' && observed.receiptStatus === 'reverted')
        )
          await rt.kernel.mutate((k) => k.reconcile(grantId, observed));
        const after = entryOf(grantId);
        const reconciled =
          after.state === 'INDEXED'
            ? journal.update(grantId, {
                state: 'RECONCILED',
                blockNumber: after.blockNumber,
                ...(after.outcome ? { outcome: after.outcome } : {}),
              })
            : after;
        return { tx: txView(reconciled), reservation: reservation(grantId) };
      });
    },

    async settle({ grantId }) {
      return classify(async () => {
        const entry = entryOf(grantId);
        if (raw().grantState(grantId).state !== 'RECONCILED')
          refused('NOT_RECONCILED');
        const settled =
          entry.state === 'RECONCILED'
            ? journal.update(grantId, {
                state: 'SETTLED',
                blockNumber: entry.blockNumber,
                ...(entry.outcome ? { outcome: entry.outcome } : {}),
              })
            : entry;
        if (settled.state !== 'SETTLED')
          refused('NOT_SETTLEABLE', settled.state);
        const receipt = await rt.chain.receipt(settled.transactionHash);
        if (!receipt) throw new Error('RECEIPT_UNAVAILABLE');
        const result = {
          tx: txView(settled),
          reservation: reservation(grantId),
          observation: observeGrantExecution(receipt, rt.module, rt.chainId),
        };
        await faults.reach('after-reconciliation-before-completion', grantId);
        return result;
      });
    },

    async reservationStatus({ grantId }) {
      return classify(async () => reservation(grantId));
    },

    async releaseExpiredReservation({ grantId }) {
      return classify(async () => {
        await rt.kernel.mutate((k) => k.releaseExpired());
        return reservation(grantId);
      });
    },

    async autonomyStatus({ groupId }) {
      const status = await rt.freeze.status(groupId);
      return { frozen: status.frozen, reason: status.reason };
    },
  };
}
