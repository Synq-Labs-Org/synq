---
title: Environment variables
description: Every environment variable the Synq services read, with purpose, whether it is required and its default.
---

This page lists the names the code reads (found in `apps`, `workers`, `packages` and `plugins`), never values. Rules that apply everywhere:

- **Secrets are files, not values.** Anything that holds key material is read from a file whose path is in a `*_KEY_FILE` variable. Keep those files outside the repository and outside the data directories they protect, with owner-only permissions.
- **Compose passes unset variables as empty strings.** The code treats an empty string as unset where noted.
- **Mainnet is locked.** `SYNQ_ALLOW_MAINNET_BROADCAST` must stay `false`. The bot refuses to start when it is `true`.
- **Flags** written `0`/`1` accept exactly those strings.

"Required" means the service fails to start (or the feature stays off) without it.

> **Warning**
> Some variables below belong to the archived Monad-era integrations (marked legacy). They are listed because the code still reads them; none is needed for the Arc features.

## Network and safety

| Variable                                                                        | Purpose                                                                                                                             | Required | Default                                           |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| `SYNQ_ALLOW_MAINNET_BROADCAST`                                                  | Allows mainnet transactions. Must be `false`; the bot and workflow worker enforce it                                                | Optional | `false`                                           |
| `SYNQ_MAINNET_CANARY_MAX_USD`                                                   | Cap in USD for a guarded mainnet canary spend; `0` disables                                                                         | Optional | none (disabled)                                   |
| `SYNQ_NETWORK`                                                                  | Active chain profile (`local/anvil`, `sandbox/monad-testnet`, `proof/monad-mainnet`). CI uses `local/anvil`; the bot sets it itself | Optional | `sandbox/monad-testnet` for the read-model server |
| `SYNQ_ARC_TESTNET_RPC_URL`                                                      | Preferred Arc testnet RPC; the registry's public list is the fallback                                                               | Optional | Registry list                                     |
| `SYNQ_ARC_RPC_URL`                                                              | Arc RPC for the workspace, Deal Room, invoice and business features                                                                 | Optional | Registry list                                     |
| `SYNQ_ARC_MAINNET_RPC_URL`                                                      | Arc mainnet RPC (read-only profile)                                                                                                 | Optional | Registry list                                     |
| `SYNQ_SEPOLIA_RPC_URL`, `SYNQ_BASE_SEPOLIA_RPC_URL`, `SYNQ_ARB_SEPOLIA_RPC_URL` | RPC for the Circle CCTP testnet source routes                                                                                       | Optional | Registry list                                     |

## Bot (`apps/demo/src/telegram.ts`)

| Variable                     | Purpose                                                    | Required                                    | Default                                        |
| ---------------------------- | ---------------------------------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`         | Telegram bot token                                         | Required                                    | none                                           |
| `SYNQ_TELEGRAM_DATABASE_URL` | Postgres connection string                                 | Optional                                    | The local compose database `synq_telegram_e2e` |
| `SYNQ_API_HOST`              | API listen address                                         | Optional                                    | `127.0.0.1` (container sets `0.0.0.0`)         |
| `SYNQ_API_PORT`              | API listen port                                            | Optional                                    | `3200` (container sets `3292`)                 |
| `SYNQ_SKIP_INFRA`            | `1` skips starting local Docker infrastructure             | Optional                                    | unset (starts infra)                           |
| `SYNQ_TESTNET_KEY_FILE`      | File holding the testnet operator key                      | Required for on-chain features              | A file in the home `.synq` directory           |
| `SYNQ_KERNEL_AUDIT_KEY_FILE` | Kernel audit-log integrity key file (at least 32 bytes)    | Optional (generated locally)                | Generated under the local state directory      |
| `SYNQ_JOURNAL_KEY_FILE`      | Execution journal integrity key file                       | Optional (generated locally)                | Generated under the local state directory      |
| `SYNQ_WEB_BASE_URL`          | Public web origin used in links and cards                  | Optional                                    | `http://localhost:3000` for business links     |
| `SYNQ_ORIGIN`                | Exact web origin allowed for cookie sessions and passkeys  | Required when workspaces are enabled        | Local relying-party origin otherwise           |
| `SYNQ_RP_ID`                 | WebAuthn relying party id (the web host name)              | Optional here; required by the `/v1` server | Local relying-party id                         |
| `SYNQ_WORKSPACES_ENABLED`    | `1` turns on workspaces (the web hub and iOS app backend)  | Optional                                    | off                                            |
| `SYNQ_LEGACY_MONAD_FUNDS`    | `1` enables legacy group fund writes (archived Monad flow) | Optional (legacy)                           | off                                            |
| `SYNQ_ASSISTANT_TZ`          | Time zone the fund assistant uses                          | Optional                                    | `Asia/Kolkata`                                 |

