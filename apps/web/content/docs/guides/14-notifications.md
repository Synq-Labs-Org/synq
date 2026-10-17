---
title: Notifications and push
description: The notification categories, how push works, why alerts are generic, and how to mute or turn them off.
---

Synq tells you that **something happened**, never **what it was**. Notification titles come from the category alone, so a lock screen never shows a name, price, address or deal text.

## Categories

| Category | Title shown |
| --- | --- |
| `NEW_LEAD` | New enquiry |
| `OFFER_ACCEPTED` | An offer was accepted |
| `CLIENT_DEPOSIT_FINALIZED` | A deposit settled |
| `AGENT_PAYMENT_FINALIZED` | An agent payment settled |
| `PAYMENT_BLOCKED` | A payment was blocked |
| `RISK_REVIEW` | Something needs a review |
| `ESCROW_DISPUTED` | An escrow was disputed |
| `CIRCLE_CONTRIBUTION_RECEIVED` | New contribution |
| `FUND_PROPOSAL` | New fund proposal |
| `APPROVAL_REQUESTED` | Something needs your signature |
| `LEASE_EXPIRING` | A lease is expiring |
| `SECURITY_PAUSE` | Security pause |

Owners and admins of the workspace are the usual recipients of business alerts. One notification exists per event and person, so a retried job never sends you two.

## The in-app list

Open **Notifications** in the hub (or the app) for the list. Each item links to a page in the app, for example a lead, an agent run, a circle or the approvals inbox. You can mark items as read (up to 200 at once). The list shows an unread count.

## Push on iPhone

Push is **off until you turn it on**. Open **Account**, then **Notifications**, then **Turn on**. iOS asks for permission, and only after you agree does the app register a token.

| What the push contains | What it never contains |
| --- | --- |
| The generic title, the category and the event id | Names, prices, amounts, addresses, deal text |

When you tap a push, the app **only navigates**. The destination loads after your session and membership are checked, and **nothing is approved by the tap**. A device token authenticates nothing.

## Muting and quiet hours

A registered device can carry a list of muted categories and a quiet-hours window (start, end, time zone). Pushes that fall into muted categories or quiet hours are skipped, not delayed. These settings are part of the device registration the app sends.

## Delivery rules

- A push is queued once per active, unmuted device.
- A token that moves to a different person is revoked from the old one.
- Signing out deletes the device session and clears Synq notifications from the lock screen.
- Sandbox and production Apple push hosts are chosen per device.

If the server is not set up to send push, the app says so ("Allowed on this iPhone, but this Synq server cannot send notifications yet.").

## Telegram notifications

For workspaces bound to a Telegram chat, payout, invoice and revenue-allocation events are delivered as cards through a durable queue. Delivery is re-checked against the binding, so a chat that is unlinked stops receiving cards.

See also [Privacy](/docs/security/privacy).
