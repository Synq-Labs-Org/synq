---
title: CI and deploy
description: What GitHub Actions checks on every push and how main reaches the production host.
---

> **Testnet**
> The hosted deployment at synqlabs.world runs against Arc testnet. The bot container is started with `SYNQ_ALLOW_MAINNET_BROADCAST=false`, and the canary spend cap is zero.

## CI (`.github/workflows/verify.yml`)

The `verify` workflow runs on every push (except to `deploy`) and every pull request. Third-party actions are pinned by commit SHA, Node is pinned (22.23.1) and the repository is checked out without persisted credentials.

| Job                                                | Steps                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript`                                       | `corepack pnpm install --frozen-lockfile`; Prettier check; ESLint; strict typecheck (API and web); dependency boundaries (`architecture`); whole-tree secret scan; schema compatibility; plugin contract tests; rejection of demo identities in shipped runtime; unit tests with machine-readable results; build; Envio indexer codegen and typecheck. Test results are kept as an artifact |
| `sast`                                             | CodeQL for JavaScript and TypeScript with the `security-extended` queries; any error-level finding fails the job. Results stay inside the job                                                                                                                                                                                                                                               |
| `contracts`                                        | `forge fmt --check`, `forge build`, `forge test` with Foundry pinned                                                                                                                                                                                                                                                                                                                        |
| `integration` (needs `typescript` and `contracts`) | Preflight, forge build, a pinned Temporal CLI with a verified checksum, `corepack pnpm infra:up` (Postgres 17 and Redis from `infra/compose.yaml`), then `corepack pnpm test:integration` against Anvil, Postgres and Redis                                                                                                                                                                 |
| `images` (main only)                               | Builds the **bot** and **web** images natively on arm64, matching the Graviton host, and pushes them to GitHub Container Registry tagged with the commit SHA. Registry layer caching is used. Images are public like the source; no runtime config or keys enter an image                                                                                                                   |
| `promote` (main only, needs all jobs above)        | Fast-forwards the `deploy` branch to the green commit                                                                                                                                                                                                                                                                                                                                       |

Locally the same gates are `corepack pnpm verify` (preflight, typecheck, lint, secrets, format check, build, unit tests, contract tests, integration tests).

## Deploy model

Continuous delivery is pull-based. **Nothing is built on the host.**

```text
 push to main
     |
     v
 GitHub Actions: typescript, sast, contracts, integration  (all green)
     |
     v
 images job: build arm64 bot + web  --> container registry :<commit sha>
     |
     v
 promote job: fast-forward `deploy` branch
     |
     v   host polls `deploy` every 2 minutes (systemd timer)
 host-deploy.sh:
   1. fetch `deploy` with a read-only deploy key; stop if it has not moved
   2. refresh runtime config and key files from the cloud secret store
   3. pull the images for that exact commit (a missing image leaves the running stack untouched)
   4. docker compose up -d --wait   (health-gated restart)
   5. keep this deploy's images and the previous one's for rollback; prune the rest
   6. record the deployed commit
```

### The host

`infra/aws/synq.cfn.yaml` defines one small Graviton EC2 instance in a CloudFormation stack: an instance profile that can read only its own parameters from the secret store, an Elastic IP, a gp3 root volume, and a security group that allows only HTTP and HTTPS. There is no SSH; operators use the cloud's session manager. The stack, runtime config, deploy key, bootstrap, status, logs and an operator console are driven by `scripts/deploy/aws.sh` from an operator's machine. Values are never printed.

### The stack (`infra/compose.aws.yaml`)

| Service    | Image                                    | Role                                                                                                                                                                                |
| ---------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `caddy`    | Caddy 2.10                               | TLS termination for synqlabs.world, its `www` redirect and its `api` host, with HSTS and security headers                                                                           |
| `web`      | Built from `infra/docker/web.Dockerfile` | Next.js on port 3100, read-only filesystem. Its `/api/v1`, `/v2` and `/v3` rewrites target the bot. The API origin is a build argument because Next.js fixes rewrites at build time |
| `bot`      | Built from `infra/docker/bot.Dockerfile` | The `apps/demo/src/telegram.ts` service: embedded API on port 3292, Telegram, workspaces, Kernel, execution wiring                                                                  |
| `postgres` | Postgres 17.6, digest-pinned             | Application database on a named volume, tuned for a small host                                                                                                                      |

All containers run with `no-new-privileges`, capped log size and memory limits. Secrets are mounted read-only from a host directory that the deploy script fills from the secret store; the bot runs as a non-root user with state and evidence on volumes.

### Other images and a self-contained stack

`infra/docker/api.Dockerfile` (the `/v1` API) and `worker.Dockerfile` (the Temporal workflow worker) are not part of the single-host deployment but are used by `infra/compose.prod.yaml`, a deploy-ready full stack with API, web, workflow worker, Postgres, Redis and a single-node Temporal that builds its own images (`corepack pnpm stack:prod:up`). It publishes only the web app, on loopback. See [Self-hosting](/docs/self-hosting).

## What does not change at deploy time

- Contracts: they are deployed deliberately with Foundry scripts and recorded in the chain registry, never by the host.
- Keys: created and stored by the operator in the secret store, never baked into images or the repository. The secret scanner checks the whole tree in CI.
- Mainnet: the broadcast lock stays on.
