# Synq Kernel

Deterministic authorization. Agents propose; only this policy authorizes. The Kernel has no model and no signer dependency. Its clock is injected and must never move backwards.

| Module | Responsibility |
|---|---|
| `canonical.ts` | `IntentCanonicalizer`: the stable `intentId`, `intentHash` and economic hash (§36.2) |
| `mandates.ts` | `MandateResolver`: tuple keys, versions, widening or security-sensitive supersession, terminal revocation, on-chain mapping |
| `policy.ts` | `PolicyEngine`: the typed `PolicyResult` and AUTO/REVIEW/CONSENSUS/BLOCKED tiers |
| `freshness.ts` | `FreshnessGate` with the `FreshnessProbe` and `DirectVerifier` ports (§20, SEC-006). Both modes carry pause, mandate status/version/minimum valid version, Safe owners and threshold, and refuse through one rule set (`assertAccountState`); approvals from signers that are not current Safe owners are rejected. |
| `risk.ts` | `RiskGate` (quotes, evidence, minimum output, allocation) and `SimulationGate` |
| `approvals.ts` | `ApprovalCalculator` (ADR-0011) over the `ApprovalLedger`, `MembershipDirectory` and `DelegationEvaluator` ports |
| `grants.ts` | `GrantIssuer` (`GrantDraft`, then `ExecutionGrant`) and `GrantVerifier` |
| `ledger.ts` | Budgets, treasury reservations, nonces, claim, prepare, reconciliation and release |
| `audit.ts` | `AuditRecorder`: an append-only decision log, HMAC-SHA256-linked when `auditKey` is set, with an optional sink. A sink that exposes `head()` anchors restores |
| `lifecycle.ts` | §11 `ACTION_MACHINE` transitions via `recordTransition` |
| `snapshot.ts` | Snapshot and verified restore |
| `decisions.ts` | Authorization request and decision types, refusal payload and decision shaping |
| `nonce-status.ts` | `NonceStatusReader` port and the echo-checked nonce status read |
| `hedge-policy.ts` | `HedgePolicy` (hedge mandate, `HedgeIntent`, close-only fallback, leverage/notional/ratio/liquidation-buffer/collateral caps) and `HedgeGrantAuthority` (one-time HMAC-bound grants the Perpl executor verifies). No hedge kind can withdraw or transfer. |
| `kernel.ts` | Orchestration. Authorizations run one at a time, and the mandate and ledger are rechecked after every await. |

## Flow
1. Call `authorize({intent, risk, simulation, approvals: []})`. It returns `PENDING_APPROVAL` with a deterministic `draft`.
2. Members sign `executionGrantTypedData(draft.domain, draft.grant)` (from `@synq/schemas`) through identity challenges, which produce `VerifiedApproval`s.
3. Call `authorize({..., approvals})`. It returns `AUTHORIZED` with a grant whose `grantId` is the EIP-712 digest that `ExecutionModule.hashGrant` returns.
4. The worker calls `claimForExecution(grant, intent, workerId)`, then `prepareModuleCall(kernel, claim, data)` once, then `signGrantBoundTransaction`, then `submitGrantTransaction(kernel, claim, broadcaster, entry)` (`@synq/execution-worker`). That call runs `recordSubmission(claim, keccak256(raw))` before it broadcasts.
5. Call `reconcile(grantId, observeGrantExecution(receipt, module, chainId))`.

## Integrity and release
- `auditKey` (at least 32 bytes) keys the audit chain. Load it with `loadKernelAuditKey([dataDirs])` from `@synq/execution-worker` (env `SYNQ_KERNEL_AUDIT_KEY_FILE`). Non-local profiles refuse to construct a Kernel without it.
- `Kernel.restore` needs the same key or an `AuditSink` that exposes `head()`. If a sink is configured, the snapshot's head must equal `sink.head()`. Otherwise the restore fails with `AUDIT_CHAIN_BROKEN`.
- `nonceStatus` must echo `{chainId, module, account, nonce, intentHash}`. A mismatched, malformed or failing reply refuses the release. Release also requires `blockTimestamp >= validUntil` and neither the nonce nor the intent used. `RpcNonceStatusReader` (`@synq/read-model/kernel`) reads at `head - confirmationDepth + 1`.

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
