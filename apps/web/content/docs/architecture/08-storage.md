---
title: Storage and migrations
description: How Synq stores data in Postgres and how schema changes are applied.
---

Postgres is the system of record. Redis is used by the read model and some tests. The chain is the source of truth for money, and the database records what the chain has proven or what a person has signed.

## What lives where

| Store                                              | Used by                                                                                                              | Contents                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace database (`synq_ws_*` and module tables) | `packages/workspaces`, API, worker                                                                                   | Principals, wallets, sessions and device sessions, workspaces and members (with an append-only membership log), invites, channel bindings, rate limits, vault setups and signatures, leads, offers, commercial policies, agreements, invoices and books, contributions, governance, Amane accounts, leases and jobs, agent events, notifications and push devices |
| Ledger                                             | `packages/ledger`                                                                                                    | Document-linked double-entry ledger; each entry balances per asset and carries chain evidence and an idempotency key                                                                                                                                                                                                                                              |
| Outboxes and journals                              | `workers/execution`                                                                                                  | Signed payment records (`SIGNED`, `CONFIRMED`, `FAILED`, `NEEDS_REVIEW`), consumed grants and nonces, saga state                                                                                                                                                                                                                                                  |
| Indexer database                                   | `apps/api/src/arc-indexer.ts`                                                                                        | Block cursors and hashes, indexed chain events with provenance                                                                                                                                                                                                                                                                                                    |
| Read model                                         | `packages/read-model`                                                                                                | Projections for the API, optionally cached in Redis                                                                                                                                                                                                                                                                                                               |
| Channel stores                                     | `packages/channels`, `packages/identity`                                                                             | Chat links, memory (opt-in), durable delivery                                                                                                                                                                                                                                                                                                                     |
| Domain stores                                      | `dealroom`, `allocations`, `treasury`, `governance`, `settlement`, `profile-vault`, `plugins/risk`, `plugins/duffel` | Their own tables                                                                                                                                                                                                                                                                                                                                                  |
| Files                                              | Bot state volume                                                                                                     | Journal and Kernel audit logs under mounted state directories, keys by file path only                                                                                                                                                                                                                                                                             |

Sensitive tables hold digests rather than secrets wherever possible: session and refresh tokens are stored as SHA-256 digests, push tokens carry a digest for lookup, and the profile vault stores purchase secrets sealed.

## Rules the schema enforces

- Money columns are `numeric(78,0)` base units with positive or non-negative checks.
- Workspaces are pinned to the Arc testnet chain id by a `CHECK` constraint, and an ACTIVE workspace must have a vault and threshold.
- Immutable rows are protected by triggers: the membership log is append-only, a vault setup's data and hash cannot change, durable delivery rows only move forward.
- Uniqueness keys implement idempotency: one job per (workspace, trigger, lease), one notification per (event, principal), one delivery per (event, channel, destination), one ledger entry per chain evidence key.
- Foreign keys tie child rows to their workspace so tenant isolation does not depend only on application code.

## Migrations

Each module owns an ordered list of migrations with an `up` and a `down` script, for example `WORKSPACE_MIGRATIONS` in `packages/workspaces/src/migrations.ts`, `AMANE_MIGRATIONS`, `FINANCE` and `AGENT_EVENT_MIGRATIONS`. `migrate(target?)`:

1. Opens a transaction and takes a Postgres advisory lock named for the module, so two processes cannot migrate at once.
2. Creates the module's `*_migrations` table if needed and reads the applied versions.
3. Runs `down` scripts, newest first, for applied versions above the target.
4. Runs `up` scripts, in order, for versions up to the target that are not applied, recording each.

The target defaults to the latest version and must be a valid integer; the whole run is one transaction, so a failed migration leaves nothing half applied. Services migrate on start. Optional modules (notifications, Amane) tolerate their tables being absent by reporting the feature as unavailable. Because every migration has a `down`, tests exercise rolling forward and back.

## Contracts and deployments

Contract deployment records are written under `contracts/deployments`, which the services read (`SYNQ_DEPLOYMENTS_DIR`). Addresses used at runtime come from the chain registry and are verified against pinned code hashes before use.
