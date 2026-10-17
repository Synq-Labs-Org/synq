---
title: Agent payments with Amane leases
description: Set up an Amane account and a lease so Synq's agent can pay a contractor when a trigger fires, without a new human signature, but never outside the lease.
---

An **Amane lease** lets an owner say once: "this agent may pay this recipient up to this much, until this date." The contract enforces it. After that, a job such as "pay this contractor 40 USDC when invoice X is paid" runs without asking you to sign again.

> **Testnet**
> Amane leased payments run on Arc testnet with test USDC. Read the [concept page](/docs/concepts/amane) first for how the pieces fit.

## Who can do this

| Action | Role |
| --- | --- |
| Register an Amane account, a lease, create a job | Owner |
| See leases, limits and jobs | Owner, admin |

## Step 1: create the Amane account (outside Synq)

You set up an Amane account that you control on chain: one recipient, one token, an owner-signed root policy. Synq cannot create or widen it.

## Step 2: register the account

In **Settings** then **Agent payments** choose **Register an Amane account** and paste the account address. Synq reads the contract on chain and checks that:

- the Synq owner's wallet is a controller of the account (`AMANE_NOT_CONTROLLER` otherwise),
- the account is not already attached to another workspace (`AMANE_ACCOUNT_REGISTERED`),
- the account's code hash matches the expected Amane build (`AMANE_CODE_MISMATCH`).

Registration only records what the chain already enforces.

## Step 3: issue and register a lease

You sign an agent lease to Synq's agent key on the Amane account (an approvals request of purpose `LEASE_ISSUE`). Then **Register a lease** with the account id and the lease id. Synq reads the lease back from the contract and rejects it if:

- the lease agent is not Synq's agent (`LEASE_AGENT_MISMATCH`),
- the lease is not live (`LEASE_NOT_LIVE`),
- it is registered elsewhere (`LEASE_REGISTERED_ELSEWHERE`).

The Leases table then shows lease, per-action limit, available amount, expiry, state and enforcing contract, with a [proof level](/docs/concepts/proof-levels) read live from the chain.

## Step 4: create a job

Choose **Create a contractor job**:

| Field | Meaning |
| --- | --- |
| Lease | Which lease to spend from |
| Trigger | `INVOICE_PAID` (wait until that invoice is paid in full with finalized receipts) or `OWNER_REQUEST` (ready now) |
| Trigger reference | The invoice id for `INVOICE_PAID` |
| Amount | USDC base units; must not exceed the lease's per-action limit (`ABOVE_LEASE_PER_ACTION`) |
| Purpose | Up to 160 chars |

The page notes: "Once a job is ready the agent pays it with no new signature from you, but only within the lease. If the lease limit, recipient or expiry does not allow it, the job is refused."

## Job states

| State | Meaning |
| --- | --- |
| `WAITING` | Trigger not met yet |
| `READY` | Trigger met; queued for the worker |
| `SENT` | Transaction broadcast |
| `PAID` | Final on chain |
| `REFUSED` | The lease, a check or the contract refused; a reason is stored |
| `NEEDS_REVIEW` | The transaction reverted or the outcome is uncertain |

## What the worker does for each job

```text
 trigger met -> read the lease from the contract -> SDK validation
   -> recipient screening -> agent key signs the exact intent
   -> simulation -> Kernel grant bound to the exact call
   -> signed bytes recorded, grant consumed -> broadcast
   -> contract verifies -> receipt reconciled
```

A refused job never partially pays.

## Ending a lease

Pausing or revoking a lease is a signed on-chain action from the owner's wallet (`LEASE_REVOKE`). The app says: "Pausing or revoking a lease is a signed on-chain action from the owner's wallet; this screen cannot do it by itself."
