---
title: SynqArcFallbackHandler
description: The Safe fallback handler that stops ERC-1271 signatures from bypassing the vault policy.
---

`SynqArcFallbackHandler` (`contracts/src/arc/SynqArcFallbackHandler.sol`) replaces Safe's stock `CompatibilityFallbackHandler` on every Synq vault. It is stateless, has no admin and is not upgradeable (`UPGRADE_AUTHORITY()` returns `NON_UPGRADEABLE_NO_ADMIN`).

## Why it exists

The stock handler validates ERC-1271 signatures against the owners' own signatures or approved hashes. An owner quorum could then authorize USDC `transferWithAuthorization`, `receiveWithAuthorization` or `permit` (the FiatToken bytes-signature variants) with no Safe transaction at all. That would bypass the [policy guard](/docs/contracts/vault-policy): no timelock, no pause, no Safe event.

## What it does instead

- A 1271 signature is valid only as an **empty signature** over a message the Safe itself marked as signed (`signedMessages`). Only a `DELEGATECALL` to `SignMessageLib` can set that, and the policy timelocks and freezes every `DELEGATECALL`.
- Owner signatures and approved hashes are rejected outright.
- Everything is rejected while the Safe's guard reports `paused()`. A guard that cannot answer `paused()` counts as paused (fail closed).

## External functions

| Function                                                                            | Purpose                                                                                        |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `isValidSignature(bytes32, bytes)`                                                  | ERC-1271; returns `0x1626ba7e` only for a Safe-approved message, empty signature, unpaused     |
| `isValidSignature(bytes, bytes)`                                                    | Legacy ERC-1271 with the same rule (`0x20c13b0b`)                                              |
| `getMessageHash`, `getMessageHashForSafe`, `encodeMessageDataForSafe`               | Read-only message hashing used by Safe tooling                                                 |
| `getModules()`                                                                      | First ten modules of the calling Safe                                                          |
| `simulate(target, payload)`                                                         | Runs Safe's `simulateAndRevert` (state always rolled back) and returns or re-throws the result |
| `onERC721Received`, `onERC1155Received`, `onERC1155BatchReceived`, `tokensReceived` | Token callbacks so the vault can receive assets                                                |
| `supportsInterface`                                                                 | ERC-165 for the receivers                                                                      |

There are no events and no custom errors; `simulate` reverts with `simulate: malformed` on an unexpected result.

## How Synq uses it

`SynqArcVaultFactory` deploys one instance and installs it as the fallback handler of every vault, and checks the Safe's fallback handler storage slot after creation. The execution worker verifies the handler's code against the registry address before it trusts a vault. See the [overview](/docs/contracts).
