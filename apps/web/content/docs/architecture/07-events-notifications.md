---
title: Events and notifications
description: Agent events, the live stream, in-app notifications, push and chat delivery.
---

Synq shows people what happened without leaking what it was about. One append-only event log feeds everything the user sees in real time.

```text
 agents, Kernel, worker, chain indexer
              |  record once per semantic key
              v
   +---------------------------+
   | agent events (Postgres)   |  per-workspace sequence,
   | actor, status, proof level|  typed, append-only
   +---------------------------+
        |           |            |
        v           v            v
   /v3/events    notifications   chat receipts
   (SSE, poll)   + APNs push     (Telegram, iMessage)
```

## Agent events

`packages/workspaces/src/agent-events.ts` stores what agents did as typed records rather than chat text. A **run** groups the steps of one piece of work; each step is an event with:

| Field         | Values                                                                                                 |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| `kind`        | `DECISION`, `INTENT`, `GRANT`, `BROADCAST`, `FINALIZED`, `REJECTED`, `RECONCILED`, `ESCALATED`         |
| `actor`       | `MODEL`, `DETERMINISTIC`, `HUMAN`, `CHAIN`, `PROVIDER`                                                 |
| `status`      | The run status                                                                                         |
| `proofLevel`  | `LIVE_ARC_TESTNET`, `LIVE_ARC_MAINNET`, `PROVIDER_SANDBOX`, `LOCAL_FIXTURE`, `NOT_VERIFIED`, `BLOCKED` |
| `semanticKey` | Events are recorded once per key, so a retried worker or a re-run projection never duplicates a row    |

`FINALIZED` and `RECONCILED` can come only from chain or ledger evidence, never from a model. These rows back the run views in the API (`/v3/workspaces/{workspaceId}/agent-runs`).

The same table has a **stream** projection: for each change it records only what changed (a stream type, an entity id and a cursor), never the content. Stream types are `LEAD_UPDATED`, `LEAD_MESSAGE`, `OFFER_UPDATED`, `AGENT_EVENT`, `APPROVAL_CHANGED`, `BALANCE_CHANGED`, `NOTIFICATION` and `CONTEXT_REVOKED`.

## Live delivery

`GET /v3/events` (server-sent events) and `GET /v3/events/since` (polling) read the stream by cursor and filter it to the contexts the principal belongs to. The server re-checks the session and membership on every poll and sends `CONTEXT_REVOKED` when access ends. Details are in the [Events API](/docs/api/events). A client that receives an event fetches the current state with a normal authenticated read; the event itself carries no private content.

## Notifications

`packages/workspaces/src/notifications.ts` keeps in-app notifications and push devices.

- One notification per (event, principal), so a retried producer never duplicates it.
- Titles are generic by construction: they come from the category alone (`NEW_LEAD`, `OFFER_ACCEPTED`, `CLIENT_DEPOSIT_FINALIZED`, `AGENT_PAYMENT_FINALIZED`, `PAYMENT_BLOCKED`, `RISK_REVIEW`, `ESCROW_DISPUTED`, `CIRCLE_CONTRIBUTION_RECEIVED`, `FUND_PROPOSAL`, `APPROVAL_REQUESTED`, `LEASE_EXPIRING`, `SECURITY_PAUSE`) and never carry a name, price, address or deal text.
- A push is queued once per active, unmuted device, honouring quiet hours, and carries only the title, the category and the event id (`PENDING`, `SENT`, `FAILED`, `SKIPPED` delivery states). Details are fetched after sign-in and a membership check. A device token authenticates nothing.
- The APNs sender (`apps/demo/src/apns.ts`) uses token-based auth (an ES256 JWT from a `.p8` key file), HTTP/2 to the sandbox or production host chosen per device, and builds the payload from a fixed shape. Tokens and keys are never logged.
- Signing a device session out or revoking it stops pushes to the devices it registered and skips their queued deliveries.

## Chat delivery

Verified chat bindings get cards, for example a receipt for a paid payout (`apps/demo/src/workspace-notifications.ts`). `packages/channels/src/durable-delivery.ts` queues each message per (event, channel, destination) in Postgres with leases and retries (`QUEUED`, `SENDING`, `RETRY`, `SENT`, `UNKNOWN`, `REVOKED`, `FAILED`). The money commits before the message is enqueued, and an ambiguous provider result becomes `UNKNOWN` and is held for review rather than re-sent blindly.

## Chain events

The Arc indexer (`apps/api/src/arc-indexer.ts`, core in `packages/ledger/src/arc-chain-indexer.ts`) follows finalized blocks with a durable cursor, checks parent hashes for reorgs and marks removed events, verifies the emitter's code hash against the registry before trusting any log, and stores events unique on (chain, tx, log index, kind) with provenance. Effects such as ledger postings and invoice settlement run from the stored events after the batch commits and are idempotent. A separate workspace indexer discovers active vaults on every pass instead of using a wallet list in the environment.
