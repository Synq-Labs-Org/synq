---
title: Glossary
description: Plain definitions of every term used in the Synq documentation, from Admin to x402.
---

Terms are alphabetical. Links point to the page that explains the idea in depth.

## A

| Term            | Meaning                                                                                                                                  |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Admin**       | A workspace role that runs the inbox and sales but has no signing authority. [Roles](/docs/concepts/workspaces-roles)                    |
| **Agent**       | Software (a model or rules) that proposes and explains but holds no treasury key. [Agents](/docs/security/agents)                        |
| **Agent event** | One append-only step of an agent run, with actor, status and proof level. [Agent events](/docs/concepts/agent-events)                    |
| **Agent run**   | A group of events for one piece of agent work                                                                                            |
| **Agreement**   | A deal document built from an accepted offer and signed by client and owner wallets. [Client agreements](/docs/guides/client-agreements) |
| **Allowlist**   | The recipients a vault operator may pay. Starts empty                                                                                    |
| **Amane**       | A payment-account contract that enforces owner-signed leases for agent payments. [Amane](/docs/concepts/amane)                           |
| **Approval**    | A wallet signature over exact terms. [Approvals](/docs/concepts/approvals-eip712)                                                        |
| **APNs**        | Apple Push Notification service, used for iPhone push                                                                                    |
| **Arbiter**     | An optional third party who can settle escrow disputes                                                                                   |
| **Arc testnet** | The test blockchain (chain id 5042002) Synq runs on                                                                                      |
| **Audience**    | `web` or `native`: what a login challenge is meant for                                                                                   |
| **Audit log**   | The append-only, hash-linked record of Kernel decisions                                                                                  |

## B

| Term                   | Meaning                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| **Base units**         | Integer amounts: 1 USDC = 1,000,000. [Units](/docs/concepts/units-and-money) |
| **Basis points (bps)** | Hundredths of a percent; 100 bps = 1%                                        |
| **Bill**               | A payable, recurring bill or milestone recorded in the books                 |
| **Broadcast**          | Sending a signed transaction to the chain                                    |
| **Business workspace** | The workspace kind that can have leads and offers                            |

## C

| Term                  | Meaning                                                                     |
| --------------------- | --------------------------------------------------------------------------- |
| **Cadence**           | Days between recurring bills                                                |
| **Catalog**           | The items and prices in the commercial policy                               |
| **Chain id**          | Network number in a signature domain; 5042002 for Arc testnet               |
| **Challenge**         | A single-use login message to sign. Lasts 5 minutes                         |
| **Circle**            | A group workspace where members contribute (also "circles" in the app)      |
| **Client**            | An outside counterparty on a lead; never a member                           |
| **Commercial policy** | The owner-signed rules for offers. [Policy](/docs/guides/commercial-policy) |
| **Consent scope**     | The sentence a client sees about who can read their conversation            |
| **Context**           | A personal or business space chosen in the app's switcher                   |
| **Contribution**      | A member's deposit into a group fund; equity, not revenue                   |
| **Cooling**           | The 24-hour wait for a new or changed vendor                                |
| **Cursor**            | A position in the event stream used to resume                               |

## D

| Term                   | Meaning                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| **Deal Room**          | Deals between workspace contacts with an independent arbiter                                     |
| **Deep link**          | A path in the app or web opened from a notification                                              |
| **Delay (governance)** | How long a queued vault change waits (1 hour to 30 days)                                         |
| **Deposit**            | The part of an offer total paid up front; minimum set by policy                                  |
| **Device session**     | App session with an access token and rotating refresh token. [Sessions](/docs/security/sessions) |
| **Digest**             | A SHA-256 hash stored instead of a secret token                                                  |
| **Discount cap**       | Maximum percent below list price in the policy                                                   |

## E

| Term                      | Meaning                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| **EIP-712**               | The typed-data signing standard. [Signing](/docs/concepts/approvals-eip712)                        |
| **Escrow**                | A contract holding USDC and releasing by milestone. [Escrow](/docs/concepts/escrow-milestones)     |
| **Escalate**              | Hand a lead to an owner                                                                            |
| **Execution grant**       | A one-use, expiring, exact-call permission from the Kernel. [Kernel](/docs/concepts/kernel-grants) |
| **Execution worker**      | The separate service that verifies grants and broadcasts                                           |
| **External counterparty** | A non-member party such as a client                                                                |

