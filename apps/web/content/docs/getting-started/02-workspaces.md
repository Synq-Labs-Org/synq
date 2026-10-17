---
title: Create a workspace
description: What a workspace is, the three kinds, how it moves from forming to active, and how to create one.
---

A **workspace** is the container for everything shared: members and their roles, the vault, leads, offers, invoices, payouts, books and the audit trail. You can belong to several.

## The three kinds

| Kind       | Typical use                                  | Notes                                                                            |
| ---------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `PERSONAL` | Your own wallets and vaults                  | Only you; owner invitations are not allowed                                      |
| `GROUP`    | Friends or a club pooling money (a "circle") | Members contribute; a contribution is the member's equity, never revenue         |
| `BUSINESS` | A freelancer or small company                | The only kind that can receive client leads, run the sales agent and send offers |

In the iPhone app, personal contexts show Home, Circles, Activity, Money and Approvals. Business contexts show Home, Inbox, Deals, Agents and Money.

## Lifecycle

```text
   FORMING  ----->  LAUNCHING  ----->  ACTIVE
   (owners join,    (every owner       (vault exists,
    set threshold)   signed the         payouts and
                     vault setup;       governance
                     executor            available)
                     deploys vault)
```

- **FORMING.** You and any co-owners are being gathered. Owners can only be invited while the workspace is forming.
- **LAUNCHING.** Every owner has been asked to sign the exact vault setup. When all signatures are in, the execution worker creates the vault on Arc testnet.
- **ACTIVE.** The vault exists. Its address and signing threshold are shown on the workspace.

A workspace can be used for chat, leads and offers before the vault is active, but money movement needs the vault. See [Set up the vault](/docs/guides/vault-setup).

## Create one

On the web, open the workspaces page, sign in, then in **Create a workspace** enter:

- **Name**: 1 to 80 characters.
- **Type**: Personal, Group or Business.

You become the first owner. The iPhone app and hub then show the workspace in the context switcher.

## What every workspace records

- The chain: always Arc testnet, chain id 5042002.
- The creator and the member list. Other members see a short wallet hint such as `0x1234...abcd`, not the full address.
- Status, vault address and Safe threshold once active.

Next: [Invite members and choose roles](/docs/getting-started/members-roles).
