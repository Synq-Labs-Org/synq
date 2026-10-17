---
title: Approvals and signing
description: A step-by-step guide to the approvals inbox, what each request means and how signing in your own wallet works.
---

The approvals inbox lists everything waiting for **your wallet's signature**, across all your workspaces. It is the only place money-affecting decisions are made.

> **Security**
> A login, a Face ID unlock, a notification tap and a chat "yes" are never approvals. Only the signatures listed on the approval page count.

## Where to find it

- Web hub: **Approvals** in the left navigation, or `/approvals`.
- iPhone app: the **Approvals** tab (personal contexts) or the "Waiting for your signature" row (business Home).
- Telegram: the bot only links you to the secure page.

## What kinds of requests appear

| Purpose | What you are approving |
| --- | --- |
| `VAULT_SETUP` | The exact vault: owners, threshold, caps, delay, gas ceiling |
| `VAULT_ACTION` | A Safe action: allow or remove a vendor, change caps, or a large vendor payment |
| `PAYOUT` | A payment to a verified vendor |
| `FINANCE_CHANGE` | Adding or changing vendors, budgets, bills, payables |
| `REVENUE_POLICY` | How incoming revenue is split |
| `DEAL_TERMS` | Terms of a deal |
| `ESCROW` | An escrow action (fund, release, refund, dispute) |
| `LEASE_ISSUE` / `LEASE_REVOKE` | Granting or ending an agent's payment lease |
| `CIRCLE_REFUND` | Refunding a group-fund contribution |
| `COMMERCIAL_POLICY` | The sales policy your agent must stay within |

## Step by step

1. **Open the request.** Each row shows the workspace, a one-line summary, the amount if there is one, a recipient hint such as `0x1234...abcd`, how many signatures are in so far (for example 1 of 2) and when it expires.
2. **Read "What you would sign".** The page shows: amount (or "No amount: this changes settings or authority"), recipient, who must sign, which contract or service enforces it, signatures so far and expiry.
3. **Check the steps.** Under "Signatures your wallet will ask for, in order" you see one to three steps. Some approvals need two signatures, for example a spending limit and then the exact payment.
4. **Connect the right account.** The page refuses to continue if your wallet is on a different address than the required signer, and tells you to switch.
5. **Switch to Arc testnet.** If your wallet is on another network the page asks it to switch to chain `5042002`. If the network is not listed in your wallet, add it first.
6. **Sign.** Your wallet shows the exact typed data (EIP-712) for each step. Compare it to the page. Approve each prompt.
7. **Read the result.**

| Result | Meaning |
| --- | --- |
| `RECORDED` | Your signature is stored. More owners still need to sign (for example 1 of 2) |
| `READY` | Enough signatures. Ready to submit; **nothing has moved yet** |
| `SUBMITTED` | Sent to the chain. Not final until the receipt shows finality |
| `REJECTED` | The server did not accept the signature. Nothing was approved |

## Quorum

Many approvals need several owners. The vault's **threshold** says how many. Each owner signs separately from their own wallet, in any order, before the request expires. The default approval lifetime for a payout is 15 minutes; the page always shows the exact deadline.

## Expiry and replay

Every approval has a one-use nonce and a deadline. An old signature cannot be replayed, and an expired request must be re-proposed.

## If something looks wrong

- If the amount, recipient or signer on the wallet screen differs from the page, **do not sign**. See [Approvals and EIP-712 signing](/docs/concepts/approvals-eip712) for what the fields mean.
- If the page says the request was not found, it may have expired, been cancelled or been signed by someone else.
- A `409` conflict message means the underlying request changed. Reload and read it again.

On iPhone the signing step opens your wallet through WalletConnect. The app says: "Your wallet shows these exact terms again before it signs."
