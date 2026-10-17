---
title: Revenue splits
description: Automatic rules for what happens to a final incoming payment: tax reserve, bills, operating floor, fixed and percentage distributions, all under signed limits.
---

A **revenue policy** tells Synq how to divide a finalized incoming payment. It is a proposal engine, not a signer: nothing moves until each transfer leg is authorized by the Kernel under a mandate your owners signed.

## The waterfall

When a payment is **final on chain**, the plan is built in this fixed order:

```text
 incoming payment (final receipt)
   1. tax estimate reservation          (stays in the vault)
   2. contractor payables due           (verified vendors, within the horizon)
   3. upcoming bills                    (rent, payroll, subscriptions...)
   4. operating floor top-up            (stays in the vault)
   5. fixed distributions               (a set amount to a beneficiary)
   6. percentage distributions of the surplus
   7. free cash                         (remainder, including rounding dust)
```

All math is integer base units. Rounding dust goes to free cash, so the legs always add up to the receipt exactly. Reservations say plainly that **no money moved**; only transfer legs move USDC.

## Policy fields

| Field                                  | Meaning                                                                                  |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Tax estimate reserve                   | Share of each receipt held back, in basis points (0 to 5,000; 100 = 1%)                  |
| Operating floor                        | Minimum cash to keep                                                                     |
| Obligation horizon                     | How many days ahead of bills and payables to cover (1 to 120)                            |
| Vendors                                | 1 to 20 verified vendors whose payables may be paid                                      |
| Distributions                          | Up to 10: `FIXED` amount, or `PERCENT_OF_SURPLUS` in basis points, each to a beneficiary |
| Maximum transfer                       | Largest autonomous transfer per leg                                                      |
| Maximum automatic transfers per window | Total per window (60 seconds to 31 days)                                                 |
| Maximum splits per window              | Receipts allocated per window                                                            |
| Valid for                              | 15 minutes to 30 days                                                                    |

## Approval

The current Safe owner quorum signs the policy **and** the exact payment mandate derived from it. A policy can be `REVIEW`, `ACTIVE`, `SUPERSEDED` or `REVOKED`. Revoking takes a signature too, so a stolen chat session cannot delete your limits.

## Safety checks on every leg

Even with an active policy, a leg only runs if:

- the beneficiary is still a **verified** vendor at run time,
- screening and risk checks pass,
- amounts fit the limits and the period budget,
- the Kernel issues a one-use grant for the exact transfer,
- the vault's own policy contract allows it.

## Reading what happened

The revenue panel lists **Incoming payment allocations**: invoice, state, received amount and whether the receipt needs review. For each split, a deterministic explanation cites every transfer by transaction and on-chain reference. The same split always gives the same text. In Telegram, `splits` lists recent allocations.

## Group funds

In a group workspace a contribution is the member's equity, never revenue, so it is not split.
