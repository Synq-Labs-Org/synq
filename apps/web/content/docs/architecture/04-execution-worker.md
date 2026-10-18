---
title: Execution worker and outbox
description: The restricted executor, the only package that signs, and how it sends each payment exactly once.
---

`workers/execution` (`@synq/execution-worker`) is the **restricted executor**. It and `packages/wallet-core` are the only packages the architecture check permits to use signing primitives; planner packages, the web UI and the Kernel cannot reach them, even transitively.

## Order of checks before anything is signed

From `workers/execution/src/arc.ts`, for every transfer:

1. The RPC answers with the chain id we expect.
2. The chain profile allows mutation (Arc testnet does; Arc mainnet is read-only).
3. The token is a registry asset whose deployed bytecode hash matches the pinned hash.
4. The call simulates successfully.
5. The payer can cover value plus worst-case gas. On Arc, the ERC-20 amount and the gas come from the same USDC balance, so they are checked together, and fees respect the 20 gwei base-fee floor.
6. Value always moves through the 6-decimal ERC-20 interface. Native-value sends are refused.

The Kernel grant is verified and consumed before this, as described in [Kernel and grants](/docs/architecture/kernel-and-grants).

## The outbox: exactly once across crashes

`arc-outbox.ts`, `pg-outbox.ts`, `vault-outbox.ts`:

- The signed transaction bytes and their hash are recorded under the payment's **idempotency key** before the network can see them. A Postgres store can record the signed payout and the grant's consumption in **one transaction**, so a crash can never leave a consumed grant without a record, or a record whose grant could be admitted again.
- Every later attempt for the same key (retry, restart, duplicate message) recovers from the record: it reads the receipt, or rebroadcasts the very same signed bytes (same hash and nonce, which the chain accepts at most once). It never prepares or signs a second transaction for a key.
- If the nonce was consumed by something else, or the outcome is ambiguous, the record stops at `NEEDS_REVIEW`. Nothing pays again automatically.

| Outbox state   | Meaning                                            |
| -------------- | -------------------------------------------------- |
| `SIGNED`       | Bytes recorded; broadcast and confirmation pending |
| `CONFIRMED`    | Receipt verified against the grant                 |
| `FAILED`       | Reverted or rejected, not retried blindly          |
| `NEEDS_REVIEW` | A person must decide                               |

Relays that share an operator key take a per-sender lock so nonces do not collide.

## What lives here

| Area                         | Files                                                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transfers and vault payments | `arc.ts`, `vault.ts`, `vault-outbox.ts`, `workspace-vault.ts`, `workspace-payout.ts`                                                                                                                                |
| Escrow                       | `escrow.ts`, `workspace-escrow.ts`, `agreement-escrow.ts`, `pg-escrow.ts`: opening and releasing [SynqMilestoneEscrow](/docs/contracts/milestone-escrow) deals, and proving a client's funding transaction on chain |
| Amane                        | `amane-pay.ts`: the [leased payment pipeline](/docs/amane/integration)                                                                                                                                              |
| Cross-chain                  | `cctp.ts`, `cctp-saga.ts`, `gateway.ts`, `pg-cctp-gateway.ts`: CCTP and Gateway sagas where a burn with an unknown outcome is never resubmitted                                                                     |
| Revenue and treasury         | `split-executor.ts`, `workspace-splits.ts`, `workspace-treasury.ts`, `council-payout.ts`, `workspace-governance.ts`                                                                                                 |
| Authority and keys           | `workspace-authority.ts`, `workspace-signing.ts`, `integrity.ts` (journal and audit key loading), `x402-signer.ts`, `circle-wallets.ts`                                                                             |
| Reconciliation               | `reconciliation.ts`, `journal.ts`, `persistence.ts`                                                                                                                                                                 |

## Keys

The worker loads keys only from files whose paths come from the environment (for example `SYNQ_TESTNET_KEY_FILE` or `SYNQ_WORKSPACE_OPERATOR_KEY_FILE`), never from values in the environment. Integrity keys for the journal and the Kernel audit log must be at least 32 bytes and are refused if the key file lives inside a protected data directory (the directories that hold the data they protect). Different roles use different keys: the Amane agent key must differ from the operator key. See [Environment variables](/docs/self-hosting/environment) for the file settings.

> **Security**
> The worker is deliberately small and boring. Anything that needs judgment (is this recipient legitimate, is this price fair) is decided before it, by the Kernel and risk engines; the worker only checks that what it is asked to sign is exactly what was authorized.
