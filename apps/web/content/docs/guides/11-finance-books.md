---
title: Vendors, budgets and books
description: Add verified vendors, set signed budgets, record bills and obligations, and understand the owner-quorum rule behind every change.
---

The finance area holds the facts payouts depend on. **Every edit requires the current Safe owner quorum.** No chat command and no database role can change them alone.

## Rule of thumb

> **Security**
> A finance change is an EIP-712 `FinanceChange` signed by the vault's current owners. It expires after about 15 minutes and carries a revision and a one-use nonce, so it cannot be replayed or applied to a different state.

## Vendors

A vendor is a name plus a **verified payout wallet**. Signing attests that you independently verified the vendor and the address (`OWNER_ATTESTATION`).

- A new vendor, or a changed address, becomes **eligible only after 24 hours** (status `COOLING`, then `VERIFIED`). Changing the address away and back does not reset the clock; the history is immutable.
- Verified is not enough to pay. The vendor must also be on the vault's on-chain allowlist, added with the `QUEUE_VENDOR` then `ALLOW_VENDOR` vault actions after the governance delay.

## Budgets

| Field | Meaning |
| --- | --- |
| Per payment | Largest single payment; above it a payout takes the Safe quorum route |
| Daily | Total for a day |
| Reserve | Cash to keep untouched |
| AI daily | How much agent-initiated payments may total in a day |

Per payment and AI daily cannot exceed daily. A budget can be revoked with a reason.

## Bills and obligations

| Record | Fields |
| --- | --- |
| Vendor bill (payable) | vendor, number, amount, issued and due dates, reference, document text |
| Milestone (obligation) | reference, vendor, approved amount, status: Approved, Delivered, Accepted, Disputed |
| Recurring bill | label, kind (Bill, Payroll, Rent, Subscription), amount, next due date, cadence 1 to 366 days |

A payable can be closed as `PAID_ELSEWHERE` or `VOID` with a reason. Recurring bills can be removed with a reason.

## Why quorum

These records feed revenue splits and the finance agents. If anyone could edit them, an attacker could create a fake bill and route money to themselves. Requiring the same owners that control the vault closes that door.

## Reading the books

The Money page shows receivables (open invoices), payables (open bills), balances with their observation time and freshness, and risk cases. A balance with no observation is shown as unknown rather than guessed.

See also [Payouts](/docs/guides/payouts) and [Revenue splits](/docs/guides/revenue-splits).
