---
title: Anatomy of a money move
description: One owner-approved payout followed from request to on-chain receipt and ledger entry.
---

This page follows a vendor payout from a business workspace through every component. Other money moves (escrow funding, Amane payments, treasury swaps) reuse the same stages with different adapters.

```text
 1 request        2 assess          3 decide          4 approve (if needed)
 chat / app  -->  payables +   -->  Kernel:      -->  owner signs the exact
 "pay Acme 40     risk flags,       ALLOW / DENY /    intent (EIP-712)
  USDC for X"     screening         REQUIRE_OWNER
                                    _APPROVAL
                                         |
                                         v
 8 notify   <--  7 book        <--  6 verify     <--  5 execute
 push, chat,     ledger entry,      receipt vs         worker checks grant,
 event stream    PAID, events       the grant          simulates, signs ONCE,
                                                       broadcasts via vault
```

## 1. Request

A user asks in chat or the app. For chat, `packages/workspaces/src/payout-command.ts` parses a fixed grammar (`pay <vendor> <amount> USDC for <purpose> ref <reference>`); every field is read from the message, never inferred by a model. A model can only draft or explain. The request creates a payout row for a workspace member with the right role.

## 2. Assess

`@synq/payables` compares the payee with the vendor master (verified payout addresses and history), checks duplicates and available cash after reservations, and the risk plugin screens the recipient against the sanctions list. Anything unknown or unavailable becomes a flag; hard flags deny, and unavailable screening fails closed for high-value payouts.

## 3. Decide

The Kernel's `decide` takes the signed mandate, current mandate state, the intent, risk flags, whether simulation passed, and the current time. It checks in this order: the mandate was signed by its owner; not revoked, in its validity window, same version, chain, token and payer; then it collects every denial (recipient allowlist, purpose, positive amount, obligation not already paid, hard risk flags, risk availability above a value threshold); then the rolling period budget; then simulation. The result is one of:

| Outcome                  | Meaning                                                                                                              |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ALLOW`                  | A Kernel grant bound to the exact call                                                                               |
| `REQUIRE_OWNER_APPROVAL` | Above the per-action cap, or a confirmation was demanded; carries one-use approval terms (nonce, 15-minute deadline) |
| `DENY`                   | Reasons are returned and appended to the audit log                                                                   |

## 4. Approve

When the Kernel asks for approval, the owner signs `intentApprovalTypedData` (the exact intent plus the Kernel nonce) in their wallet or passkey flow. The Kernel recovers the signer and requires it to equal the mandate owner, rejects expired or reused nonces, and then allows. Taps in a chat are never signatures.

## 5. Execute

The execution worker receives the grant. Before signing it verifies the grant MAC, expiry, that the mandate is not revoked, that the grant matches the exact call it is about to sign (chain, token, payer, recipient, amount, target and calldata), and consumes the grant's single-use nonce in the same database transaction that records the signed bytes. It then verifies the policy contract code hash against the registry, simulates the call, signs, and broadcasts. For a governed vault the call is `SynqArcVaultPolicy.pay(recipient, amount, ref)`, so the contract enforces its own per-payment and 24-hour caps and recipient allowlist again. See [SynqArcVaultPolicy](/docs/contracts/vault-policy).

## 6. Verify

After the receipt arrives the worker checks it against the grant: the transaction succeeded, the expected `OperatorPaid` event came from the pinned policy, and the matching USDC transfer has the exact recipient and amount. Only then is the payment considered made. If the nonce was consumed by something else or the result is ambiguous, the record stops at `NEEDS_REVIEW` and nothing pays again automatically.

## 7. Book

`workers/execution/src/workspace-payout.ts` books a confirmed payout once: a balanced ledger entry keyed by chain evidence (so a replayed event cannot post twice), a `PAYOUT_SENT` agent event, a risk audit record, and the `PAID` state. The Arc chain indexer independently watches finalized blocks and can reconcile the same effect from the stored chain events.

## 8. Notify

The new events feed the live event stream, in-app notifications and push, and a receipt card to verified chat bindings. See [Events and notifications](/docs/architecture/events-notifications).

## What can go wrong, and what happens

| Failure                                    | Result                                                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Model proposes a different recipient       | Not on the mandate allowlist: `DENY`                                                                                             |
| Owner approval is replayed                 | Nonce already used: `DENY`                                                                                                       |
| Worker crashes after signing               | The next attempt finds the recorded bytes, reads the receipt or rebroadcasts the same bytes; it never signs a second transaction |
| RPC says success but the transfer differs  | Verification fails; `NEEDS_REVIEW`                                                                                               |
| Policy contract is paused by the guardian  | Simulation reverts; nothing is signed                                                                                            |
| Mandate revoked after the grant was issued | Executor-side check refuses the grant                                                                                            |
