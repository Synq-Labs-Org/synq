---
title: Sending offers
description: How offers are versioned and validated, how an owner or admin sends one, and what happens when the client accepts.
---

An **offer** is a set of terms: line items, rush or not, delivery days, milestones, a deposit and a short note. Every offer is an immutable **version** whose terms hash chains to the version it replaces.

## Who sends offers

| Sender                 | When allowed             | Validator actor                          |
| ---------------------- | ------------------------ | ---------------------------------------- |
| Sales agent            | Lead handling is `AGENT` | Agent: owner threshold applies           |
| Staff (owner or admin) | Lead handling is `HUMAN` | Staff; an owner may exceed the threshold |

Staff cannot send an offer while the agent is handling the lead. Take over first ([The AI sales agent](/docs/guides/sales-agent)).

> **Note**
> Sending an offer as staff is currently an API action (`POST /v3/workspaces/{workspaceId}/leads/{leadId}/offers`). The hub and iPhone app show offers, their checks and a **Re-check** button, but do not yet include a screen to author one.

## Offer terms

| Field          | Rule                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------- |
| `lines`        | 1 to 20 lines of `sku`, `quantity` (1 to 1000) and `unitUnits` (USDC base units as a string) |
| `rush`         | true or false                                                                                |
| `deliveryDays` | 1 to 365                                                                                     |
| `milestones`   | 1 to 6 items of `label`, `units`, `dueInDays`                                                |
| `depositUnits` | USDC base units                                                                              |
| `note`         | up to 400 chars                                                                              |

Amounts are integers in USDC base units: `12500000` is 12.5 USDC. See [Units and money](/docs/concepts/units-and-money).

## The send result

Sending runs the validator. The response has:

- `sent` true or false,
- `checks`: every rule with `passed` and a detail,
- `needsOwner`: true when the total is above the owner-approval threshold,
- `offer`: the stored version, or null when refused.

If any check fails nothing is sent and nothing is stored as an offer.

## Versions and statuses

```text
 offer v1 (SENT) --counter--> offer v2 (SENT)   v1 becomes COUNTERED
 offer v2 (SENT) --client accepts--> ACCEPTED
 other end states: REJECTED, EXPIRED, WITHDRAWN
```

- Sending a new version for the same offer id marks the previous `SENT` version `COUNTERED`. You cannot change an `ACCEPTED` offer.
- Once an offer leaves `SENT` its terms and the status guard stop any further edit.
- A `SENT` offer past its expiry is shown as `EXPIRED`.

## Re-checking an offer

**Re-check** (or `POST .../offers/{offerId}/versions/{version}/validate`) re-runs the validator now against the policy version the offer was made under, and adds two checks: `NOT_EXPIRED` and `POLICY_CURRENT` (that policy is still active).

## Accepting

The client accepts in chat by quoting the offer **version**. Only the newest, unexpired, `SENT` version can be accepted; anything else returns `OFFER_STALE`. Acceptance:

- sets the offer to `ACCEPTED`,
- sets the lead stage to `AGREED_PENDING_SIGNATURES`,
- flags the lead **needs owner**,
- and is not a signature and not a payment.

Next: [Client agreements and escrow funding](/docs/guides/client-agreements).
