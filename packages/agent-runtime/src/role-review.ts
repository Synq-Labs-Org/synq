import {
  canonicalBigInt,
  type CapabilityAction,
  type ModelRole,
  type RoleReview,
  type WorldModelSnapshot,
} from '@synq/schemas';
import type { CapabilityGraph } from '@synq/world-model';
import type {
  ActionDraft,
  IntentItem,
  MandateDraft,
} from './pipeline/model-output.js';

export type EconomicDraft = ActionDraft | MandateDraft;
export const ROLE_ROUTE: Readonly<Record<EconomicDraft['action'], ModelRole>> =
  {
    TRANSFER: 'FUNDING',
    CROSS_CHAIN_FUND: 'FUNDING',
    SPOT_TRADE: 'TRADING',
    PERP_HEDGE: 'RISK',
    CARD_PAYMENT: 'COMMERCE',
    X402_PAYMENT: 'COMMERCE',
  };
const VENUE_ACTION: Readonly<
  Record<EconomicDraft['action'], CapabilityAction>
> = {
  TRANSFER: 'TRANSFER',
  CROSS_CHAIN_FUND: 'FUND',
  SPOT_TRADE: 'TRADE',
  PERP_HEDGE: 'TRADE',
  CARD_PAYMENT: 'TRANSFER',
  X402_PAYMENT: 'TRANSFER',
};
export const MAX_REVIEW_SLIPPAGE_BPS = 500;

export function isEconomic(item: IntentItem): item is EconomicDraft {
  return item.kind === 'ACTION' || item.kind === 'MANDATE';
}

export function routeDrafts(
  items: readonly IntentItem[],
): Map<ModelRole, number[]> {
  const routed = new Map<ModelRole, number[]>();
  items.forEach((item, i) => {
    if (!isEconomic(item)) return;
    const role = ROLE_ROUTE[item.action];
    routed.set(role, [...(routed.get(role) ?? []), i]);
  });
  return routed;
}

type Check = RoleReview['checks'][number];
const units = (raw: string) => canonicalBigInt(raw);

export function roleChecks(
  role: ModelRole,
  draft: EconomicDraft,
  itemIndex: number,
  world: WorldModelSnapshot,
  graph: CapabilityGraph,
): Check[] {
  const check = (name: string, ok: boolean, detail: string): Check => ({
    itemIndex,
    name,
    ok,
    detail: detail.slice(0, 300),
  });
  if (role === 'COMMERCE')
    return [
      check(
        'commerce_phase',
        false,
        'UNAVAILABLE_IN_PHASE: commerce rails are delivered with P11',
      ),
    ];
  const verdict = graph.canPerform(
    VENUE_ACTION[draft.action],
    world.network.value.profile,
    draft.providerId,
  );
  const venue = check(
    role === 'FUNDING' ? 'funding_capability' : 'venue_capability',
    verdict.availability === 'AVAILABLE' ||
      verdict.availability === 'REQUIRES_HUMAN',
    `${verdict.availability}: ${verdict.reason}`,
  );
  const checks = [venue];
  if (role === 'TRADING' && draft.kind === 'MANDATE') {
    const tranche = units(draft.perActionCap.baseUnits);
    const budget = units(draft.cumulativeBudget.baseUnits);
    checks.push(
      check(
        'tranche_within_budget',
        tranche !== null &&
          budget !== null &&
          tranche > 0n &&
          tranche <= budget,
        'per-tranche cap must be positive and within the cumulative budget',
      ),
      check(
        'cadence_set',
        draft.cadenceSeconds !== null && draft.cadenceSeconds > 0,
        'a gradual strategy needs a positive cadence',
      ),
      check(
        'slippage_bounded',
        draft.maxSlippageBps >= 0 &&
          draft.maxSlippageBps <= MAX_REVIEW_SLIPPAGE_BPS,
        `slippage must be at most ${MAX_REVIEW_SLIPPAGE_BPS} bps`,
      ),
    );
  }
  if (role === 'RISK') {
    const risk = world.riskState;
    checks.push(
      check(
        'risk_state_healthy',
        risk.value.status === 'HEALTHY' && risk.meta.freshness === 'FRESH',
        `risk ${risk.value.status}, ${risk.meta.freshness}`,
      ),
    );
  }
  if (role === 'FUNDING') {
    const token = draft.kind === 'ACTION' ? draft.token : draft.inputToken;
    const amount = units(
      draft.kind === 'ACTION'
        ? draft.amount.baseUnits
        : draft.cumulativeBudget.baseUnits,
    );
    const position = world.treasury.value.find(
      (p) => 'address' in p.asset && p.asset.address === token.toLowerCase(),
    );
    checks.push(
      check(
        'within_free_treasury',
        amount !== null &&
          position !== undefined &&
          amount <= BigInt(position.free),
        position
          ? `free ${position.free} base units (${world.treasury.meta.freshness})`
          : 'token not held by the treasury',
      ),
    );
  }
  return checks;
}

export function roleBlocks(
  reviews: readonly RoleReview[],
  itemIndex: number,
): string | null {
  for (const r of reviews) {
    if (!r.itemIndexes.includes(itemIndex)) continue;
    if (r.outcome !== 'OK') return `${r.role} ${r.outcome}`;
    const failed = r.checks.find((c) => c.itemIndex === itemIndex && !c.ok);
    if (failed)
      return `${r.role} check ${failed.name} failed: ${failed.detail}`;
    const v = r.verdicts.find((x) => x.itemIndex === itemIndex);
    if (!v) return `${r.role} returned no verdict`;
    if (v.verdict !== 'PROCEED') return `${r.role} ${v.verdict}: ${v.notes}`;
  }
  return null;
}
