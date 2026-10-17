---
title: Running the test suites
description: What each test command needs and how to run it on a clean machine.
---

All commands run from the repository root with `corepack pnpm`. See [Testing strategy](/docs/architecture/testing) for what the suites prove.

## No services needed

```bash
corepack pnpm test                                  # unit tests (excludes *.integration.test.ts)
corepack pnpm exec vitest run tests/contracts       # API contract, generated files, docs drift
corepack pnpm test:plugins                          # plugin contract tests
corepack pnpm test:schema-compat                    # reference examples still parse
corepack pnpm test:brain                            # reasoner ports and world model
corepack pnpm typecheck                             # tsc for the repo and the web app
corepack pnpm lint                                  # ESLint and the architecture check
corepack pnpm format:check                          # Prettier
corepack pnpm secrets                               # secret scan of the tracked tree
```

Run one file or test with `corepack pnpm exec vitest run tests/kernel/some.test.ts -t "name"`.

If the API schema changes, regenerate with `node --import tsx scripts/contracts-generate.ts` and `corepack pnpm docs:api`; the contract and docs drift tests fail until you do.

## Foundry contract tests

```bash
corepack pnpm test:contracts     # forge build and forge test, offline
forge fmt --root contracts --check
```

Fuzz tests run 256 cases and invariant tests run with depth 64 and fail on revert. A separate `fork` profile exists for tests against a live fork and is skipped by default.

## Integration tests

These need Docker, Foundry and (for workflow tests) the Temporal CLI.

```bash
corepack pnpm infra:up           # Postgres on 55432, Redis on 56379, bound to loopback
corepack pnpm preflight
corepack pnpm test:integration
```

`test:integration` runs `forge build` and then Vitest over an explicit list of integration files: Anvil with deployed contracts, Postgres stores, durable outboxes and crash recovery, the API with real sessions, the abuse and gauntlet suites, and the Amane and escrow flows. The default database server is the compose Postgres; to use your own, set `SYNQ_TEST_PG_BASE` to its URL without a database name and each suite creates its own database there.

A few suites need services beyond the compose file and are skipped or fail without them: the workflow tests need a Temporal dev server (`temporal server start-dev`, or `TEMPORAL_CLI` pointing at the binary), the read-model fork tests need `SYNQ_RM_FORK_TESTS=1` and an Envio environment, and the web end-to-end test needs Playwright browsers.

## Other suites

| Command                                                         | Needs                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `corepack pnpm test:workflow`                                   | Temporal dev server                                                                     |
| `corepack pnpm test:e2e`                                        | Playwright, Postgres, a built web app (`tests/e2e/prepare-db.ts` prepares the database) |
| `corepack pnpm test:indexer`                                    | `SYNQ_RM_FORK_TESTS=1`, Envio                                                           |
| `corepack pnpm test:gauntlet`                                   | The scripted security gauntlet                                                          |
| `corepack pnpm test:testnet`                                    | A funded testnet key file and an Arc RPC; hits the real testnet                         |
| `corepack pnpm test:live:p08`, `test:live:p09`, `test:live:p10` | Opt-in switches and provider credentials                                                |
| `corepack pnpm test:mm-plugin`                                  | The MetaMask plugin's own package tests                                                 |

## Running everything

`corepack pnpm verify` chains preflight, typecheck, lint, secrets, format check, build, unit tests, contract tests and integration tests. It is the closest local equivalent of the CI jobs described in [CI and deploy](/docs/architecture/ci-deploy).

> **Note**
> Live and testnet suites spend testnet funds and call third-party sandboxes. They are never run in CI and are guarded by explicit environment switches.