## F

| Term               | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| **Finance change** | A signed edit to vendors, budgets or bills               |
| **Fixture**        | A local stand-in for a real service. See `LOCAL_FIXTURE` |
| **Floor price**    | The lowest unit price any offer may use                  |
| **Forming**        | Workspace status while owners are being gathered         |
| **Freeze offers**  | Stop all new offers on a lead                            |

## G

| Term                | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| **Gas**             | Fee for a chain transaction; sponsored for vault setup                     |
| **Gateway**         | The service that receives chat messages and applies verified identity      |
| **Grace period**    | The window (14 days) to execute a queued vault operation                   |
| **Group workspace** | A kind used for pooled funds                                               |
| **Guard**           | A Safe module that checks every transaction. Synq's is the policy contract |
| **Guardian**        | The key that can pause vault outflows for up to 7 days                     |

## H

| Term           | Meaning                                               |
| -------------- | ----------------------------------------------------- |
| **Handling**   | Who answers a lead: `AGENT`, `HUMAN` or `FROZEN`      |
| **Hash chain** | Records linked so any change is detectable            |
| **Hold**       | A payout state: approved but not executing right now  |
| **Hub**        | The web interface at `/personal` and `/w/<workspace>` |

## I

| Term                   | Meaning                                                                         |
| ---------------------- | ------------------------------------------------------------------------------- |
| **Idempotency key**    | A UUID making a repeated request safe                                           |
| **Inbox**              | The list of leads for owners and admins                                         |
| **Intent**             | A proposed action in the Kernel's terms (a payment intent)                      |
| **Invitation**         | A one-use token to join a workspace or start a lead                             |
| **Invoice**            | A signed request for payment with a pay link. [Invoices](/docs/guides/invoices) |
| **Issue (an invoice)** | Sign and publish it                                                             |

## K

| Term       | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| **Kernel** | The deterministic rule engine. [Kernel](/docs/concepts/kernel-grants) |

## L

| Term                   | Meaning                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------- |
| **Lead**               | A private conversation with one prospect. [Leads](/docs/guides/leads-invites)           |
| **Lease**              | An owner-signed grant letting an agent pay within limits. [Amane](/docs/concepts/amane) |
| **Ledger**             | The double-entry record of balances and receipts                                        |
| **Live updates**       | The event stream of change markers. [Live updates](/docs/guides/live-updates)           |
| **`LIVE_ARC_TESTNET`** | Proof level: confirmed on Arc testnet. [Proof levels](/docs/concepts/proof-levels)      |
| **`LOCAL_FIXTURE`**    | Proof level: produced by a local test double                                            |

## M

| Term          | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| **Mandate**   | An owner-signed set of payment limits for the Kernel                            |
| **Member**    | A workspace role for collaborators                                              |
| **Milestone** | A step of a deal with its own amount and due day                                |
| **Mainnet**   | The real-value network. Locked off in Synq. [Lock](/docs/security/testnet-lock) |
| **Memo**      | A short text on an invoice                                                      |

## N

| Term                  | Meaning                                        |
| --------------------- | ---------------------------------------------- |
| **Native (audience)** | Login meant for the iPhone app                 |
| **Needs owner**       | A lead flag asking for an owner                |
| **Nonce**             | A one-use random value in a signature or grant |
| **`NOT_VERIFIED`**    | Proof level: nothing external was checked      |

## O

| Term           | Meaning                                                         |
| -------------- | --------------------------------------------------------------- |
| **Obligation** | An invoice, milestone or bill a payment settles                 |
| **Offer**      | Versioned terms sent to a client. [Offers](/docs/guides/offers) |
| **Operator**   | The scoped key that pays allowlisted recipients within caps     |
| **Origin**     | The website address a signature or request must match           |
| **Owner**      | The role that holds signing authority                           |

