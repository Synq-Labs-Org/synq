---
title: API reference
description: The Synq v3 app API: authentication, idempotency, errors and every route.
---

The Synq app API (contract version 3.0.0) is the one backend used by the iOS app, the web hub and the channel bots. This reference is generated from the Zod schemas in `packages/contracts`, so it cannot drift from the code. There are 50 routes: 49 marked IMPLEMENTED and 1 PLANNED in the contract.

> **Testnet**
> Everything runs on Arc testnet. Mainnet broadcasts are locked off (`SYNQ_ALLOW_MAINNET_BROADCAST=false`). No route in this API signs or sends money on its own: money moves only after a wallet signature or an on-chain proof.

## Base URL

Production clients call `https://synqlabs.world/api/v3/...`. The web app rewrites `/api/v3/*` to the API service's `/v3/*`, so the paths in this reference (which start with `/v3`) are appended to `https://synqlabs.world/api`. The older `/api/v1` and `/api/v2` paths are rewritten the same way; `/v2` still hosts the sign-in challenge.

## Authentication

| Mode          | How                                                 | Used by                                   |
| ------------- | --------------------------------------------------- | ----------------------------------------- |
| Native bearer | `Authorization: Bearer <64 hex chars>`              | iOS app and any client that wants refresh |
| Web cookie    | `__Host-synq_workspace` cookie, `Secure`, host-only | The web hub                               |

- A native **device session** is created by exchanging a signed login challenge (`POST /v3/auth/device-session`) or a one-time code made by a signed-in web session (`POST /v3/auth/device-session/code`).
- The access token lives **15 minutes**. The refresh token lives **30 days** and **rotates on every use**.
- Reusing a refresh token that was already rotated **revokes the session** (`SESSION_REVOKED`).
- A malformed bearer header is `401 UNAUTHENTICATED`. If both a bearer header and a cookie are sent, the bearer header wins. Duplicate cookies are refused.
- Cookie sessions that mutate state must also send an `Origin` header equal to the configured web origin, otherwise `403 ORIGIN_MISMATCH`. Bearer sessions are not subject to the Origin check, since they are not sent automatically by a browser.
- Auth column in the route tables: **None** (open), **Session** (any valid session), **Session + Idempotency-Key** (a mutation).
- Workspace routes also require membership with the listed role. A non-member, or a request for another tenant's id, gets `404`.

## Idempotency

Every mutation under `/v3` that requires a session must carry an `Idempotency-Key` header containing a UUID. A missing or malformed key is `400 IDEMPOTENCY_KEY_REQUIRED`. Lead messages use the key as the delivery key, so a retry with the same key is stored and answered once. Use a fresh key per user action and reuse it only when retrying that same action.

## Rate limits

Limits are fixed one-minute windows stored in Postgres. Exceeding one returns `429 RATE_LIMITED`.

| Bucket                                                   | Limit per minute |
| -------------------------------------------------------- | ---------------- |
| Unauthenticated auth routes, per client address (hashed) | 20               |
| Each authenticated principal                             | 120              |
| Each workspace (workspace routes and circles)            | 240              |
| Lead invitations, per workspace                          | 30               |
| Redeeming a lead invite, per principal                   | 10               |
| Client lead messages, per principal                      | 30               |
| Escrow prepare and submit, per principal                 | 30               |

## Errors

