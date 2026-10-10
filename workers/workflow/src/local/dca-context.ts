import { slotOf, parseDcaPolicy } from '@synq/strategy-engine';
import type { DcaContextSource } from '../activities/dca-engine.js';
import type { FileTickStore } from '../activities/strategy.js';
import type { LocalWorkflowManifest } from './manifest.js';

/**
 * Local-anvil read model for the strategy engine. Each recorded EXECUTE tick is a pending lot of the policy's base
 * tranche (the policy pins maxTranche to baseTranche, so this never under-counts), the Kernel's remaining mandate
 * budget is the free balance, and the venue is the local transfer path with no position to allocate against.
 */
export function localDcaContext(
  manifest: LocalWorkflowManifest,
  ticks: Pick<FileTickStore, 'all'>,
  policies: Readonly<Record<string, unknown>>,
): DcaContextSource {
  return {
    async context({ strategy, state }) {
      const raw = policies[strategy.strategyId];
      if (raw === undefined) return null;
      const policy = parseDcaPolicy(raw);
      if (
        policy.maxTranche !== policy.baseTranche ||
        policy.budgetAsset.address !== manifest.token.toLowerCase()
      )
        return null;
      const executions = ticks
        .all()
        .filter(
          (t) =>
            t.strategyId === strategy.strategyId &&
            t.decision === 'EXECUTE' &&
            t.childWorkflowId !== null,
        )
        .map((t) => {
          const at = Math.floor(Date.parse(t.recordedAt) / 1000);
          return {
            slot: slotOf(policy, at),
            intentId: t.childWorkflowId!.replace(/^synq\.action\./, ''),
            at,
            amountIn: policy.baseTranche,
            status: 'PENDING' as const,
          };
        });
      return {
        policy: raw,
        treasury: {
          freeBudgetAsset: state.remainingBudget,
          totalValueInBudgetAsset: manifest.mandate.cumulativeBudget,
          targetPositionValueInBudgetAsset: '0',
        },
        history: { executions },
        market: {
          venue: policy.venue,
          assetIn: policy.budgetAsset.address,
          assetOut: policy.targetAsset.address,
          change24hBps: 0,
          venueHealthy: true,
          liquidityMaxInput: policy.budget,
          sourcesConflict: false,
        },
      };
    },
  };
}
