---
title: Leases and intents
description: The root policy, agent lease and PAY intent typed data, plus limits and revocation.
---

Three EIP-712 messages define an Amane payment. All use the domain `{ name: "Amane Arc", version: "2", chainId, verifyingContract: <the Amane account> }` for the vendored 0.2.0 release, so a signature is bound to one chain and one account and cannot be replayed elsewhere. (The newer v3 candidate uses version `3` deliberately so v2 signatures can never be reused; see [Vendored packages and SDK](/docs/amane/sdk).)

## Root policy (signed by the owner)

The owner installs the root policy through a `Control` message signed by a controller of the account. It describes the outer boundary for everything the account will ever pay.

| Field              | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| `version`          | Policy version                                              |
| `token`            | The one ERC-20 the account may pay (Arc USDC)               |
| `recipient`        | The one recipient the account may pay                       |
| `adapterId`        | Identity of the pay adapter, pinned to the deployed release |
| `recovery`         | Where funds can be recovered to                             |
| `perAction`        | Maximum per payment                                         |
| `perPeriod`        | Maximum per period                                          |
| `total`            | Lifetime maximum                                            |
| `periodSeconds`    | Length of the period                                        |
| `maxLeaseLifetime` | Longest any lease may last                                  |

The vendored release supports a strict singleton PAY subset: one token, one recipient and one adapter per root policy.

## Agent lease (signed by the owner)

A lease grants the agent a slice of the root policy.

| Field                             | Meaning                                   |
| --------------------------------- | ----------------------------------------- |
| `leaseId`                         | Identifier chosen by the owner            |
| `rootHash`                        | The root policy this lease sits under     |
| `agent`                           | The agent address allowed to sign intents |
| `validAfter`, `expiresAt`         | Validity window                           |
| `perAction`, `perPeriod`, `total` | Lease limits, never above the root limits |

Synq only accepts a lease whose `agent` is Synq's configured agent address (`LEASE_AGENT_MISMATCH` otherwise) and which is live on chain (`LEASE_NOT_LIVE`).

## PAY intent (signed by the agent key)

For every payment the agent signs one intent for exactly one action.

| Field                             | Meaning                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `leaseId`                         | Lease being used                                                                                                                         |
| `nonce`                           | One use per lease; Synq assigns the next unused value per job                                                                            |
| `kind`                            | `PAY` (the only supported action)                                                                                                        |
| `token`, `recipient`, `adapterId` | Must equal the root policy                                                                                                               |
| `amount`                          | Base units of USDC (6 decimals)                                                                                                          |
| `deadline`                        | Intent expiry; Synq uses the chain time plus 10 minutes, and the Kernel refuses a deadline that is expired or more than 15 minutes ahead |
| `maxFee`, `feeRecipient`          | Zero in this release (reimbursement is disabled)                                                                                         |
| `planHash`                        | Binds the intent to the Synq job (`keccak256` of `synq-amane-job:<jobId>`)                                                               |

The agent key is held only inside the execution worker and signs only Amane intents. It must differ from the worker's operator key (`AMANE_AGENT_MUST_DIFFER_FROM_OPERATOR`).

## Limits the contract enforces

For each payment the account checks, independently of Synq:

- the lease is live (inside its window, not revoked, root policy unchanged);
- the account is not paused;
- the nonce is unused and the deadline has not passed;
- token, recipient and adapter equal the root policy;
- the amount is within the per-action cap, and within the remaining lease period, root period, lease total and root total.

Synq reads the same five remaining amounts before it signs (`readLeaseState`) and refuses a payment above any of them (`amount exceeds the remaining lease or policy budget`). The effective available amount shown to users is the smallest of them.

## Revocation

- The owner (a controller of the account) can revoke a lease, pause the account, or replace the root policy on chain. Any of these makes later intents fail.
- Synq checks `leaseLive`, `paused` and `revoked` on every payment, and the mandates view reports a lease whose chain read fails as `NOT_VERIFIED` and a no-longer-live lease as `BLOCKED`.
- `POST /v3/workspaces/{workspaceId}/mandates/{leaseId}/revoke-intent` is in the API contract as PLANNED: Synq would prepare a revoke for the issuer to sign, and the lease would count as revoked only once the chain says so. Today the owner revokes directly against the Amane account with their own wallet.
- A revoked lease is never silently ignored by Synq; the next job simply refuses before any money moves.
