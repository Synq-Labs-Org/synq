---
title: ExecutionModule
description: The Safe module that runs owner-quorum-signed execution grants inside mandate envelopes.
---

`ExecutionModule` (`contracts/src/ExecutionModule.sol`) is a Safe module that executes **ExecutionGrants**: EIP-712 typed data signed by the Safe's owner quorum, each authorizing exactly one delegated action. One deployment serves many Safes, with all per-account state keyed by the Safe address and governed by that Safe. Execution is always a plain `CALL` through `execTransactionFromModule`; `DELEGATECALL` is never requested.

The EIP-712 domain is name `SynqExecutionModule`, version `1`, with the chain id and the module address.

## The grant

`ExecutionGrant` fields: `groupId`, `account`, `mandateId`, `mandateVersion`, `executor`, `pluginId`, `chainId`, `target`, `selector`, `calldataHash`, `token`, `maxInputAmount`, `nativeValue`, `minOutputAmount`, `recipient`, `validAfter`, `validUntil`, `nonce`, `intentHash`.

The grant is verified with the Safe's own `checkSignatures`, so EOA, `eth_sign`, approved-hash and contract-owner (ERC-1271) signatures follow Safe rules. Malleable signatures are refused.

## External functions

| Function                                                          | Caller             | Effect                                                                                  |
| ----------------------------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------- |
| `execute(grant, data, signatures)`                                | The named executor | Runs one grant (see below). Returns the EIP-712 `grantHash`                             |
| `setExecutor(executor, allowed)`                                  | Registered Safe    | Allows or disallows an executor. Executors still need a quorum-signed grant naming them |
| `pause()` / `unpause()`                                           | Registered Safe    | Stops or resumes delegated execution for that Safe. Owner transactions are unaffected   |
| `cancelNonce(nonce)`                                              | Registered Safe    | Burns an unused grant nonce                                                             |
| `domainSeparator()`, `grantStructHash(grant)`, `hashGrant(grant)` | Anyone             | The digest the owners sign. `hashGrant` equals the Kernel's `grantId`                   |

Public: `registry`, `factory`, `isExecutor`, `paused`, `nonceUsed`, `intentUsed`, constants `NAME`, `VERSION`, `DOMAIN_TYPEHASH`, `GRANT_TYPEHASH`, `TRANSFER_SELECTOR`.

## What `execute` does, in order

1. Not paused for that account.
2. Quorum signature over the grant digest (`InvalidSignatures`; `ModuleIsSafeOwner` if the module itself is an owner, because Safe would treat the module call as an approved hash).
3. `chainId` equals the current chain; the caller is the grant's executor and an allowed executor; the group in the registry matches; the registry names this module; the module is enabled.
4. Within `validAfter` and `validUntil`; non-zero `intentHash`; nonce and intent unused.
5. `keccak256(data) == calldataHash`; target and recipient are not protected addresses (zero, the Safe, module, registry, factory).
6. Action shape. Two actions only: a native transfer (empty calldata) or an ERC-20 `transfer(address,uint256)` with exactly 68 bytes of calldata where the recipient and amount match the grant.
7. Marks nonce and intent used, then calls `registry.authorizeSpend`, which enforces the mandate envelope and records spend.
8. Executes the call from the Safe, then checks balance deltas: the Safe decreased by exactly the amount, the recipient received exactly that, and output is at least `minOutputAmount`.

## Events and errors

Event: `GrantExecuted(groupId, intentHash, mandateId, mandateVersion, account, executor, pluginId, chainId, nonce, grantHash, target, selector, calldataHash, token, recipient, tokenAmount, nativeValue, outputAmount)`, plus `ExecutorSet`, `Paused`, `Unpaused`, `NonceCancelled`.

Errors: `AccountNotRegistered`, `InvalidExecutor`, `AlreadyPaused`, `NotPaused`, `Reentrancy`, `ExecutionPaused`, `InvalidSignatures`, `MalleableSignature`, `ModuleIsSafeOwner`, `ModuleSelfApproval`, `WrongChain`, `UnauthorizedExecutor`, `GroupMismatch`, `ModuleNotAuthorized`, `ModuleNotEnabled`, `GrantNotYetValid`, `GrantExpired`, `InvalidIntent`, `NonceAlreadyUsed`, `IntentAlreadyExecuted`, `CalldataMismatch`, `SelectorMismatch`, `ProtectedAddress`, `UnsupportedAction`, `InvalidActionShape`, `ExecutionFailed`, `BalanceDeltaMismatch`, `InsufficientOutput`.

## Invariants

- One grant, one execution: nonces and intent hashes are single use.
- The executor cannot alter recipient, amount or calldata; they are bound by the signed digest.
- Success is proven by balance deltas, not by the call returning true.
- The owner quorum can stop it any time (`pause`, `cancelNonce`, mandate revocation).

## How Synq uses it

The Kernel issues a `GrantDraft`, members sign `executionGrantTypedData`, and the Kernel returns an `ExecutionGrant` whose `grantId` equals `hashGrant`. The execution worker claims the grant, submits `execute`, and reconciles the `GrantExecuted` receipt. See [Kernel and grants](/docs/architecture/kernel-and-grants) and [Execution worker](/docs/architecture/execution-worker).
