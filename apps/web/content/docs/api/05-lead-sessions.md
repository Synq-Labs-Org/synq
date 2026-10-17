---
title: Lead sessions (client view)
description: The outside client own view of their conversations.
---

The outside client is not a workspace member and never gets a workspace route. These routes show a client only the conversations bound to their own verified web identity; anyone else gets `404`. Staff-only fields (internal notes, handling version, other leads) are never present. A client message moves no money: the agent replies only while handling is `AGENT`. The `Idempotency-Key` doubles as the message delivery key, so a retried send is stored once and answered once. Client messages are throttled to 30 a minute per principal.

## Routes

### GET /v3/lead-sessions

The client's own private conversations with businesses.

|              |                                                |
| ------------ | ---------------------------------------------- |
| Route id     | `leadSessions.list`                            |
| Auth         | Session (bearer or cookie)                     |
| Who may call | external client who redeemed a web lead invite |
| Status       | IMPLEMENTED                                    |

**Response** ([ClientLeadList](/docs/api/schemas#clientleadlist))

| Field   | Type                                                       | Required | Notes |
| ------- | ---------------------------------------------------------- | -------- | ----- |
| `leads` | [ClientLeadSummary](/docs/api/schemas#clientleadsummary)[] | yes      |       |

Example response (synthetic fixture):

```json
{
  "leads": [
    {
      "leadId": "00000000-0000-4000-8000-000000000003",
      "businessName": "Example Studio",
      "stage": "OFFER_SENT",
      "lastActivityAt": "2026-10-17T10:03:00.000Z"
    }
  ]
}
```

### GET /v3/lead-sessions/{leadId}

Transcript and sent offers, without staff-only fields.

|              |                                                      |
| ------------ | ---------------------------------------------------- |
| Route id     | `leadSessions.detail`                                |
| Auth         | Session (bearer or cookie)                           |
| Who may call | the client bound to that lead (anyone else gets 404) |
| Status       | IMPLEMENTED                                          |

Path parameters: `leadId` (UUIDs unless stated).

**Response** ([ClientLeadDetail](/docs/api/schemas#clientleaddetail))

| Field                 | Type                                                         | Required | Notes |
| --------------------- | ------------------------------------------------------------ | -------- | ----- |
| `lead`                | [ClientLeadSummary](/docs/api/schemas#clientleadsummary)     | yes      |       |
| `consent`             | object                                                       | yes      |       |
| `consent.granted`     | boolean                                                      | yes      |       |
| `consent.grantedAt`   | ISO-8601 time or null                                        | yes      |       |
| `consent.scope`       | string (max 200)                                             | yes      |       |
| `messages`            | [LeadMessage](/docs/api/schemas#leadmessage)[]               | yes      |       |
| `olderMessagesCursor` | string (max 200, min 1) or null                              | yes      |       |
| `offers`              | [ClientOfferVersion](/docs/api/schemas#clientofferversion)[] | yes      |       |

Example response (synthetic fixture):

```json
{
  "lead": {
    "leadId": "00000000-0000-4000-8000-000000000003",
    "businessName": "Example Studio",
    "stage": "OFFER_SENT",
    "lastActivityAt": "2026-10-17T10:03:00.000Z"
  },
  "consent": {
    "granted": true,
    "grantedAt": "2026-10-17T10:01:00.000Z",
    "scope": "The business may read this private conversation."
  },
  "messages": [
    {
      "messageId": "00000000-0000-4000-8000-000000000014",
      "author": "LEAD",
      "text": "Can you do a logo and two banners by Friday?",
      "offerVersion": null,
      "createdAt": "2026-10-17T10:02:00.000Z"
    }
  ],
  "olderMessagesCursor": null,
  "offers": [
    {
      "offerId": "00000000-0000-4000-8000-000000000005",
      "version": 1,
      "termsHash": "0xc71c916768de28c0c224036e9c9fd7976ff24124a24445f4b37b571ff78d8075",
      "status": "SENT",
      "total": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "120000000"
      },
      "lines": [
        {
          "description": "Logo and two banners",
          "quantity": 1,
          "unitUnits": "120000000",
          "totalUnits": "120000000"
        }
      ],
      "milestones": [
        {
          "label": "Final files",
          "units": "120000000",
          "dueAt": null
        }
      ],
      "expiresAt": "2026-10-18T10:00:00.000Z",
      "createdAt": "2026-10-17T10:03:00.000Z"
    }
  ]
}
```

### POST /v3/lead-sessions/{leadId}/message

Client message; the sales agent replies only while handling is AGENT. Moves no money.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `leadSessions.message`                                  |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | the client bound to that lead (anyone else gets 404)    |
| Status       | IMPLEMENTED                                             |

Path parameters: `leadId` (UUIDs unless stated).

**Request body** ([LeadMessageRequest](/docs/api/schemas#leadmessagerequest))

| Field  | Type                     | Required | Notes |
| ------ | ------------------------ | -------- | ----- |
| `text` | string (max 4000, min 1) | yes      |       |

**Response** ([LeadMessage](/docs/api/schemas#leadmessage))

| Field          | Type                               | Required | Notes                  |
| -------------- | ---------------------------------- | -------- | ---------------------- |
| `messageId`    | uuid                               | yes      |                        |
| `author`       | `LEAD`, `AGENT`, `STAFF`, `SYSTEM` | yes      |                        |
| `text`         | string (max 4000)                  | yes      |                        |
| `offerVersion` | integer or null                    | yes      |                        |
| `createdAt`    | ISO-8601 time                      | yes      | UTC ISO-8601 timestamp |
