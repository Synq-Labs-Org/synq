---
title: Keys and custody
description: Who holds which keys, what each key can do, and the three rules: agents never hold treasury keys, signing in never approves money, and a chat yes is not an approval.
---

## The three rules

> **Security**
>
> 1. **Agents never hold treasury keys.** The money is controlled by the owners' wallets through a Safe.
> 2. **Signing in never approves money.** The login message and the app lock are separate from approvals.
> 3. **A chat "yes" is not an approval.** Only an EIP-712 signature over the exact terms is.

## Who holds what

| Key                        | Held by                           | Can                                                                                                  | Cannot                                                            |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Owner wallet key           | Each owner, in their own wallet   | Sign approvals, Safe transactions, mandates, policies                                                | Is never given to Synq                                            |
| Safe (vault)               | On-chain contract                 | Hold USDC; move it with M-of-N owner signatures                                                      | Change its own policy without the timelock                        |
| Operator                   | Synq's execution worker           | Pay allowlisted recipients, USDC only, within the per-payment and 24-hour caps, after a Kernel grant | Add recipients, raise caps, change owners                         |
| Guardian                   | A configured pause key            | Freeze outflows for at most 7 days                                                                   | Move funds, change owners, block recovery                         |
| Sponsor                    | Synq's gas sponsor                | Pay gas for vault setup up to a ceiling you see before you sign                                      | Spend your USDC                                                   |
| Kernel grant key           | Synq's Kernel                     | Authenticate grants (MAC)                                                                            | Sign transactions                                                 |
| Agent key (Amane)          | Synq's agent                      | Pay inside an owner-signed lease                                                                     | Exceed the lease; the contract refuses                            |
| Escrow arbiter (Deal Room) | A role key on deals that name one | Settle disputes on those deals                                                                       | Redirect funds: refunds go to the payer, withdrawals to the payee |
| APNs key                   | Synq's push sender                | Send generic pushes                                                                                  | Read your data                                                    |
| Client wallet              | The client                        | Sign the agreement; fund the escrow                                                                  | Is never a workspace member                                       |

Synq's operational keys exist, but each is **narrow** and, wherever money is involved, bounded again by a contract. Treasury custody is the Safe, and the owners control the Safe.

## Where signing happens

- **Web:** your injected browser wallet. Synq never sees the private key.
- **iPhone:** a wallet reached by WalletConnect. The app and the iMessage extension do not store keys.
- **Telegram:** never. The bot links you to the secure page.

## Recovery and loss

Synq cannot recover an owner's key. If an owner loses a key, the remaining owners may still reach the threshold; replacing an owner is a timelocked Safe transaction. Choose a threshold that tolerates a loss, but is high enough that one stolen key is not enough. For a two-owner workspace the default threshold is 2 of 2, so losing either key blocks owner-quorum actions until you plan for it: consider three owners.

## Self-hosting keys

Operators who run Synq keep secrets (database credentials, the Kernel grant key, the operator and sponsor keys, the APNs key) in environment files or key files outside the repository; the secret scanner in the repository blocks committed secrets and mnemonics. Details are in the self-hosting section of the reference documentation when published.

## What to check as a user

1. The signer address on the approvals page is your owner wallet.
2. The vault address in the workspace matches what you expect and the chain is Arc testnet.
3. You never typed a seed phrase into a Synq page; no Synq page will ever ask for one.
