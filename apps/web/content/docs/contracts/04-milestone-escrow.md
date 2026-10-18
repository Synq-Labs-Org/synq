---
title: SynqMilestoneEscrow
description: The milestone escrow that holds client funds for a deal and releases them per milestone.
---

`SynqMilestoneEscrow` (`contracts/src/arc/SynqMilestoneEscrow.sol`, Solidity 0.8.28) holds one ERC-20 (Arc USDC) for deals made of up to 32 milestones. A payer funds the whole deal in a single transfer; each milestone then moves exactly once.

> **Security**
> The contract has no owner, no admin, no proxy, no pause, no `DELEGATECALL` and no `SELFDESTRUCT`. The token address is immutable. `UPGRADE_AUTHORITY()` returns `NON_UPGRADEABLE_NO_ADMIN`. Synq cannot change the rules of a deal after it is funded.

## Roles

| Role    | Set by                                      | Can                                                                                                                                               |
| ------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payer   | `msg.sender` of `open`                      | Release a funded milestone (unless a dispute is active); raise one dispute; withdraw a dispute it raised                                          |
| Payee   | `open` argument                             | Refund any unreleased milestone back to the payer (voluntary); raise one dispute                                                                  |
| Arbiter | `open` argument, optional (zero means none) | Release or refund any funded milestone at any time; named only on deals that allow disputes                                                       |
| Anyone  |                                             | Trigger `withdraw` of a released milestone (funds go only to the payee); trigger a timeout `refund` after `refundAfter` when no dispute is active |

`open` rejects a payee equal to the caller or the contract, an arbiter equal to the payer, the payee or the contract, zero or more than 32 milestones, and a `refundAfter` that is not in the future.

## Lifecycle

```text
                    open()  (payer funds all milestones)
                      |
                      v
                 +----------+      release()  payer, or arbiter       +-----------+
                 |  Funded  | ------------------------------------->  | Released  |
                 +----------+                                         +-----------+
                      |                                                     |
   refund()  payee or arbiter any time;                                     | withdraw()  anyone,
   anyone after refundAfter if no active dispute                            | pays the payee
                      |                                                     v
                      v                                              +-----------+
                 +----------+                                        | Withdrawn |
                 | Refunded |  (to the original payer)               +-----------+
                 +----------+
```

Each milestone is `None` until the deal opens, then `Funded`, and ends in `Withdrawn` or `Refunded`. A milestone can never be both. Every state change happens before its token transfer, and every mutating function is `nonReentrant`.

### Disputes

When a deal names an arbiter, the payer or the payee may call `dispute`. For `DISPUTE_PERIOD` (30 days) the payer cannot release and nobody can trigger the timeout refund, so only the arbiter settles. The raiser may call `withdrawDispute`. When the period lapses, the payer's release and the timeout refund resume. Each party may raise at most one dispute per deal, so a dispute cannot be renewed to freeze funds forever.

## Constants and views

| Name                       | Value or meaning                                                                   |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `UPGRADE_AUTHORITY`        | `"NON_UPGRADEABLE_NO_ADMIN"`                                                       |
| `MAX_MILESTONES`           | 32                                                                                 |
| `DISPUTE_PERIOD`           | 30 days                                                                            |
| `token`                    | The escrowed ERC-20 (immutable)                                                    |
| `dealCount`                | Number of deals opened; ids start at 1                                             |
| `totalLiability`           | Sum of Funded and Released-but-not-withdrawn milestones                            |
| `deal(dealId)`             | Payer, payee, arbiter, `refundAfter`, dispute flags, `milestoneCount`, `termsHash` |
| `milestone(dealId, index)` | `amount` and `status`                                                              |
| `disputeActive(dealId)`    | Whether a dispute currently freezes release and timeout refunds                    |

## External functions

| Function                                                  | Who                                                                          | Effect                                                                                                                                                              |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open(payee, arbiter, refundAfter, termsHash, amounts[])` | Payer                                                                        | Creates the deal and pulls the total with `transferFrom`. A short or fee-on-transfer delivery reverts, so the escrow always holds what it owes. Returns the deal id |
| `release(dealId, index)`                                  | Payer or arbiter                                                             | Funded to Released. The payer is blocked while a dispute is active                                                                                                  |
| `withdraw(dealId, index)`                                 | Anyone                                                                       | Released to Withdrawn; transfers to the payee                                                                                                                       |
| `refund(dealId, index)`                                   | Payee or arbiter any time; anyone after `refundAfter` with no active dispute | Funded to Refunded; transfers to the original payer                                                                                                                 |
| `dispute(dealId)`                                         | Payer or payee                                                               | Starts a 30-day freeze; needs an arbiter                                                                                                                            |
| `withdrawDispute(dealId)`                                 | The raiser                                                                   | Ends the active dispute                                                                                                                                             |

## Events

`DealOpened(dealId, payer, payee, arbiter, termsHash, total, refundAfter)`, `MilestoneReleased(dealId, milestone, by, amount)`, `MilestoneWithdrawn(dealId, milestone, payee, amount)`, `MilestoneRefunded(dealId, milestone, payer, amount)`, `Disputed(dealId, by, deadline)`, `DisputeWithdrawn(dealId, by)`.

## Errors

`InvalidDeal`, `InvalidAmount`, `UnknownDeal`, `UnknownMilestone`, `WrongStatus(status)`, `NotAuthorized(caller)`, `RefundNotYetAllowed(refundAfter)`, `DealDisputed`, `NoArbiter`, `DisputeAlreadyUsed`, `NotDisputeRaiser`, `TransferFailed`, `Reentrancy`.

## Invariants

- The refund always goes to the deal's original payer; no one can change it.
- Funds on withdrawal go only to the deal's payee.
- A milestone moves at most once from Funded, so it can be paid or refunded, never both.
- `totalLiability` equals the Funded plus Released-unwithdrawn amounts, and the token balance covers it because `open` checks the delivered amount.
- A dispute cannot be renewed: one per party per deal.

## How Synq uses it

The agreement signed by the client and owner includes a `termsHash`. The client wallet sends two transactions from its own key: an ERC-20 `approve` and `open` (see [Client agreements and escrow](/docs/api/agreements-escrow)). Synq prepares the exact calls, then the client submits the `open` transaction hash and the deal counts as funded only after the execution worker proves the `DealOpened` event on chain with the expected terms hash. Releases and refunds follow the milestone approvals in the workspace. See [execution worker](/docs/architecture/execution-worker) for the proof step.

The deployed address on Arc testnet, if any, is published only in `packages/chain-registry`; this page does not duplicate it. See [Contracts overview](/docs/contracts).
