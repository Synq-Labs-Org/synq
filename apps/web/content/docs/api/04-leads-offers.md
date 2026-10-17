---
title: Leads and offers
description: Staff inbox, takeover, invitations, offers and policy validation.
---

A lead is an outside prospect talking to a business through a private link. The sales agent answers while handling is `AGENT`; staff can take over (`HUMAN`), hand back, freeze offers or escalate. Takeover uses optimistic concurrency: send `expectedVersion` and a stale value answers `409 VERSION_CONFLICT`. Staff messages and offers are accepted only while handling is `HUMAN` (otherwise `409 TAKEOVER_REQUIRED`).

Offers are checked by deterministic commercial policy code, never by the model. A send that fails a check returns `sent: false` with the failed checks. A send above the owner threshold needs an owner signature from the approvals inbox. Invitation creation is throttled to 30 a minute per workspace; redeeming to 10 a minute per principal.

## Routes

### GET /v3/workspaces/{workspaceId}/inbox

Private leads, newest activity first.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.inbox`          |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN               |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId` (UUIDs unless stated).

**Query parameters**

| Field      | Type                                                                                                                                                                                                                                                                     | Required | Notes |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ----- |
| `cursor`   | string (max 200, min 1)                                                                                                                                                                                                                                                  | no       |       |
| `limit`    | integer (min 1, max 100)                                                                                                                                                                                                                                                 | no       |       |
| `stage`    | `LEAD_OPEN`, `DISCOVERY`, `QUALIFIED`, `OFFER_DRAFTED`, `OFFER_VALIDATED`, `OFFER_SENT`, `NEGOTIATING`, `AGREED_PENDING_SIGNATURES`, `SIGNED`, `FUNDING_PENDING`, `FUNDED`, `ACTIVE`, `DELIVERED`, `ACCEPTANCE_PENDING`, `RELEASED`, `REFUNDED`, `DISPUTED`, `CANCELLED` | no       |       |
| `handling` | `AGENT`, `HUMAN`, `FROZEN`                                                                                                                                                                                                                                               | no       |       |

**Response** ([InboxPage](/docs/api/schemas#inboxpage))

| Field        | Type                                           | Required | Notes |
| ------------ | ---------------------------------------------- | -------- | ----- |
| `items`      | [LeadSummary](/docs/api/schemas#leadsummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                | yes      |       |

Example response (synthetic fixture):

```json
{
  "items": [
    {
      "leadId": "00000000-0000-4000-8000-000000000003",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "label": "Telegram lead · 4F2A",
      "source": "TELEGRAM",
      "stage": "NEGOTIATING",
      "handling": "AGENT",
      "needsOwner": false,
      "unread": 2,
      "lastActivityAt": "2026-10-17T10:03:00.000Z"
    }
  ],
  "nextCursor": null
}
```

### GET /v3/workspaces/{workspaceId}/leads/{leadId}

Lead summary, consented transcript and offer versions.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.lead`           |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN               |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

**Response** ([LeadDetail](/docs/api/schemas#leaddetail))

| Field                 | Type                                             | Required | Notes |
| --------------------- | ------------------------------------------------ | -------- | ----- |
| `lead`                | [LeadSummary](/docs/api/schemas#leadsummary)     | yes      |       |
| `handlingVersion`     | integer (min 0)                                  | yes      |       |
| `consent`             | object                                           | yes      |       |
| `consent.granted`     | boolean                                          | yes      |       |
| `consent.grantedAt`   | ISO-8601 time or null                            | yes      |       |
| `consent.scope`       | string (max 200)                                 | yes      |       |
| `messages`            | [LeadMessage](/docs/api/schemas#leadmessage)[]   | yes      |       |
| `olderMessagesCursor` | string (max 200, min 1) or null                  | yes      |       |
| `offers`              | [OfferVersion](/docs/api/schemas#offerversion)[] | yes      |       |

Example response (synthetic fixture):

```json
{
  "lead": {
    "leadId": "00000000-0000-4000-8000-000000000003",
    "workspaceId": "00000000-0000-4000-8000-000000000001",
    "label": "Telegram lead · 4F2A",
    "source": "TELEGRAM",
    "stage": "NEGOTIATING",
    "handling": "AGENT",
    "needsOwner": false,
    "unread": 2,
    "lastActivityAt": "2026-10-17T10:03:00.000Z"
  },
  "handlingVersion": 3,
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
    },
    {
      "messageId": "00000000-0000-4000-8000-000000000015",
      "author": "AGENT",
      "text": "Yes. Here is an offer for 120 USDC in two milestones.",
      "offerVersion": 1,
      "createdAt": "2026-10-17T10:03:00.000Z"
    }
  ],
  "olderMessagesCursor": null,
  "offers": [
    {
      "offerId": "00000000-0000-4000-8000-000000000005",
      "version": 1,
      "termsHash": "0xc71c916768de28c0c224036e9c9fd7976ff24124a24445f4b37b571ff78d8075",
      "previousTermsHash": null,
      "policyVersion": 2,
      "status": "SENT",
      "createdBy": "AGENT",
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
          "label": "Drafts",
          "units": "60000000",
          "dueAt": "2026-10-19T10:00:00.000Z"
        },
        {
          "label": "Final files",
          "units": "60000000",
          "dueAt": "2026-10-21T10:00:00.000Z"
        }
      ],
      "expiresAt": "2026-10-18T10:00:00.000Z",
      "createdAt": "2026-10-17T10:03:00.000Z"
    }
  ]
}
```

### POST /v3/workspaces/{workspaceId}/leads/{leadId}/message

Staff message to the lead.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.leadMessage`                                 |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN (only while handling is HUMAN)             |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

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

