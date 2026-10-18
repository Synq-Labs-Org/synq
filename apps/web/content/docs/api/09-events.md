---
title: Events
description: The server-sent event stream and its polling twin.
---

`GET /v3/events` is a server-sent event stream; `GET /v3/events/since` returns the same records as a JSON page for clients that cannot hold a connection.

**Stream behaviour** (from the server code):

- The first line is `retry: 2000` (the poll interval in milliseconds).
- Each event is written as `id: <cursor>`, `event: <type>`, `data: <StreamEvent JSON>`.
- Start position: the `cursor` query parameter, else the `Last-Event-ID` header, else the current head (no replay of old events).
- The session is re-checked on every poll. If it ends or the principal loses access, the server sends `event: CONTEXT_REVOKED` and closes.
- A `: keep-alive` comment is written about every 15 seconds.
- A connection stays open for at most 10 minutes; reconnect with the last cursor.
- Events are filtered to contexts the principal belongs to, and membership is re-checked by each query.

Event types: `LEAD_UPDATED`, `LEAD_MESSAGE`, `OFFER_UPDATED`, `AGENT_EVENT`, `APPROVAL_CHANGED`, `BALANCE_CHANGED`, `NOTIFICATION`, `CONTEXT_REVOKED`. Cursors are decimal strings and increase monotonically.

```text
GET /v3/events?cursor=1042
retry: 2000

id: 1043
event: LEAD_MESSAGE
data: {"cursor":"1043","type":"LEAD_MESSAGE", ...}

: keep-alive
```

## Routes

### GET /v3/events

Server-sent StreamEvent records; replay from a cursor.

|              |                                              |
| ------------ | -------------------------------------------- |
| Route id     | `events.stream`                              |
| Auth         | Session (bearer or cookie)                   |
| Who may call | principal; events filtered to their contexts |
| Status       | IMPLEMENTED                                  |

**Query parameters**

| Field    | Type                    | Required | Notes |
| -------- | ----------------------- | -------- | ----- |
| `cursor` | string (max 200, min 1) | no       |       |

**Response**: `text/event-stream`. Each event carries a [StreamEvent](/docs/api/schemas#streamevent) as its data line. See [Events](/docs/api/events).

### GET /v3/events/since

Same events as the stream, for clients that cannot hold a connection.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `events.poll`              |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Query parameters**

| Field    | Type                    | Required | Notes |
| -------- | ----------------------- | -------- | ----- |
| `cursor` | string (max 200, min 1) | no       |       |

**Response** ([StreamEventPage](/docs/api/schemas#streameventpage))

| Field        | Type                                           | Required | Notes |
| ------------ | ---------------------------------------------- | -------- | ----- |
| `items`      | [StreamEvent](/docs/api/schemas#streamevent)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                | yes      |       |
