---
title: SynqArcVaultPolicy
description: The per-vault guard and module that adds a timelock, a scoped operator and a guardian pause to a Safe.
---

`SynqArcVaultPolicy` (`contracts/src/arc/SynqArcVaultPolicy.sol`) is installed on one Safe v1.4.1 vault as both its **transaction guard** and an enabled **module**. The Safe's owners keep custody. This contract adds four controls.

1. **Governance timelock.** Every Safe self-call (owners, threshold, modules, guard, fallback handler), every `DELEGATECALL`, and every operator-scope expansion must first be queued by an owner-quorum transaction, wait `delay`, and then be executed by an owner-quorum transaction, once, inside `GRACE_PERIOD`.
2. **Scoped operator.** One operator address may pay allowlisted recipients in the vault token only, up to a per-payment and a rolling 24-hour cap.
3. **Guardian pause.** The guardian can freeze outflows for at most `MAX_PAUSE`, then must wait `PAUSE_COOLDOWN`. It cannot move funds, change owners or block timelocked governance recovery.
4. **Atomic transactions.** Safe gas refunds (`gasPrice`) and non-zero `safeTxGas` are rejected, so a failed inner call reverts the whole Safe transaction and cannot burn a queued operation.

> **Security**
> No proxy, no admin, no `DELEGATECALL`, no `SELFDESTRUCT`. `token`, `delay` and `factory` are immutable and `safe` is write-once. `UPGRADE_AUTHORITY()` returns `NON_UPGRADEABLE_POLICY; SAFE_CODE_AND_POLICY_SWAP_ONLY_BY_OWNER_QUORUM_AFTER_TIMELOCK`. The only way to change a vault's code is a timelocked owner-quorum `setGuard`, `enableModule`, `disableModule`, or a `DELEGATECALL` migration.

## Roles

| Role                | Held by                                  | Power                                                                          |
| ------------------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| Factory             | `SynqArcVaultFactory`                    | Calls `bind` once to attach the Safe                                           |
| Safe (owner quorum) | The vault                                | Queue, cancel, set guardian, operator, recipients and caps; all governed calls |
| Guardian            | Address chosen at creation (may be zero) | `pause`, `unpause`                                                             |
| Operator            | Address chosen at creation (may be zero) | `pay` within caps                                                              |

## Constants

| Name                      | Value                                               |
| ------------------------- | --------------------------------------------------- |
| `MIN_DELAY` / `MAX_DELAY` | 1 hour / 30 days                                    |
| `GRACE_PERIOD`            | 14 days to execute a queued operation after its ETA |
| `MAX_PAUSE`               | 7 days                                              |
| `PAUSE_COOLDOWN`          | 2 days after a pause ends before the next           |
| `WINDOW`                  | 1 day (operator spending window)                    |

## How the guard decides

`checkTransaction` runs before every owner-signed Safe transaction.

1. `gasPrice` and `safeTxGas` must be zero (`RefundsDisabled`).
2. If the transaction is **governed** (`isGoverned`): any `DELEGATECALL`, any call to the Safe itself, or any call to the policy except the instant, scope-reducing selectors (`queue`, `cancel`, `revokeOperator`, `removeRecipient`). It must have been queued: `NotQueued`, `NotReady` before the ETA, `Expired` after ETA plus grace. A valid operation is consumed (single use). Delegatecalls and Safe value transfers are frozen while paused. A `setGuard` to a replacement must point to a guard bound to the same Safe (`InvalidReplacement`), or every later transaction would revert.
3. Otherwise, when paused, only zero-value calls to the policy itself pass (`OutflowsPaused` for the rest).

## External functions

