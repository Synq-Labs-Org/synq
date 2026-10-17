---
title: The three surfaces
description: What you can do in the iPhone app and iMessage extension, the web hub and the Telegram bot, side by side.
---

Synq meets you in three places. They share one account (your wallet), one backend and the same safety rules. **No surface can approve money by itself**: approvals always end in a wallet signature.

```text
        +----------------+   +-----------------+   +----------------+
        | iPhone app +   |   |   Web hub       |   | Telegram bot   |
        | iMessage ext.  |   |  /personal      |   | private chats  |
        |                |   |  /w/<id>/...    |   | and groups     |
        +-------+--------+   +--------+--------+   +-------+--------+
                |                     |                    |
                +---------- one Synq backend --------------+
                             (same wallet identity)
```

## Capability matrix

| Capability | iPhone app | iMessage extension | Web hub | Telegram |
| --- | --- | --- | --- | --- |
| Sign in with wallet | Yes (WalletConnect or code) | Via the app | Yes (injected wallet) | Link once with a wallet signature |
| Approvals inbox and signing | Yes | Hands off to the web page | Yes | No: points you to the secure page |
| Business inbox, take over a conversation | Yes | No | Yes | Staff messages are delivered to the client's chat |
| Agents and activity feed | Yes | No | Yes | No |
| Money, vault, payouts, invoices | View in app | Invoice checkout card | Full | Propose payouts and drafts by text |
| Client conversation with the sales agent | No | No | Yes (client page) | Yes (via an invite link) |
| Notifications | Push (generic) plus in-app list | No | In-app list | Replies in chat |
| Themes | Yes | Own choice | Yes | Not applicable |

> **Note**
> The table describes what is in the codebase today. Some screens (for example a client-side screen for signing an agreement and funding escrow) exist as API routes first; see [Client agreements and escrow](/docs/guides/client-agreements).

## iPhone app and iMessage extension

- **The app** has a context switcher. Personal contexts have Home, Circles, Activity, Money and Approvals tabs. Business contexts have Home, Inbox, Deals, Agents and Money tabs. It supports offline reading with a banner ("Offline. Showing what was last synced; nothing can be approved or sent.").
- **The extension** lives inside Messages. It shows a group fund, inserts invite and payment cards, and shows a shared invoice checkout card. It never signs, stores keys or approves; when a signature is needed it opens the Synq web page.

See [The iMessage extension](/docs/guides/imessage).

## Web hub

The hub has a personal view (`/personal`) and business views at `/w/<workspace>/...`: Overview, Inbox, Agents, Money, Deals and Settings, plus global Approvals and Notifications. A separate `/workspaces` page has account creation, invitations, vault setup, the one-time iPhone code and the older money panels. Clients open a private page at `/lead/<id>`.

## Telegram

The bot works in private chats and in groups you bind to a workspace. Prospects start a private chat with a `/start lead_...` link. Workspace members use plain commands such as `/vendors`, `/invoices` and `/team <question>`. See [Telegram commands](/docs/guides/telegram).

Everything you do in chat is a **proposal**. The bot replies with a button that opens the secure page for the real decision.
