---
title: MandateRegistry
description: Per-group mandate envelopes and the cumulative spend ledger.
---

`MandateRegistry` (`contracts/src/MandateRegistry.sol`) holds mandate governance and the cumulative spend ledger for groups backed by Safe accounts. Governance functions accept calls only from the bound group Safe itself, so every change needs the owner quorum. Spend is recorded by one module that the Safe authorized. Replacing or redeploying a module never resets cumulative spend, because spend is keyed by (account, mandateId).

## Data

| Struct          | Contents                                                                                                                                                                                                          |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MandateConfig` | `mandateHash`, `token`, `maxTokenPerAction`, `maxNativePerAction`, `cumulativeTokenCap`, `cumulativeNativeCap`, `validAfter`, `validUntil`, and the allowlists `callTargets[]`, `callSelectors[]`, `recipients[]` |
| `MandateTerms`  | The scalar terms stored per version                                                                                                                                                                               |
| `MandateState`  | `status` (`None`, `Active`, `Revoked`), `currentVersion`, `minValidVersion`, `spentToken`, `spentNative`                                                                                                          |
| `MandateLists`  | The allowlists per version                                                                                                                                                                                        |
| `SpendRequest`  | `target`, `selector`, `recipient`, `token`, `tokenAmount`, `nativeAmount`                                                                                                                                         |

`MAX_LIST_LENGTH = 32` bounds each allowlist. Native transfers use selector zero.

## External functions

| Function                                                                              | Caller                 | Effect                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bindGroup(groupId, account, module)`                                                 | Factory only           | Binds a new Safe to a group id and its initial module, once                                                                                                                                                            |
| `setModule(newModule)`                                                                | Group Safe             | Changes which module may record spend; zero disables delegated spend. Spend totals persist                                                                                                                             |
| `configureMandate(mandateId, config)`                                                 | Group Safe             | Creates version 1; a used id, even revoked, cannot be reused                                                                                                                                                           |
| `supersedeMandate(mandateId, newVersion, config, securitySensitive)`                  | Group Safe             | Writes version N+1. The token cannot change. If `securitySensitive`, grants for earlier versions become invalid. A non-sensitive supersession must be a pure widening, otherwise `NarrowingSupersessionMustInvalidate` |
| `revokeMandate(mandateId)`                                                            | Group Safe             | Terminal revocation                                                                                                                                                                                                    |
| `authorizeSpend(account, mandateId, version, request)`                                | Authorized module only | Checks the envelope and records spend before the module executes                                                                                                                                                       |
| `mandateState`, `mandateTerms`, `mandateLists`, `isCallAllowed`, `isRecipientAllowed` | Anyone                 | Views                                                                                                                                                                                                                  |

Public mappings: `groupOf`, `accountOf`, `moduleOf`, plus the `factory` constant.

## What `authorizeSpend` checks

In order: caller is the account's module; mandate is Active; version is between `minValidVersion` and `currentVersion`; inside `validAfter`/`validUntil`; (target, selector) allowlisted; recipient allowlisted; token matches the mandate token; per-action caps; cumulative caps (the smaller of the grant's version and the current version's cap). Then it adds to the spend counters and emits `SpendRecorded`.

## Events and errors

Events: `GroupBound`, `GroupModuleChanged`, `MandateConfigured`, `MandateSuperseded`, `MandateRevoked`, `SpendRecorded`.

Errors: `OnlyFactory`, `OnlyGroupAccount`, `InvalidBinding`, `GroupAlreadyBound`, `InvalidModule`, `MandateAlreadyExists`, `MandateNotFound`, `MandateIsRevoked`, `InvalidMandateId`, `InvalidVersion`, `TokenChanged`, `InvalidWindow`, `InvalidCaps`, `InvalidCallList`, `ListTooLong`, `ForbiddenAddress`, `UnauthorizedModule`, `MandateNotActive`, `MandateVersionNotValid`, `MandateOutsideWindow`, `CallNotAllowed`, `RecipientNotAllowed`, `TokenMismatch`, `PerActionCapExceeded`, `CumulativeCapExceeded`, `NarrowingSupersessionMustInvalidate`.

## Invariants

- Only the group Safe changes mandates; only its authorized module spends.
- Revocation is terminal. A revoked id is never reusable.
- A narrowing can never silently keep older, wider grants valid.
- Cumulative spend only goes up.

## How Synq uses it

The Kernel mandate resolver (`packages/kernel/src/mandates.ts`) maps its mandate onto `MandateConfig`; the freshness gate reads `mandateState` right before execution so a revoked or superseded mandate refuses. See [Kernel and grants](/docs/architecture/kernel-and-grants).
