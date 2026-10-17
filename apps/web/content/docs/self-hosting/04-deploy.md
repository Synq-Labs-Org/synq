---
title: Deploy model
description: Container images, the two compose stacks, secrets layout and what a host needs.
---

Synq ships as container images and Compose files. Nothing here deploys itself; you run the commands.

> **Testnet**
> The stacks run against Arc testnet and force `SYNQ_ALLOW_MAINNET_BROADCAST=false`. The contracts are deployed separately with Foundry and recorded in the chain registry.

## Images

| Image  | Dockerfile                       | Runs                                                                                                                                                                         |
| ------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bot    | `infra/docker/bot.Dockerfile`    | `apps/demo/src/telegram.ts`: embedded API (port 3292), Telegram, workspaces, Kernel, execution wiring. State and evidence live on volumes, keys on a read-only secrets mount |
| Web    | `infra/docker/web.Dockerfile`    | The Next.js app on port 3100. `SYNQ_API_ORIGIN` is a build argument because Next.js fixes its rewrites at build time                                                         |
| API    | `infra/docker/api.Dockerfile`    | `apps/api/src/v1-server.ts` on port 3200, with a health check at `/v1/health`                                                                                                |
| Worker | `infra/docker/worker.Dockerfile` | The Temporal workflow worker with a health endpoint on port 3300                                                                                                             |

All images start from a digest-pinned Node 22 base, run as a non-root user, keep the code root-owned and read-only to the service, and take all configuration from the runtime environment. No keys or config are baked in.

## The single-host stack

`infra/compose.aws.yaml` is the stack used for the hosted site: Caddy (automatic TLS), the web app, the bot and Postgres 17. It expects the bot and web images to be built already (the project's CI builds them for arm64 and publishes them tagged by commit). The host:

1. Holds runtime configuration in a dotenv file and key material as individual files in a secrets directory mounted read-only into the bot at `/run/secrets/synq` (the testnet operator key and, once provisioned, the workspace operator and grant keys).
2. Sets `SYNQ_IMAGE_TAG`, `SYNQ_DOMAIN`, `SYNQ_ACME_EMAIL` and `POSTGRES_PASSWORD`.
3. Pulls images for the commit and runs `docker compose up -d --wait`.

The complete CI-to-host pipeline, including the polling timer, is in [CI and deploy](/docs/architecture/ci-deploy). To run it yourself you need your own domain pointing at the host, your own image registry (edit the image names in the compose file) and your own secret store; the scripts under `scripts/deploy` are written for one specific AWS account and shouldn't be reused as-is.

## The self-contained stack

`infra/compose.prod.yaml` builds its own images and runs everything on one machine:

```bash
export POSTGRES_PASSWORD=...        # your own value
export SYNQ_SECRETS_DIR=./secrets   # key files, mounted read-only
corepack pnpm stack:prod:up         # docker compose up -d --build --wait
```

It starts Postgres, Redis, a single-node Temporal, the API, the web app and the workflow worker. Only the web app is published, on loopback; the API is reached through the web app's rewrites or on `127.0.0.1:${SYNQ_API_PUBLISH_PORT}`. Containers run read-only with all capabilities dropped. Every service value comes from your shell environment or an untracked `.env` next to the file; names are listed in [Environment variables](/docs/self-hosting/environment). A `tunnel` profile adds a Cloudflare quick tunnel for demos.

## Secrets layout

| Secret                        | Variable that points to it                            | Notes                                                                |
| ----------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Testnet operator key          | `SYNQ_TESTNET_KEY_FILE`                               | Test-only key; fund it from the Circle faucet                        |
| Workspace operator key        | `SYNQ_WORKSPACE_OPERATOR_KEY_FILE`                    | Dedicated account; vault transactions and payouts                    |
| Workspace grant key           | `SYNQ_WORKSPACE_GRANT_KEY_FILE`                       | HMAC key for Kernel grants                                           |
| Kernel audit key, journal key | `SYNQ_KERNEL_AUDIT_KEY_FILE`, `SYNQ_JOURNAL_KEY_FILE` | At least 32 bytes each; not inside the data directories they protect |
| Amane agent key               | `SYNQ_AMANE_AGENT_KEY_FILE`                           | Different from the operator key                                      |
| APNs key                      | `SYNQ_APNS_KEY_FILE`                                  | Apple `.p8`                                                          |

Use file permissions of owner-only (mode 400) and the same non-root user the container runs as. Rotate by replacing the file and restarting.

## Operating notes

- Health: the API answers `/v1/health`, the workflow worker `GET /health` when a port is set.
- Backups: Postgres holds the system of record; the chain holds the money. Back up the database volume and the state volume (journal and audit logs). Keys are backed up separately and never with the database.
- Upgrades: the services run their module migrations at start, each in a transaction under an advisory lock. Roll back by restarting the previous image; migrations have `down` scripts for deliberate rollbacks.
- Reverse proxy: set `SYNQ_TRUST_PROXY` for the API so rate limits see client addresses, and terminate TLS at the proxy.
