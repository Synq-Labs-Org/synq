---
title: Workspaces and roles
description: The four roles and a table of what each one can do, read from the rules in the code.
---

A workspace has members. Each member has exactly one role: `OWNER`, `ADMIN`, `MEMBER` or `VIEWER`. Roles are checked on the server for every request; hiding a button in the app is never the only protection.

## Role summary

| Role     | Meant for                                       | Signing authority                 |
| -------- | ----------------------------------------------- | --------------------------------- |
| `OWNER`  | Founders and partners who control the money     | Yes: owners are the vault signers |
| `ADMIN`  | A trusted operator who runs the inbox and sales | No                                |
| `MEMBER` | A collaborator                                  | No                                |
| `VIEWER` | An observer                                     | No                                |

## Permission table

| Capability                                                          | Owner |           Admin           | Member | Viewer |
| ------------------------------------------------------------------- | :---: | :-----------------------: | :----: | :----: |
| See the workspace, status and member list (wallet shortened)        |  Yes  |            Yes            |  Yes   |  Yes   |
| Invite people                                                       |  Yes  |            No             |   No   |   No   |
| Invite a co-owner (only while forming)                              |  Yes  |            No             |   No   |   No   |
| Propose and sign the vault setup                                    |  Yes  |            No             |   No   |   No   |
| Read agent runs and events                                          |  Yes  |            Yes            |  Yes   |   No   |
| Read the lead inbox and transcripts                                 |  Yes  |            Yes            |   No   |   No   |
| Create a client invitation                                          |  Yes  |            Yes            |   No   |   No   |
| Take over, hand back, freeze, escalate a lead                       |  Yes  |            Yes            |   No   |   No   |
| Message a client as staff (after takeover)                          |  Yes  |            Yes            |   No   |   No   |
| Propose a commercial policy                                         |  Yes  |            Yes            |   No   |   No   |
| Sign (activate) a commercial policy                                 |  Yes  |            No             |   No   |   No   |
| Send an offer (HUMAN handling)                                      |  Yes  | Yes, within the threshold |   No   |   No   |
| Send an offer above the owner threshold                             |  Yes  |            No             |   No   |   No   |
| See and sign a deal agreement                                       |  Yes  |         View only         |   No   |   No   |
| Propose a payout                                                    |  Yes  |            Yes            |  Yes   |   No   |
| Approve or cancel a payout                                          |  Yes  |            No             |   No   |   No   |
| Change vendors, budgets, bills (finance changes)                    |  Yes  |            No             |   No   |   No   |
| Create and issue invoices                                           |  Yes  |            No             |   No   |   No   |
| See invoices, books, balances                                       |  Yes  |            Yes            |  Yes   |  Yes   |
| Set revenue rules                                                   |  Yes  |            No             |   No   |   No   |
| Register Amane accounts, leases and jobs                            |  Yes  |            No             |   No   |   No   |
| See Amane leases and jobs                                           |  Yes  |            Yes            |   No   |   No   |
| Be a party in a deal with a contact                                 |  Yes  |            Yes            |  Yes   |   No   |
| Bind a Telegram group                                               |  Yes  |            No             |   No   |   No   |
| Receive business notifications (new lead, offer accepted, deposits) |  Yes  |            Yes            |   No   |   No   |
| Ask the finance team in chat                                        |  Yes  |            Yes            |  Yes   |  Yes   |

Where a request is not allowed, the server often answers "not found" (404) rather than "forbidden", so the existence of a lead or a lease does not leak to someone who may not see it.

## Roles are not signatures

Having the `OWNER` role does **not** let the server move money. The owner must also sign an EIP-712 message with their wallet, and the signer must be a **current** signer of the on-chain vault. Synq re-reads the vault's owners, threshold and policy contract from the chain before it acts on finance, and refuses with `ONCHAIN_AUTHORITY_CHANGED` or `VAULT_AUTHORITY_MISMATCH` if what it stored no longer matches.

## Clients are not members

People who talk to your sales agent are **outside counterparties**. They have a lead-scoped identity and (for agreements) a linked wallet. They have no role in the table above and cannot see any workspace data except their own conversation and offers.

## Admin has no signing authority

On the invite form the Admin option reads "Admin (no signing authority)". An admin can propose a commercial policy, but only an owner can make it active. An admin can run a conversation but cannot widen what the agent may do.

See [Invite members and roles](/docs/getting-started/members-roles).
