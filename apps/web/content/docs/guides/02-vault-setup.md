---
title: Set up the vault
description: Propose a Safe vault for your workspace, understand the defaults, gather owner signatures and watch it become active.
---

The vault is a Safe multisig on Arc testnet plus a policy contract. Only **owners** of a workspace in `FORMING` status can set it up. Read [The vault](/docs/concepts/vault) first if you want the design.

## Before you start

- Invite every co-owner and let them accept ([members and roles](/docs/getting-started/members-roles)). The proposed setup fixes the owner list at the moment you propose it, so owners who join later are not part of it.
- Decide your threshold and caps.
- Your server must have sponsored execution configured. If it does not, the page says: "Vault creation is blocked: sponsored execution is not configured. No vault or test balance has been created."

## Step 1: propose

On the workspaces page, open **Vault setup**. Fill in:

| Field | Default | Rule |
| --- | --- | --- |
| Signature threshold | Computed from owner count | 1 to 20 |
| Per-payment cap | 5 USDC | The most the operator may pay in one payment |
| Window cap | 20 USDC | The most the operator may pay in any rolling 24 hours |
| Governance delay | 86,400 seconds (24 hours) | 3,600 to 2,592,000 seconds (1 hour to 30 days) |

The default threshold is `min(owners, 3, ceil(owners / 2) + 1)`.

| Owners | 1 | 2 | 3 | 4 | 5 | 6 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Default threshold | 1 | 2 | 3 | 3 | 3 | 3 | 3 |

The initial **payee allowlist is empty**. Nobody can be paid by the operator until an allowlist entry is added through the timelock.

## Step 2: review

The page shows the exact setup: owners, threshold, caps, delay, sponsor gas ceiling in native testnet USDC, the factory address and when the setup expires. A setup expires **one hour** after it is proposed.

Tick **I reviewed the owners, threshold, caps and gas ceiling.** The sign button stays disabled until you do.

## Step 3: every owner signs

Each owner chooses **Sign vault setup in my wallet** and signs the EIP-712 setup. The same typed data is also available in the [approvals inbox](/docs/guides/approvals) as `VAULT_SETUP`.

| State | Meaning |
| --- | --- |
| `AWAITING_SIGNATURES` | Not every owner has signed |
| `READY` | All signatures recorded; waiting for the execution worker and receipt reconciliation |
| `ACTIVE` | The vault exists on chain; the workspace is `ACTIVE` |
| `REVERTED` / `NEEDS_REVIEW` | The deployment failed or the outcome is uncertain. No replacement transaction is signed for an uncertain outcome |

## Step 4: fund and use

When `ACTIVE`, the workspace shows the vault address and threshold. Send test USDC to the vault address to fund it. Then:

- add vendors and budgets ([Vendors, budgets and books](/docs/guides/finance-books)),
- propose payouts ([Payouts](/docs/guides/payouts)),
- allow recipients or change caps via vault actions (approvals purpose `VAULT_ACTION`).

> **Warning**
> The vault's code and policy cannot be changed by Synq. Changing owners, threshold, modules, the guard or the policy itself needs a Safe-quorum transaction that waits out the timelock. See [The vault](/docs/concepts/vault).
