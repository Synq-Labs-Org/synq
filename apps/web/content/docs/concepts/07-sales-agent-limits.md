---
title: Sales agent limits
description: The complete list of guarantees about the AI sales agent, and the layers that enforce them.
---

The sales agent is a language model working for your business inside a narrow cage. This page lists what the cage guarantees and **where each guarantee is enforced**, so you can see that none of them rests on the model behaving.

## Guarantees

| # | Guarantee | Enforced by |
| --- | --- | --- |
| 1 | It never signs and never moves money | It has no key and no signing path; money needs wallet signatures |
| 2 | An offer is sent only if the validator allows it | Deterministic `validateOffer` against the signed policy |
| 3 | Prices, discounts and dates in text come from a validated offer | The server builds the offer description from validated terms and strips amounts from model text |
| 4 | It cannot exceed the owner-approval threshold | `OWNER_THRESHOLD` check; above it the agent hands over |
| 5 | It cannot sell outside the catalog | `SKU_KNOWN` check |
| 6 | It cannot go below floors or beyond the discount cap | `PRICE_FLOOR`, `DISCOUNT_CAP` |
| 7 | It cannot promise rush work without fresh declared capacity | `RUSH_CAPACITY` |
| 8 | It cannot change the policy | Policy changes need an owner's wallet signature |
| 9 | "Accepted" in chat is not a signature | Acceptance moves a lead to AGREED_PENDING_SIGNATURES only |
| 10 | It stops when a person takes over | Handling is re-checked at write time; its in-flight reply is dropped |
| 11 | A client's message cannot instruct it to break rules | Client text is wrapped as untrusted data; rules are outside the model |
| 12 | Every step is recorded | Typed agent events, append-only |
| 13 | It sees only its own lead | One lead's transcript and the catalog; no books, vaults or other leads |

## What the model is given

- The conversation transcript, **marked as untrusted**.
- The catalog and limits from the active signed policy (SKUs, descriptions, list prices, max quantities, lead times, rush surcharges, whether capacity is declared, max discount, min deposit, max milestones).
- The latest offer.

It is **not** given: floor prices, owner threshold, your books, vault address, other leads or any credential.

## What the model must return

A strict JSON object with an action (`ASK`, `OFFER`, `ACCEPT_LATEST`, `ESCALATE`), a reply of at most 1,000 characters, the offer terms or null, and an escalation reason or null. Anything else is treated as unreadable and the conversation is handed to a person.

## Failure behaviour

The default failure mode is **ask a human**. Missing model, missing policy, unreadable output, no valid offer after two tries and over-threshold requests all end with a handover and a flag on the lead.

## What this does not protect against

- A **bad policy**. If you sign a policy with a low floor, the agent can offer it. Review before you sign.
- A **bad human decision**. An owner who signs the agreement is accountable for the terms.
- **Nonsense that is within policy.** The agent may ask poor questions; it just cannot create unlawful authority.

See [The AI sales agent](/docs/guides/sales-agent) and [Commercial policy](/docs/guides/commercial-policy).
