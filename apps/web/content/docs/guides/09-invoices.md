---
title: Invoices
description: Draft, issue and collect invoices in test USDC, how the pay link works and how payments are matched from the chain.
---

Invoices are how a business asks to be paid. They are drafted by an owner, **issued only with the owner's wallet signature**, paid by the payer from their own wallet and matched by watching the chain.

## Who can do what

| Action | Role |
| --- | --- |
| Draft an invoice | Owner |
| Issue it (sign) | Owner, and the signer must be the issuer wallet and a current vault owner |
| See invoices | Any member |
| Pay | Anyone with the pay link and a wallet |

## Draft

On the workspaces page (or the hub's Money area), use **Workspace invoices**. Enter:

| Field | Rule |
| --- | --- |
| Number | up to 80 chars, your own numbering |
| Payer name | up to 120 chars |
| Due date | `YYYY-MM-DD` |
| Line items | 1 to 30; description (up to 200), quantity (whole number), unit price in USDC |
| Tax rate | basis points, 0 to 10,000, with an optional label |
| Memo | up to 300 chars |

From Telegram you can draft with one line, in a chat bound to your workspace: `invoice Acme 120 USDC due 2026-11-15 for logo design`. A draft moves nothing; issuing needs your wallet signature on the secure page.

The invoice is always in test USDC on Arc testnet and pays to your **vault** address.

## Issue

Issuing signs the invoice terms. After it, the invoice has a hash (`termsHash`), a payment reference (`paymentRef`) and a **checkout path** `/pay/<token>`.

## Status

| Status | Meaning |
| --- | --- |
| `DRAFT` | Not yet issued |
| `ISSUED` | Open for payment |
| `PARTIALLY_PAID` | Some amount received |
| `PAID` | Paid in full |
| `OVERPAID` | More than the total received |
| `VOID` | Cancelled |

Separately, `reconciliation` says how the chain evidence stands: `NOT_PAID`, `PENDING` (waiting for a finalized receipt), `FINALIZED`, or `REVIEW` (the proof needs a human look; payments are paused until reviewed).

## The payer's page

The pay link opens a page with the issuer, invoice number, due date, line items, total, paid, amount due, **Pays to**, reference and status. The payer:

1. Connects an injected wallet (in a wallet browser).
2. The page switches or adds Arc Testnet.
3. The payer sends the prepared USDC transfer from their wallet.
4. The page polls the server with the transaction hash for up to about two minutes until the payment is verified.

If the hash does not pay this invoice, the page says "That transaction did not pay this invoice. Nothing was applied."

## Collection by the chain, not by trust

The server never trusts a payer's claim. A payment counts only when a **finalized** on-chain receipt matches the invoice. Finalized receipts also feed [revenue splits](/docs/guides/revenue-splits), books and notifications ("A deposit settled").

## iMessage checkout card

A shared invoice can be sent as a card in iMessage. The extension shows the checkout status; paying hands off to the web page. See [The iMessage extension](/docs/guides/imessage).

> **Note**
> Review links expose the invoice terms to whoever holds the link. Share them like you would a payment request.
