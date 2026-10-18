---
title: Testing strategy
description: Unit, integration, security, contract and end-to-end suites, and how they are run.
---

Synq tests the properties it promises, not only the code paths. Most suites run offline; the ones that need services say so.

## Suites

| Suite                  | Command                                         | Needs                                                                                              | What it covers                                                                                                                                                      |
| ---------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit                   | `corepack pnpm test`                            | Nothing                                                                                            | Every `*.test.ts` outside integration: domain, Kernel, schemas, plugins, channels, contracts (TypeScript side), fixtures                                            |
| Contracts (TypeScript) | `corepack pnpm exec vitest run tests/contracts` | Nothing                                                                                            | The v3 API contract, generated OpenAPI/Swift/fixtures in step with the schemas, and the API reference drift test                                                    |
| Smart contracts        | `corepack pnpm test:contracts`                  | Foundry (`forge`)                                                                                  | `forge build` and `forge test` offline: unit, fuzz (256 runs) and invariant tests (depth 64, fail on revert) for every Solidity contract, plus a Monad fork profile |
| Integration            | `corepack pnpm test:integration`                | Foundry, Anvil, Postgres, Redis (`corepack pnpm infra:up`), Temporal dev server for workflow tests | Real Postgres stores, a local Anvil chain with deployed contracts, crash recovery, reorgs, durable outboxes, the API with real sessions                             |
| Security               | files under `tests/security`, `tests/gauntlet`  | Same as integration                                                                                | Abuse tests for the app API (sessions, leads, events and notifications, Amane), Kernel critic tests, and integrated attack scenarios                                |
| Plugin contracts       | `corepack pnpm test:plugins`                    | Nothing                                                                                            | Every plugin satisfies the plugin contract                                                                                                                          |
| Schema compatibility   | `corepack pnpm test:schema-compat`              | Nothing                                                                                            | Reference examples still parse                                                                                                                                      |
| Workflow               | `corepack pnpm test:workflow`                   | Temporal dev server                                                                                | Workflow replay and activities                                                                                                                                      |
| Brain and world        | `corepack pnpm test:brain`                      | Nothing                                                                                            | Reasoner ports and the world model                                                                                                                                  |
| Web end to end         | `corepack pnpm test:e2e`                        | Playwright, built web app                                                                          | Approval signing flows in a browser                                                                                                                                 |
| Testnet                | `corepack pnpm test:testnet`                    | A funded testnet key file and RPC                                                                  | Live Arc testnet scenarios; never run in CI                                                                                                                         |
| Live provider          | `test:live:*` scripts                           | Provider credentials                                                                               | Opt-in checks against sandbox providers                                                                                                                             |
| Indexer                | `corepack pnpm test:indexer`                    | Envio fork environment                                                                             | The Envio indexer                                                                                                                                                   |

## What the tests prove

- **Authorization is exact.** Tests mutate recipients, amounts, calldata, chain and expiry of grants and expect refusal.
- **Exactly once.** Crash-recovery tests kill the worker at each instrumented point and assert one broadcast.
- **Isolation.** Abuse tests call every route as the wrong tenant, the wrong role, with a stale session or a replayed refresh token, and expect `404` or `401`, not data.
- **Redaction.** Notification tests assert titles and push payloads never contain names, prices or addresses.
- **Contracts enforce independently.** Foundry fuzz and invariant tests attack the vault policy, the escrow and the mandate registry with random call sequences.
- **Contracts and docs match the code.** `tests/contracts/app-api.test.ts` checks the generated OpenAPI, Swift models and fixtures against the Zod schemas; `tests/contracts/docs-api.test.ts` checks the committed API reference against a fresh generation.

## Reports

`corepack pnpm test:report P01` runs the unit suite with machine-readable results under `reports/tests`, which CI uploads as an artifact. The vitest config runs two workers at a time. See [Running the test suites](/docs/self-hosting/testing) for setup.