## Workspaces, vaults and Arc business

| Variable                           | Purpose                                                                                                                           | Required                                  | Default                             |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------- |
| `SYNQ_WORKSPACE_OPERATOR_KEY_FILE` | Key file of the dedicated operator account that submits vault and payout transactions                                             | Required for vault activation and payouts | none                                |
| `SYNQ_WORKSPACE_GRANT_KEY_FILE`    | Key file (HMAC) for Kernel grants in workspaces                                                                                   | Required for vault activation and payouts | none                                |
| `SYNQ_WORKSPACE_DAILY_GAS_WEI`     | Daily gas budget the sponsor may spend on vault creation, in wei                                                                  | Optional                                  | `1000000000000000000`               |
| `SYNQ_WORKSPACE_CREATION_GAS_WEI`  | Maximum gas cost reserved for creating one vault, in wei                                                                          | Optional                                  | `200000000000000000`                |
| `SYNQ_SCREENING_PROVIDER`          | Sanctions screening mode; `OFAC_SDN_LIST_ONLY` selects the labelled list-only screen. Empty means unavailable, which fails closed | Optional                                  | unset                               |
| `SYNQ_SCREENING_API_KEY`           | Credential for an external screening provider                                                                                     | Optional                                  | none                                |
| `SYNQ_ARC_BUSINESS`                | `0` turns off the Arc business features unless workspaces are enabled                                                             | Optional                                  | on                                  |
| `SYNQ_ARC_BUSINESS_NAME`           | Display name of the business                                                                                                      | Optional                                  | `Synq demo business`                |
| `SYNQ_ARC_OWNER`                   | Owner address of the business vault (checked against the vault's owners on chain)                                                 | Optional                                  | First owner of the vault            |
| `SYNQ_ARC_VENDORS`                 | Contractors, as comma-separated `Name:0xAddress:verifiedAtUnix` entries. Payable only while the vault allowlists them             | Optional                                  | none (contractor payments stay off) |
| `SYNQ_ARC_FLOOR_USDC`              | Operating cash floor in USDC the council keeps                                                                                    | Optional                                  | Built-in default floor              |
| `SYNQ_ARC_EXPLORER_TX_URL`         | Explorer transaction URL prefix for links in events                                                                               | Optional                                  | The Arc testnet explorer            |
| `SYNQ_DEALROOM_LINK_KEY`           | Hex key that signs Deal Room links; enables the Deal Room                                                                         | Optional                                  | none (off)                          |
| `SYNQ_PAY_LINK_KEY`                | Hex key that signs invoice pay links; enables invoice checkout                                                                    | Optional                                  | none (off)                          |
| `SYNQ_MEMO_WATCHER`                | `1` starts the invoice Memo payment watcher in the API server                                                                     | Optional                                  | off                                 |
| `SYNQ_GITHUB_TOKEN`                | Token for verifying GitHub evidence in Deal Room milestones                                                                       | Optional                                  | unauthenticated requests            |
| `SYNQ_GOVERNANCE_LOG_KEY`          | Hex MAC key (at least 32 bytes) for the delegation log                                                                            | Required where the delegation log is used | none                                |
| `SYNQ_AMANE_AGENT_KEY_FILE`        | Key file of Synq's Amane agent; must differ from the operator key                                                                 | Optional                                  | none (Amane off)                    |
| `SYNQ_AMANE_ACCOUNT_CODEHASH`      | Pinned code hash of the Amane account release                                                                                     | Optional                                  | none (Amane off)                    |

## `/v1` API server (`apps/api/src/v1-server.ts`)

| Variable                                 | Purpose                                                                                                        | Required                      | Default                     |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------- |
| `SYNQ_DATABASE_URL`                      | Postgres connection string                                                                                     | Required                      | none                        |
| `SYNQ_PROFILE`                           | Chain profile (`local/anvil` relaxes the Kernel requirements below)                                            | Optional                      | `sandbox/monad-testnet`     |
| `SYNQ_RP_ID`                             | WebAuthn relying party id                                                                                      | Required                      | none                        |
| `SYNQ_ORIGIN`                            | Web origin                                                                                                     | Required                      | none                        |
| `SYNQ_API_ADMIN_TOKEN`                   | Admin bearer token (at least 32 characters)                                                                    | Required                      | none                        |
| `SYNQ_API_HOST`, `SYNQ_API_PORT`         | Listen address and port                                                                                        | Optional                      | `127.0.0.1`, `3200`         |
| `SYNQ_DEPLOYMENTS_DIR`                   | Directory of contract deployment records                                                                       | Optional                      | `contracts/deployments`     |
| `SYNQ_EXECUTION_MODULE`                  | Address of the execution module                                                                                | Optional                      | none                        |
| `SYNQ_SEND_MANDATE_ID`                   | Trusted mandate id for the Send route                                                                          | Optional                      | `synq_send`                 |
| `SYNQ_RATE_LIMIT_CAPACITY`               | Token-bucket capacity per client                                                                               | Optional                      | `30`                        |
| `SYNQ_RATE_LIMIT_REFILL_PER_SECOND`      | Token-bucket refill rate                                                                                       | Optional                      | `1`                         |
| `SYNQ_TRUST_PROXY`                       | Fastify `trustProxy` setting (for example loopback and private ranges) so client addresses come from the proxy | Optional                      | none                        |
| `SYNQ_RM_DATABASE_URL`                   | Read-model Postgres                                                                                            | Required unless `local/anvil` | none                        |
| `SYNQ_RM_REDIS_URL`                      | Read-model Redis                                                                                               | Required unless `local/anvil` | none                        |
| `SYNQ_KERNEL_AUDIT_KEY_FILE`             | Kernel audit key file                                                                                          | Required unless `local/anvil` | none                        |
| `SYNQ_KERNEL_PLUGINS_FILE`               | Kernel plugin manifest file                                                                                    | Required unless `local/anvil` | none                        |
| `LITHIC_WEBHOOK_SECRET`                  | Secret for verifying Lithic webhooks at `/v1/webhooks/lithic`                                                  | Optional                      | none (route answers 404)    |
| `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` | Temporal connection for workflow routes                                                                        | Optional                      | `127.0.0.1:7233`, `default` |

## Read-model server (`apps/api/src/server.ts`, `corepack pnpm dev`)

| Variable               | Purpose                        | Required | Default                 |
| ---------------------- | ------------------------------ | -------- | ----------------------- |
| `SYNQ_PORT`            | Listen port                    | Optional | `3000`                  |
| `SYNQ_RM_DATABASE_URL` | Postgres                       | Required | none                    |
| `SYNQ_RM_REDIS_URL`    | Redis                          | Required | none                    |
| `SYNQ_RM_SCHEMA`       | Postgres schema name           | Optional | `synq_read_model`       |
| `SYNQ_RM_REORG_WINDOW` | Blocks kept for reorg handling | Optional | `200`                   |
| `SYNQ_DEPLOYMENTS_DIR` | Deployment records             | Optional | `contracts/deployments` |

## Arc indexer (`apps/api/src/arc-indexer.ts`)

| Variable                           | Purpose                                   | Required | Default            |
| ---------------------------------- | ----------------------------------------- | -------- | ------------------ |
| `SYNQ_INDEXER_DATABASE_URL`        | Postgres (falls back to `DATABASE_URL`)   | Required | none               |
| `DATABASE_URL`                     | Fallback Postgres connection string       | Optional | none               |
| `SYNQ_ARC_INDEXER_WALLETS`         | Comma-separated wallets to watch          | Optional | none               |
| `SYNQ_ARC_INDEXER_START_BLOCK`     | First block when the stream has no cursor | Optional | Current head       |
| `SYNQ_ARC_INDEXER_CONFIRMATIONS`   | Extra depth below the finalized block     | Optional | `0`                |
| `SYNQ_ARC_INDEXER_BATCH`           | Blocks per batch                          | Optional | `2000`             |
| `SYNQ_ARC_INDEXER_POLL_MS`         | Idle poll interval                        | Optional | `2000`             |
| `SYNQ_ARC_INDEXER_STREAM`          | Stream id                                 | Optional | `arc-testnet:main` |
| `SYNQ_ARC_INDEXER_RECONCILE_EVERY` | Batches between wallet reconciliations    | Optional | `30`               |

## Chat channels

| Variable                                                                                                                                                                  | Purpose                                                                                        | Required                   | Default                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------------------------------------------- |
| `SYNQ_TELEGRAM_MODE`                                                                                                                                                      | `off`, `webhook` or `poll`                                                                     | Optional                   | `webhook` when a token and webhook secret are set, `poll` with only a token, otherwise `off` |
| `TELEGRAM_WEBHOOK_SECRET`                                                                                                                                                 | Secret header for the Telegram webhook                                                         | Required in `webhook` mode | none                                                                                         |
| `SYNQ_TELEGRAM_ALL_MESSAGES`                                                                                                                                              | `1` answers every group message, not only mentions                                             | Optional                   | `0`                                                                                          |
| `SYNQ_TELEGRAM_LOGIN_REQUIRED`                                                                                                                                            | `1` requires linked web login for Telegram users                                               | Optional                   | `0`                                                                                          |
| `SYNQ_TELEGRAM_REQUIRE_CHAT_ADMIN`                                                                                                                                        | `1` requires a chat admin to link a group                                                      | Optional                   | `1`                                                                                          |
| `SYNQ_CHAT_LINK_PENDING_TTL_SECONDS`                                                                                                                                      | Lifetime of a pending chat link (min 60)                                                       | Optional                   | `86400`                                                                                      |
| `SYNQ_CHANNEL_CARDS`                                                                                                                                                      | `1` sends rich cards                                                                           | Optional                   | `1`                                                                                          |
| `SYNQ_CARD_BANNERS`                                                                                                                                                       | `1` adds banner art to cards                                                                   | Optional                   | `1`                                                                                          |
| `SYNQ_CARD_THEME`                                                                                                                                                         | Card theme id                                                                                  | Optional                   | `ascii`                                                                                      |
| `SYNQ_CARD_LINK_KEY`                                                                                                                                                      | Key (at least 32 characters) that signs links in cards                                         | Optional                   | none                                                                                         |
| `SYNQ_CARD_LINK_TTL_SECONDS`                                                                                                                                              | Card link lifetime (300 to 604800)                                                             | Optional                   | `43200`                                                                                      |
| `SYNQ_CHANNEL_NOTIFY_MS`                                                                                                                                                  | Notification pump interval (min 1000)                                                          | Optional                   | `5000`                                                                                       |
| `SYNQ_CHANNEL_MEMORY`                                                                                                                                                     | `1` turns on consented chat memory                                                             | Optional                   | `0`                                                                                          |
| `SYNQ_CHANNEL_MEMORY_PURGE_MS`                                                                                                                                            | Memory purge interval (min 10000)                                                              | Optional                   | `600000`                                                                                     |
| `SYNQ_EXPLORER_TX_URL`                                                                                                                                                    | Explorer prefix for chat receipts                                                              | Optional                   | A legacy Monad testnet explorer URL                                                          |
| `LINQ_API_KEY`, `LINQ_WEBHOOK_SECRET`, `LINQ_BASE_URL`                                                                                                                    | Linq messaging provider; the webhook secret enables it                                         | Optional                   | none                                                                                         |
| `SYNQ_IMESSAGE_TRANSPORT`                                                                                                                                                 | `off`, `bluebubbles` or `beeper`                                                               | Optional                   | `off`                                                                                        |
| `SYNQ_IMESSAGE_ALLOWED_CHATS`                                                                                                                                             | Comma-separated allowlist; required whenever iMessage is on                                    | Required if on             | none                                                                                         |
| `SYNQ_IMESSAGE_BOT_HANDLE`, `SYNQ_IMESSAGE_MENTION_WORDS`                                                                                                                 | Bot handle and mention words                                                                   | Optional                   | none, `synq`                                                                                 |
| `SYNQ_IMESSAGE_WEBHOOK_TOKEN`                                                                                                                                             | Token for iMessage webhooks                                                                    | Optional                   | none                                                                                         |
| `SYNQ_IMESSAGE_POLL_MS`                                                                                                                                                   | Poll interval (min 1000)                                                                       | Optional                   | `3000`                                                                                       |
| `BLUEBUBBLES_URL`, `BLUEBUBBLES_PASSWORD`                                                                                                                                 | BlueBubbles server address and credential                                                      | Optional                   | `http://127.0.0.1:1234`, none                                                                |
| `BEEPER_DESKTOP_URL`, `BEEPER_ACCESS_TOKEN`                                                                                                                               | Beeper Desktop address and credential                                                          | Optional                   | `http://localhost:23373`, none                                                               |
| `SYNQ_WHATSAPP_TOKEN`, `SYNQ_WHATSAPP_PHONE_NUMBER_ID`, `SYNQ_WHATSAPP_APP_SECRET`, `SYNQ_WHATSAPP_VERIFY_TOKEN` (at least 16 characters), `SYNQ_WHATSAPP_ALLOWED_WA_IDS` | WhatsApp Cloud API 1:1 chats; all five are required together, otherwise the channel is blocked | Optional                   | none                                                                                         |
| `SYNQ_WHATSAPP_GRAPH_VERSION`, `SYNQ_WHATSAPP_GRAPH_BASE_URL`                                                                                                             | Graph API version and base URL overrides                                                       | Optional                   | Library defaults                                                                             |

## Web app (`apps/web`)

| Variable                              | Purpose                                                                                    | Required | Default                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------- |
| `SYNQ_API_ORIGIN`                     | API origin that `/api/v1`, `/v2`, `/v3` proxy to. Read at build time for production builds | Optional | `http://127.0.0.1:3200` (the image build sets the bot's internal address) |
| `SYNQ_IOS_APP_ID`                     | Application id published in the Apple app-site-association file for universal links        | Optional | The project's registered app id                                           |
| `PORT`                                | Web server port in the container                                                           | Optional | `3100`                                                                    |
| `NODE_ENV`, `NEXT_TELEMETRY_DISABLED` | Standard Next.js settings                                                                  | Optional | `production` in images                                                    |

## Push notifications (APNs)

All four are needed for push to work; if any is missing the sender reports `APNS_NOT_CONFIGURED`.

| Variable             | Purpose                             | Required          | Default |
| -------------------- | ----------------------------------- | ----------------- | ------- |
| `SYNQ_APNS_KEY_FILE` | Path to the Apple `.p8` signing key | Required for push | none    |
| `SYNQ_APNS_KEY_ID`   | Key id                              | Required for push | none    |
| `SYNQ_APNS_TEAM_ID`  | Apple developer team id             | Required for push | none    |
| `SYNQ_APNS_TOPIC`    | App bundle id                       | Required for push | none    |

## Workflow worker and commerce

| Variable                                                                                        | Purpose                                                                                   | Required                             | Default                                                              |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------- |
| `TEMPORAL_ADDRESS`                                                                              | Temporal server `host:port`                                                               | Optional                             | `127.0.0.1:7233`                                                     |
| `TEMPORAL_NAMESPACE`                                                                            | Namespace                                                                                 | Optional                             | `default`                                                            |
| `TEMPORAL_CLI`                                                                                  | Temporal CLI binary for `workflow:dev`                                                    | Optional                             | `temporal`                                                           |
| `SYNQ_TQ_ECONOMIC`, `SYNQ_TQ_APPROVAL`, `SYNQ_TQ_STRATEGY`, `SYNQ_TQ_OPERATIONS`                | Task queue names                                                                          | Optional                             | `synq-economic`, `synq-approval`, `synq-strategy`, `synq-operations` |
| `SYNQ_WORKFLOW_DEPLOYMENT`                                                                      | Worker deployment name                                                                    | Optional                             | `synq-workflows`                                                     |
| `SYNQ_WORKFLOW_BUILD_ID`                                                                        | Worker build id                                                                           | Optional                             | none                                                                 |
| `SYNQ_WORKFLOW_MANIFEST`                                                                        | Path to the deployment manifest the worker loads                                          | Required in containers               | Dev derives it                                                       |
| `SYNQ_WORKFLOW_FAMILIES`                                                                        | Which task-queue families this worker serves                                              | Optional                             | All                                                                  |
| `SYNQ_WORKFLOW_WORKER_ID`                                                                       | Worker identity                                                                           | Optional                             | `local-workflow-worker`                                              |
| `SYNQ_WORKFLOW_HEALTH_HOST`, `SYNQ_WORKFLOW_HEALTH_PORT`                                        | Health endpoint (`GET /health`); off unless a port is set                                 | Optional                             | `127.0.0.1`; container sets port `3300`                              |
| `SYNQ_WORKFLOW_LOG_LEVEL`                                                                       | Log level                                                                                 | Optional                             | `WARN`                                                               |
| `SYNQ_WORKFLOW_DATABASE_URL`, `SYNQ_WORKFLOW_DEV_DIR`                                           | Dev server database and scratch directory                                                 | Optional                             | Local defaults                                                       |
| `SYNQ_DCA_POLICY_FILE`                                                                          | JSON map of DCA policies per strategy                                                     | Optional                             | none                                                                 |
| `SYNQ_ECONOMIC_GRANT_KEY`                                                                       | Hex key for the economic (commerce) Kernel authority                                      | Required for commerce execution      | none                                                                 |
| `SYNQ_ECONOMIC_MANDATES_FILE`                                                                   | Mandates installed at start                                                               | Optional                             | none                                                                 |
| `SYNQ_PROFILE_VAULT_KEY`                                                                        | Key that seals gift codes and purchase secrets                                            | Required for gift and purchase flows | none                                                                 |
| `SYNQ_BITREFILL_APPROVALS`                                                                      | `kernel-grant` routes Bitrefill approvals through Kernel grants                           | Optional                             | off                                                                  |
| `SYNQ_LITHIC_SIM_MERCHANT`                                                                      | Simulated merchant for Lithic sandbox authorizations                                      | Optional                             | none                                                                 |
| `CROSSMINT_API_KEY`, `CROSSMINT_ENV`, `CROSSMINT_PAYMENT_CHAIN`, `CROSSMINT_PAYMENT_RECIPIENTS` | Crossmint staging purchases. `CROSSMINT_ENV` must be `staging`; recipients must be pinned | Optional                             | env `staging`                                                        |
| `LITHIC_API_KEY`, `LITHIC_ENV`                                                                  | Lithic virtual cards. `LITHIC_ENV` must be `sandbox`                                      | Optional                             | `sandbox`                                                            |
| `BITREFILL_API_KEY` or `BITREFILL_API_ID` with `BITREFILL_API_SECRET`                           | Bitrefill credentials                                                                     | Optional                             | none                                                                 |
| `RELOADLY_CLIENT_ID`, `RELOADLY_CLIENT_SECRET`, `RELOADLY_ENV`                                  | Reloadly gift cards; `RELOADLY_ENV` must be `sandbox`                                     | Optional                             | `sandbox`                                                            |
| `SEARCHAPI_KEY`, `SERPAPI_KEY`                                                                  | Read-only product search                                                                  | Optional                             | none                                                                 |
| `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_ENV`                                              | eBay search                                                                               | Optional                             | `SANDBOX` unless `EBAY_ENV=production`                               |
| `DUFFEL_TEST_TOKEN`                                                                             | Duffel test-mode token (`duffel_test_...`); live keys are refused                         | Optional                             | none                                                                 |
| `SYNQ_X402_ARC_SELLER_URL`                                                                      | Arc x402 seller endpoint for paid data                                                    | Optional                             | none                                                                 |

## Models and identity

| Variable                                                 | Purpose                                                                    | Required | Default                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------- | -------- | ------------------------------------- |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`      | OpenAI Chat Completions as the Brain reasoner                              | Optional | Plugin defaults                       |
| `QWEN_API_KEY` (or `DASHSCOPE_API_KEY`), `QWEN_BASE_URL` | Qwen reasoner                                                              | Optional | Plugin defaults                       |
| `KIMI_API_KEY` (or `MOONSHOT_API_KEY`), `KIMI_BASE_URL`  | Kimi reasoner                                                              | Optional | `https://api.moonshot.ai/v1` base URL |
| `MASTRA_TELEMETRY_DISABLED`                              | Disables Mastra telemetry                                                  | Optional | unset                                 |
| `DYNAMIC_API_KEY`, `DYNAMIC_ENVIRONMENT_ID`              | Dynamic wallet identity provider (`DYNAMIC_ENVIRONMENT_ID` must be a UUID) | Optional | none                                  |

## Legacy and companion tools

| Variable                                                                                                                                                                                  | Purpose                                                      | Required | Default                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------- | ----------------------- |
| `SYNQ_PERPL_API_KEY_FILE`, `SYNQ_PERPL_READ_KEY_FILE`, `SYNQ_PERPL_TRADE_KEY_FILE`                                                                                                        | Perpl executor key files by scope (legacy)                   | Optional | none                    |
| `SYNQ_API_URL`                                                                                                                                                                            | Synq API URL for the MetaMask plugin                         | Optional | `http://127.0.0.1:3200` |
| `SYNQ_MM_GROUPS`, `SYNQ_MM_JOURNAL_DIR`, `SYNQ_MM_SESSION_DIR`, `SYNQ_MM_MAX_CONTRIBUTION`, `SYNQ_MM_RPC_URL`                                                                             | MetaMask Agent Wallet plugin settings (legacy Monad testnet) | Optional | Home-directory defaults |
| `SYNQ_DEMO_AMOUNT`, `SYNQ_KEEP_LOCAL_CHAIN`, `SYNQ_DEMO_DATABASE_URL`, `SYNQ_SEND_EVIDENCE_DIR`, `SYNQ_SEND_EXECUTION_MODE`, `SYNQ_P08_E2E_DATABASE_URL`, `SYNQ_E2E_TESTNET_DATABASE_URL` | Demo drivers (`corepack pnpm demo`, send demo, testnet e2e)  | Optional | Local defaults          |

## Container stack variables

Used by `infra/compose.aws.yaml` and `infra/compose.prod.yaml` (the compose files themselves, not the services).

| Variable                                         | Purpose                                                              | Required             | Default        |
| ------------------------------------------------ | -------------------------------------------------------------------- | -------------------- | -------------- |
| `POSTGRES_PASSWORD`                              | Database password for the stack                                      | Required             | none           |
| `SYNQ_DOMAIN`, `SYNQ_ACME_EMAIL`                 | Public domain and the ACME contact for Caddy                         | Required (aws stack) | none           |
| `SYNQ_SECRETS_DIR`                               | Host directory mounted read-only at `/run/secrets/synq` (prod stack) | Optional             | `./secrets`    |
| `SYNQ_API_PUBLISH_PORT`, `SYNQ_WEB_PUBLISH_PORT` | Loopback ports the prod stack publishes                              | Optional             | `3200`, `3100` |

## Tests and tooling

These are read by test suites and scripts, not by the services. They are listed so a clean machine can run everything.

| Variable                                                                                                                                                                                                                                                                                                              | Purpose                                                                     | Default                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------- |
| `SYNQ_TEST_PG_BASE`                                                                                                                                                                                                                                                                                                   | Base Postgres URL for integration suites; each suite adds its database name | The compose Postgres on `127.0.0.1:55432`      |
| `SYNQ_WORKSPACES_TEST_DATABASE_URL`, `SYNQ_DURABLE_TEST_DATABASE_URL`, `SYNQ_CROSS_TEST_DATABASE_URL`, `SYNQ_P11_TEST_DATABASE_URL`, `SYNQ_RISK_TEST_DATABASE_URL`, `SYNQ_HEDGE_TEST_DATABASE_URL`, `SYNQ_CHANNELS_DATABASE_URL`, `SYNQ_EXECUTION_DATABASE_URL`, `SYNQ_WORKSPACES_MIGRATION_DATABASE_URL` and similar | Per-suite database overrides                                                | `SYNQ_TEST_PG_BASE` plus a suite database name |
| `SYNQ_RM_TEST_REDIS_URL`, `SYNQ_P06_TEST_REDIS_URL`                                                                                                                                                                                                                                                                   | Redis for read-model and world-model tests                                  | Compose Redis on `127.0.0.1:56379`             |
| `SYNQ_ANVIL_BIN`                                                                                                                                                                                                                                                                                                      | Anvil binary path                                                           | `anvil` on the path                            |
| `SYNQ_RM_FORK_TESTS`                                                                                                                                                                                                                                                                                                  | `1` enables the Envio fork tests (`test:indexer`)                           | off                                            |
| `SYNQ_LIVE_P08`, `SYNQ_LIVE_P09`, `SYNQ_P10_LIVE`, `SYNQ_ARC_LIVE_READS`                                                                                                                                                                                                                                              | Opt-in switches for live-network tests                                      | off                                            |
| `SYNQ_EVIDENCE_DIR`, `SYNQ_FUNDING_EVIDENCE_DIR`, `SYNQ_KEY_DIR`                                                                                                                                                                                                                                                      | Where scripts write evidence and keep local keys                            | Local directories                              |
