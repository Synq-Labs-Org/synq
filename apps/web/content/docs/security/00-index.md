---
title: Security overview and threat model
description: What Synq protects, who it defends against, the layers between a bad actor and your money, and the honest limits of a testnet demonstration.
---

> **Testnet**
> Synq is a preproduction testnet demonstration. The controls below are real and tested, but the system has not been through a production security audit and mainnet is locked off. Read [Testnet-only status](/docs/security/testnet-lock).

## What is being protected

| Asset                               | Where it lives                                                   |
| ----------------------------------- | ---------------------------------------------------------------- |
| Workspace funds (test USDC)         | Safe vault and policy contract; escrow contracts; Amane accounts |
| Authority to spend                  | Owners' wallet keys; signed mandates and policies                |
| Client conversations and deal terms | Synq database, visible to owners and admins                      |
| Sessions and tokens                 | Cookies, device sessions                                         |
| The audit trail                     | Append-only tables and hash-linked logs                          |

## Who we assume might attack

| Actor                                  | Capability assumed                                                       |
| -------------------------------------- | ------------------------------------------------------------------------ |
| A malicious or manipulated client      | Sends crafted chat messages, tries to get a better price or extra access |
| A prompt-injected or confused AI agent | Produces arbitrary text and tool-shaped output                           |
| A compromised chat account             | Controls a Telegram or iMessage identity                                 |
| A stolen session or refresh token      | Calls the API as the victim for a while                                  |
| A malicious website                    | Tries to get a victim to sign something or replay a request              |
| A compromised Synq server or worker    | Can run code in Synq's services                                          |
| A rogue or phished owner               | Holds one signing key                                                    |

## Layers between an attacker and the money

```text
  chat / API request
        |
  1  session + membership check          (who are you, are you in this workspace?)
  2  role check                          (are you allowed this action?)
  3  deterministic rules                 (Kernel, offer validator, policy)
  4  signed authority                    (EIP-712 from the right wallet(s))
  5  one-use grant, exact call hash      (cannot be mutated or replayed)
  6  recorded-before-broadcast outbox    (no silent retries)
  7  on-chain policy                     (caps, allowlist, timelock, pause)
  8  reconciliation                      (receipt matched; ambiguity -> review)
```

A single failure at one layer does not move money. The vault's own policy contract is the last line: even a compromised Synq server holding the operator key can only pay allowlisted recipients up to the caps, and the guardian can freeze it.

## Threats and answers

| Threat                                      | Answer                                                                                              |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| "Just say yes in chat"                      | Chat is never an approval; only signatures over exact terms count ([Agents](/docs/security/agents)) |
| Prompt injection in a client message        | Client text is untrusted data; rules and signatures sit outside the model                           |
| Model invents a price                       | Prices come from the validator-approved offer, never model text                                     |
| Replay of an old approval                   | One-use nonces, deadlines, intent-specific grants                                                   |
| Modified recipient or amount after approval | Grant binds the exact call hash; the executor recomputes it                                         |
| Stolen refresh token                        | Rotation with reuse detection revokes the device session                                            |
| Phishing for a signature                    | Typed data is readable; login says it approves nothing; signer and chain are checked                |
| Lead data leak via push                     | Push has only a generic title, category and event id                                                |
| Client turned into a member                 | Clients are external counterparties with a lead-scoped view                                         |
| Cross-workspace access                      | Membership checks on every route; 404 rather than 403 for hidden things                             |
| Bad vendor swap                             | New or changed vendor address waits 24 hours and needs owner quorum                                 |
| Compromised operator key                    | Scoped by the policy contract: allowlist, per-payment and 24-hour caps, USDC only                   |
| Governance takeover                         | Timelock on owner, threshold and module changes; guardian can pause                                 |
| Database tampering                          | Append-only triggers; hash-linked audit log with external anchoring option                          |

## Known limits (from the repository's own notes)

- Review links expose terms to whoever holds the link.
- The escrow arbiter in Deal Room deals is a hot-key role.
- Whole-operation escrow resumption after grant expiry is not automatic.
- A database rollback across a cold restart needs an independently retained audit checkpoint to be detected.
- External wallet screening, production messaging bridges and credential-dependent providers are unproven.
- iMessage conversation binding is blocked until a verified bridge exists.

Continue with [what agents can and cannot do](/docs/security/agents), [keys and custody](/docs/security/keys-custody), [sessions](/docs/security/sessions), [privacy](/docs/security/privacy), [the testnet lock](/docs/security/testnet-lock) and [reporting issues](/docs/security/reporting).
