---
title: Invite members and roles
description: How one-use invitations work, the four roles, and who can see and do what.
---

Only an **owner** can invite people. Invitations are single-use tokens that expire.

## Roles at a glance

| Role | In one line |
| --- | --- |
| `OWNER` | A signer. Holds signing authority over money and policy |
| `ADMIN` | Runs the day-to-day (inbox, offers within policy) with **no signing authority** |
| `MEMBER` | Participates, can read agent activity and propose payouts |
| `VIEWER` | Read-only participant; cannot propose payouts or be a deal party |

The full permission table is in [Workspaces and roles](/docs/concepts/workspaces-roles).

## Send an invitation

1. Open the workspace on the web (workspaces page).
2. In the member section choose the **Invite role**: Member, Viewer, Admin (no signing authority), or Owner.
3. Choose how long it is valid. The server accepts 60 seconds to 24 hours and defaults to 1 hour.
4. Copy the token. **It is shown once.** Send it privately to the person.

The person signs in with their own wallet, opens **Join a workspace**, and pastes the **one-use invitation token**.

> **Note**
> The token is stored only as a hash on the server. If you lose it, create a new one; there is no way to read the old one back.

## Rules for owner invitations

- You can invite owners only while the workspace is **forming** and it is not a personal workspace.
- A workspace can have at most **20 owners**.
- Owners become the Safe signers of the vault. The default threshold is computed from the number of owners; see [The vault](/docs/concepts/vault).

## Accepting

An invitation can be accepted once, before it expires, by the first wallet that redeems it. After acceptance the member appears with their role. A wallet that is already a member cannot take a second role.

## Changing your mind

The current API has no operation that changes a member's role after they join. If someone needs different authority, invite them again with the right role from a wallet that is allowed to hold it. Money authority never changes silently: owner status is tied to the vault's signer list, which only changes through a Safe-quorum transaction behind a timelock.

## Clients are not members

Business clients who talk to your sales agent are **outside counterparties**. They are bound to a lead, not to your workspace. They cannot read your books, vaults or other leads. A person who is already a member of your workspace cannot be turned into a lead. See [Leads and invitations](/docs/guides/leads-invites).
