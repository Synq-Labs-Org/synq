---
title: Architecture
description: How Synq's clients, services, Kernel, execution worker and Arc fit together.
---

Synq is a TypeScript monorepo (Node 22, pnpm workspaces) plus a Solidity contracts project. The design rule behind everything is a hard split between **proposing** and **authorizing and signing**: models and planners can propose; only deterministic code can authorize; only the execution worker holds keys that can sign.

> **Testnet**
> Everything runs on Arc testnet (chain id 5042002). Arc mainnet is registered read-only, and mainnet broadcasts are locked off (`SYNQ_ALLOW_MAINNET_BROADCAST=false`).

## System overview

```text
  iOS app / iMessage     Web hub (Next.js)       Telegram, WhatsApp
  (apps/ios-messages)    (apps/web)              (packages/channels)
          \                    |                        /
           \                   |                       /
            v                  v                      v
        +----------------------------------------------------+
        |  API service  (apps/api + apps/demo composition)   |
        |  /v1 /v2 /v3 routes, channel ingress, brain        |
        +----------------------------------------------------+
              |                    |                  |
              v                    v                  v
     +----------------+   +-----------------+  +----------------+
     | Workspaces     |   | Agents (planners)|  | Read model /   |
     | Postgres:      |   | agent-runtime,   |  | Arc indexer    |
     | members, leads,|   | brain, strategies|  | (events, chain |
     | invoices,      |   | propose only     |  |  projections)  |
     | ledger, events |   +--------+---------+  +----------------+
     +--------+-------+            |
              \                    v
               \          +------------------+
                `-------> |  Kernel          |  deterministic:
                          |  mandates, risk, |  allow / deny /
                          |  approvals,      |  owner approval
                          |  grants          |
                          +--------+---------+
                                   | signed, single-use grant
                                   v
                          +------------------+
                          | Execution worker |  the only signer;
                          | outbox, journal, |  simulate, sign once,
                          | verify receipts  |  broadcast, reconcile
                          +--------+---------+
                                   v
                          +------------------+
                          | Arc testnet      |  Safe vaults + policy,
                          | contracts        |  milestone escrow, Amane
                          +------------------+
```

## The main moving parts

| Layer            | What it does                                                                                                                              | Where                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Clients          | iOS app and iMessage extension (SwiftUI), the Next.js web hub, Telegram and WhatsApp bots                                                 | `apps/ios-messages`, `apps/web`, `packages/channels`         |
| API              | Fastify services that serve `/v1`, `/v2` and the app contract `/v3`, plus chat webhooks                                                   | `apps/api`, `apps/demo`                                      |
| Workspaces       | The system of record in Postgres: principals, sessions, members, leads, offers, agreements, invoices, ledger, agent events, notifications | `packages/workspaces`, `packages/ledger`                     |
| Agents           | Model-backed planners (sales agent, finance team, treasury strategies). They read untrusted input and produce proposals                   | `packages/agent-runtime`, `packages/strategies`, `plugins/*` |
| Kernel           | Deterministic authorization with no model and no signer. Issues grants                                                                    | `packages/kernel`                                            |
| Execution worker | Holds the signing keys, submits transactions exactly once, verifies results                                                               | `workers/execution`                                          |
| Workflows        | Temporal workers for long-running flows                                                                                                   | `workers/workflow`                                           |
| Chain            | Arc testnet contracts and the registry that pins their code                                                                               | `contracts`, `packages/chain-registry`                       |

## Principles

1. **Agents propose, the Kernel authorizes, the worker signs.** No planner package can reach a signing primitive, directly or through dependencies. A script enforces it in CI ([Agent runtime boundaries](/docs/architecture/agent-runtime)).
2. **Humans approve with signatures.** Chat buttons, votes and model output are not approvals. The only approval input is a recovered EIP-712 signature from the right wallet. Login never approves money.
3. **Fail closed.** Unknown risk, stale data, unreachable screening or a mismatched code hash refuses the action.
4. **Exactly once.** Signed bytes are recorded before they can reach the network, and grants and nonces are single use ([Execution worker](/docs/architecture/execution-worker)).
5. **Chain is the proof.** A payment, funding or lease counts only after it is proven from a receipt or an indexed event, not because a server says so.
6. **Money is integer base units.** Amounts are decimal strings of base units tied to a registry asset; floats never carry money.

## Pages

- [Package map](/docs/architecture/package-map): every package, worker, plugin and app.
- [Anatomy of a money move](/docs/architecture/money-move): one payout from request to receipt.
- [Kernel and grants](/docs/architecture/kernel-and-grants).
- [Execution worker and outbox](/docs/architecture/execution-worker).
- [Chain registry](/docs/architecture/chain-registry).
- [Agent runtime boundaries](/docs/architecture/agent-runtime).
- [Events and notifications](/docs/architecture/events-notifications).
- [Storage and migrations](/docs/architecture/storage).
- [Testing strategy](/docs/architecture/testing).
- [CI and deploy](/docs/architecture/ci-deploy).

For concepts and guides see [Concepts](/docs/concepts) and [Guides](/docs/guides); for the security model see [Security](/docs/security).