### POST /v3/workspaces/{workspaceId}/leads/{leadId}/takeover

Take over, hand back, freeze offers or escalate; 409 on a stale version.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.leadTakeover`                                |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN                                            |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

**Request body** ([TakeoverRequest](/docs/api/schemas#takeoverrequest))

| Field             | Type                                                                         | Required | Notes |
| ----------------- | ---------------------------------------------------------------------------- | -------- | ----- |
| `action`          | `HUMAN_TAKEOVER`, `HAND_BACK_TO_AGENT`, `FREEZE_OFFERS`, `ESCALATE_TO_OWNER` | yes      |       |
| `expectedVersion` | integer (min 0)                                                              | yes      |       |

**Response** ([TakeoverResult](/docs/api/schemas#takeoverresult))

| Field             | Type                                           | Required | Notes |
| ----------------- | ---------------------------------------------- | -------- | ----- |
| `handling`        | [LeadHandling](/docs/api/schemas#leadhandling) | yes      |       |
| `handlingVersion` | integer (min 0)                                | yes      |       |

### POST /v3/workspaces/{workspaceId}/lead-invites

Single-use private invitation link for a prospect.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.leadInvite`                                  |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN                                            |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId` (UUIDs unless stated).

**Request body** ([LeadInviteRequest](/docs/api/schemas#leadinviterequest))

| Field              | Type                          | Required | Notes |
| ------------------ | ----------------------------- | -------- | ----- |
| `source`           | `TELEGRAM`, `WEB`             | yes      |       |
| `expiresInSeconds` | integer (min 300, max 604800) | yes      |       |

**Response** ([LeadInvite](/docs/api/schemas#leadinvite))

| Field         | Type           | Required | Notes                  |
| ------------- | -------------- | -------- | ---------------------- |
| `inviteId`    | uuid           | yes      |                        |
| `telegramUrl` | string or null | yes      |                        |
| `webUrl`      | string         | yes      |                        |
| `expiresAt`   | ISO-8601 time  | yes      | UTC ISO-8601 timestamp |

### POST /v3/lead-invites/redeem

Bind a private session to the redeeming identity, once.

|              |                                                 |
| ------------ | ----------------------------------------------- |
| Route id     | `leadInvite.redeem`                             |
| Auth         | Session (bearer or cookie)                      |
| Who may call | external lead with a provider-verified identity |
| Status       | IMPLEMENTED                                     |

**Request body** ([LeadInviteRedeem](/docs/api/schemas#leadinviteredeem))

| Field   | Type                              | Required | Notes |
| ------- | --------------------------------- | -------- | ----- |
| `token` | string (`^[A-Za-z0-9_-]{16,64}$`) | yes      |       |

**Response** ([LeadInviteRedeemResult](/docs/api/schemas#leadinviteredeemresult))

| Field    | Type    | Required | Notes |
| -------- | ------- | -------- | ----- |
| `leadId` | uuid    | yes      |       |
| `bound`  | boolean | yes      |       |

### POST /v3/workspaces/{workspaceId}/offers/{offerId}/versions/{version}/validate

Run the deterministic commercial policy checks on one offer version.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.offerValidate`                               |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN                                            |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId`, `offerId`, `version` (UUIDs unless stated).

**Response** ([OfferValidation](/docs/api/schemas#offervalidation))

| Field             | Type             | Required | Notes |
| ----------------- | ---------------- | -------- | ----- |
| `allowed`         | boolean          | yes      |       |
| `policyVersion`   | integer          | yes      |       |
| `checks`          | object[]         | yes      |       |
| `checks[].rule`   | string (max 60)  | yes      |       |
| `checks[].passed` | boolean          | yes      |       |
| `checks[].detail` | string (max 300) | yes      |       |

### POST /v3/workspaces/{workspaceId}/leads/{leadId}/offers

Send an offer (or a new version of one) after the policy checks pass.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.leadOffer`                                   |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN (only while handling is HUMAN)             |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

**Request body** ([OfferSendRequest](/docs/api/schemas#offersendrequest))

| Field     | Type                                       | Required | Notes |
| --------- | ------------------------------------------ | -------- | ----- |
| `terms`   | [OfferTerms](/docs/api/schemas#offerterms) | yes      |       |
| `offerId` | uuid                                       | no       |       |

**Response** ([OfferSendResult](/docs/api/schemas#offersendresult))

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `sent`       | boolean                                                | yes      |       |
| `checks`     | [OfferCheck](/docs/api/schemas#offercheck)[]           | yes      |       |
| `needsOwner` | boolean                                                | yes      |       |
| `offer`      | [OfferVersion](/docs/api/schemas#offerversion) or null | yes      |       |
