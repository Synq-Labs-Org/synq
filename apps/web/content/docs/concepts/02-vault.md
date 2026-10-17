---
title: The vault
description: How a workspace's money is held in a Safe multisig with a policy contract: threshold, owners, scoped operator, timelock, guardian pause and no upgrade authority.
---

The **vault** is where a workspace's test USDC lives. It is built from two on-chain parts on Arc testnet:

1. A **Safe** (version 1.4.1) multisig. The workspace's owners are the Safe's signers, with an M-of-N **threshold**.
2. A **policy contract** (`SynqArcVaultPolicy`) installed as the Safe's transaction guard and module. It adds controls the Safe alone does not have.

```text
                 +----------------------------------------+
   owners ------>|  Safe  (M-of-N EIP-712 signatures)     |
   (threshold)   |   guard + module:  SynqArcVaultPolicy  |
                 +------------------+---------------------+
                                    |
        +---------------------------+-----------------------------+
        |                           |                             |
  owner-quorum              scoped operator                 guardian
  transactions              (Synq executor)                 (pause only)
  (timelock for             pays ONLY allowlisted
   governance)              recipients, USDC only,
                            per-payment + 24h caps
```

## Owners and threshold

Owners come from the workspace's owner members when the setup is proposed. The default threshold is `min(owners, 3, ceil(owners / 2) + 1)`; you can pick another from 1 to 20. Moving money from the Safe directly always needs that many owner signatures.

## The four controls

1. **Governance timelock.** Any change to the Safe's owners, threshold, modules, guard or fallback handler, any delegate call (the only way to change the Safe code), and any widening of the operator's scope must first be **queued** by an owner-quorum transaction, then wait the **delay** (default 24 hours; 1 hour to 30 days), then be **executed** by an owner-quorum transaction within a 14-day grace period.
2. **Scoped operator.** One operator address (set by the deployment; in Synq's hosted setup it is the execution worker's key) may pay **allowlisted recipients** in the vault's **USDC only**, up to a **per-payment cap** and a **rolling 24-hour cap**. It has no other entry point and cannot change governance. Defaults: 5 USDC per payment, 20 USDC per day.
3. **Guardian pause.** The guardian can freeze outflows (both owner-quorum transfers and operator payments) for at most **7 days**, then must wait a **2-day cooldown** before pausing again. It cannot move funds, change owners or block governance recovery. Lifting a pause early or replacing the guardian needs the timelock.
4. **Atomic transactions.** Gas refunds and non-zero `safeTxGas` are rejected, so a failed inner call always reverts the whole Safe transaction and cannot consume a queued operation.

A custom fallback handler also blocks a loophole: signature-based USDC authorisations (such as `transferWithAuthorization`) cannot be approved by an owner quorum off-chain to bypass the guard.

## No upgrade authority

The policy contract has no proxy, no admin, no delegate call and no self-destruct. The vault's token, delay and Safe address are immutable or write-once. The only way to change the vault's code or policy is a timelocked owner-quorum transaction that swaps the guard or module, or migrates the Safe singleton.

## How it appears in the product

| Product action | Vault mechanism |
| --- | --- |
| Vault setup | A factory creates the Safe, installs the policy and verifies the result in one transaction |
| Small payout (within the signed budget) | Operator pays within caps after owner approval and a Kernel grant |
| Large payout | Safe-quorum `PAY_VENDOR` action |
| Add a vendor to the allowlist | `QUEUE_VENDOR`, wait the delay, then `ALLOW_VENDOR` |
| Change caps | `QUEUE_CAPS`, then `SET_CAPS` after the delay |
| Emergency | Guardian pause |

## Other places value sits

- Milestone escrow contract for client deals ([Escrow](/docs/concepts/escrow-milestones)).
- An Amane account for leased agent payments ([Amane](/docs/concepts/amane)).

> **Testnet**
> This vault exists only on Arc testnet. Its contracts are not audited as production custody. Treat them as a demonstration of the design.

See [Set up the vault](/docs/guides/vault-setup) and [Keys and custody](/docs/security/keys-custody).
