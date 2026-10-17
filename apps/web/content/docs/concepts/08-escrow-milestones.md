---
title: Escrow and milestones
description: How the milestone escrow contract holds a client's deposit and releases it milestone by milestone, with refunds, an optional arbiter and disputes.
---

For client work Synq uses **SynqMilestoneEscrow**, a small contract on Arc testnet that holds USDC for one deal of up to 32 milestones. Its rules are in the contract, not in Synq's database.

## Money states

Each milestone moves exactly once along one of two paths:

```text
                 release              withdraw
   Funded ------------------> Released ---------> Withdrawn   (to the payee)
      |
      +-------- refund -----------------------------------> Refunded   (to the payer)
```

## Who may do what

| Action | Who | Condition |
| --- | --- | --- |
| Open and fund a deal | Anyone (becomes the **payer**) | One transfer of the whole total; payee, arbiter and refund time are fixed here |
| Release a milestone | The payer, or the arbiter | Milestone is Funded; a payer release is frozen during an active dispute |
| Withdraw | Anyone may trigger | Pays **only** the payee, only a Released milestone |
| Refund | The payee, or the arbiter, at any time | Funds go to the original payer |
| Refund | Anyone, after the refund time | Milestone unreleased and not under dispute |
| Dispute | Payer or payee, once each | Needs an arbiter; freezes payer release and timeout refund for 30 days |
| Withdraw a dispute | The party who raised it | Anytime while active |

Rules that cannot be bypassed:

- The refund always goes to the original payer; nobody can change it.
- Funds only ever go to the deal's payee or back to the payer.
- Opening requires the payee to differ from the payer, the arbiter to differ from both, a refund time in the future, 1 to 32 milestones and no zero amounts.
- Opening refuses short deliveries (fee-on-transfer tokens); the contract must hold what it owes.
- Every state change happens before the token transfer and every entry point is non-reentrant.
- There is **no owner, no admin, no pause, no proxy**. Nobody can upgrade or freeze it.

## How Synq uses it for client deals

An agreement built from an offer ([Client agreements](/docs/guides/client-agreements)) opens the deal with:

- **payer**: the client's linked wallet,
- **payee**: the workspace vault (or the owner wallet if there is no vault),
- **arbiter**: none, so there are no disputes and the client releases,
- **refund time**: `now + (delivery days + 30 days)`,
- **terms hash**: the hash of the signed agreement version, recorded on chain,
- **amounts**: the offer's milestones.

After the client broadcasts `open`, the server verifies the `DealOpened` event and token transfer against the signed agreement before recording the escrow as funded.

## Deals with an independent arbiter

Deals between workspace contacts (the Deal Room screens) use three distinct parties: client, freelancer and an **independent arbiter**. The server refuses a deal where one person fills two roles (`INDEPENDENT_ARBITER_REQUIRED`). The arbiter settles disputes. The repository notes that the escrow arbiter is a **hot-key role**.

## What to remember

- Signing an agreement is not funding. Funding is a separate transaction from the client's own wallet.
- A milestone released is not yet paid out; `withdraw` pays it.
- If a client disappears, the refund returns the money to them after the refund time, and the payee can also refund voluntarily. If the client never releases, the work is not paid: pick milestones and deposits you can live with.

See [Owner agreements](/docs/guides/owner-agreements) and [Units and money](/docs/concepts/units-and-money).
