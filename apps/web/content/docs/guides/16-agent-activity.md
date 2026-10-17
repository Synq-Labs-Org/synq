---
title: Agent activity
description: Read agent runs and events in the hub or app: what each status means, where proof levels appear, and how to follow a payment to a receipt.
---

The **Agents** tab shows "what agents decided and what actually happened on chain." It is visible to owners and admins in the business navigation, and members can read agent events through the API.

## Runs and events

A **run** groups the steps of one piece of agent work, for example "Sales conversation: Acme" or "Deal escrow funded: 2 milestones". Each step is an **event** with:

| Field | Meaning |
| --- | --- |
| Kind | `DECISION`, `INTENT`, `GRANT`, `BROADCAST`, `FINALIZED`, `REJECTED`, `RECONCILED`, `ESCALATED` |
| Actor | `MODEL`, `DETERMINISTIC` (a rule), `HUMAN`, `CHAIN`, `PROVIDER` |
| Status | See below |
| Proof level | How strongly evidence backs it ([Proof levels](/docs/concepts/proof-levels)) |
| Summary | Up to 400 chars |
| Optional | Amount, recipient hint, evidence hash, transaction hash, chain id |

Events are append-only. They cannot be edited or deleted.

## Statuses

| Status | Meaning |
| --- | --- |
| `PENDING` | Proposed, nothing authorized yet |
| `REQUIRES_OWNER` | Waiting for an owner |
| `AUTHORIZED` | Rules or signatures allow it |
| `BROADCAST` | Sent to the chain |
| `FINALIZED` | Final on chain (from chain evidence only) |
| `RECONCILED` | Matched to the ledger (from ledger evidence only) |
| `BLOCKED` | A rule refused it |
| `REJECTED` | Rejected |
| `TIMED_OUT` | Expired |
| `REORG_PENDING` | The chain may have reorganised; waiting |
| `REVOKED` | Authority withdrawn |
| `QUARANTINED` | Set aside for review |

## Reading a run

Open a run to see its events in order, with **Chain receipts** below: transaction hashes with a **View on the explorer** link. The app notes that it can show leases and limits but cannot pause or revoke them: that is a signed action from an owner's wallet.

## Trigger types

Runs begin from triggers such as a lead message, a settled invoice or another event. You will see titles like "Sales conversation", "Deal agreement signed", "Deal escrow funded".

## Idempotency

Each event has a **semantic key**; recording the same key twice does nothing. A retried worker never duplicates a row. See [Agent events and idempotency](/docs/concepts/agent-events).
