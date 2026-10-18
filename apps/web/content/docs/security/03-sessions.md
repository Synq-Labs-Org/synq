---
title: Sessions and token rotation
description: How web cookies and device sessions work, how refresh tokens rotate, what reuse detection does and how to sign everything out.
---

A session is proof that someone signed the login challenge for a wallet. It lets the holder **read and propose**. It never approves money.

## Token handling

- Session tokens and refresh tokens are random values. The server stores only a **SHA-256 digest**, never the token itself.
- Invitations, lead links and native sign-in codes are also stored as digests and shown once.

## Web sessions

| Property  | Value                                                                                                 |
| --------- | ----------------------------------------------------------------------------------------------------- |
| Carrier   | `HttpOnly`, `Secure`, `SameSite=Strict` cookie                                                        |
| Lifetime  | 15 minutes                                                                                            |
| Mutations | Must come from the configured site origin; a cross-site page cannot make your browser change anything |
| Logout    | Clears the cookie and deletes the session row                                                         |

## Device sessions (iPhone)

```text
   sign in (wallet or code)
          |
          v
   access token  (15 min)   +   refresh token (30 days)
          |                         |
   used on every call               used only at /v3/auth/refresh
          |                         |
   expires                          ROTATES: old refresh token recorded as used,
                                    new access + refresh issued,
                                    previous access token deleted
```

- **Rotation.** Each refresh invalidates the old refresh token and the old access token.
- **Reuse detection.** If a refresh token that was _already used_ is presented again, someone else may hold a copy. Synq **revokes the whole device session** (`SESSION_REVOKED`) and deletes its access tokens. The real user simply signs in again.
- **Device list.** Account shows every signed-in device with its name, platform and last seen time, and marks the current one.
- **Sign out of this iPhone** removes the session and local cache. **Sign out every device** revokes all sessions for your account.
- Legacy code sessions (15 minutes, no refresh) are used when the server does not offer device sessions; the app shows a banner saying so.

## The sign-in challenge

| Property  | Value                                                           |
| --------- | --------------------------------------------------------------- |
| Lifetime  | 5 minutes                                                       |
| Use       | Once; consumed atomically                                       |
| Bound to  | Wallet, origin, audience (`web` or `native`) and a random nonce |
| Signed as | EIP-712 `Synq Workspace Login`, chain 5042002                   |

A signature made for the web audience cannot be turned into a native session, and the browser refuses a challenge whose origin is not the page it is on.

## Native handoff code

The web page can produce a one-use code that the app exchanges for a session. It expires in 2 minutes, is limited to a few requests per minute per account, and can only be requested from a signed-in **web** session.

## Rate limiting

Anonymous routes are throttled per IP; routes inside a workspace are throttled per workspace (for example 240 requests a minute); chat commands per person and per chat. Excess requests get `RATE_LIMITED` (429).

## Revocation and live sessions

The event stream re-checks your session on every poll. If it was revoked or your membership removed, you receive `CONTEXT_REVOKED` and the stream ends.

## Security headers on the web

The site sends a strict Content Security Policy (scripts and connections only to its own origin, no framing), `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.

## What to do if you suspect a leak

1. Sign out every device from Account.
2. Review pending approvals; reject nothing you do not recognise by simply not signing it. Unsigned approvals expire.
3. If a wallet key may be exposed, move to new owners through the vault's timelocked process. See [Keys and custody](/docs/security/keys-custody).
