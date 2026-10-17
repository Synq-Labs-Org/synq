---
title: Kernel and execution grants
description: How the deterministic Kernel turns an agent proposal plus an owner's signed authority into a one-use, expiring grant, and why a model can never create authority.
---

The **Kernel** is the part of Synq that decides whether a proposed action is allowed. It contains **no AI model and no signing key for your money**. It is a rule engine with an injected clock.

> **Security**
> Agents propose; only the Kernel authorizes. The Kernel itself cannot spend: it issues a *grant*, and a separate executor verifies the grant before it signs.

## The flow for a payment

```text
 1 PROPOSE        agent or person submits a PaymentIntent
      |
 2 DECIDE         Kernel checks the intent against the owner-signed mandate,
      |           live spend, risk and simulation
      |               ALLOW  | REQUIRE_OWNER_APPROVAL | DENY (with every reason)
      |
 3 APPROVE        if required: owner signs PaymentApproval (EIP-712)
      |           with a one-use nonce and a deadline (15 minutes)
      |
 4 GRANT          Kernel issues an ExecutionGrant bound to the exact call:
      |           chain, token, payer, recipient, amount, one-use nonce, short expiry,
      |           authenticated with the Kernel's key (MAC)
      |
 5 EXECUTE        the executor verifies the grant, consumes the nonce,
      |           records the signed bytes BEFORE broadcast, then broadcasts
      |
 6 RECONCILE      the receipt is matched on chain; the event becomes FINALIZED
```

## The mandate

A **payment mandate** is signed by its human owner and defines what is possible at all: payer account, asset, an allowlist of recipients, allowed purposes, a per-action cap, a rolling budget with its period, and a validity window. **Nothing else creates authority.** A chat button, a Telegram vote or model output is never a signature.

## What the Kernel checks

The Kernel reports **every** reason in one pass so the audit trail is complete. It denies when:

- the mandate is not signed by its owner, is revoked, not yet valid or expired,
- the intent references another mandate version, chain, asset or paying account,
- the amount is not positive, the recipient is not on the mandate allowlist, or the purpose is not allowed,
- the obligation (invoice or bill) was already granted or paid under this mandate,
- a hard risk flag is raised,
- the risk service is unavailable for a high-value payment (it fails closed),
- the period budget would be exceeded,
- the simulation failed,
- the owner approval is expired, already used or signed by the wrong address.

An amount above the per-action cap is not denied outright: it requires the owner's fresh approval instead. If approval is needed, the outcome is `REQUIRE_OWNER_APPROVAL` with the exact terms the owner must sign.

## One-use grants

A grant is useless for anything but the call it names:

- It binds the **exact call hash**. A changed recipient or amount produces a different hash and the executor refuses.
- Its nonce is consumed before signing, so it **cannot be replayed**.
- It **expires** quickly, never later than the owner's approval or setup deadline.
- A revoked mandate stops new grants immediately.

For escrow calls the grant identity includes a hash of the exact call: a grant for milestone 0 cannot release milestone 1, and a grant for terms v1 cannot open an escrow for terms v2.

## Other Kernel decisions in Synq

| Decision | What it binds |
| --- | --- |
| Vault creation | All proposed owners signed the exact setup; sponsor gas was reserved |
| Safe governance action | The current Safe quorum signed this bounded call and expiry |
| Escrow open, release, refund | The exact call, with who pays whom |
| Amane leased pay | The lease read back from the contract, plus the agent's signed intent |

## Why a database cannot cheat

The Kernel's audit log is an append-only record linked with an HMAC when an audit key is set. Restoring a snapshot needs the same key or an external anchor of the log head, otherwise the restore fails (`AUDIT_CHAIN_BROKEN`). The repository notes an honest limit: a database rollback across a cold restart needs an independently retained checkpoint to be detected.

See [Approvals and EIP-712 signing](/docs/concepts/approvals-eip712) and [What agents can and cannot do](/docs/security/agents).
