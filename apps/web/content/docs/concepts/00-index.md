---
title: Concepts
description: How the parts of Synq work and fit together: roles, vault, Kernel, signatures, proof, events, escrow and leased payments.
---

Read concepts when you want to know **why** Synq behaves as it does. Each page ends with links to the matching guide.

| Concept                                                          | One line                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [Workspaces and roles](/docs/concepts/workspaces-roles)          | Who can do what                                               |
| [The vault](/docs/concepts/vault)                                | A Safe multisig plus a policy contract that bounds spending   |
| [Kernel and execution grants](/docs/concepts/kernel-grants)      | Deterministic rules turn signed authority into one-use grants |
| [Approvals and EIP-712 signing](/docs/concepts/approvals-eip712) | What you sign, and why it is safe to read                     |
| [Proof levels](/docs/concepts/proof-levels)                      | How much evidence backs a claim                               |
| [Agent events and idempotency](/docs/concepts/agent-events)      | An append-only record of what agents did                      |
| [Sales agent limits](/docs/concepts/sales-agent-limits)          | What the sales AI can and cannot do                           |
| [Escrow and milestones](/docs/concepts/escrow-milestones)        | Funds that release step by step                               |
| [Amane leased payments](/docs/concepts/amane)                    | Pre-authorised agent payments enforced by a contract          |
| [Units and money](/docs/concepts/units-and-money)                | Base units, decimals and how amounts are written              |

## The central design rule

```text
   AGENTS            KERNEL                OWNERS               CHAIN
   propose   ---->   check rules   --->    sign exact    --->   contracts
   explain           against signed        terms with            enforce
   (no keys)         limits (no model)     own wallets           limits again
```

Every money movement is checked **at least three times by different parties**: a deterministic rule engine, the owners' signatures over exact terms, and a contract on chain that enforces limits no matter what Synq says.
