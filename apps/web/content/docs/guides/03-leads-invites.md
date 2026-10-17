---
title: Leads and invitations
description: How a business invites a prospect, how the invitation is bound to one identity, what the client agrees to, and how the inbox works.
---

A **lead** is a private conversation between your business and one outside prospect. Only `BUSINESS` workspaces have leads, and only **owners and admins** can see them.

## Create a client invitation

1. Open **Inbox** in the hub (or the iPhone app's Inbox tab).
2. Choose **Invite a client**.
3. Pick the **Channel**: `Web link` or `Telegram` (Telegram needs a connected bot; otherwise the server answers `TELEGRAM_NOT_CONFIGURED`).
4. Choose **Expires after**: 1 hour, 24 hours or 7 days (the server allows 5 minutes to 7 days).
5. Copy the link. **The token is shown once.** The iPhone app notes: "A private link that works once and expires. It carries no prices or messages."

The link looks like `.../deal-invite/<token>` for the web or a `t.me/<bot>?start=lead_...` link for Telegram.

## What the client sees first

On the web the client lands on "A business would like to talk with you privately". The page says the business can read the conversation and that nothing moves money: "no payment, deposit or agreement happens by opening this link or signing in". The client signs in with their wallet, then chooses **Accept and start**. The link works once.

The consent scope stored with the lead is:

> The business you are talking to can read this private conversation. It is not shared in any group.

The time of acceptance is stored as the consent record, and the inbox shows it to staff: "This client agreed that the business can read this conversation (since ...)".

## Single use and one identity

```text
   token (shown once)  ->  stored only as a hash
        |
        v
   prospect opens it with a provider-verified identity
   (Telegram user id, or a web sign-in)
        |
        v
   bound once -> the same identity reopening gets the same lead;
                 anyone else gets "invalid invitation"
```

The client becomes an **external counterparty**. They are never a workspace member and cannot read books, vaults or other leads. A person who is already a member of the workspace cannot be bound as a lead.

## The inbox

| Element          | Meaning                                                                   |
| ---------------- | ------------------------------------------------------------------------- |
| Leads list       | Filter by handling (Agent, Human, Frozen) and stage                       |
| Needs you        | A lead flagged for an owner (escalation, or an accepted offer)            |
| Conversation     | The transcript. Older messages are not shown on the page                  |
| Offers           | Each offer version with its checks; **Re-check** runs the validator again |
| Handling buttons | Take over, Hand back, Freeze offers, Escalate to owner                    |

## Lead stages

```text
 LEAD_OPEN -> DISCOVERY -> QUALIFIED -> OFFER_DRAFTED -> OFFER_VALIDATED
   -> OFFER_SENT <-> NEGOTIATING -> AGREED_PENDING_SIGNATURES -> SIGNED
   -> FUNDING_PENDING -> FUNDED -> ACTIVE -> DELIVERED -> ACCEPTANCE_PENDING
   -> RELEASED | REFUNDED | DISPUTED | CANCELLED
```

The server moves a lead through the early stages as messages and offers happen; the funding stages come from the agreement and escrow ([Client agreements](/docs/guides/client-agreements)).

## History cannot be rewritten

Lead messages and the audit of handling changes are append-only in the database. Updating or deleting a past message raises an error.

## Telegram prospects

A prospect who opens a `lead_` link in a private Telegram chat is bound by their Telegram identity. After that, anything they type in that private chat reaches the sales agent (or staff). See [Telegram commands](/docs/guides/telegram).
