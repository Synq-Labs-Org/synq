---
title: Sign in with a wallet
description: How wallet sign-in works on the web, in the iPhone app and with a one-time code, what sessions last, and why signing in never approves money.
---

Synq has no passwords and no email accounts. You prove you control an Ethereum-style wallet by signing a short login message. The wallet address becomes your identity across the web hub, the iPhone app and the Telegram link.

> **Security**
> Signing in proves the wallet is yours. It does not approve a payment, a vault setup or anything else. The message you sign says so in plain words: "Sign in to Synq on Arc testnet. This signature does not approve payments or vault setup."

## What you need

- A wallet that can sign EIP-712 typed data. On the web this means a browser wallet that injects `window.ethereum`. WalletConnect is not wired into the web page yet; the page tells you to use a browser with an injected wallet.
- In the iPhone app, a wallet reachable through WalletConnect when your build includes a WalletConnect project id. If your build does not, use the one-time code route below.

## The sign-in flow

```text
 Browser / app                         Synq API
 -------------                         --------
 1. ask for a challenge  ------------>  create challenge (valid 5 minutes)
                         <------------  typed data "Synq Workspace Login"
 2. wallet shows the message,
    you sign it
 3. send signature       ------------>  recover the signer address
                                        must equal the wallet, origin must match
                                        challenge is single use
                         <------------  session (cookie on web, token in app)
```

The login message is EIP-712 typed data with the domain name `Synq Workspace Login`, version `1`, chain id `5042002` (Arc testnet). It contains:

| Field | Meaning |
| --- | --- |
| `challengeId` | A random id; the challenge can be used once |
| `wallet` | Your address |
| `origin` | The site asking you to sign. The page refuses a challenge whose origin is not its own |
| `audience` | `web` or `native`, so a web login cannot be replayed as a native one |
| `nonce` | Random value that makes each message unique |
| `expiresAt` | Challenge deadline, at most 5 minutes ahead |
| `statement` | The human sentence quoted above |

## Sessions

| Surface | What you hold | Lifetime |
| --- | --- | --- |
| Web hub | An `HttpOnly`, `Secure`, `SameSite=Strict` cookie | 15 minutes, then sign in again |
| iPhone app (device session) | A short access token and a rotating refresh token | Access token 15 minutes; refresh token up to 30 days |
| iPhone app (legacy code session) | A 15-minute token from a one-time code | 15 minutes, then a new code |

A **device session** is what the app uses when the server supports it. The app renews quietly while you use it. The refresh token rotates every time it is used. If an old, already-used refresh token is ever presented again, Synq assumes a copy leaked and revokes that whole device session. See [Sessions and token rotation](/docs/security/sessions).

## Signing in on iPhone with a one-time code

If your iPhone cannot reach your wallet directly, sign in on the web and hand the session to the phone:

1. Open the workspaces page in your browser and sign in with your wallet.
2. Choose **Generate private sign-in code**. You get a one-use code that expires in **2 minutes**.
3. In the app choose **Sign in with code** and paste it.

The code grants a 15-minute session. It carries no payment authority. Because the code is single use and short lived, a shoulder-surfed or leaked code is worthless a couple of minutes later.

## App Lock

On iPhone you can turn on **App Lock** under Account. It asks for Face ID or Touch ID when you return to the app. The app says it plainly: unlocking shows the app again and **does not approve or sign anything**. A biometric unlock is a screen lock, never a signature.

## Signing out

- **Sign out of this iPhone** deletes this device's session and cached data and clears Synq notifications from the lock screen.
- **Sign out every device** revokes all device sessions for your account. Each device must sign in again.
- On the web, logging out clears the cookie.

## Troubleshooting

| Problem | Likely cause |
| --- | --- |
| "Open this page in a browser with an injected Ethereum wallet" | No browser wallet detected; use a wallet-enabled browser or sign in on the phone with a code |
| "Invalid sign-in challenge" | The challenge origin, wallet or expiry did not match; reload and try again |
| Signed in but sees no workspaces | You have none yet. [Create one](/docs/getting-started/workspaces) or accept an invitation |
| Asked to sign in again after a short time | Web sessions last 15 minutes |
