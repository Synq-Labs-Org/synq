---
title: Approvals and EIP-712 signing
description: What EIP-712 typed data is, what each Synq signature covers, and why a human can read before signing.
---

An **approval** in Synq is a signature, made by your own wallet, over a structured message that lists the exact terms. The format is **EIP-712 typed data** (`eth_signTypedData_v4`).

## Why typed data

A raw hex blob tells you nothing. EIP-712 gives every field a name and a type, and the wallet can display them, for example *recipient*, *amount*, *deadline*. The signature also commits to a **domain**: a name, a version and the chain id (5042002). A signature made for one Synq message type can never be accepted as another.

## The messages you may be asked to sign

| Domain name | Primary type | What it covers |
| --- | --- | --- |
| `Synq Workspace Login` | `WorkspaceLogin` | Proves wallet ownership. **Not an approval** |
| `Synq Client Wallet` | `ClientWallet` | Links a client's wallet to one lead |
| `Synq Commercial Policy` | `CommercialPolicy` | The exact policy hash the sales agent may act within |
| `Synq Deal Agreement` | `DealAgreement` | Client and owner terms: wallets, payee, milestones, total, expiry |
| `Synq Payment Mandate` | `PaymentMandate` | An owner's limits: recipients, purposes, per-action cap, budget, window |
| `Synq Payment Approval` | `PaymentApproval` | One exact payment: intent, recipient, amount, obligation reference, nonce, deadline |
| `Synq Workspace Finance` | `FinanceChange` | A vendor, budget, bill or payable edit, with revision and nonce |
| `Synq Workspace Revenue Revocation` | `RevokeRevenuePolicy` | Ending a revenue policy |
| Vault setup | setup typed data | Owners, threshold, caps, delay, gas ceiling |
| Safe action | action typed data | Vault governance call, payout through the Safe, etc. |

Some approvals need **two or three** signatures in a fixed order (for example a mandate and then the exact payment approval). The approvals page lists them in order.

## What is inside a payment approval

```text
 PaymentApproval {
   intentId        which intent
   mandateId       under which signed mandate
   token           the USDC contract
   payer           the vault
   recipient       who gets paid
   amount          uint256 base units
   obligationRef   the invoice or bill being paid
   nonce           one use
   deadline        unix time; default 15 minutes ahead
 }
```

Change any field after signing and the recovered signer is a different address, so the Kernel refuses.

## Checking before you sign

1. **Signer.** The approvals page names the address that must sign. A mismatch is blocked.
2. **Chain.** Your wallet must be on Arc testnet (5042002).
3. **Amount and recipient.** Compare the wallet prompt to the page. Amounts are shown to the wallet as decimal strings of base units.
4. **Purpose.** The page says what the request is and what enforces it.
5. **Expiry.** An expired approval is refused even if you sign.

## What a signature is not

- A login signature is not an approval.
- A signature in one workspace does not authorise anything in another (workspace ids are inside the messages).
- An approval signature does not move money by itself; it unlocks a grant that the Kernel issues and a separate executor consumes once.

## Signatures and wallets

Safe owners sign with ordinary Ethereum accounts. The server recovers each signer from the signature and compares it to the vault's **current** owner list read from the chain. Signatures from addresses that are not current owners are not counted.

See [Approvals and signing](/docs/guides/approvals) for the step-by-step.
