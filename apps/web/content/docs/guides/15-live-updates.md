---
title: Live updates
description: How the hub and apps stay current with a server-sent event stream that carries markers, not content, and how to replay missed events.
---

Pages refresh themselves when something changes. The mechanism is a **stream of markers**: each says _what_ changed, never the content. The client then re-fetches the thing it cares about.

```text
 server                                        client
 ------                                        ------
 lead message committed  --marker-->  { type: LEAD_MESSAGE, entityId }
                                              |
                                      GET /v3/workspaces/.../leads/<id>
```

## Event types

| Type               | Meaning                                                  |
| ------------------ | -------------------------------------------------------- |
| `LEAD_UPDATED`     | A lead's stage or handling changed                       |
| `LEAD_MESSAGE`     | A new message in a lead                                  |
| `OFFER_UPDATED`    | An offer version changed                                 |
| `AGENT_EVENT`      | An agent run advanced                                    |
| `APPROVAL_CHANGED` | An approval request changed                              |
| `BALANCE_CHANGED`  | A balance changed                                        |
| `NOTIFICATION`     | A new notification                                       |
| `CONTEXT_REVOKED`  | Your session or membership no longer allows this context |

Markers are filtered by **who may open the thing**: lead, offer and run markers go only to owners and admins, member-visible markers go to members, and so on. A viewer does not receive staff markers.

## Using the stream

`GET /v3/events` returns `text/event-stream`.

- Each event has an `id` equal to its **cursor**. Reconnect with `?cursor=` or the `Last-Event-ID` header to replay what you missed.
- With no cursor, you start at the current head.
- The server polls its event table every 2 seconds, sends a keep-alive comment about every 15 seconds, and closes the connection after about **10 minutes**. Reconnect with the last cursor.
- On every poll it re-checks your session. If the session or membership is gone it sends a `CONTEXT_REVOKED` event and ends the stream.
- For clients that cannot hold a stream, `GET /v3/events/since?cursor=` returns a page of events and a `nextCursor`.
- Duplicates share an `eventId`; handle them idempotently.

```text
 id: 1042
 event: LEAD_MESSAGE
 data: {"cursor":"1042","type":"LEAD_MESSAGE","workspaceId":"...","entityId":"...","observedAt":"..."}
```

## Why markers carry no content

If the stream carried message text or amounts, any bug in routing or filtering would leak them. Markers only hold ids and types, and every refetch is authenticated and membership-checked.
