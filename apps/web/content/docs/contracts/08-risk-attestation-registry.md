---
title: RiskAttestationRegistry
description: On-chain stablecoin risk attestations written only through a Chainlink CRE forwarder.
---

`RiskAttestationRegistry` (`contracts/src/RiskAttestationRegistry.sol`) stores the latest stablecoin risk attestation per asset. Reports arrive only through the configured Chainlink CRE forwarder (it implements the CRE `IReceiver`). The Kernel's risk gate reads it and treats `UNKNOWN` and `STALE` as fail-closed.

## Report format

`abi.encode(bytes32 assetId, uint64 timestamp, uint256 referencePrice, uint32 deviationBps, uint64 stalenessSec, uint8 status, bytes32 sourceConfigHash)`: exactly 224 bytes (`REPORT_LENGTH`). `referencePrice` has `REFERENCE_DECIMALS = 8` decimals. `Status` is `UNKNOWN`, `HEALTHY`, `DEGRADED` or `STALE`.

An `Attestation` stores timestamp, staleness, deviation, status, price, source config hash, workflow id, and the `recordedAt` time and block.

## Roles

| Role      | Power                                                                                |
| --------- | ------------------------------------------------------------------------------------ |
| Forwarder | The only address that may call `onReport`                                            |
| Owner     | Rotates the forwarder and the workflow identity checks (two-step ownership transfer) |

## External functions

| Function                                                   | Caller               | Effect                                                                                               |
| ---------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------------------- |
| `onReport(metadata, report)`                               | Forwarder            | Validates and records a report                                                                       |
| `latest(assetId)`                                          | Anyone               | Latest attestation (all zero and `UNKNOWN` if none)                                                  |
| `setForwarder(forwarder)`                                  | Owner                | Rotates the forwarder (mock for simulation, the production forwarder later)                          |
| `setWorkflowExpectation(workflowId, author, workflowName)` | Owner                | Optional workflow identity checks; a name requires an author because names are truncated to 10 bytes |
| `transferOwnership(next)`, `acceptOwnership()`             | Owner, pending owner | Two-step ownership                                                                                   |
| `supportsInterface`                                        | Anyone               | ERC-165                                                                                              |

## Checks in `onReport`

Sender is the forwarder; metadata (62 or 64 bytes) matches any configured workflow id, author and name; report length is 224; asset id is not zero; status is valid; HEALTHY and DEGRADED need a non-zero price; the timestamp is strictly newer than the stored one (`StaleAttestation`), so a delayed or replayed report cannot overwrite a newer one; and not more than `MAX_FUTURE_SKEW` (300 seconds) ahead of the block.

## Events and errors

Events: `AttestationRecorded`, `ForwarderUpdated`, `WorkflowExpectationUpdated`, `OwnershipTransferStarted`, `OwnershipTransferred`.

Errors: `InvalidForwarder`, `InvalidSender`, `NotOwner`, `NotPendingOwner`, `InvalidMetadata`, `InvalidWorkflowId`, `InvalidAuthor`, `InvalidWorkflowName`, `WorkflowNameRequiresAuthor`, `InvalidReportLength`, `InvalidAsset`, `InvalidStatus`, `MissingReferencePrice`, `StaleAttestation`, `FutureAttestation`.

## How Synq uses it

The Chainlink CRE workflow in `plugins/chainlink-cre` computes the attestation off chain and delivers it here. The Kernel risk gate (`packages/kernel/src/risk-attestation.ts`) reads attestations for risk-sensitive actions (spot trades, conversions, perp hedges, cross-chain funding) and refuses when the status is `UNKNOWN` or `STALE`. This is not a vault contract: it gates agent proposals and cannot move funds.
