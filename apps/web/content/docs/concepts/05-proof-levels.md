---
title: Proof levels
description: The labels that tell you how strongly a claim is backed by evidence: LIVE_ARC_TESTNET, PROVIDER_SANDBOX, LOCAL_FIXTURE, NOT_VERIFIED, BLOCKED and LIVE_ARC_MAINNET.
---

Every agent event and many records carry a **proof level**. It answers one question: _how do we know this?_ A fixture and a chain transaction can look identical on screen, so the label keeps them apart.

| Level              | Meaning                                              | Example                                                                                  |
| ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `LIVE_ARC_TESTNET` | Read from or confirmed on Arc testnet                | A funded escrow whose `open` transaction was proven; a lease read live from the contract |
| `LIVE_ARC_MAINNET` | Confirmed on mainnet                                 | **Never produced in this demo**; mainnet is locked off                                   |
| `PROVIDER_SANDBOX` | Confirmed by a third-party provider's sandbox        | A provider sandbox result; a sandbox balance never funds Arc transactions                |
| `LOCAL_FIXTURE`    | Produced by a local test double                      | The execution mode `LOCAL_FIXTURE` used in offline runs                                  |
| `NOT_VERIFIED`     | Nothing external was checked                         | Two wallet signatures validated on the server; a model's proposal                        |
| `BLOCKED`          | Verification was attempted and refused or impossible | A lease that is not live on chain                                                        |

## How levels are assigned

- A model decision is `NOT_VERIFIED`. So is a sales-conversation step.
- Signing both sides of an agreement is `NOT_VERIFIED`: signatures were checked, nothing happened on chain.
- `FINALIZED` and `RECONCILED` statuses can come **only** from chain or ledger evidence, and carry the level of that evidence.
- For Amane leases: if the live read fails the level is `NOT_VERIFIED`, if the lease is live it is `LIVE_ARC_TESTNET`, and if the contract says it is not live it is `BLOCKED`.

## Reading levels in the product

- In **Agents**, each event row shows its proof level next to its status.
- Escrow shows `escrow.proofLevel` on the agreement.
- Leases show a level read at the moment you open the page.

> **Warning**
> A high-looking status with a low proof level means _recorded_, not _verified_. Do not treat `AUTHORIZED` with `NOT_VERIFIED` as money having moved.

## Claims the project itself labels

The repository records its own limits with the same words. For example, an x402 payment path is labelled `LOCAL_FIXTURE` because no public Arc-testnet facilitator and seller pair was available, and external wallet screening is blocked pending credentials. Treat anything without live-testnet evidence as unproven.

See [Agent events and idempotency](/docs/concepts/agent-events).
