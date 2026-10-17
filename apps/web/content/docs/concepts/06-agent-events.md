---
title: Agent events and idempotency
description: The append-only record of what agents did, how each event is keyed so retries never duplicate, and how the stream relates to it.
---

Agents do not hide in chat. Their work is recorded as **typed events** that you can read, filter and audit.

## Runs and events

```text
 Run  "Sales conversation: Acme"   status = REQUIRES_OWNER   proof = NOT_VERIFIED
  |
  +-- #41 DECISION   MODEL          PENDING        "Proposed offer terms..."
  +-- #42 DECISION   DETERMINISTIC  AUTHORIZED     "Business rules allowed offer v1..."
  +-- #43 ESCALATED  DETERMINISTIC  REQUIRES_OWNER "Handed the conversation..."
```

- A **run** is one piece of agent work, opened once per source key (for example `lead:<id>` or `agreement:<id>`).
- An **event** is one step: kind, actor, status, summary, proof level and optional amount, recipient hint, transaction hash.
- Each event gets a **per-workspace sequence number**, so order is unambiguous.
- Events are **append-only**: a database trigger raises an error on any update or delete.
- The run's status and proof level follow its **latest event**.

## Semantic keys: idempotency

Every event carries a `semanticKey`, for example `agreement:<id>:signed` or `lead:<id>:<turn>:model:0`. Recording a key that already exists returns the original event and changes nothing. Consequences:

- A worker that retries after a crash does not duplicate rows.
- A projection that re-runs does not add duplicates.
- Two parallel processes cannot both record "funded".

The same idea protects other writes: payout proposals use an **idempotency key** (same key, same body returns the same payout; a different body is an `IDEMPOTENCY_CONFLICT`), and v3 mutations require an `Idempotency-Key` header (a UUID).

## Who may produce which status

| Status | Source allowed |
| --- | --- |
| `FINALIZED` | Chain evidence only |
| `RECONCILED` | Ledger evidence only |
| `AUTHORIZED` | Deterministic rules or a human signature |
| Others | Models, rules, humans, chain or providers as appropriate |

A model can produce `DECISION` events with status `PENDING`; it cannot mark anything final.

## Events never carry private content

Event summaries are short and factual. The **stream** that notifies clients (see [Live updates](/docs/guides/live-updates)) carries only an event type and an entity id; clients fetch details through authenticated, membership-checked routes.

## Who can read

Owners, admins and members can read agent events. Viewers cannot. Some marker types (lead, offer, run) are limited to owners and admins.

## Where events come from today

| Producer | Events |
| --- | --- |
| Sales agent | Decisions, rule checks, handovers per conversation turn |
| Agreements | "Deal agreement signed" and "Deal escrow funded" |
| Settlement and workers | Invoice settlement, deposits, payments |

See [Proof levels](/docs/concepts/proof-levels).
