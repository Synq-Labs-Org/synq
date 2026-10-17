---
title: The iMessage extension
description: What the Synq extension inside Messages does, its cards, and why it hands every signature to the secure page.
---

The extension lets you use Synq from inside a conversation in Apple Messages. It is part of the same iPhone app install.

> **Security**
> The extension **never signs, stores keys or approves**. Whenever a signature is needed it opens the Synq web page in a secure sheet. A card in a chat is a proposal, not a decision.

## What it shows

| Mode    | What you see                                                                                           |
| ------- | ------------------------------------------------------------------------------------------------------ |
| Start   | A way to start a fund or an Arc workspace, sign in with a private code, or paste a Synq link           |
| Fund    | A shared fund for a conversation: total, members, the group's approval threshold and pending proposals |
| Invoice | A shared invoice checkout card with live status                                                        |
| Review  | A group-bound review card for an approval link another Synq channel issued                             |

The extension recognises Synq links only on the configured Synq host. It remembers which fund belongs to a conversation on your device; it cannot read the transcript.

## Signing in from Messages

Open the workspaces page in a browser, choose **Generate private sign-in code** and paste the code in the extension. The code works once and expires in two minutes. It grants no payment authority. See [Sign in with a wallet](/docs/getting-started/sign-in).

## Cards

- **Invite card.** Shares a fund or workspace to the chat.
- **Payment card.** Shows an amount and recipient; tapping it goes to the secure page.
- **Invoice card.** Shows invoice status. Paying opens the pay page.

Live cards in the transcript refresh their status. Their size is capped so a bubble never dominates the conversation.

## What belongs to the earlier fund product

Parts of the extension (starting a group fund, test money, flights and gifts, approving with a group passkey) belong to the earlier group-fund product that used passkeys and a test stablecoin. The Arc workspace flows are wallet-based. Where a screen says "passkey", it follows that earlier flow.

## Linking a workspace to Messages

Linking an iMessage conversation to a workspace for notifications is **blocked** until a verified bridge exists: the server reports `BLOCKED_REQUIRES_VERIFIED_BRIDGE`. The extension says "This conversation is not linked for notifications yet."

## Themes

The extension has its own theme choice. See [Themes](/docs/guides/themes).
