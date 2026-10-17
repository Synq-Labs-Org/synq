---
title: How Synq integrates Amane
description: Account and lease registration, contractor jobs, and the fixed payment pipeline.
---

## Setup

1. **Owner sets up an Amane account** on Arc testnet with their own wallet and signs the root policy. Synq does not deploy or control the account.
2. **Register the account**: `POST /v3/workspaces/{workspaceId}/amane/accounts`. Synq reads the account's code and root policy from chain and requires that the deployed code hash equals the pinned release (`AMANE_CODE_MISMATCH`), that the signing owner is a controller of the account on chain (`AMANE_NOT_CONTROLLER`), and that the account is not already registered (`AMANE_ACCOUNT_REGISTERED`). Registration records what the chain already enforces and cannot widen it.
3. **Owner signs a lease** to Synq's agent address, then registers it with `POST .../amane/leases`. Synq reads it back from chain.

The routes exist only when the server has an agent key and a pinned code hash configured; otherwise `GET .../mandates` reports `NOT_CONFIGURED`. The relevant settings are `SYNQ_AMANE_AGENT_KEY_FILE` (a key file, never a value in the environment) and `SYNQ_AMANE_ACCOUNT_CODEHASH`. See [Environment variables](/docs/self-hosting/environment).

## Jobs

A **job** says "pay this contractor this amount when this trigger happens", inside a named lease. Create it with `POST .../amane/jobs`.

| Field         | Meaning                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `leaseId`     | The lease to pay under                                                                            |
| `triggerKind` | `INVOICE_PAID` (wait until a client invoice settles in full) or `OWNER_REQUEST` (due immediately) |
| `triggerRef`  | The invoice id, or a reference, up to 80 characters                                               |
| `amount`      | Base units; must not exceed the lease per-action cap (`ABOVE_LEASE_PER_ACTION`)                   |
| `purpose`     | Human description, up to 160 characters                                                           |

A job is unique per (workspace, trigger kind, trigger reference, lease), so repeating the request returns `JOB_EXISTS`. Job states:

```text
 WAITING --(invoice paid in full)--> READY --> SENT --> PAID
    |                                  |        |
    |                                  v        v
 (OWNER_REQUEST starts READY)       REFUSED   NEEDS_REVIEW
```

`REFUSED` means a check failed before any money moved. `NEEDS_REVIEW` means a transaction was sent and did not finish as expected (reverted or unknown), so a person must look.

## The payment pipeline

The execution worker runs these steps in a fixed order for each READY job. Every step is recorded as an agent event on the run so the owner sees it. A refusal at any step moves no money.

1. **Trigger met**: the invoice settled, or the owner asked.
2. **Allocate a nonce**: one per job, never reused (unique per lease in the database).
3. **Read the lease** from the Amane account at one block, after checking the deployed code against the pinned hash.
4. **SDK validation** (`validateAction`) of the exact PAY intent against root, lease and state.
5. **Recipient screening** with the risk plugin's sanctions screening. Unavailable screening is a refusal.
6. **Agent key signs** the exact intent.
7. **Simulation**: the `execute(intent, signature)` call is simulated from the operator address.
8. **Kernel decision** (`decideAmaneLeasedPay`): see below.
9. **Record and broadcast**: the signed transaction bytes are recorded in the durable outbox with the grant consumed, then broadcast by the operator (the relay shares the per-sender lock with the workspace vault relays because the operator key is shared; gas is estimated with a 30 percent margin and checked against the operator's balance).
10. **Verify**: the account's `Executed` event is verified from the receipt (`verifyExecution`), and the payment is booked in the ledger once. Repeating the step after a crash is safe.

### The Kernel's check

`decideAmaneLeasedPay` returns DENY unless all of these hold: the chain is Arc testnet (or a local chain in tests); the recipient and token agree between the job, the signed intent and the on-chain root policy; the amount equals the job amount and is positive; the lease is live, the account unpaused and the nonce unused; the amount is within all five remaining budgets; the intent deadline is in the future and at most 15 minutes ahead; risk screening is available with no hard hold; the simulation succeeded; and the execution call targets the Amane account with zero native value. An ALLOW yields a Kernel grant bound to that one call, with a one-use nonce and short expiry. See [Kernel and grants](/docs/architecture/kernel-and-grants).

> **Security**
> The contract enforces the lease again independently of Synq. Even a bug in the Kernel or a stolen worker cannot pay a different recipient, a different token, or more than the owner's policy allows.

## What users see

`GET .../mandates` lists each lease with its action list (`PAY`), the recipient and asset, the per-action limit, the amount available right now (read from the contract), expiry, revocation time, the enforcing contract and a proof level: `LIVE_ARC_TESTNET` when the contract confirms the lease is live, `BLOCKED` when it is not, and `NOT_VERIFIED` when the chain could not be read. Its `capability` field uses the Amane capability vocabulary:

| Status                  | Meaning                                                                       |
| ----------------------- | ----------------------------------------------------------------------------- |
| `NOT_CONFIGURED`        | No account, code mismatch, or no live lease                                   |
| `ONCHAIN_AUTHENTICATED` | Account and live lease enforced by the contract; no Synq payment verified yet |
| `VERIFIED_TESTNET`      | A Synq-run payment was verified on Arc testnet                                |

Persistence: tables `synq_amane_accounts`, `synq_amane_leases` and `synq_amane_jobs` (migration version 1 of the Amane module).
