---
title: Payouts
description: Propose a payment to a verified vendor, how it is routed by size, who must sign, and how to follow it to finality.
---

A **payout** is a payment from the vault to a **verified vendor**. Anyone who is not a viewer can propose one. Owners approve. The vault's policy contract and the Safe owners enforce the limits.

## Prerequisites

- An active vault with test USDC.
- A **verified vendor** past its cooling period ([Vendors, budgets and books](/docs/guides/finance-books)).
- A **signed budget**. Without one: "No signed budget. Payouts remain blocked."
- The vendor must also be on the vault's on-chain allowlist for the operator route.

## Propose

From the hub's payouts panel, or in Telegram:

```text
pay Acme Design 25 USDC for logo work ref INV-1042
pay 25 USDC to Acme Design for logo work, invoice INV-1042
```

Every field is read from the message; nothing is guessed. The vendor name must match exactly one verified vendor. The payment needs a **reference** (an invoice or bill number). Only one active payout may exist per reference (`OBLIGATION_ALREADY_PROPOSED`). A repeated request with the same idempotency key returns the same payout; changing its details returns `IDEMPOTENCY_CONFLICT`.

Telegram answers with a card and a button to review. **Chat never approves or signs.**

## Routing by size

```text
 amount <= per-payment limit of the signed budget ?
        |                         |
       yes                        no
        v                         v
  VAULT_POLICY route        SAFE_QUORUM route
  owner approves with       Safe owners sign a vault action
  EIP-712; operator pays    (PAY_VENDOR) at the threshold;
  within the policy caps    no operator involved
```

- **Vault policy route.** The owner signs the exact intent and a bounded payment mandate; the Kernel issues a one-use grant; the execution worker pays through the vault's scoped operator within the per-payment and rolling-24-hour caps.
- **Safe quorum route.** Larger amounts need Safe-owner signatures up to the threshold.

## States

| State          | Meaning                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `REVIEW`       | Proposed, waiting for approval                                                                       |
| `READY`        | Enough signatures; waiting to execute                                                                |
| `HOLD`         | Approved but not executing right now; it still counts against the rolling cap, and a reason is shown |
| `SIGNED`       | Transaction signed and recorded before broadcast                                                     |
| `PAID`         | Final on chain                                                                                       |
| `FAILED`       | Did not execute                                                                                      |
| `NEEDS_REVIEW` | Outcome uncertain; a person must reconcile before any retry                                          |
| `CANCELLED`    | Cancelled by an owner                                                                                |

An owner can cancel while `REVIEW`, `READY` or `HOLD`, unless a signed transaction already exists (`SIGNED_PAYOUT_REQUIRES_RECONCILIATION`).

## Approve

1. Open the request in [Approvals](/docs/guides/approvals) (purpose `PAYOUT` or `VAULT_ACTION`).
2. Check recipient, amount and purpose against the invoice.
3. Sign. The signer must be a **current** vault owner. At quorum the status turns `READY`.

The approval has a deadline (15 minutes by default). If it expires, propose again.

## What stops a bad payout

| Guard                                         | Where                    |
| --------------------------------------------- | ------------------------ |
| Recipient must be a verified vendor           | Synq finance             |
| New or changed vendor addresses wait 24 hours | Synq finance             |
| Per-payment, daily and AI-daily budget        | Signed budget and Kernel |
| Vendor on the vault allowlist                 | Vault policy contract    |
| Rolling 24-hour operator cap                  | Vault policy contract    |
| Pause by the guardian                         | Vault policy contract    |
| Owner quorum for anything larger              | Safe                     |

See [The vault](/docs/concepts/vault) and [Kernel and grants](/docs/concepts/kernel-grants).
