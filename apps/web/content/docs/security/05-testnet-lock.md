---
title: Testnet-only status and the mainnet broadcast lock
description: Why Synq cannot move real money, how the mainnet broadcast switch and the chain checks enforce it, and what would have to change.
---

> **Testnet**
> Synq is a **preproduction testnet demonstration**. No mainnet canary, public launch or real-money use is authorised.

## What the lock is

The environment switch `SYNQ_ALLOW_MAINNET_BROADCAST` must be exactly the string `true` before any mainnet value movement could even be attempted. In the repository it is set to `false` and several components enforce it:

| Layer               | Behaviour                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Telegram bot        | Refuses to start if the switch is `true`, then forces it to `false`                                                                              |
| Workflow activities | Every value-moving step calls a guard first; on a mainnet chain without the switch it fails with `MAINNET_BROADCAST_DISABLED` and does not retry |
| Chain registry      | Even with the switch on, a separate mutation gate applies downstream                                                                             |
| Kernel              | Accepts only the Arc testnet chain id (a local chain is accepted in tests, never mainnet)                                                        |
| Execution worker    | Its deployment manifest check refuses a mainnet profile                                                                                          |
| Proof levels        | `LIVE_ARC_MAINNET` exists as a label but is never produced                                                                                       |

## Why it matters to you

- You cannot lose real money in Synq.
- Anything labelled USDC is test USDC.
- Results from this demo are not evidence about production behaviour, throughput, cost or reliability.

## Honest status of related claims

| Claim                                                             | Status                                                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Arc testnet transactions (escrow, payouts, splits)                | Evidence exists as local JSON proofs and explorer links in the repository             |
| CCTP and Gateway cross-chain proofs                               | Use Arc testnet and Ethereum Sepolia                                                  |
| x402 payments                                                     | `LOCAL_FIXTURE`: no public Arc-testnet facilitator and seller pair was available      |
| External wallet screening                                         | Blocked pending credentials; missing screening is disclosed, never treated as success |
| Real Telegram Guest Mode round trip                               | Not proven                                                                            |
| Production, credential-dependent and mainnet paths                | Unproven                                                                              |
| Developer-controlled wallets playing client, contractor and owner | Roles in demos, not independent customers                                             |

## What would have to change for mainnet

At minimum: independent security audits of the contracts and services, a production custody and key-management review, removal of the testnet-only checks in a controlled release, verified providers for screening and messaging, legal and compliance review, and an explicit decision by the maintainers. None of that is done or implied by these docs.
