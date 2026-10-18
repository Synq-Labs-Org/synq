---
title: Amane leased payments
description: How Amane lets an owner pre-authorise an agent to pay a specific recipient within hard limits that a contract enforces.
---

**Amane** is a payment account contract on Arc testnet that lets an owner delegate _bounded_ spending to an agent. In Synq it powers jobs such as "pay this contractor when this invoice is paid" without asking for a new signature each time.

## The pieces

```text
   OWNER wallet
      | creates + signs
      v
   Amane ACCOUNT  (one recipient, one token, owner-signed root policy)
      | owner signs a LEASE to the agent key
      v
   LEASE: agent may PAY recipient up to X per action, Y in total, until T
      ^
      | agent signs an intent per job; the contract checks it against the lease
   JOB: "pay 40 USDC, purpose, trigger = invoice paid"
```

| Term        | Meaning                                                                                             |
| ----------- | --------------------------------------------------------------------------------------------------- |
| Account     | The contract that holds funds for leased payments. Controlled by the owner on chain                 |
| Root policy | The owner-signed rules of the account: recipient, token, adapter                                    |
| Lease       | An owner-signed grant to one agent: per-action limit, total, expiry, recipient                      |
| Job         | A request to pay inside a lease, with a trigger                                                     |
| Trigger     | `INVOICE_PAID` (waits until the invoice is paid in full with finalized receipts) or `OWNER_REQUEST` |

## What Synq does and does not do

Synq only **records** what the chain already enforces, and only after reading it back from the contract. It cannot widen a lease. If Synq is compromised, the contract still refuses anything outside the lease: wrong recipient, over the limit, expired or revoked.

## What the owner approves

The owner approves the account and the lease with wallet signatures. After that, the agent pays jobs with **no new human signature**, which is the whole point, and why the lease should be small and short.

## Safety layers around each payment

1. The job's trigger must be met.
2. The lease is read from the contract (live, agent matches, not expired).
3. The Amane SDK validates the action.
4. The recipient is screened.
5. The agent key signs the exact intent.
6. The payment is simulated.
7. The Kernel issues a grant bound to the exact call.
8. Signed bytes are recorded and the grant consumed before broadcast.
9. The contract verifies the signature, lease and limits again.
10. The receipt is reconciled; a revert becomes `NEEDS_REVIEW`.

## When things go wrong

| Situation                                 | Result                                        |
| ----------------------------------------- | --------------------------------------------- |
| Amount above the lease's per-action limit | Job creation fails (`ABOVE_LEASE_PER_ACTION`) |
| Lease expired or revoked                  | Job `REFUSED` with a reason                   |
| Recipient not the lease recipient         | Refused by the contract                       |
| Same trigger and lease twice              | `JOB_EXISTS`; one payment per trigger         |
| Transaction reverts or outcome unclear    | `NEEDS_REVIEW`; no blind retry                |

## Notifications

A lease nearing its end raises `LEASE_EXPIRING`; a finalized leased payment raises `AGENT_PAYMENT_FINALIZED`.

See [Agent payments setup](/docs/guides/agent-payments). The Amane section of the reference documentation covers the SDK and contracts when published.
