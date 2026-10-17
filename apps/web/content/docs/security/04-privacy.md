---
title: Privacy of leads and push notifications
description: What Synq stores about client conversations, who can read them, what the client is told, and why push alerts contain nothing sensitive.
---

## Leads

A lead is a private conversation between one outside prospect and a business.

| Question                                | Answer                                                                                                                                                                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who can read the transcript?            | Owners and admins of that workspace only                                                                                                                                            |
| Who else?                               | Nobody: other members, viewers, other workspaces and groups cannot                                                                                                                  |
| Is it posted to groups?                 | Never. The product copy says: "never posted to a group"                                                                                                                             |
| Is the client told?                     | Yes. Before they start, they see the consent scope: "The business you are talking to can read this private conversation. It is not shared in any group." The consent time is stored |
| Can staff or the agent rewrite history? | No. Messages and handling audit rows are append-only                                                                                                                                |
| How is a client's identity stored?      | A SHA-256 digest of the channel and the provider-verified identity, plus a delivery reference for replies                                                                           |
| Can the client see my other data?       | No. They see their own conversation and offers (staff-only fields are dropped from offer views)                                                                                     |
| Can a member be a lead?                 | No. Members cannot be bound as leads                                                                                                                                                |

## Chat memory (earlier group-fund gateway)

The gateway that carries the earlier group-fund commands has an opt-in memory feature: `/memory` shows what Synq keeps from a chat, `/memory optin` and `/memory optout` are personal choices, and chat admins can switch retention on for a number of days or off. It is separate from the Arc workspace lead flow.

## Push notifications

| Rule                 | Detail                                                                 |
| -------------------- | ---------------------------------------------------------------------- |
| Generic title        | Taken from the category alone, such as "A deposit settled"             |
| Contents             | Title, category and event id. No names, prices, addresses or deal text |
| Fetching details     | After you sign in and pass a membership check                          |
| Tapping              | Only navigates. Never approves anything                                |
| Device token         | Authenticates nothing; a token cannot read data                        |
| Opt-in               | Off until you turn it on in Account                                    |
| Mute and quiet hours | Per device, per category                                               |
| Sign out             | Clears notifications from the lock screen                              |

## What other members see of you

The member list shows your role and a shortened wallet (`0x1234...abcd`), not the full address.

## What is redacted

Replies from the finance team in chat pass through a redaction step before they are shown, and the audit trail is redacted and hash-linked. Agent events carry short summaries, amounts and a recipient hint, not private message text.

## Links that expose terms

Pay links and review links reveal the terms they point at to whoever holds the link. Share them privately. Invitation links work once and expire, and carry no prices or messages.

## Data you control

Signing out clears the app's cache and session. The product has no self-service data export or deletion screen yet; operators of a deployment control retention.
