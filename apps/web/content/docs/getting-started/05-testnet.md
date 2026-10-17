---
title: Testnet and test USDC
description: Why everything runs on Arc testnet, the network details, how to get test USDC, and what testnet status means for you.
---

> **Testnet**
> Synq is a preproduction testnet demonstration. All money in these docs is **test USDC on Arc testnet**. It has no monetary value and can be reset at any time.

## Network facts

| Item | Value |
| --- | --- |
| Network | Arc testnet |
| Chain id | `5042002` (network id `eip155:5042002`) |
| Asset | USDC, 6 decimals (1 USDC = 1,000,000 base units). Asset id `arc-testnet:USDC` |
| Gas | Paid in native testnet USDC. Vault setup is sponsored by a gas sponsor with a ceiling shown to you before you sign |
| Block explorer | `https://explorer.testnet.arc.io` |
| Mainnet broadcast | Disabled (`SYNQ_ALLOW_MAINNET_BROADCAST=false`) |

Contract addresses and expected code hashes for the deployment live in the repository registry file `sources/arc_registry.json`.

## Getting test USDC

Test USDC is obtained outside Synq, from a public Arc testnet faucet for the wallet you sign in with. The codebase contains no faucet for Arc itself (the contributor-fund demo has its own internal starter balances, not covered here). Once your wallet holds test USDC you can:

- fund an invoice or escrow from your wallet as a client,
- pay gas for your own transactions,
- send test USDC to your workspace's vault address so the vault can pay vendors.

> **Warning**
> Never send anything of real value to an address shown in these docs or in the app. The vault is a testnet contract. If you copy an address, check the network is Arc testnet (5042002) first.

## What "testnet" changes

- Transactions are real on the test chain, so they are final and public, but worth nothing.
- Wallet screening, risk feeds and several providers run in sandbox or fixture mode. Each agent event carries a [proof level](/docs/concepts/proof-levels) saying which.
- The execution worker refuses mainnet chains. See [Testnet-only status](/docs/security/testnet-lock).
- Developer-controlled wallets play several roles (client, contractor, owner) in the public demonstration evidence, so those results are not independent customer activity.

## Reading the chain yourself

Every receipt that Synq shows has a transaction hash. Paste it into the Arc testnet explorer to see the transfer. For an escrow funding the hash is the `open` transaction; for an invoice payment it is the USDC transfer.

## Known limits of the demonstration

- Credential-dependent providers (real wallet screening, production messaging bridges) are unproven.
- The real Telegram Guest Mode round trip is not proven, per the repository status notes.
- iMessage linking of a chat to a workspace is blocked until a verified bridge exists.
