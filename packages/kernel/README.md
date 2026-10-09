# Synq Kernel

Deterministic authorization. Agents propose; only this policy authorizes. The Kernel has no model and no signer dependency. Its clock is injected and must never move backwards.

| Module | Responsibility |
|---|---|
| `canonical.ts` | `IntentCanonicalizer`: the stable `intentId`, `intentHash` and economic hash (§36.2) |
| `mandates.ts` | `MandateResolver`: tuple keys, versions, widening or security-sensitive supersession, terminal revocation, on-chain mapping |
| `policy.ts` | `PolicyEngine`: the typed `PolicyResult` and AUTO/REVIEW/CONSENSUS/BLOCKED tiers |
| `freshness.ts` | `FreshnessGate` with the `FreshnessProbe` and `DirectVerifier` ports (§20, SEC-006) |
| `risk.ts` | `RiskGate` (quotes, evidence, minimum output, allocation) and `SimulationGate` |
| `approvals.ts` | `ApprovalCalculator` (ADR-0011) over the `ApprovalLedger`, `MembershipDirectory` and `DelegationEvaluator` ports |
| `grants.ts` | `GrantIssuer` (`GrantDraft`, then `ExecutionGrant`) and `GrantVerifier` |
| `ledger.ts` | Budgets, treasury reservations, nonces, claim, prepare, reconciliation and release |
| `audit.ts` | `AuditRecorder`: an append-only, hash-linked decision log with an optional sink |
| `lifecycle.ts` | §11 `ACTION_MACHINE` transitions via `recordTransition` |
| `snapshot.ts` | Snapshot and verified restore |
| `kernel.ts` | Orchestration. Authorizations run one at a time, and the mandate and ledger are rechecked after every await. |

## Flow
1. Call `authorize({intent, risk, simulation, approvals: []})`. It returns `PENDING_APPROVAL` with a deterministic `draft`.
2. Members sign `executionGrantTypedData(draft.domain, draft.grant)` (from `@synq/schemas`) through identity challenges, which produce `VerifiedApproval`s.
3. Call `authorize({..., approvals})`. It returns `AUTHORIZED` with a grant whose `grantId` is the EIP-712 digest that `ExecutionModule.hashGrant` returns.
4. The worker calls `claimForExecution(grant, intent, workerId)`, then `prepareModuleCall(kernel, claim, data)` once, then `signGrantBoundTransaction`.
5. Call `reconcile(grantId, observeGrantExecution(receipt, module, chainId))`.

## Mapping a mandate to the on-chain MandateRegistry
`toMandateConfig(mandate)` builds the on-chain `MandateConfig` as follows.

| Kernel mandate | On-chain `MandateConfig` |
|---|---|
| `artifactHash(mandate)` | `mandateHash` |
| `inputAsset.address` | `token` |
| `perActionCap`, `maxNativeValue` | `maxTokenPerAction`, `maxNativePerAction` |
| `cumulativeBudget`, `cumulativeNativeBudget` | `cumulativeTokenCap`, `cumulativeNativeCap` |
| `validAfter`, `validUntil` | `validAfter`, `validUntil` |
| (target, selector) pairs from `bindings`, deduplicated | `callTargets`, `callSelectors` |
| `recipients[].address` | `recipients` |

Fields that only the Kernel enforces:
- plugin and action in `bindings`
- tiers
- approval policy
- slippage
- allocation
- leverage
- TTLs
- frequency
- execution count

Identifiers:
- `mandateId` on chain is `keccak256(abi.encode(groupId, mandateId))` (`onchainMandateId`).
- `pluginId` on chain is `keccak256(pluginId)`.
- `chainGroupId` is the group id that `SynqGroupFactory` assigns.
- `operators` are passed to `module.setExecutor`.
- `members` are the Safe owners.
- `approvalPolicy.accountThreshold` is the Safe threshold.

Supersession follows the contract's rules. A non-sensitive supersession must only widen the mandate. A narrowing must be security-sensitive, which invalidates earlier grants.
