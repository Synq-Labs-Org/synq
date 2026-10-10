import { Context } from '@temporalio/activity';
import { encodeFunctionData, type Address } from 'viem';
import type { DurableKernel } from '@synq/api/kernel-runtime';
import type { JournaledBroadcaster } from '@synq/execution-worker';
import { moduleAbi } from '@synq/execution-worker/abi';
import type { AutonomyFreezePort } from './economic.js';
import type {
  Hex,
  OperationsActivities,
  ReconciliationSweep,
} from './types.js';

export type OperationsRuntime = {
  broadcaster: JournaledBroadcaster;
  kernel: DurableKernel;
  freeze: AutonomyFreezePort;
  module: Address;
  /** Safe account for a group; owners sign the pause through the Safe, never the worker. */
  accountOf(groupId: string): Promise<Address>;
  modulePaused(account: Address): Promise<{ paused: boolean; block: bigint }>;
};

const OPEN = ['SIGNED', 'SUBMITTED', 'INCLUDED', 'RECONCILIATION_REQUIRED'];

export function createOperationsActivities(
  rt: OperationsRuntime,
): OperationsActivities {
  return {
    async sweepJournal(): Promise<ReconciliationSweep> {
      const journal = rt.broadcaster.journal;
      const result: ReconciliationSweep = {
        checked: 0,
        confirmed: [],
        unresolved: [],
        released: 0,
      };
      for (const grantId of journal.grantIds()) {
        const entry = journal.get(grantId);
        if (!entry || !OPEN.includes(entry.state)) continue;
        result.checked++;
        try {
          Context.current().heartbeat(grantId);
        } catch {
          void 0;
        }
        const after = await rt.broadcaster.reconcile(grantId);
        (after.state === 'CONFIRMED'
          ? result.confirmed
          : result.unresolved
        ).push(grantId as Hex);
      }
      result.released = await rt.kernel.mutate((k) => k.releaseExpired());
      return result;
    },
    async freezeAutonomy({ groupId, reason, incidentId }) {
      const { since } = await rt.freeze.freeze(groupId, reason, incidentId);
      return { frozen: true, since };
    },
    async unfreezeAutonomy({ groupId, incidentId }) {
      await rt.freeze.unfreeze(groupId, incidentId);
      return { frozen: (await rt.freeze.status(groupId)).frozen };
    },
    async prepareSafePause({ groupId }) {
      return {
        safe: (await rt.accountOf(groupId)).toLowerCase() as Hex,
        to: rt.module.toLowerCase() as Hex,
        data: encodeFunctionData({ abi: moduleAbi, functionName: 'pause' }),
      };
    },
    async observeOnchainPause({ groupId }) {
      const observed = await rt.modulePaused(await rt.accountOf(groupId));
      return { paused: observed.paused, block: observed.block.toString() };
    },
  };
}
