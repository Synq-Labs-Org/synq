---
title: SynqArcVaultFactory
description: Creates a Safe vault with its policy guard and fallback handler in one verified transaction.
---

`SynqArcVaultFactory` (`contracts/src/arc/SynqArcVaultFactory.sol`) creates Synq group and business vaults on Arc. In one transaction it deploys a fresh [SynqArcVaultPolicy](/docs/contracts/vault-policy), creates a Safe v1.4.1 proxy through the canonical proxy factory with the policy installed as both module and guard, installs [SynqArcFallbackHandler](/docs/contracts/fallback-handler) (the stock CompatibilityFallbackHandler is deliberately not used), binds the policy to the Safe, and then verifies the outcome.

> **Security**
> The factory has no owner, no proxy and no mutable configuration. It cannot touch a vault after creation. A vault's code changes only through that vault's own owner quorum, after its policy timelock.

## Constructor and immutables

`constructor(safeSingleton, safeProxyFactory, token)` requires code at all three addresses (`InfrastructureMissing` otherwise) and deploys the fallback handler and a setup helper (`SynqArcVaultSetup`).

| Immutable           | Meaning                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `safeSingleton`     | SafeL2 v1.4.1 singleton                                          |
| `safeProxyFactory`  | SafeProxyFactory v1.4.1                                          |
| `fallbackHandler`   | The `SynqArcFallbackHandler` this factory deployed               |
| `token`             | The one asset every vault's operator may pay (Arc USDC)          |
| `setupHelper`       | The delegatecall helper used by `Safe.setup`                     |
| `proxyInitCodeHash` | keccak256 of the Safe proxy init code, used to predict addresses |

Constants: `MAX_OWNERS = 20`, `GUARD_SLOT`, `FALLBACK_HANDLER_SLOT` (Safe v1.4.1 storage slots).

## External functions

| Function                                                                                         | Purpose                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createVault(VaultParams p, bytes32 salt)`                                                       | Creates the vault. Returns `vaultId`, the Safe address and the policy. Anyone may call it; the id is namespaced by chain, factory, creator and salt         |
| `deployReplacementPolicy(guardian, operator, delay, recipients, perPaymentCap, windowCap, salt)` | Called by an existing vault Safe to mint a replacement policy already bound to itself. Installing it is a separate timelocked `setGuard` and `enableModule` |
| `computeVaultId(creator, salt)`                                                                  | Deterministic vault id                                                                                                                                      |
| `predictSafe(initializer, saltNonce)`                                                            | CREATE2 address the proxy factory will assign                                                                                                               |
| `isCreating(account)`                                                                            | True only for the Safe the factory is creating in the current call                                                                                          |

`VaultParams` holds `owners`, `threshold`, `guardian`, `operator`, `delay`, `recipients`, `perPaymentCap` and `windowCap`.

## Setup helper

`SynqArcVaultSetup.install(policy)` runs through `Safe.setup`'s delegatecall. It reverts when called directly (`OnlyDelegateCall`) and unless the factory reports it is creating that exact Safe (`NotFactoryCreation`). It then enables the policy as module and sets it as guard. Because of `isCreating`, a copied initializer cannot be replayed through the permissionless proxy factory to squat a vault's address.

## Validation

- 1 to 20 unique owners, threshold between 1 and the owner count.
- No owner may be zero, the Safe sentinel, the factory, the setup helper, the token or the fallback handler.
- The operator must not be an owner (it must never count toward the quorum) and must differ from the guardian; recipients must not include the operator.
- Post-creation checks: predicted address matches, module enabled, guard slot equals the policy, fallback slot equals the handler, threshold as requested. Failure reverts `SetupVerificationFailed`.

## Events and errors

Events: `VaultCreated(vaultId, safe, policy, owners, threshold, guardian, operator, delay, creator)` and `ReplacementPolicyDeployed(safe, policy, guardian, operator)`.

Errors: `InfrastructureMissing`, `InvalidOwners`, `InvalidThreshold`, `InvalidOwner`, `InvalidRole`, `SetupVerificationFailed`, `CreationInProgress`.

## How Synq uses it

A business workspace proposes a vault setup (`packages/workspaces/src/vault-setup.ts`): threshold, per-payment cap (default 5 USDC), rolling 24-hour cap (default 20 USDC) and timelock delay (default 1 day, between 1 hour and 30 days). The setup is EIP-712 typed data (`@synq/kernel/arc-vault-setup`) that every owner signs. It moves through `AWAITING_SIGNATURES`, `READY`, then `ACTIVE`, or `REVERTED` and `NEEDS_REVIEW` when the chain result is not what was signed. Once the signatures are in, the execution worker (`workers/execution/src/vault.ts` and `workspace-vault.ts`) simulates and submits `createVault` from a sponsor account with a bounded gas budget, verifies the contract code against the registry, and reads back `VaultCreated`. The addresses are listed in the [contracts overview](/docs/contracts).
