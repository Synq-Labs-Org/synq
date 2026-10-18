---
title: Vendored packages and SDK
description: The pinned Amane release in vendor/amane and the newer authority SDK interface.
---

## What is vendored

Amane is not yet published to npm and its repository is not public. Synq therefore vendors three local release tarballs in `vendor/amane` with a `MANIFEST.json` that pins the source commit and each tarball's SHA-256.

| Package         | Version | Role                                                                                                               |
| --------------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| `@amane/arc`    | 0.2.0   | Arc account artifacts (ABI, code), deployment verification (`verifyDeployment`), `ARC_USDC`                        |
| `@amane/policy` | 0.2.0   | Root policy, lease and action types, EIP-712 domain and hashes, `compilePolicy`, `validateAction`, `validateLease` |
| `@amane/verify` | 0.2.0   | `verifyExecution`, which proves a payment from the receipt                                                         |

| Tarball                  | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `amane-arc-0.2.0.tgz`    | `f6ec1d83cb1b058c9b10c808b20dc339be538e3d5bd1b2d7c2832b76b7665c7a` |
| `amane-policy-0.2.0.tgz` | `ae2b0fcc174163003c3478ed3fe6c6aebb6e02dbed7a15273bf02f9b02c2400f` |
| `amane-verify-0.2.0.tgz` | `70ae08acb096ff0ae16941e01eeefdb775d5696227d8460b8fadd3c72ac20436` |

The manifest also records the release source commit (`a60a90a`), the deployed contract source commit (`2b21f29`), the licence (MIT) and the scope: restricted singleton PAY on Arc testnet, everything else unsupported. `plugins/amane` exports the same pin as `AMANE_PIN`. Upgrading means re-vendoring tarballs, updating the manifest and the expected code hash, and re-running the Amane tests.

Not vendored: `@amane/core` and `@amane/sdk` 0.1.0 (the v1 types and SDK) and `@amane/cctp`, which Synq does not use.

## The release scope (0.2.0, restricted PAY)

The release manifest rates the overall gate set **PARTIAL**: it is an evidence-backed restricted Arc PAY release, not a full authority release. It supports a strict singleton PAY subset. SWAP, BRIDGE, ESCROW_FUND, multi-target clauses and delegated issuer scopes are unavailable, reimbursement is disabled, and CCTP helpers are unsigned preparation only. Synq enables only what is proven and keeps the rest disabled behind capability checks.

## The newer v3 authority interface (candidate)

A larger local candidate, **Amane full authority v3**, is specified in the SDK interface and release manifest handoffs. It is **not deployed and not adopted by Synq**: no live v3 address exists, no npm publication, and Synq keeps the verified 0.2 pin until an explicit migration.

What the v3 interface adds, as specified:

| Area       | Interface                                                                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Policy     | Full nested `RootPolicy`, `AgentLease` and `ActionIntent` from `@amane/policy/authority`, with endpoint arrays, multiple adapters, asset caps, recipients, price floors, recovery destinations and delegated issuer entries. Allowed actions: SWAP=0, PAY=9, BRIDGE=10, ESCROW_FUND=11; no arbitrary CALL. Nonce is `uint64`; amounts are base-unit integers |
| Typed data | Domain `{ name: "Amane Arc", version: "3", chainId, verifyingContract }`, deliberately incompatible with v1 and v2 signatures. Thirty differential struct and domain vectors                                                                                                                                                                                 |
| Registry   | `compileAuthorityPolicy` resolves a policy against a registry at one block, checking registry and adapter identity and token decimals and code; returns a branded `ResolvedAuthorityPolicy` that plain JSON cannot forge                                                                                                                                     |
| Client     | `AuthorityClient`: `checkIdentity`, `signPolicy`, `prepareAction`, `simulate`, `encodeExecute`                                                                                                                                                                                                                                                               |
| Controls   | Companion fee policy, fee intent, quota binding and quota grant typed data. The agent signs both the action and its exact fee companion; fees share the lease and root limits                                                                                                                                                                                |
| Quotas     | Root-threshold quota binding, one-way quota mode, global and endpoint quotas with freeze ACK semantics                                                                                                                                                                                                                                                       |
| CCTP       | Source adapter and spec-bound receiving vault that authenticates the raw message and measures the exact mint; local attester fixtures are explicitly not Circle evidence                                                                                                                                                                                     |

The v3 candidate's local validation (at its latest pin) is 159 TypeScript, 267 Foundry and 142 Move tests passing, plus a fresh tarball consumer. Its package set is `@amane/arc`, `@amane/cctp`, `@amane/policy` and `@amane/verify` at 0.3.1 with `@amane/core` and `@amane/sdk` at 0.1.0. Independent review for it is a targeted engineering review, not a security audit.
