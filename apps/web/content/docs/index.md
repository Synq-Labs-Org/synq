---
title: Synq documentation
description: Everything a user, business owner or integrator needs to know about Synq, a finance team in chat that never holds your keys.
---

Synq is a finance team in chat for freelancers and small businesses. Specialist software agents read invoices, cash and counterparty risk, answer questions and draft work. **A deterministic rulebook and your own wallet signature decide whether money moves.** An agent can propose; it can never approve.

> **Testnet**
> Everything in these docs runs on **Arc testnet** (chain id 5042002) with test USDC that has no monetary value. Synq is a preproduction demonstration. Nothing here moves real money, and mainnet broadcasting is locked off. See [Testnet and test USDC](/docs/getting-started/testnet).

```text
        +-----------------------------------------------------+
        |  You: iPhone app / iMessage  |  Web hub  |  Telegram |
        +------------------------------+-----------+----------+
                                       |
                              proposals and questions
                                       v
        +-----------------------------------------------------+
        |  Agents: sales, finance, risk   (propose, explain)   |
        +------------------------------+----------------------+
                                       |
                                       v
        +-----------------------------------------------------+
        |  Kernel: deterministic rules + your signed limits    |
        +------------------------------+----------------------+
                                       |  one-use grant
                                       v
        +-----------------------------------------------------+
        |  Executor -> Safe vault / escrow on Arc testnet      |
        +-----------------------------------------------------+
```

## Start here

| If you want to... | Read |
| --- | --- |
| Understand what Synq is and does | [What is Synq](/docs/getting-started) |
| Sign in and set up a workspace | [Sign in with a wallet](/docs/getting-started/sign-in), [Create a workspace](/docs/getting-started/workspaces) |
| Run a small business end to end | [Quickstart for a business](/docs/getting-started/quickstart-business) |
| Sign your first approval | [Approvals and signing](/docs/guides/approvals) |
| Let an AI assistant talk to clients | [The AI sales agent](/docs/guides/sales-agent), [Commercial policy](/docs/guides/commercial-policy) |
| Understand why it is safe | [Security overview](/docs/security), [What agents can and cannot do](/docs/security/agents) |
| Look up a word | [Glossary](/docs/glossary) |

## How the documentation is organised

| Section | What it covers |
| --- | --- |
| [Getting started](/docs/getting-started) | What Synq is, signing in, workspaces, roles, the three surfaces, testnet |
| [Guides](/docs/guides) | Step-by-step tasks: approvals, leads, offers, escrow, invoices, payouts, notifications |
| [Concepts](/docs/concepts) | How the pieces work: roles, vault, Kernel, EIP-712, proof levels, escrow, Amane |
| [Security](/docs/security) | Threat model, custody, sessions, privacy, the mainnet lock, reporting |
| [FAQ](/docs/faq) | Short answers and a table of error codes |
| [Glossary](/docs/glossary) | Every term used in these docs |

Further sections (architecture, API reference, contracts, Amane, self-hosting) are written for integrators and operators and appear in the navigation as they are published.

## Three promises worth remembering

1. **Signing in never approves money.** The login message says so in plain words, and the server refuses to treat it as anything else.
2. **A chat "yes" is not an approval.** Telegram, iMessage and the web chat can propose. Only an EIP-712 signature from the right wallet, over the exact terms, counts.
3. **Agents never hold treasury keys.** Money sits in a Safe multisig vault or an escrow contract. An agent that is fooled, confused or compromised still cannot sign for your owners.
