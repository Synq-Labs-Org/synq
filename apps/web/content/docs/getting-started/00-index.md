---
title: What is Synq
description: A plain explanation of Synq, who it is for, what it does and what it deliberately does not do.
---

Synq gives a small team the back office of a finance department, delivered where people already talk: iMessage, Telegram and the web. It is built for freelancers, small businesses and informal groups that handle money together.

> **Testnet**
> Synq runs on **Arc testnet** only. Balances are test USDC. Treat everything as a demonstration of how the product works, not as a place to keep value.

## What Synq does

| Job                  | What happens                                                                                              | Who decides                                   |
| -------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Talk to prospects    | An AI sales agent answers questions and proposes offers inside rules you sign                             | You sign the rules; a validator enforces them |
| Agree a deal         | Client and owner each sign the exact terms with their own wallets                                         | Both wallets                                  |
| Hold the deposit     | The client funds a milestone escrow contract from their own wallet                                        | The client                                    |
| Invoice and get paid | Issue invoices with a pay link; payments are matched from the chain                                       | The owner signs the invoice                   |
| Pay contractors      | Propose payouts to verified vendors; small ones follow the vault policy, large ones need owner signatures | The vault policy or the Safe owners           |
| Keep books           | Vendors, bills, budgets, revenue splits and an audit trail of agent work                                  | Owners approve changes                        |
| Keep you informed    | Generic push notifications and a live activity feed                                                       | Not applicable                                |

## What Synq deliberately does not do

- It does not let an agent sign for you. There is no model with a spending key.
- It does not treat a chat message, a button tap or a notification as consent to spend.
- It does not run on mainnet. The mainnet broadcast switch is off and refuses to turn on in the demo bot. See [Testnet-only status and the mainnet lock](/docs/security/testnet-lock).
- It does not make your clients become members of your workspace. Clients are outside counterparties with a narrow view.

## The pieces in one picture

```text
   iPhone app          Web hub            Telegram bot
   iMessage ext.    (/personal, /w/...)   (private + group chats)
        \                 |                  /
         \                |                 /
          +----------- Synq API ------------+
          |   workspaces, leads, offers,    |
          |   agreements, invoices, payouts |
          +---------+------------+----------+
                    |            |
             Kernel (rules)   Agent events (audit)
                    |
              Execution worker  ---> Arc testnet
                                     Safe vault, USDC, escrow
```

## Key ideas, in a sentence each

- **Workspace.** A shared space with a name, a kind (personal, group or business), members with roles, and optionally a vault. [Details](/docs/concepts/workspaces-roles).
- **Vault.** A Safe multisig on Arc testnet holding the workspace's USDC, with a policy contract that adds caps, a timelock and a pause. [Details](/docs/concepts/vault).
- **Kernel.** The deterministic rule engine that turns a proposal plus your signed authority into a one-use grant, or a refusal. [Details](/docs/concepts/kernel-grants).
- **Approval.** An EIP-712 typed-data signature from your wallet over exact terms. [Details](/docs/concepts/approvals-eip712).
- **Proof level.** A label on every agent event saying how strongly it is backed by evidence. [Details](/docs/concepts/proof-levels).

## Where to go next

1. [Sign in with a wallet](/docs/getting-started/sign-in)
2. [Create a workspace](/docs/getting-started/workspaces)
3. [Invite members and choose roles](/docs/getting-started/members-roles)
4. [Pick your surface](/docs/getting-started/surfaces)
5. [Get set up on testnet](/docs/getting-started/testnet)
