---
title: Units and money
description: How USDC amounts are written in Synq: base units, six decimals, strings and why floating point is never used.
---

All money in Synq is **test USDC on Arc testnet** (asset id `arc-testnet:USDC`), written as an integer count of **base units**.

| Display    | Base units |
| ---------- | ---------- |
| 1 USDC     | `1000000`  |
| 12.50 USDC | `12500000` |
| 0.001 USDC | `1000`     |
| 5 USDC     | `5000000`  |

USDC has **6 decimals**. Amounts in APIs are **strings** of digits, such as `"12500000"`, so that no client ever turns a large number into a floating-point value.

## Where you type decimals

Forms accept USDC with at most six decimals (`12.50`) and convert to base units. Telegram commands accept `25 USDC` or `0.5 USDC`; more than six decimals is refused.

## Native gas versus USDC

On Arc, gas is paid in the chain's native currency, which the interface shows as testnet USDC with 18 decimals. Do not confuse the 18-decimal native balance with the 6-decimal USDC token. Wallet prompts for the pay page add Arc Testnet with that native currency.

## Basis points

Percentages in policies are stored as **basis points**: 100 basis points = 1%, 10,000 = 100%. The forms for sales policy take percentages; the revenue form takes basis points directly ("100 = 1%").

## Rounding

Where a split must divide an amount, math is integer and any remainder (rounding dust) goes to the free-cash leg so totals always add up exactly.

## Other fields you will meet

| Field      | Format                                                                                 |
| ---------- | -------------------------------------------------------------------------------------- |
| Timestamps | Unix seconds on the server; ISO dates in views                                         |
| Hashes     | `0x` followed by 64 hex characters (terms hashes, evidence hashes, transaction hashes) |
| Addresses  | 40 hex characters with `0x`, shown shortened as `0x1234...abcd` for other people       |
| Ids        | UUIDs; invoices `inv_` plus hex                                                        |

See [Glossary](/docs/glossary).
