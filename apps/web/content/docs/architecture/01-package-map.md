---
title: Package map
description: Every app, package, worker and plugin in the monorepo and what it is for.
---

The repository is a pnpm workspace (`pnpm-workspace.yaml`). Package names use the `@synq/` scope. Dependency direction is policed by `scripts/architecture.mjs` (see [Agent runtime boundaries](/docs/architecture/agent-runtime)); a package on the active Arc runtime may not depend, even indirectly, on the archived Monad integrations marked **legacy** below.

## Apps

**`apps/api`** (`@synq/api`) holds the HTTP service building blocks: the `/v1` API server with its Kernel runtime, rate limiting and read model; chat ingress (`channel-server`, `channel-routes`, `channels-poll`, an iMessage bridge); the Deal Room, invoice, funding, mandate and send routes; the Lithic webhook; the Arc indexer service entry (`corepack pnpm indexer:arc`); and the read-model server.

**`apps/demo`** (`@synq/demo`) is the composition root. Despite the name it contains the production wiring: `telegram.ts` builds the single "bot" service (embedded API, Telegram, workspaces, Kernel, execution wiring) that the deploy runs, and `app-routes.ts`, `workspace-routes.ts`, `workspace-http.ts` implement the `/v3` and `/v2` workspace routes. It also holds the local and testnet demo drivers (`local.ts`, `testnet.ts`), the APNs sender, the approvals inbox and the Duffel and gift flows.

**`apps/web`** (`@synq/web`) is the Next.js web hub. It serves the signed-in hub (personal context, workspaces, approvals, notifications), passkey and wallet sign-in, the approval and signing pages, public deal and invoice pages, and this documentation. `next.config.ts` rewrites `/api/v1`, `/api/v2` and `/api/v3` to the API origin and sets the security headers and content security policy.

**`apps/ios-messages`** is the native iOS project: the SwiftUI app (`SynqApp`), the iMessage extension (`SynqMessages`, `SynqMessagesExtension`) and shared code (`SynqShared`). Its types are generated from the API contract (`packages/contracts/generated/swift`).

## Core packages

**`packages/domain`** has the shared primitives: chain-and-precision-explicit `Money` (integer base units of a registry asset), settlement environments, lifecycle state machines, error types and Postgres helpers. It has no I/O and no signing.

**`packages/schemas`** defines the Zod schemas that cross trust boundaries: intents, approvals, evidence, events, plugin manifests, workflow payloads, hedge and world types, card schemas, network profiles and the EIP-712 typed data shapes.

**`packages/contracts`** (`@synq/contracts`) is the v3 app API contract: every route, request and response schema, fixtures, and the generators for OpenAPI and Swift models. The [API reference](/docs/api) is generated from it.

**`packages/chain-registry`** pins networks, assets and contract addresses with expected code hashes. It is the only place that may name a chain id or address. See [Chain registry](/docs/architecture/chain-registry).

**`packages/kernel`** is deterministic authorization: canonical intents, mandates, the policy engine, freshness gates, risk and simulation gates, approvals, grants, the budget ledger, audit log and the Arc payment authority. See [Kernel and grants](/docs/architecture/kernel-and-grants).

**`packages/identity`** handles wallet and passkey identity: login challenges, channel links, membership, delegation, grant approvals and provider adapters. It is the human signing boundary used by the web app.

**`packages/workspaces`** is the workspace system of record in Postgres: principals, sessions and device sessions, members and roles, vault setup, leads and offers, agreements, invoices and books, contributions, governance, Amane accounts, agent events and notifications, with versioned migrations.

**`packages/ledger`** is the document-linked double-entry ledger (every entry balances per asset and carries chain evidence), plus the Arc chain indexer core that follows finalized blocks with reorg handling.

**`packages/invoices`** issues invoices only on the issuer's EIP-712 signature, gives each version a unique payment reference, and settles an invoice only from a matching on-chain Memo payment.

**`packages/payables`** is accounts payable and the contractor network: verified payout addresses with history, pending address changes, and deterministic risk flags for payables.

**`packages/allocations`** runs revenue-split and allocation policies, forecasts and waterfalls, with owner-signed policy and mandates.

**`packages/treasury`** models group money: contributions credited from final on-chain transfers, charters, and spend ballots.

**`packages/governance`** covers councils, ballots, delegation logs, policy changes and custody rules, for example an M-of-N owner council whose decisions execute at most once.

**`packages/dealroom`** is the Deal Room: draft, rules, typed data and evidence for negotiated deals between a business and a client, with Postgres storage and chat cards.

**`packages/settlement`** is the Settlement Fabric: providers declare what they can actually execute, a router selects by capability, and ledgers keep simulated, sandbox and real value apart. Includes Arc routes, reservations, x402 and grant ledgers.

**`packages/funding`** covers funding and send flows: routing, conversions, sessions, guards, and evidence. Parts target the legacy AUSD flow.

**`packages/offer-exchange`** matches and books offers (travel and similar) behind a capability model and ports.

**`packages/read-model`** is the projection layer: events from an indexer become a read model with freshness and authorization rules, a Kernel adapter and Postgres storage.

