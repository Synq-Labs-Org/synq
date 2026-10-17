---
title: What agents can and cannot do
description: A plain table of what Synq's AI agents may do, what they can only propose, and what is impossible for them by construction.
---

Synq's agents are language-model and rule-based helpers: a **sales agent** for client conversations, and a **finance team** (a supervisor with specialists such as CFO and risk roles) that answers questions in chat. They are useful because they read and write quickly. They are safe because they have no authority of their own.

## Can

| Agent        | Can                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Sales agent  | Ask questions, propose offer terms for the validator, record a client's acceptance of the latest offer, hand over to a person |
| Finance team | Read a fresh snapshot of the workspace, answer questions with cited sources and freshness, explain splits and payouts         |
| Both         | Write typed events to the audit trail                                                                                         |

## Can only propose

| Action                          | Who decides                                                 |
| ------------------------------- | ----------------------------------------------------------- |
| An offer                        | The deterministic validator against the owner-signed policy |
| A payout                        | The proposer's request goes to review; the owners sign      |
| A vendor, budget or bill change | The current Safe owner quorum signs                         |
| A revenue split                 | Owners' signed policy plus Kernel grants per leg            |

The finance team can end a reply with `PENDING_OWNER_SIGNATURE` (a payout is waiting for owners) or `USE_EXPLICIT_PAYMENT_REQUEST_FOR_WALLET_REVIEW` (it cannot guess; ask in the exact form).

## Cannot

| Cannot                                         | Why                                                           |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Sign a transaction for your vault              | No agent holds an owner key or a Safe signer key              |
| Approve their own proposals                    | Approval is an EIP-712 signature from a current owner         |
| Change a policy, budget or owner list          | Needs owner signatures; vault changes need a timelock         |
| Spend outside a mandate                        | The Kernel denies; grants are exact-call and one-use          |
| Pay an unverified or cooling vendor            | Finance refuses (`VENDOR_NOT_VERIFIED`, `VENDOR_COOLING`)     |
| Turn a chat "yes" into consent                 | The bot replies that chat never approves money                |
| See other leads, books or vaults (sales agent) | It receives only one lead's transcript and the catalog        |
| Act after a person takes over                  | Handling is checked at write time                             |
| Edit or delete history                         | Events and lead messages are append-only                      |
| Use mainnet                                    | Broadcast is disabled and the Kernel accepts only Arc testnet |

## The one exception, and why it is bounded

An **Amane lease** lets Synq's agent key pay _without a new signature_. That authority exists only because an owner signed a lease on chain, and the contract enforces the recipient, per-action limit, total and expiry. Revoking the lease removes it. See [Amane leased payments](/docs/concepts/amane).

## Prompt injection

Everything a client or a chat participant writes reaches a model wrapped as **untrusted evidence**. The system prompt says so. More importantly, nothing the model returns can authorise money: a perfectly successful injection could at worst make the agent say something odd, ask for a person, or propose terms the validator rejects.

## A note on honesty

Models make mistakes. The design assumption is that they will. The cost of a mistake is bounded by what the rules and signatures permit, not by how well the model behaves. See [Sales agent limits](/docs/concepts/sales-agent-limits) and [Kernel and grants](/docs/concepts/kernel-grants).
