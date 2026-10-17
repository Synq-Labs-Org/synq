---
title: Telegram commands
description: Every Telegram command and phrase the Synq bot understands, how to link your chat, and why chat never approves money.
---

The Telegram bot is a convenient way to ask questions and **propose** work. It cannot approve, sign or move money.

> **Security**
> Replying "yes", "ok", "approve", "confirm" or `/approve` never approves anything. The bot answers: "Chat never approves money. Review the exact request on the secure page and sign with the required Safe owners."

## Link your chat to a workspace

On the workspaces page, open **Chat identity** (it says "Linking a chat never approves a payment or changes Safe ownership"):

1. Choose **Verify my Telegram identity** and complete the Telegram login.
2. Choose **Send a private link code to my Telegram account**. Synq sends an 8-digit code to you in Telegram.
3. Type the code and choose **Sign this identity link in my wallet**. Provider proof, the private code and your wallet signature together create the link.
4. Bind a chat: **Use this workspace in my Telegram direct chat**, or, for a group, enter the group chat id (it starts with a minus sign) and choose **Link group after checking my admin role**. Binding a group needs a workspace owner who is also an admin of that Telegram group.

If linking is not configured on the server the page says so.

A chat is bound to one workspace. Until you link your own wallet, the bot says: "Link your own wallet to this workspace on the secure Synq page. A username, phone number or chat reply never approves money."

## Workspace commands

These work in a chat bound to a workspace:

| You type | What happens |
| --- | --- |
| `/vendors` | Lists verified vendors and a button to open settings |
| `pay <vendor> <amount> USDC for <purpose> ref <reference>` | Proposes a payout. Also: `pay <amount> USDC to <vendor> for <purpose>, invoice <reference>` |
| `/pay status` | Shows payout status |
| `/bills` | Lists open bills |
| `/invoices` | Lists invoices |
| `invoice <payer> <amount> USDC due <YYYY-MM-DD> for <work>` | Drafts an invoice (a draft moves nothing) |
| `/deals` | Lists deals |
| `/splits` | Lists revenue allocations |
| `/swaps` | Lists treasury swap operations |
| `/treasury` | Shows the vault balance and block |
| `/team <question>` or `/ask <question>` | Asks the workspace finance team (CFO and risk agents) a question |

Every reply carries an **Open workspace** button. Rate limits apply (30 messages per minute per person, 60 per workspace chat). If a command is not recognised the bot lists the commands above.

> **Note**
> Payout proposals only accept **verified vendors**, matched by exact name or id. An ambiguous or missing name gets: "Choose one verified vendor from workspace settings."

## Asking the team

`/team why is cash low this week?` runs the workspace team. It returns an answer, the roles that handled it, cited sources with freshness (`FRESH`, `STALE`, `UNKNOWN`) and whether the data was decision-grade. A reply can end in one of two safe outcomes: `USE_EXPLICIT_PAYMENT_REQUEST_FOR_WALLET_REVIEW` (ask for a payment in the exact `pay ...` form) or `PENDING_OWNER_SIGNATURE` (a proposed payout waits for owners). Questions are limited to 2,000 characters. Output passes a redaction step before it is shown.

## Prospects and clients

A prospect opens a link of the form `https://t.me/<bot>?start=lead_...` in a **private** chat. The token is single use and binds their Telegram identity to the business's lead. After that every message they send goes to the sales agent (or to staff after a takeover), and staff replies are delivered back in that chat. See [Leads and invitations](/docs/guides/leads-invites) and [The AI sales agent](/docs/guides/sales-agent).

## Group-fund commands (earlier product)

The gateway also carries commands for the earlier group-fund product: `/synq` (link this chat to a group), `/wallet`, `/balance`, `/contribute`, `/send`, `/mandates`, `/propose`, `/status`, `/unlink`, `/memory`, `/deal`, `/confirm`, `/help`. Those refer to a test stablecoin and passkey approvals and do not apply to Arc workspaces. The same rule holds: approvals only happen on the Synq web page.

## Limits

The real Telegram Guest Mode round trip is not proven, per the repository's status notes. The adapters and local ingress are tested.
