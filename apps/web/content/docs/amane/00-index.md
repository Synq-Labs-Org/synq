---
title: Amane agent payments
description: Leased agent payments, where a smart account on Arc enforces what Synq's agent may pay.
---

Amane is a separate open-source project (MIT licence) for **leased agent authority**. An owner signs a root policy and a time-boxed lease for an agent key; a smart account on chain then enforces those limits for every payment, no matter what the agent's software does. Synq consumes Amane as a library and as a deployed contract. Amane never depends on Synq.

> **Testnet**
> Synq's Amane integration is restricted to the **PAY** action on Arc testnet. Mainnet broadcasts are locked off (`SYNQ_ALLOW_MAINNET_BROADCAST=false`). Every other Amane action (swap, bridge, escrow funding, fees, quotas) is unsupported in Synq today. See [Status](/docs/amane/status).

## Why it exists

A normal agent payment needs a human signature every time, or it trusts the agent's software with a key. A lease sits in between: the owner signs once, on chain, how much the agent may pay, to whom and until when. After that the agent can pay a contractor with no new human signature, but the contract refuses anything outside the lease, even if Synq's servers are compromised.

```text
 owner wallet                       Amane account (Arc testnet)
     |  signs root policy                 |
     |  signs agent lease  ------------>  |  stores policy + lease
     |                                    |
 Synq agent key                           |
     |  signs one PAY intent  ----------> |  checks lease live, caps,
     |  (via execution worker)            |  recipient, token, nonce, time
     |                                    |  --> pays the one allowed recipient
     |                                    |  emits Executed
 Synq verifies Executed, books ledger <---+
```

## The pieces in Synq

| Piece                   | Where                                                            | Role                                                                                                                    |
| ----------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Vendored Amane packages | `vendor/amane`                                                   | Pinned `@amane/arc`, `@amane/policy`, `@amane/verify` tarballs                                                          |
| Typed adapter           | `plugins/amane`                                                  | Reads live state from the contract, builds exact PAY intents and calldata, verifies the `Executed` event. Holds no keys |
| Workspace service       | `packages/workspaces/src/amane.ts`                               | Records accounts, leases and jobs after reading them back from chain                                                    |
| Kernel decision         | `decideAmaneLeasedPay` in `packages/kernel/src/arc-authority.ts` | Last deterministic check before the agent's payment is allowed                                                          |
| Execution worker        | `workers/execution/src/amane-pay.ts`                             | Signs the intent with the agent key, simulates, broadcasts, verifies, books                                             |
| API                     | `/v3/workspaces/{workspaceId}/amane/*` and `/mandates`           | See [Amane routes](/docs/api/amane)                                                                                     |

## Pages

- [Leases and intents](/docs/amane/leases-and-intents): the typed data, limits and revocation.
- [How Synq integrates](/docs/amane/integration): setup, jobs and the payment pipeline.
- [Vendored packages and SDK](/docs/amane/sdk): the pinned release and the newer SDK interface.
- [Status](/docs/amane/status): what is proven locally, live on testnet, and pending.
