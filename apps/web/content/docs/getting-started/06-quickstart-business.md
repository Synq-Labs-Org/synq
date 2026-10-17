---
title: Quickstart for a business
description: An end-to-end walk from creating a business workspace to a funded client deal and a contractor payout.
---

This walkthrough follows one small business, "Studio", through the full loop on Arc testnet. Each step links to the detailed guide.

```text
 1 sign in -> 2 workspace -> 3 co-owner -> 4 vault -> 5 policy -> 6 invite client
      -> 7 agent talks -> 8 offer -> 9 accept -> 10 both sign -> 11 client funds
      -> 12 work + release -> 13 invoice / payout / split
```

## 1. Sign in and create the workspace

Connect your wallet and [sign in](/docs/getting-started/sign-in). [Create a workspace](/docs/getting-started/workspaces) of type **Business**.

## 2. Add co-owners (optional)

[Invite](/docs/getting-started/members-roles) one or more owners while the workspace is forming. Each owner is a vault signer. A solo owner is allowed.

## 3. Launch the vault

Propose the vault setup, choose the signing threshold and the caps, and have every owner sign it. See [Set up the vault](/docs/guides/vault-setup).

## 4. Sign a commercial policy

Define your catalog (what you sell, list price, floor price, limits), the maximum discount, the minimum deposit and the amount above which only an owner may send an offer. Propose it and sign the exact policy hash with an owner wallet. See [Commercial policy](/docs/guides/commercial-policy).

## 5. Invite a client

In the inbox choose **Invite a client**, pick Web link or Telegram, set an expiry and copy the link. See [Leads and invitations](/docs/guides/leads-invites).

## 6. Let the sales agent talk

The client opens the link, agrees that the business can read the conversation, and chats with the sales assistant. The agent asks questions and proposes terms; every offer is checked by a deterministic validator against your policy. See [The AI sales agent](/docs/guides/sales-agent).

## 7. Take over if you want to

Use **Take over** in the inbox at any time. From then on only a person replies. See [Taking over](/docs/guides/sales-agent#taking-over-a-conversation).

## 8. Offer, accept, sign, fund

The client accepts an offer in chat. That only moves the lead to "agreed, pending signatures". The client links a wallet, then client and owner each sign the exact terms, then the client funds the escrow from their own wallet. See [Offers](/docs/guides/offers), [Client agreements and escrow](/docs/guides/client-agreements) and [Owner agreements](/docs/guides/owner-agreements).

## 9. Get paid and pay out

[Issue an invoice](/docs/guides/invoices) with a checkout link, then [propose payouts](/docs/guides/payouts) to verified vendors and set up [revenue splits](/docs/guides/revenue-splits).

## 10. Watch what agents did

Open the **Agents** tab to read every run, its events and its proof levels. See [Agent activity](/docs/guides/agent-activity).