## P

| Term                   | Meaning                                                                           |
| ---------------------- | --------------------------------------------------------------------------------- |
| **Passkey**            | A device credential used in Synq's earlier fund product                           |
| **Payable**            | A vendor invoice the workspace owes                                               |
| **Payee**              | The receiver of escrowed funds                                                    |
| **Payer**              | The funder of an escrow                                                           |
| **Payout**             | A payment to a verified vendor. [Payouts](/docs/guides/payouts)                   |
| **Personal workspace** | A single-owner workspace                                                          |
| **Policy contract**    | `SynqArcVaultPolicy`, the guard and module on the vault                           |
| **Proof level**        | A label for the strength of evidence. [Proof levels](/docs/concepts/proof-levels) |
| **`PROVIDER_SANDBOX`** | Proof level: confirmed by a provider's sandbox                                    |
| **Push**               | An iPhone notification                                                            |

## Q

| Term              | Meaning                                        |
| ----------------- | ---------------------------------------------- |
| **Queue (vault)** | The first step of a timelocked vault change    |
| **Quiet hours**   | A per-device window when pushes are skipped    |
| **Quorum**        | Enough owner signatures to reach the threshold |

## R

| Term               | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| **Reconciliation** | Matching chain receipts to Synq's records                                               |
| **Refresh token**  | A rotating token for renewing a device session                                          |
| **Refund time**    | When anyone may refund unreleased escrow milestones                                     |
| **Revenue policy** | The signed rules for splitting incoming payments. [Splits](/docs/guides/revenue-splits) |
| **Role**           | Owner, Admin, Member or Viewer                                                          |
| **Rush**           | An offer flag for faster delivery, with a surcharge and capacity check                  |

## S

| Term             | Meaning                                                            |
| ---------------- | ------------------------------------------------------------------ |
| **Safe**         | The multisig wallet (v1.4.1) used as the vault                     |
| **Sales agent**  | The AI that answers leads. [Sales agent](/docs/guides/sales-agent) |
| **Semantic key** | The idempotency key of an agent event                              |
| **Session**      | Proof of a signed login. [Sessions](/docs/security/sessions)       |
| **Signer**       | An address whose signature is required                             |
| **SKU**          | A catalog item code                                                |
| **Sponsor**      | The gas payer for vault setup                                      |
| **Stage**        | A lead's position, from `LEAD_OPEN` to `RELEASED`                  |
| **Surcharge**    | Extra percent for rush work                                        |

## T

| Term           | Meaning                                                    |
| -------------- | ---------------------------------------------------------- |
| **Takeover**   | A person replacing the agent in a lead                     |
| **Terms hash** | Hash of an offer's exact terms, chained to its predecessor |
| **Testnet**    | A test blockchain with valueless tokens                    |
| **Threshold**  | The M in M-of-N: signatures needed                         |
| **Timelock**   | A mandatory delay before sensitive vault changes           |
| **Typed data** | Structured, human-readable data in EIP-712                 |

## U

| Term     | Meaning                                                    |
| -------- | ---------------------------------------------------------- |
| **USDC** | The dollar stablecoin used here (test version), 6 decimals |

## V

| Term          | Meaning                                                                         |
| ------------- | ------------------------------------------------------------------------------- |
| **Validator** | The deterministic offer checker                                                 |
| **Vault**     | The Safe plus policy holding a workspace's funds. [Vault](/docs/concepts/vault) |
| **Vendor**    | A verified payee for payouts                                                    |
| **Viewer**    | A read-only role                                                                |

## W

| Term              | Meaning                                              |
| ----------------- | ---------------------------------------------------- |
| **Wallet**        | An account that signs with a private key you control |
| **WalletConnect** | A protocol connecting the iPhone app to your wallet  |
| **Waterfall**     | The ordered split of a receipt in a revenue policy   |
| **Workspace**     | The shared container for members, vault and records  |

## X

| Term     | Meaning                                                               |
| -------- | --------------------------------------------------------------------- |
| **x402** | An HTTP payment protocol; labelled `LOCAL_FIXTURE` in this repository |
