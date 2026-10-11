# @synq/strategy-engine

Deterministic DCA `StrategyEvaluator` (Bible §23). The model writes or revises a strategy; this package evaluates ordinary triggers with no model call, no I/O and no clock of its own (`now` is an input). The output is `EXECUTE`, `SKIP` or `ESCALATE`. `ESCALATE` wakes the risk and strategy agents. The evaluator never authorizes anything: an `EXECUTE` still becomes an `ActionIntent` that the Kernel checks against the mandate, a live quote, the AUSD risk attestation and simulation.

## Units
- Amounts are `bigint` in the budget asset's raw units (AUSD has 6 decimals).
- Prices are 1e18 fixed point, in budget asset per one whole target unit (AUSD per MON).
- Percentages are integer basis points.
- JSON callers pass bigints as canonical decimal strings.

## Inputs
- `policy` (`DcaPolicySchema`):
  - schedule: `strategyId`, `startAt`, `expiresAt`, `frequencySeconds`
  - assets and venue: `budgetAsset`, `targetAsset`, `allowedAssets`, `venue`, `allowedVenues`
  - tranche: `baseTranche`, `maxTranche`, `minTranche`
  - caps: `budget`, `maxDeployment`, `maxAllocationBps`, `maxSlippageBps`
  - triggers: `spike.skipIf24hChangeAboveBps`, `dip.{multiplierBps, triggerBelowTrailingBps}`, `escalateIfAbsMoveAboveBps` (default 2000), `maxMarketDataAgeSeconds`
  - `pause.{paused, pauseOnReferenceStatuses, pauseOnVenueUnhealthy}`
  - The schema rejects unknown fields, `maxTranche < baseTranche`, `minTranche > baseTranche`, `maxDeployment > budget`, `expiresAt <= startAt`, a venue or asset missing from its allowlist, and out-of-range bps.
- `market`:
  - `asOf`, `venue`, `assetIn`, `assetOut`, `price`, `trailingReferencePrice`, `change24hBps`
  - `venueHealthy`, `liquidityMaxInput` (the largest input the live quote or book fills within the slippage bound)
  - `referenceStatus`: the AUSD risk attestation, one of HEALTHY, DEGRADED, UNKNOWN or STALE
  - `sourcesConflict`
- `treasury`: `freeBudgetAsset` (net of reservations), `totalValueInBudgetAsset`, `targetPositionValueInBudgetAsset`.
- `history`: `executions[{slot, intentId, at, amountIn, status}]` and `exitedPrincipal`. PENDING and SETTLED spends both count, so pending money is never free. FAILED spends do not count.

## Rule order
The first rule that matches decides. `slot = floor((now - startAt) / frequencySeconds)` and `decisionId = "<strategyId>:<slot>"`.

1. `now >= expiresAt` gives SKIP `EXPIRED` (terminal). `now < startAt` gives SKIP `NOT_STARTED`.
2. `pause.paused` gives SKIP `PAUSED`.
3. If a non-failed execution already exists for this slot: SKIP `ALREADY_EXECUTED_IN_SLOT`. If the last non-failed execution is newer than `now - frequency`: SKIP `NOT_DUE`.
4. Venue and route checks:
   - The market venue is not in `allowedVenues`: ESCALATE `VENUE_NOT_ALLOWED`.
   - The market assets are not in `allowedAssets`: ESCALATE `ASSET_NOT_ALLOWED`.
   - The route is not the policy's venue/assetIn/assetOut: ESCALATE `MARKET_ROUTE_MISMATCH`.
5. Market data is in the future or older than `maxMarketDataAgeSeconds`: ESCALATE `STALE_MARKET_DATA`. `sourcesConflict`: ESCALATE `CONFLICTING_EVIDENCE`.
6. Venue unhealthy: SKIP `VENUE_UNHEALTHY_PAUSED` when `pauseOnVenueUnhealthy` is set, otherwise ESCALATE `VENUE_UNAVAILABLE`.
7. `referenceStatus` is not HEALTHY: SKIP `REFERENCE_<STATUS>_PAUSED` when the status is listed in `pauseOnReferenceStatuses`, otherwise ESCALATE `AUSD_RISK_<STATUS>`. The evaluator never executes without a HEALTHY AUSD reference.
8. `|change24hBps| >= escalateIfAbsMoveAboveBps`: ESCALATE `LARGE_MARKET_MOVE`.
9. `change24hBps > skipIf24hChangeAboveBps`: SKIP `SPIKE`. The comparison is strict, matching "skip if 24h change > 8%".
10. The tranche starts at `baseTranche`. If `price * 10000 <= trailing * (10000 - trigger)`, it becomes `min(base * multiplierBps / 10000, maxTranche)` (reason `DIP_MULTIPLIER`).
11. Caps are applied in this order. If a limit is below `minTranche`, the result is SKIP with that limit's reason. Otherwise the tranche is clamped and `<REASON>_CAPPED` is added.
    1. Remaining budget, `budget - settled - pending` (`BUDGET_EXHAUSTED`).
    2. Deployment capacity, `maxDeployment - (spent - exitedPrincipal)` (`MAX_DEPLOYMENT`).
    3. Allocation headroom, `floor(maxAllocationBps * total / 10000) - position` (`ALLOCATION_CAP`). A buy keeps the total treasury value constant.
    4. `freeBudgetAsset` (`INSUFFICIENT_FREE_BALANCE`).
12. If the tranche exceeds `liquidityMaxInput`, it is resized down (`LIQUIDITY_RESIZED`). If the liquidity is below `minTranche`, the result is ESCALATE `LOW_LIQUIDITY`.
13. EXECUTE with `tranche {amountIn, maxSlippageBps, venue, assetIn, assetOut, indicativeOutput, minOutputFloor, dipApplied}`.
    - `indicativeOutput = amountIn * 10^targetDecimals * 1e18 / (price * 10^budgetDecimals)`
    - `minOutputFloor = indicativeOutput * (10000 - maxSlippageBps) / 10000`
    - Both are indicative. The live quote at execution time and the Kernel's slippage floor govern.

## Workflow integration
`evaluateDcaActivity(input: unknown): DcaDecisionJson` is the Temporal Activity entrypoint. It parses JSON input (bigints as strings) and returns JSON-safe output. A DCA workflow evaluator port maps onto it directly:
- The workflow timer fires.
- An Activity assembles `{policy, market, treasury, history, now}` from the read model, the Kuru quote and the risk attestation reader.
- It calls `evaluateDcaActivity`.
- On EXECUTE it proposes an intent whose idempotency key is `decisionId`.
- On ESCALATE it wakes the agents.
- On SKIP it records the reason and waits for the next slot.

The in-process interface is `StrategyEvaluator.evaluate(input)` (`dcaEvaluator`).

`bibleSection23Example({ausd, mon, startAt})` builds the §23 compiled mandate (400 AUSD, kuru, base 25 AUSD weekly, spike 8%, dip 1.5x at -10%, max tranche 50 AUSD, 40% allocation, 75 bps). The caller supplies assets, so no address is hard-coded here.
