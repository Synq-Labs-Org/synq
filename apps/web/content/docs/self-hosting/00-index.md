---
title: Self-hosting
description: Run Synq locally, configure its services, run the tests and understand the deploy model.
---

Synq is open source and runs from the repository. This section is for people who want to develop against it or run their own instance. It does not contain values for any secret; it lists the names the services read and what they do.

> **Testnet**
> Everything runs on Arc testnet. Arc mainnet is registered read-only, and every service sets or enforces `SYNQ_ALLOW_MAINNET_BROADCAST=false`. Do not point a self-hosted instance at funds you cannot afford to lose; the contracts are unaudited testnet deployments.

## What you run

| Service                | Entry point                                                                                   | Needs                               | Notes                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot (the main service) | `corepack pnpm demo:telegram` (`apps/demo/src/telegram.ts`)                                   | Postgres, a Telegram bot token      | Embedded API on port 3200 by default (3292 in the container), Telegram, workspaces, Kernel and execution wiring. This is what the hosted deployment runs |
| `/v1` API server       | `corepack pnpm dev` is the read-model server; the `/v1` server is `apps/api/src/v1-server.ts` | Postgres, Redis, a Kernel audit key | Used by the self-contained `compose.prod.yaml` stack                                                                                                     |
| Web hub                | `corepack pnpm --filter @synq/web dev` (port 3100)                                            | The API origin                      | Next.js. `/api/v1`, `/v2` and `/v3` are rewritten to the API origin                                                                                      |
| Arc indexer            | `corepack pnpm indexer:arc`                                                                   | Postgres, an Arc RPC                | Follows finalized blocks and settles Memo invoice payments. It never signs                                                                               |
| Workflow worker        | `workers/workflow/src/local/worker-main.ts`                                                   | Temporal                            | Optional; for the long-running flows                                                                                                                     |
| Chat bridges           | `corepack pnpm channels:telegram:poll`, `corepack pnpm channels:imessage`                     | Tokens and an allowlist             | Optional ingress processes                                                                                                                               |

## Where to go next

- [Local development](/docs/self-hosting/local-development): prerequisites, install, infra, Anvil and running the bot and web.
- [Environment variables](/docs/self-hosting/environment): every variable the services read.
- [Running the test suites](/docs/self-hosting/testing): what each suite needs.
- [Deploy model](/docs/self-hosting/deploy): images, compose stacks and the secret layout.

For how the pieces fit together see [Architecture](/docs/architecture), and for a tour of using the product see [Getting started](/docs/getting-started).
