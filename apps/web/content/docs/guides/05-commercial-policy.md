---
title: Commercial policy
description: The signed rulebook that bounds every offer, each field explained, and how to propose and sign a new version.
---

The **commercial policy** is the document that tells Synq what your business is willing to sell and on what terms. Offers are valid only if a deterministic validator says they fit the active policy. A policy takes effect only after an **owner signs its exact hash**.

## Fields

| Field | Meaning | Range |
| --- | --- | --- |
| Catalog items | 1 to 50 items | SKUs must be unique |
| SKU | Short product code | |
| Description | What it is | up to 200 chars |
| List price per unit | Standard price in USDC | |
| Floor price per unit | Lowest allowed unit price; never above list | |
| Maximum quantity | Per line | 1 to 1000 |
| Lead time (days) | Normal delivery time | 0 to 365 |
| Rush surcharge (%) | Added when an offer is marked rush | 0 to 100 percent |
| Capacity (optional) | Units you can deliver, with an as-of time. Unknown means rush work is refused | |
| Maximum discount (%) | How far below list any unit price may go | 0 to 50 percent |
| Minimum deposit (%) | Smallest deposit as a share of the total | 0 to 100 percent |
| Maximum milestones | Most milestones per offer | 1 to 6 |
| Offer valid for (hours) | How long a sent offer stays open | 1 hour to 30 days |
| Owner must approve offers above | Total (USDC) above which only an owner may send | |
| Capacity counts as fresh for (hours) | Age after which declared capacity is "unknown" | 1 hour to 30 days |

Prices on the page are entered in USDC with at most 6 decimals, such as `12.50`; the system stores integer base units.

## The checks every offer must pass

| Check | Rule |
| --- | --- |
| `SKU_KNOWN` | Every line uses a catalog SKU |
| `QUANTITY_LIMIT` | Quantity within the item's maximum |
| `PRICE_FLOOR` | Unit price at or above the floor |
| `DISCOUNT_CAP` | Not below list by more than the maximum discount |
| `LEAD_TIME` | Delivery days at least the item's lead time (normal work) |
| `RUSH_CAPACITY` | Rush work: fresh declared capacity covers the quantity |
| `MILESTONES_TOTAL` | Milestones add up to the total (lines plus rush surcharge) |
| `MILESTONE_COUNT` | No more milestones than the policy allows |
| `MILESTONES_BEFORE_DELIVERY` | Every milestone due on or before delivery |
| `DEPOSIT` | Deposit within the total and at least the minimum percentage |
| `POSITIVE_TOTAL` | Total greater than zero |
| `OWNER_THRESHOLD` | Above the threshold only an owner may send |

## Propose a version

1. Open **Settings** then **Sales policy** (owners and admins).
2. If none exists the page says "No policy yet. Propose the first version below."
3. Fill the form under **Propose a new version** and submit. The version is created in state `REVIEW` and gets a hash.
4. An **owner** opens the [approvals inbox](/docs/guides/approvals), reads the `COMMERCIAL_POLICY` request and signs. The wallet shows the statement: "Let the sales agent send offers within this policy. Offers never move money; payments need separate wallet approvals."

States: `REVIEW` then `ACTIVE`; the previous active version becomes `SUPERSEDED`. A version's content is immutable once stored.

> **Note**
> Admins can propose policies; only owners can sign them. An admin cannot widen the agent's authority without an owner's wallet.

## Changing the policy later

Propose a new version. Existing offers keep the policy version they were made under, which is shown on each offer card ("policy v3"). Re-checking an old offer also verifies that its policy is still the active one (`POLICY_CURRENT`).