| Function                                                                    | Caller                                 | Timing                    | Effect                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bind(safe)`                                                                | Factory                                | Once                      | Attaches the Safe. Rejects a Safe equal to the operator, guardian or a recipient                                                                                                                                                                   |
| `checkTransaction(...)`, `checkAfterExecution(...)`                         | Safe                                   | Per transaction           | Guard hooks. The post hook is a no-op because execution is atomic                                                                                                                                                                                  |
| `queue(to, value, data, operation)`                                         | Safe                                   | Instant (quorum)          | Records `eta = now + delay`; refuses a live duplicate (`AlreadyQueued`)                                                                                                                                                                            |
| `cancel(id)`                                                                | Safe                                   | Instant                   | Removes a queued operation                                                                                                                                                                                                                         |
| `setGuardian(address)`                                                      | Safe                                   | Timelocked                | Replaces the guardian; the operator may not be the guardian                                                                                                                                                                                        |
| `setOperator(address)`                                                      | Safe                                   | Timelocked                | Sets the operator; not an owner, the Safe, guardian, a recipient                                                                                                                                                                                   |
| `revokeOperator()`                                                          | Safe                                   | Instant                   | Removes the operator (scope reduction)                                                                                                                                                                                                             |
| `addRecipient(address)`                                                     | Safe                                   | Timelocked                | Allowlist addition                                                                                                                                                                                                                                 |
| `removeRecipient(address)`                                                  | Safe                                   | Instant                   | Allowlist removal                                                                                                                                                                                                                                  |
| `setCaps(perPayment, window)`                                               | Safe                                   | Timelocked                | Sets operator caps                                                                                                                                                                                                                                 |
| `pause()`                                                                   | Guardian                               | Instant                   | Freezes outflows until now plus `MAX_PAUSE`; cannot extend a running pause; `PauseCooldown` if too soon                                                                                                                                            |
| `unpause()`                                                                 | Guardian, or Safe through the timelock |                           | Lifts the freeze; the cooldown runs from now                                                                                                                                                                                                       |
| `pay(recipient, amount, ref)`                                               | Operator                               | Instant, not while paused | Transfers from the Safe via `execTransactionFromModule`. Checks recipient allowlist, amount greater than zero, per-payment cap, rolling-window cap, then verifies the Safe and recipient balance deltas equal `amount` (`PaymentFailed` otherwise) |
| `paused()`, `operationId(...)`, `isGoverned(...)`, `supportsInterface(...)` | Anyone                                 | View                      | Status and helpers. Supports the Safe v1.4.1 Guard interface and ERC-165                                                                                                                                                                           |

Public state: `factory`, `token`, `delay`, `safe`, `guardian`, `pausedUntil`, `operator`, `perPaymentCap`, `windowCap`, `windowSpent`, `windowStart`, `isRecipient`, `eta`.

## Events

`Bound`, `OperationQueued`, `OperationCancelled`, `OperationExecuted`, `GuardianChanged`, `Paused`, `Unpaused`, `OperatorChanged`, `RecipientSet`, `CapsChanged`, `OperatorPaid(ref, operator, recipient, token, amount)`.

## Errors

`NotFactory`, `AlreadyBound`, `NotSafe`, `NotGuardian`, `NotOperator`, `InvalidDelay`, `InvalidAddress`, `AlreadyQueued`, `NotQueued`, `NotReady`, `Expired`, `RefundsDisabled`, `OutflowsPaused`, `RecipientNotAllowed`, `CapExceeded`, `ZeroAmount`, `PaymentFailed`, `Reentrancy`, `PauseCooldown`, `InvalidReplacement`.

## Invariants

- The operator can pay only allowlisted recipients, only in `token`, never more than the per-payment cap, and never more than the window cap per rolling day. It cannot change governance.
- Scope can shrink instantly (revoke the operator, remove a recipient, cancel a queue entry) but can grow only after the delay.
- A pause cannot be extended by the guardian, and recovery operations remain available to the quorum during a pause. A stolen quorum cannot lift a pause sooner than the lesser of `MAX_PAUSE` and `delay`.
- A queued operation executes at most once and only in its window.

## How Synq uses it

Synq's execution worker is the vault **operator**. For an approved payout (for example a contractor payment from a settled invoice) it submits `pay(recipient, amount, ref)` with `ref` tying the payment to the invoice or mandate id, through an outbox that guarantees one broadcast per grant (`workers/execution/src/vault-outbox.ts`). The Kernel grant authorizes the call; the policy enforces the same limits again on chain. Owners add recipients through the timelock, and the guardian role is the emergency brake. See [Architecture](/docs/architecture) and the [Kernel and grants](/docs/architecture/kernel-and-grants).
