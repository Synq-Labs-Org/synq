---
title: Agent runtime boundaries
description: How planners are kept away from signers, and the CI check that enforces it.
---

Synq runs several model-backed agents (the sales agent for leads, the finance and agent teams, treasury strategy agents, channel assistants). They are useful because they read messy, untrusted input. They are dangerous for the same reason, so the architecture makes them unable to sign.

## Zones

| Zone                    | Packages                                                                           | May do                                      | May not                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planner                 | `agent-runtime`, `world-model`, `strategy-engine`, `strategies`, every `plugins/*` | Read data, call models, produce proposals   | Import any signing primitive or the execution worker, directly or transitively                                                                                      |
| Brain                   | `agent-runtime`, `world-model`, `plugins/openai`, `plugins/qwen`, `plugins/kimi`   | Structured reasoning over validated inputs  | Import `profile-vault`, `identity`, `wallet-core`, the execution worker or contract build output. Traveler, shipping and gift-code plaintext never reaches a prompt |
| Deterministic authority | `domain`, `schemas`, `kernel`                                                      | Decide, with no model and no I/O of its own | Import a model SDK, a plugin, or a signing primitive                                                                                                                |
| UI                      | `apps/web`                                                                         | Show and collect signatures                 | Reach signing code except through `packages/identity`, the human signing boundary                                                                                   |
| Signer                  | `workers/execution`, `packages/wallet-core`                                        | Hold keys and sign                          | (Nothing else may sign.)                                                                                                                                            |
| Perpl signer            | `workers/perpl-executor`                                                           | The legacy Perpl API-key signer             | Planner zones may not reach it or name its key files                                                                                                                |

## The enforcement script

`scripts/architecture.mjs` (run by `corepack pnpm architecture` and as part of `corepack pnpm lint`) parses every source file in `packages`, `apps`, `workers` and `plugins` with the TypeScript compiler and fails the build on any of:

- **Signing imports outside the signer packages**: `viem/accounts`, `@noble/curves`, `@scure/bip32` and `bip39`, ethers wallets, `node:crypto` signing functions, and viem wallet functions such as `createWalletClient`, `writeContract`, `signTypedData`, `sendTransaction`. Verification-only helpers (`verifyTypedData`, `recoverAddress`, `keccak256` and similar) are allowed.
- **Transitive signing authority**: a planner, UI or deterministic package that reaches a signing package through its dependency graph is reported with the path.
- **Brain zone leaks**: imports of the signer, identity, profile vault or execution secrets.
- **Deterministic authority impurity**: model SDK imports, plugin imports, signing.
- **Secret material in planner zones**: names such as `PRIVATE_KEY`, `MNEMONIC`, `*_KEY_FILE`, `AUDIT_KEY`, `JOURNAL_KEY`.
- **Dynamic code loading**: `eval`, `new Function`, computed `require`, dynamic `import()` and `process.getBuiltinModule` are rejected in planner, UI and deterministic zones, because they could dodge the checks above.
- **Unchecked `any`** outside tests and fixtures.
- **Key loaders**: planner packages may not reference functions named `load*Key`.
- **Raw chain-id comparisons**: see [Chain registry](/docs/architecture/chain-registry).
- **Legacy reach**: the active Arc runtime packages may not reach the archived Monad integrations, directly or through dependencies.
- **Dependency cycles** between workspace packages.
- **Workflow sandbox**: code under `workers/*/src/workflows/` runs in Temporal's deterministic replay sandbox and may import only `@temporalio/workflow`, `@temporalio/common`, `@synq/schemas` and `@synq/domain`, with no `fetch`, timers or `process` access.
- **Build output imports**: nothing may import from `contracts/out`, because CI typechecks before `forge build` runs.

## Untrusted input

Inside the planner zone, everything from outside is treated as data, never instruction: chat text, lead messages, invoices, web pages and model output (`agent-runtime/src/untrusted.ts`). A model result is validated against a strict schema before any other component sees it, and an agent can only narrow its own authority: a treasury schedule can be shrunk or paused by an agent, but widening it needs an owner approval bound to the exact new schedule digest.

## What a compromised agent can still do

- Draft messages and proposals. Proposals pass through the Kernel, which checks the mandate, recipient allowlist, caps, risk and approvals.
- Waste a limited amount of money inside an owner-signed mandate, bounded on chain by the vault policy or Amane lease caps.
- It cannot send to a new recipient, raise a cap, approve itself, or reach a key.

See [Security](/docs/security) for the threat model in plain language.
