---
title: SynqGroupFactory
description: Creates mandate-governed group Safes and binds them to the MandateRegistry.
---

`SynqGroupFactory` (`contracts/src/SynqGroupFactory.sol`) creates a group account as a Safe v1.4.1 proxy with the [ExecutionModule](/docs/contracts/execution-module) enabled, then binds the group in the [MandateRegistry](/docs/contracts/mandate-registry). It deploys its own registry, module and setup helper so the trust graph is fixed at deploy time. Its fallback handler is the stock `CompatibilityFallbackHandler` v1.4.1, which is why the newer [vault stack](/docs/contracts) uses a stricter handler instead.

## Components

| Name                  | Role                                                                                                                                                                                                             |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SynqGroupFactory`    | Creates groups. No owner and no mutable configuration. `MAX_OWNERS = 20`                                                                                                                                         |
| `SynqSafeModuleSetup` | Helper reached through `Safe.setup`'s delegatecall. `enableModule(module)` reverts when called directly (`OnlyDelegateCall`) and unless the factory is currently creating that exact Safe (`NotFactoryCreation`) |

Immutables: `safeSingleton` (SafeL2 v1.4.1), `safeProxyFactory`, `fallbackHandler`, `registry`, `module`, `moduleSetup`, `proxyInitCodeHash`.

## External functions

| Function                                 | Purpose                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `createGroup(owners, threshold, salt)`   | Validates owners (1 to 20 unique, none zero, sentinel or a Synq contract; threshold from 1 to the count), computes `groupId`, creates the proxy, checks the module is enabled and the threshold set, calls `registry.bindGroup`. Returns `groupId` and the account |
| `computeGroupId(creator, salt)`          | Id namespaced by chain, factory, creator and salt, so nobody can front-run another creator's id                                                                                                                                                                    |
| `predictAccount(initializer, saltNonce)` | CREATE2 address the proxy factory will assign                                                                                                                                                                                                                      |
| `isCreating(account)`                    | True only for the proxy being created in the current call                                                                                                                                                                                                          |

Event: `GroupCreated(groupId, account, owners, threshold, module, registry, creator, salt)`.

Errors: `InfrastructureMissing`, `InvalidOwners`, `InvalidThreshold`, `InvalidOwner`, `SetupVerificationFailed`, `CreationInProgress`.

## Invariant

The initializer only succeeds while the factory is creating that exact proxy, so a copied initializer cannot be replayed through the permissionless Safe proxy factory to squat a group's address.

## How Synq uses it

The Kernel's `toMandateConfig` maps a group mandate onto the registry (see [Kernel and grants](/docs/architecture/kernel-and-grants)). The group id the factory assigns is the `chainGroupId` the Kernel uses, and the mandate's operators become executors on the module.
