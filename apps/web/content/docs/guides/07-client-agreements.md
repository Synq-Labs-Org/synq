---
title: Client agreements and escrow funding
description: The client's side of a deal: link a wallet, sign the exact terms, and fund the milestone escrow from their own wallet.
---

After a client accepts an offer in chat, the deal becomes a **signed agreement** and a **funded escrow**. The client does this from their own wallet. The business never signs for them, and a chat message or Telegram identity is never a signature.

> **Note**
> These steps are implemented as client API routes under `/v3/client/leads/{leadId}/...`. At the time of writing there is no dedicated client screen for them in the web hub or iPhone app: the private lead page shows the conversation and offers, and integrators drive the signing and funding calls. Owner-side deal views in the hub link out to the wallet for the escrow actions.

## The whole flow

```text
 accept offer in chat
        |  lead stage = AGREED_PENDING_SIGNATURES
        v
 client links a wallet (signs a ClientWallet statement)
        v
 server builds ONE agreement from the accepted offer
        v
 client signs   owner signs      (same EIP-712 payload, either order)
        |  status = SIGNED
        v
 client funds the escrow: approve USDC, then open the deal
        |  status = FUNDING_PENDING
        v
 server sees the open transaction on chain and checks it
        |  status = FUNDED, lead stage = FUNDED
        v
 work, then milestones are released (see Escrow and milestones)
```

## Step 1: link a wallet

The client asks for a wallet-link message, signs it and posts the signature.

- The message is EIP-712 `Synq Client Wallet` and says: "Use this wallet to sign and pay for my deal with this business. I am not joining the business workspace."
- It names the workspace, lead, the client's principal id, the wallet and an expiry. The server offers 15 minutes; it accepts a deadline no more than 1 hour out.
- One wallet is linked per lead. The linked wallet must be different from the owner wallet and from the vault address (`CLIENT_WALLET_CONFLICT`).

## Step 2: the agreement

Fetching the agreement creates it from the **accepted** offer if none exists. If it cannot yet be created the response says why in `blocked`:

| `blocked`                  | Meaning                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `NO_ACCEPTED_OFFER`        | The lead is not in AGREED_PENDING_SIGNATURES or the latest offer is not ACCEPTED       |
| `CLIENT_WALLET_REQUIRED`   | Link a wallet first                                                                    |
| `NO_OWNER`                 | The workspace has no owner to sign                                                     |
| `CLIENT_WALLET_CONFLICT`   | Client wallet equals the owner wallet or payee                                         |
| `AGREEMENT_STALE`          | The offer changed after the agreement was drafted; it is voided and a new one is built |
| `AGREEMENT_TERMS_TAMPERED` | Stored fields no longer match their hash                                               |

The agreement binds: workspace, lead, offer id and version, the offer's terms hash, client wallet, owner wallet, **payee** (the vault if the workspace has one, otherwise the owner wallet), no arbiter, the milestones with amounts and due days, the total, delivery days and an expiry **7 days** after creation.

## Step 3: sign the exact terms

Both wallets sign the same EIP-712 `Synq Deal Agreement` payload. The statement inside it reads: "We agree to exactly these terms. Signing is not payment: the client funds the escrow separately from their own wallet, and funds release only by the milestones listed."

The submission carries the agreement id, the offer version, the terms hash and the signature. The server recovers the signer and requires it to equal the wallet fixed in the agreement. A signature over any other version or any altered field recovers a different address and is refused.

When both signatures are in, the status becomes `SIGNED` and an agent event records "each signed the exact accepted terms with their own wallets" at proof level `NOT_VERIFIED` (two signatures were checked; nothing is on chain yet).

## Step 4: fund the escrow

Ask for the escrow call. The server returns two transactions for the client's wallet to send, in order:

1. `APPROVE`: allow the escrow contract to pull the total in USDC.
2. `OPEN`: open the deal with the payee, no arbiter, a refund time, the milestone amounts and the signed terms hash.

The refund time is `now + (delivery days + 30 days)`. The status becomes `FUNDING_PENDING`.

After sending the `OPEN` transaction the client posts its hash. The server does not trust the hash: it proves the transaction came from the client with the prepared calldata, checks the escrow's `DealOpened` event and the token transfer, and only then marks the agreement `FUNDED`. Repeating the call returns the same result. Until a receipt is seen, nothing is funded.

> **Warning**
> Do not send the escrow transactions from any other wallet than the one linked to the lead. Funding from another account will not match the signed agreement.

## Expiry and recovery

- An unsigned agreement expires after 7 days (`EXPIRED`).
- An agreement that is stale or tampered is voided before funding.
- Funding that was prepared but not sent can be prepared again.
- If you fund and never get a release, the escrow lets anyone refund an unreleased milestone to the payer after the refund time. See [Escrow and milestones](/docs/concepts/escrow-milestones).
