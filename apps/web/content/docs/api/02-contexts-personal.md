---
title: Contexts and personal routes
description: The context switcher, the personal overview and circles.
---

A principal has one personal context and one business context for every business workspace it belongs to. These routes feed the app's context switcher and the personal home screen. Everything here is read-only.

## Routes

### GET /v3/me/contexts

Personal context plus one context per business workspace.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `me.contexts`              |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Response** ([Contexts](/docs/api/schemas#contexts))

| Field         | Type                                   | Required | Notes                                              |
| ------------- | -------------------------------------- | -------- | -------------------------------------------------- |
| `principalId` | string (max 80)                        | yes      |                                                    |
| `walletHint`  | string (max 16)                        | yes      | Shortened address for display, such as 0x12ab…9f3c |
| `contexts`    | [Context](/docs/api/schemas#context)[] | yes      |                                                    |

Example response (synthetic fixture):

```json
{
  "principalId": "principal-example",
  "walletHint": "0x1111…1111",
  "contexts": [
    {
      "contextId": "personal",
      "kind": "PERSONAL",
      "workspaceId": null,
      "displayName": "Personal",
      "role": null,
      "workspaceStatus": null,
      "unreadCount": 1
    },
    {
      "contextId": "00000000-0000-4000-8000-000000000001",
      "kind": "BUSINESS",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "displayName": "Example Studio",
      "role": "OWNER",
      "workspaceStatus": "ACTIVE",
      "unreadCount": 3
    }
  ]
}
```

### GET /v3/personal/overview

Own wallets, personal vaults, circles and recent activity.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `personal.overview`        |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Response** ([PersonalOverview](/docs/api/schemas#personaloverview))

| Field         | Type                                               | Required | Notes |
| ------------- | -------------------------------------------------- | -------- | ----- |
| `principalId` | string (max 80)                                    | yes      |       |
| `wallets`     | [WalletBalance](/docs/api/schemas#walletbalance)[] | yes      |       |
| `circles`     | [CircleSummary](/docs/api/schemas#circlesummary)[] | yes      |       |
| `vaults`      | [PersonalVault](/docs/api/schemas#personalvault)[] | yes      |       |
| `recent`      | [ActivityItem](/docs/api/schemas#activityitem)[]   | yes      |       |

Example response (synthetic fixture):

```json
{
  "principalId": "principal-example",
  "wallets": [
    {
      "address": "0x1111111111111111111111111111111111111111",
      "label": "Sign-in wallet",
      "balances": [
        {
          "assetId": "arc-testnet:USDC",
          "symbol": "USDC",
          "chainId": 5042002,
          "decimals": 6,
          "settled": "12500000",
          "reserved": "0",
          "pending": "0",
          "quarantined": "0"
        }
      ],
      "freshness": {
        "observedAt": "2026-10-17T10:00:00.000Z",
        "source": "CHAIN",
        "stale": false
      }
    }
  ],
  "circles": [
    {
      "circleId": "00000000-0000-4000-8000-000000000002",
      "displayName": "Example trip circle",
      "status": "ACTIVE",
      "role": "MEMBER",
      "memberCount": 3,
      "threshold": 2,
      "vault": "0x2222222222222222222222222222222222222222",
      "myContribution": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "5000000"
      },
      "held": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "settled": "15000000",
        "reserved": "5000000",
        "pending": "0",
        "quarantined": "0"
      },
      "openProposals": 1,
      "freshness": {
        "observedAt": "2026-10-17T10:00:00.000Z",
        "source": "CHAIN",
        "stale": false
      }
    }
  ],
  "vaults": [],
  "recent": [
    {
      "activityId": "activity-1",
      "kind": "CONTRIBUTION",
      "title": "You added 5 USDC to Example trip circle",
      "workspaceId": "00000000-0000-4000-8000-000000000002",
      "amount": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "5000000"
      },
      "status": "FINAL",
      "txHash": "0xd33f861b0c8e75a6f9aecf156568c46bb980fdf3e0ce4a70aaa89e9b8b8ebc7a",
      "occurredAt": "2026-10-17T10:02:00.000Z"
    }
  ]
}
```

### GET /v3/personal/circles

Group circles the principal is a verified member of.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `personal.circles`         |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Query parameters**

| Field    | Type                     | Required | Notes |
| -------- | ------------------------ | -------- | ----- |
| `cursor` | string (max 200, min 1)  | no       |       |
| `limit`  | integer (min 1, max 100) | no       |       |

**Response** ([CirclePage](/docs/api/schemas#circlepage))

| Field        | Type                                               | Required | Notes |
| ------------ | -------------------------------------------------- | -------- | ----- |
| `items`      | [CircleSummary](/docs/api/schemas#circlesummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                    | yes      |       |

### GET /v3/personal/circles/{circleId}

Members, attributed contributions, proposals and rules.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `personal.circle`          |
| Auth         | Session (bearer or cookie) |
| Who may call | circle member              |
| Status       | IMPLEMENTED                |

Path parameters: `circleId` (UUIDs unless stated).

**Response** ([CircleDetail](/docs/api/schemas#circledetail))

| Field           | Type                                                         | Required | Notes |
| --------------- | ------------------------------------------------------------ | -------- | ----- |
| `circle`        | [CircleSummary](/docs/api/schemas#circlesummary)             | yes      |       |
| `members`       | [CircleMember](/docs/api/schemas#circlemember)[]             | yes      |       |
| `contributions` | [CircleContribution](/docs/api/schemas#circlecontribution)[] | yes      |       |
| `proposals`     | [CircleProposal](/docs/api/schemas#circleproposal)[]         | yes      |       |
| `capabilities`  | map of [Capability](/docs/api/schemas#capability)            | yes      |       |
