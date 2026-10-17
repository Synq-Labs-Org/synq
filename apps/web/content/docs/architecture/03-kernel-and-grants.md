---
title: Kernel and grants
description: The deterministic authorization layer and the grants it issues.
---

The Kernel (`packages/kernel`) is deterministic authorization. **Agents propose; only this policy authorizes.** It has no model and no signer dependency, and its clock is injected and must never move backwards. `scripts/architecture.mjs` fails the build if `kernel`, `domain` or `schemas` import a model SDK, a plugin or any signing primitive.

## Modules

| Module                           | Responsibility                                                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canonical.ts`                   | The canonical intent: stable `intentId`, `intentHash` and economic hash                                                                                                                                                    |
| `mandates.ts`                    | Mandate resolver: versions, widening versus security-sensitive supersession, terminal revocation, mapping to the on-chain registry                                                                                         |
| `policy.ts`                      | Policy engine and its tiers `AUTO`, `REVIEW`, `CONSENSUS`, `BLOCKED`                                                                                                                                                       |
| `freshness.ts`                   | Freshness gate with a probe and a direct verifier: pause, mandate status and version, Safe owners and threshold are re-read and any mismatch refuses; approvals from signers that are not current Safe owners are rejected |
| `risk.ts`, `risk-attestation.ts` | Risk gate (quotes, evidence, minimum output, allocation), simulation gate, and the stablecoin attestation reader                                                                                                           |
| `approvals.ts`                   | Approval calculator over a ledger, a membership directory and a delegation evaluator                                                                                                                                       |
| `grants.ts`                      | `GrantIssuer` (draft, then execution grant) and `GrantVerifier`                                                                                                                                                            |
| `ledger.ts`                      | Budgets, treasury reservations, nonces, claim, prepare, reconcile and release                                                                                                                                              |
| `audit.ts`                       | Append-only decision log, HMAC-linked when an audit key is set, with optional external sink                                                                                                                                |
| `lifecycle.ts`                   | The action state machine and its transitions                                                                                                                                                                               |
| `snapshot.ts`                    | Snapshot and verified restore                                                                                                                                                                                              |
| `nonce-status.ts`                | A nonce status reader whose reply must echo `{chainId, module, account, nonce, intentHash}`                                                                                                                                |
| `hedge-policy.ts`                | Hedge mandates and one-time grants for the legacy perps executor; no hedge kind can withdraw or transfer                                                                                                                   |
| `kernel.ts`                      | Orchestration. Authorizations run one at a time and the mandate and ledger are rechecked after every await                                                                                                                 |

## Two grant families

### 1. Mandate and module grants (EIP-712)

For groups on the mandate stack, the Kernel returns `PENDING_APPROVAL` with a deterministic draft. Members sign `executionGrantTypedData` through identity challenges, producing verified approvals. The Kernel then returns `AUTHORIZED` with a grant whose `grantId` is the EIP-712 digest that `ExecutionModule.hashGrant` returns. The worker claims the grant, submits `ExecutionModule.execute` and reconciles the `GrantExecuted` event. See [ExecutionModule](/docs/contracts/execution-module) and [MandateRegistry](/docs/contracts/mandate-registry).

The mapping from a Kernel mandate to the on-chain `MandateConfig` (`toMandateConfig`): `artifactHash(mandate)` to `mandateHash`; input asset address to `token`; per-action and native caps to `maxTokenPerAction` and `maxNativePerAction`; budgets to the cumulative caps; validity window to `validAfter`/`validUntil`; the deduplicated (target, selector) pairs to the call allowlist; recipients to the recipient allowlist. The on-chain mandate id is `keccak256(abi.encode(groupId, mandateId))`. Plugin and action bindings, tiers, approval policy, slippage, allocation, leverage, TTLs, frequency and execution count are enforced only by the Kernel.

### 2. Arc payment authority (`arc-authority.ts`)

For Arc workspaces and vaults the authority is a **payment mandate signed by its human owner** (EIP-712 with the Arc chain id): payer account, asset, recipient allowlist, allowed purposes, per-action cap, rolling period budget, validity window. Nothing else creates authority. `decide` evaluates one payment intent and returns `ALLOW`, `REQUIRE_OWNER_APPROVAL` or `DENY` (see [Anatomy of a money move](/docs/architecture/money-move)).

An `ALLOW` yields an **execution grant**:

| Field                                              | Meaning                                                                                                                                   |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `grantId`, `intentId`                              | Identifiers                                                                                                                               |
| `mandateId`, `mandateVersion`, `mandateHash`       | Which mandate version authorized it                                                                                                       |
| `chainId`, `token`, `payer`, `recipient`, `amount` | The exact transfer                                                                                                                        |
| `actionHash`                                       | keccak of chain, token, payer, recipient and amount                                                                                       |
| `executionCallHash`                                | keccak of the exact call (target, value, calldata) when the call is not a plain transfer, for example a vault `pay` or an Amane `execute` |
| `operator`                                         | The executor identity allowed to use it                                                                                                   |
| `nonce`, `issuedAt`, `expiresAt`                   | One use, short expiry                                                                                                                     |
| `issuedByKernel`, `mac`                            | HMAC-SHA256 under the Kernel's grant key                                                                                                  |

Executors call `verifyGrant` and `admitGrant`: the MAC must match (compared in constant time), the grant must be unexpired, its mandate not revoked, the call about to be signed must hash to the same action and call hashes, and its nonce (or the whole grant, with a durable fence) is consumed exactly once. A mutated recipient, a replay, a stale grant or a revoked mandate never runs.

Other decisions in the same file: `decideVaultCreation` and `admitVaultCreationGrant` for creating a vault, `decideWorkspaceSafeAction` for owner-quorum Safe actions, and [`decideAmaneLeasedPay`](/docs/amane/integration) for payments under an Amane lease. Escrow purposes (`ESCROW_FUNDING`, `ESCROW_RELEASE`, `ESCROW_REFUND`) are kept apart from the payment purposes so agent proposals cannot name them; escrow intents are built only from a mutually signed Deal Room agreement.

## Integrity and release

- The audit key (at least 32 bytes, from `SYNQ_KERNEL_AUDIT_KEY_FILE`) keys the audit chain. Non-local profiles refuse to build a Kernel without it. `Kernel.restore` needs the same key or an audit sink that exposes its head; a mismatch fails with `AUDIT_CHAIN_BROKEN`.
- A grant is released back to the budget only when the nonce status read proves it was not used and the grant's `validUntil` has passed on chain time.
- Authorization is serial: the Kernel never interleaves two authorizations and rechecks the mandate and ledger after every await.

## What the Kernel does not do

It never signs, never calls a model, never trusts a planner's description of risk (risk flags come from deterministic engines), and never moves money. It decides, and it remembers why.
