---
title: Local development
description: Prerequisites, install, local infrastructure, Anvil, and running the bot and web app.
---

## Prerequisites

| Tool                | Version                              | Why                                                                                       |
| ------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------- |
| Node.js             | 22 (`>=22 <23`)                      | Runtime; `corepack pnpm preflight` fails on any other major                               |
| Corepack and pnpm   | pnpm 10.28.2 via Corepack            | Package manager. Use `corepack pnpm ...`; `scripts/bin/pnpm` is a shim that does the same |
| Docker with Compose | Recent                               | Postgres 17 and Redis for integration tests and local runs                                |
| Foundry             | `forge` and `anvil` (CI uses v1.2.3) | Contract build and tests; the local chain                                                 |
| Temporal CLI        | 1.8.x                                | Only for workflow integration tests and `workflow:dev`                                    |
| Playwright browsers | Optional                             | Only for `test:e2e`                                                                       |

The Foundry libraries (`forge-std`, Safe v1.4.1) are vendored in `contracts/lib`, so no submodule step is needed in a normal checkout.

## Install

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm preflight
```

`preflight` checks the Node major version, the lockfile, that `forge` and `anvil` are installed, and that the network profile is valid.

## Local infrastructure

```bash
corepack pnpm infra:up
```

This starts `infra/compose.yaml`: Postgres 17 on `127.0.0.1:55432` (a database named `synq_test`, with a local-only throwaway superuser defined in the compose file) and Redis 7 on `127.0.0.1:56379`. Both bind to loopback only. Tests create their own databases on this server.

If you already run a Postgres of your own, point the tests at it with `SYNQ_TEST_PG_BASE` (for example `postgresql://postgres@127.0.0.1:55433`); the individual suites then create databases such as `synq_m2_workspaces` under that base. Individual suites also accept their own override variables, listed in [Environment variables](/docs/self-hosting/environment#tests-and-tooling).

## Anvil and the local demo

Everything that touches contracts has a local mode that needs only Anvil and Foundry:

```bash
corepack pnpm build
forge build --root contracts --offline
corepack pnpm demo            # scripted local demo against a fresh Anvil chain
```

The demo starts its own Anvil, deploys the contracts, runs the flow and tears the chain down; set `SYNQ_KEEP_LOCAL_CHAIN=1` to keep it. Integration tests also start Anvil themselves (`SYNQ_ANVIL_BIN` overrides the binary). The `local/anvil` profile (chain id 31337) is what CI uses as `SYNQ_NETWORK`.

## Run the bot

The bot is the main service. It needs a Telegram bot token from BotFather, a Postgres database and an operator key file for testnet transactions.

```bash
corepack pnpm infra:up
export TELEGRAM_BOT_TOKEN=...            # your own bot's token, never committed
export SYNQ_SKIP_INFRA=1                 # you already ran infra:up
corepack pnpm demo:telegram
```

What the process does at start:

- Refuses to run if `SYNQ_ALLOW_MAINNET_BROADCAST=true`, and sets it to `false`.
- Reads an optional operator env file in your home directory without printing or overriding what is already set.
- Defaults `SYNQ_TESTNET_KEY_FILE` to a file in `~/.synq` (create the key there yourself; fund it from the Circle faucet for Arc testnet) and generates the Kernel audit and journal integrity keys under its local state directory if they are missing.
- Connects to Postgres (`SYNQ_TELEGRAM_DATABASE_URL`, which defaults to the local compose database `synq_telegram_e2e`), runs migrations, and starts the API on `SYNQ_API_HOST:SYNQ_API_PORT` (default `127.0.0.1:3200`).
- Enables workspaces, which power the web hub and the iOS app, only when `SYNQ_WORKSPACES_ENABLED=1`. Then `SYNQ_ORIGIN` and `SYNQ_RP_ID` must match the web origin you use (for local runs `http://localhost:3100` and `localhost`).
- Turns on the Arc business features when their keys are set: `SYNQ_DEALROOM_LINK_KEY` (Deal Room) and `SYNQ_PAY_LINK_KEY` (invoice checkout), with `SYNQ_ARC_VENDORS`, `SYNQ_ARC_OWNER` and the other `SYNQ_ARC_*` settings.
- Optional integrations switch on by their credentials: `OPENAI_API_KEY` (assistant model), `DUFFEL_TEST_TOKEN` (flights and stays in test mode), `SEARCHAPI_KEY` and `LITHIC_API_KEY` with `LITHIC_ENV=sandbox` (gifts).

To run chat ingress as a separate process: `corepack pnpm channels:telegram:poll` (long polling) and `corepack pnpm channels:imessage` (a BlueBubbles or Beeper bridge, off unless `SYNQ_IMESSAGE_TRANSPORT` is set and an allowlist is given).

## Run the web app

```bash
corepack pnpm --filter @synq/web dev
```

The dev server listens on port 3100. It proxies `/api/v1`, `/api/v2` and `/api/v3` to `SYNQ_API_ORIGIN` (default `http://127.0.0.1:3200`, matching the bot's default API port). Set `SYNQ_API_ORIGIN` before starting if your API is elsewhere. Next.js reads it at build time for production builds. Passkeys bind to the relying party id, so sign-in only works when `SYNQ_RP_ID` on the API equals the host you browse (`localhost` locally).

## Run the Arc indexer

```bash
corepack pnpm indexer:arc                      # follow the chain
corepack pnpm indexer:arc -- --from N --to M   # bounded run, then exit
```

Set `SYNQ_INDEXER_DATABASE_URL`, optionally `SYNQ_ARC_TESTNET_RPC_URL` and `SYNQ_ARC_INDEXER_WALLETS` (see the environment page).

## Useful scripts

| Command                                           | Purpose                                                    |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `corepack pnpm typecheck`                         | `tsc` for the repo and for the web app                     |
| `corepack pnpm lint`                              | ESLint plus the architecture check                         |
| `corepack pnpm format` / `format:check`           | Prettier                                                   |
| `corepack pnpm secrets`                           | Secret scan of the tracked tree                            |
| `corepack pnpm architecture`                      | Dependency and signing boundaries                          |
| `node --import tsx scripts/contracts-generate.ts` | Regenerate the OpenAPI document, Swift models and fixtures |
| `corepack pnpm docs:api`                          | Regenerate the API reference pages                         |
| `corepack pnpm registry:probe`                    | Compare registry pins with a live RPC                      |
