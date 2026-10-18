---
title: Authentication routes
description: Device sessions, refresh rotation, session list and logout.
---

Sign-in itself starts with the `/v2/auth/challenge` login challenge (audience `native` for the iOS app). The wallet signs the challenge and the client exchanges it here for a device session. Login proves wallet ownership and never approves money.

Each device holds one live session: signing in again from the same `deviceId` revokes the previous one. The access token is valid for 15 minutes. The refresh token is valid for 30 days and rotates on every use; presenting a refresh token that was already rotated away revokes the whole device session and answers `SESSION_REVOKED`, because someone else may hold a copy.

The unauthenticated routes in this group are throttled per client address (20 requests a minute).

> **Security**
> Tokens are 32 random bytes shown once as 64 hex characters. The server stores only a SHA-256 digest of each token, so a database read cannot replay a session.

## Routes

### POST /v3/auth/device-session

Exchange a signed native login challenge for a device session.

|              |                                            |
| ------------ | ------------------------------------------ |
| Route id     | `auth.deviceSession`                       |
| Auth         | None                                       |
| Who may call | wallet that signed the /v2 login challenge |
| Status       | IMPLEMENTED                                |

**Request body** ([DeviceSessionRequest](/docs/api/schemas#devicesessionrequest))

| Field         | Type                               | Required | Notes |
| ------------- | ---------------------------------- | -------- | ----- |
| `challengeId` | uuid                               | yes      |       |
| `signature`   | string (`^0x[0-9a-fA-F]{130}$`)    | yes      |       |
| `device`      | [Device](/docs/api/schemas#device) | yes      |       |

**Response** ([DeviceSession](/docs/api/schemas#devicesession))

| Field              | Type                      | Required | Notes                  |
| ------------------ | ------------------------- | -------- | ---------------------- |
| `principalId`      | string (max 80)           | yes      |                        |
| `sessionId`        | uuid                      | yes      |                        |
| `accessToken`      | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `accessExpiresAt`  | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |
| `refreshToken`     | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `refreshExpiresAt` | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |

### POST /v3/auth/device-session/code

Exchange a one-time web sign-in code for a device session (no wallet on the phone).

|              |                                                              |
| ------------ | ------------------------------------------------------------ |
| Route id     | `auth.deviceSessionFromCode`                                 |
| Auth         | None                                                         |
| Who may call | holder of a fresh one-time code from a signed-in web session |
| Status       | IMPLEMENTED                                                  |

**Request body** ([DeviceCodeSessionRequest](/docs/api/schemas#devicecodesessionrequest))

| Field    | Type                               | Required | Notes |
| -------- | ---------------------------------- | -------- | ----- |
| `code`   | string (`^[0-9a-f]{48}$`)          | yes      |       |
| `device` | [Device](/docs/api/schemas#device) | yes      |       |

**Response** ([DeviceSession](/docs/api/schemas#devicesession))

| Field              | Type                      | Required | Notes                  |
| ------------------ | ------------------------- | -------- | ---------------------- |
| `principalId`      | string (max 80)           | yes      |                        |
| `sessionId`        | uuid                      | yes      |                        |
| `accessToken`      | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `accessExpiresAt`  | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |
| `refreshToken`     | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `refreshExpiresAt` | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |

### POST /v3/auth/refresh

Rotate tokens. Reusing an old refresh token revokes the session.

|              |                                                     |
| ------------ | --------------------------------------------------- |
| Route id     | `auth.refresh`                                      |
| Auth         | None                                                |
| Who may call | holder of the current refresh token for that device |
| Status       | IMPLEMENTED                                         |

**Request body** ([RefreshRequest](/docs/api/schemas#refreshrequest))

| Field          | Type                      | Required | Notes |
| -------------- | ------------------------- | -------- | ----- |
| `deviceId`     | uuid                      | yes      |       |
| `refreshToken` | string (`^[0-9a-f]{64}$`) | yes      |       |

**Response** ([DeviceSession](/docs/api/schemas#devicesession))

| Field              | Type                      | Required | Notes                  |
| ------------------ | ------------------------- | -------- | ---------------------- |
| `principalId`      | string (max 80)           | yes      |                        |
| `sessionId`        | uuid                      | yes      |                        |
| `accessToken`      | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `accessExpiresAt`  | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |
| `refreshToken`     | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `refreshExpiresAt` | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |

### GET /v3/auth/sessions

The principal's signed-in devices.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `auth.sessions`            |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Response** ([SessionList](/docs/api/schemas#sessionlist))

| Field      | Type                                                 | Required | Notes |
| ---------- | ---------------------------------------------------- | -------- | ----- |
| `sessions` | [SessionSummary](/docs/api/schemas#sessionsummary)[] | yes      |       |

### POST /v3/auth/logout

End this device session.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `auth.logout`                                           |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | principal                                               |
| Status       | IMPLEMENTED                                             |

**Response** ([Ok](/docs/api/schemas#ok))

| Field | Type   | Required | Notes |
| ----- | ------ | -------- | ----- |
| `ok`  | `true` | yes      |       |

### POST /v3/auth/revoke-all

End every session of this principal, including this one.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `auth.revokeAll`                                        |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | principal                                               |
| Status       | IMPLEMENTED                                             |

**Response** ([RevokeAll](/docs/api/schemas#revokeall))

| Field     | Type            | Required | Notes |
| --------- | --------------- | -------- | ----- |
| `revoked` | integer (min 0) | yes      |       |