Every non-2xx response has the same body, [ApiError](/docs/api/schemas#apierror):

```json
{ "error": "VERSION_CONFLICT", "message": "version conflict" }
```

`error` is a stable machine code; `message` is human readable and never contains request data. Responses carry `cache-control: no-store`.

| Status | Codes                                                                                         | Meaning                                                        |
| ------ | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 400    | `INVALID_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_CURSOR`, `PRIVATE_DATA_REFUSED`       | Body, query or header failed validation                        |
| 401    | `UNAUTHENTICATED`, `SESSION_REVOKED`, `INVALID_NATIVE_CODE`, `NATIVE_CHALLENGE_REQUIRED`      | No valid session; refresh, then sign in                        |
| 403    | `FORBIDDEN`, `ORIGIN_MISMATCH`, `OWNER_REQUIRED`, `NATIVE_SESSION_REQUIRED`, signature errors | Authenticated but not allowed, or a signature was not accepted |
| 404    | `NOT_FOUND` and entity-specific codes                                                         | Missing, or not yours                                          |
| 409    | `VERSION_CONFLICT`, `OFFER_STALE`, `TAKEOVER_REQUIRED`, `AGREEMENT_ALREADY_FUNDED`            | State changed; reload and retry                                |
| 422    | `POLICY_BLOCKED` family, `LEASE_NOT_LIVE`, `CLIENT_WALLET_IS_MEMBER`                          | Understood but refused by policy                               |
| 429    | `RATE_LIMITED`                                                                                | Slow down                                                      |
| 503    | `NOT_CONFIGURED`, `UNSUPPORTED`, `AGREEMENT_ESCROW_UNAVAILABLE`, `AMANE_NOT_CONFIGURED`       | Feature not available on this server                           |
| 500    | `WORKSPACE_UNAVAILABLE`                                                                       | Unexpected failure; details are never returned                 |

A channel-identity or wallet-signature failure surfaces as 403 with the identity error code. The optional `retryable` flag tells a client whether retrying can help.

## Status values

Each route in the contract carries a `status`. `IMPLEMENTED` routes are served. `PLANNED` routes are in the contract so clients can build against them but the server does not register them. `GET /v3/meta` reports the live status of every route, so a client should hide anything not IMPLEMENTED there. Optional modules (approvals, leads, offers, events, notifications, Amane, agreements) register their routes only when configured, so a route marked IMPLEMENTED in the contract can still report PLANNED from a server without that module.

Responses also use shared vocabularies: [ProofLevel](/docs/api/schemas#prooflevel) (how strongly a fact is proven) and [CapabilityStatus](/docs/api/schemas#capabilitystatus) (whether a feature can be used). Money is an integer count of token base units in a decimal string, never a float; times are UTC ISO-8601.

## Pagination

List routes take `cursor` and `limit` (1 to 100) and return `items` and `nextCursor` (null on the last page). Cursors are opaque; pass them back unchanged.

## Real-time

`GET /v3/events` streams server-sent events and `GET /v3/events/since` polls the same feed. See [Events](/docs/api/events).

## Pages

| Group                                                        | Routes |
| ------------------------------------------------------------ | ------ |
| [Authentication routes](/docs/api/auth)                      | 6      |
| [Contexts and personal routes](/docs/api/contexts-personal)  | 4      |
| [Workspace routes](/docs/api/workspaces)                     | 7      |
| [Leads and offers](/docs/api/leads-offers)                   | 8      |
| [Lead sessions (client view)](/docs/api/lead-sessions)       | 3      |
| [Client agreements and escrow](/docs/api/agreements-escrow)  | 8      |
| [Approvals](/docs/api/approvals)                             | 3      |
| [Notifications and devices](/docs/api/notifications-devices) | 4      |
| [Events](/docs/api/events)                                   | 2      |
| [Amane routes](/docs/api/amane)                              | 4      |
| [Schemas](/docs/api/schemas)                                 | 108    |

The machine-readable contract is `packages/contracts/generated/openapi.json`.

## Service routes

### GET /v3/meta

Contract version and which routes this server implements.

|              |             |
| ------------ | ----------- |
| Route id     | `meta`      |
| Auth         | None        |
| Who may call | anyone      |
| Status       | IMPLEMENTED |

**Response** ([Meta](/docs/api/schemas#meta))

| Field             | Type                                       | Required | Notes |
| ----------------- | ------------------------------------------ | -------- | ----- |
| `contractVersion` | string                                     | yes      |       |
| `routes`          | [MetaRoute](/docs/api/schemas#metaroute)[] | yes      |       |

Example response (synthetic fixture):

```json
{
  "contractVersion": "3.0.0",
  "routes": [
    {
      "id": "me.contexts",
      "status": "IMPLEMENTED"
    },
    {
      "id": "workspace.inbox",
      "status": "PLANNED"
    }
  ]
}
```