**`packages/world-model`** builds the world snapshot agents reason over: Arc balances, capability graph and metadata, through ports.

**`packages/risk-engine`** has deterministic portfolio, hedge and risk-packet math.

**`packages/strategy-engine`** is the deterministic DCA evaluator: given a strategy and the clock as an input it returns `EXECUTE`, `SKIP` or `ESCALATE` with no model call and no I/O. **`packages/strategies`** builds Arc treasury strategies on top (registry assets only, owner-owned caps, pause and stop controls).

**`packages/agent-runtime`** is the agent layer: the Brain (a vendor-neutral structured reasoner port), Mastra-based runtime, the finance team and agent team, role review, record and replay, untrusted-input handling and observability. Planner zone: no signing.

**`packages/channels`** is the chat layer: Telegram, iMessage, WhatsApp and Linq gateways, commands, rich cards and themes, durable delivery that holds ambiguous provider results for review, and Postgres stores.

**`packages/profile-vault`** keeps sensitive purchase data (traveler details, shipping addresses, gift codes) sealed. Planner and Brain code may not import it.

**`packages/plugin-sdk`** defines the contract plugins implement. **`packages/metamask-delegation`** adapts MetaMask delegations to group Safes (legacy AUSD flow). **`packages/metamask-synq-plugin`** is a plugin for the MetaMask Agent Wallet CLI: read groups, contribute and propose mandate spends.

## Workers

**`workers/execution`** (`@synq/execution-worker`) is the restricted executor and the only package allowed to sign: Arc transfers, the exactly-once outbox, vault operator payments, escrow open and release, Amane payments, CCTP and Gateway sagas, split and payout executors, integrity-key loading and chain reconciliation. See [Execution worker and outbox](/docs/architecture/execution-worker).

**`workers/workflow`** (`@synq/workflow-worker`) runs Temporal workflows and activities for long-lived flows (approvals, operations, economic and strategy task queues, commerce providers). Workflow code runs in a replay sandbox and may import only deterministic modules.

**`workers/perpl-executor`** is the Perpl perpetuals executor with its own key scopes (legacy, Monad-era).

## Plugins

Plugins are adapters to external systems. Planner-side plugins read and plan; signing stays in the executor.

| Plugin                                                                 | Purpose                                                                                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `plugins/amane`                                                        | Typed adapter over the pinned Amane SDK for leased agent PAY. See [Amane](/docs/amane)                                     |
| `plugins/arc-swap`                                                     | Same-chain USDC and EURC swaps on Arc testnet through Circle App Kit Swap, with owner-set limits                           |
| `plugins/circle-app-kit`                                               | Checks what Circle App Kit asks a wallet to sign before anything is signed                                                 |
| `plugins/circle-cctp`                                                  | Circle CCTP V2 transfers as a saga (burn, attestation, mint); plans and tracks, never signs                                |
| `plugins/circle-earn`                                                  | Circle App Kit Earn vault discovery, quote hygiene and yield decision gate                                                 |
| `plugins/circle-gas`                                                   | Network-fee planning for Arc (USDC gas) and Circle source chains                                                           |
| `plugins/circle-gateway`                                               | Circle Gateway unified USDC balance accounting                                                                             |
| `plugins/circle-paymaster`                                             | ERC-4337 USDC gas on the chains Circle lists; refuses Arc because Arc needs none                                           |
| `plugins/usyc`                                                         | USYC permissioned money-market fund access on Arc testnet, entitlement-checked on chain                                    |
| `plugins/chainlink-cre`                                                | Chainlink CRE risk pipeline and registry reader                                                                            |
| `plugins/risk`                                                         | Counterparty screening (OFAC SDN list, fail closed), risk rules, cases and audit                                           |
| `plugins/commerce`                                                     | Purchases and gifts: product search, Crossmint (staging), Lithic (sandbox) virtual cards, Bitrefill, checkout and journeys |
| `plugins/duffel`                                                       | Duffel flights and stays in test mode, with booking attempts                                                               |
| `plugins/openai`, `plugins/qwen`, `plugins/kimi`                       | Model providers behind the Brain port; output is untrusted until validated                                                 |
| `plugins/agora`                                                        | Typed Agora API surface for AUSD (legacy)                                                                                  |
| `plugins/aurora`, `plugins/kuru`, `plugins/perpl`, `plugins/layerzero` | Archived Monad-era integrations (legacy); kept with their tests but unreachable from the Arc runtime                       |

## Other top-level directories

| Directory      | Contents                                                                                                |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `contracts`    | Solidity sources, Foundry tests and deployment records. See [Smart contracts](/docs/contracts)          |
| `vendor/amane` | Pinned Amane tarballs and `MANIFEST.json`                                                               |
| `sources`      | `arc_registry.json` and other pinned source data                                                        |
| `indexer`      | The Envio indexer project                                                                               |
| `infra`        | Compose files, Dockerfiles, Caddy and CloudFormation. See [CI and deploy](/docs/architecture/ci-deploy) |
| `scripts`      | Build, preflight, secret scan, architecture check, generators, proofs and operator tooling              |
| `tests`        | Cross-package unit, integration, security and end-to-end suites                                         |
