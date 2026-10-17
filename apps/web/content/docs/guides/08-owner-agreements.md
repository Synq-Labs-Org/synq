---
title: Owner agreement signing
description: How the business owner views a deal agreement, signs it with an owner wallet, and follows the escrow through to release.
---

The business side of a deal is deliberately small: an **owner** signs the exact terms with their own wallet, then watches the client fund the escrow.

## Who can do what

| Action | Role |
| --- | --- |
| See the lead's agreement | Owner, admin |
| Sign the agreement | Owner only |
| Fund the escrow | Never the business: the client pays |
| Release or refund a milestone | The parties' wallets; see below |

## View the agreement

`GET /v3/workspaces/{workspaceId}/leads/{leadId}/agreement` returns the agreement, or the reason it cannot exist yet (see the `blocked` table in [Client agreements](/docs/guides/client-agreements)). If an owner fetches it, the agreement binds **that owner's wallet** as the business signer; otherwise the earliest-joined owner is bound.

## Sign

`POST /v3/workspaces/{workspaceId}/leads/{leadId}/agreement/owner-signature` with the agreement id, offer version, terms hash and the EIP-712 signature. Check before you sign:

- The client wallet is the one the client linked.
- The **payee** is your vault (or your owner wallet if there is no vault yet).
- Milestone amounts and due days match the offer you intended.
- The total equals the offer total.
- The expiry is what you expect (7 days from creation).

Your wallet shows the typed data; if any field is not what the page shows, do not sign.

## After both signatures

The status is `SIGNED` and the lead stage `SIGNED`. The client then funds the escrow. When the open transaction is proven, the agreement is `FUNDED` and an agent event with status `FINALIZED` and actor `CHAIN` is recorded with the transaction hash and the proof level of the verification.

## Releasing money

Milestones move once: `Funded` then `Released` then `Withdrawn` to the payee, or `Funded` then `Refunded` to the client.

- **Release** is done by the payer (the client) or an arbiter. Agreements built from offers use **no arbiter**, so the client releases.
- **Withdraw** can be triggered by anyone but pays only the payee.
- **Refund** is by the payee or arbiter at any time, or by anyone after the refund time.

Escrow actions on the contract are always sent from a party's own wallet; Synq does not sign for the parties. For the deal escrow screens the server prepares the exact call and checks it again after submission. See [Escrow and milestones](/docs/concepts/escrow-milestones) and [Kernel and grants](/docs/concepts/kernel-grants). The iPhone app's deal screen says: "Fund, release or dispute in your wallet".
