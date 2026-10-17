---
title: Schemas
description: Every named request and response schema.
---

Every named wire schema, in contract order. Fields marked required must be present; every object rejects unknown fields.

## ApiError

| Field       | Type             | Required | Notes |
| ----------- | ---------------- | -------- | ----- |
| `error`     | string (max 64)  | yes      |       |
| `message`   | string (max 600) | yes      |       |
| `retryable` | boolean          | no       |       |

## Ok

| Field | Type   | Required | Notes |
| ----- | ------ | -------- | ----- |
| `ok`  | `true` | yes      |       |

## ProofLevel

Enumeration: `LIVE_ARC_TESTNET`, `LIVE_ARC_MAINNET`, `PROVIDER_SANDBOX`, `LOCAL_FIXTURE`, `NOT_VERIFIED`, `BLOCKED`

## CapabilityStatus

Enumeration: `AVAILABLE`, `BLOCKED`, `NOT_CONFIGURED`, `UNSUPPORTED`, `OFFCHAIN_ONLY`, `ONCHAIN_AUTHENTICATED`, `VERIFIED_TESTNET`

## Capability

| Field    | Type                                                   | Required | Notes |
| -------- | ------------------------------------------------------ | -------- | ----- |
| `status` | [CapabilityStatus](/docs/api/schemas#capabilitystatus) | yes      |       |
| `reason` | string (max 600)                                       | yes      |       |

## WorkspaceKind

Enumeration: `PERSONAL`, `GROUP`, `BUSINESS`

## WorkspaceStatus

Enumeration: `FORMING`, `LAUNCHING`, `ACTIVE`

## Role

Enumeration: `OWNER`, `ADMIN`, `MEMBER`, `VIEWER`

## Money

| Field      | Type                               | Required | Notes                                        |
| ---------- | ---------------------------------- | -------- | -------------------------------------------- |
| `assetId`  | string (max 64)                    | yes      | Registry id such as arc-testnet:USDC         |
| `symbol`   | string (max 12)                    | yes      |                                              |
| `chainId`  | integer                            | yes      |                                              |
| `decimals` | integer (min 0, max 36)            | yes      |                                              |
| `units`    | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string |

## Balance

| Field         | Type                               | Required | Notes                                        |
| ------------- | ---------------------------------- | -------- | -------------------------------------------- |
| `assetId`     | string (max 64)                    | yes      |                                              |
| `symbol`      | string (max 12)                    | yes      |                                              |
| `chainId`     | integer                            | yes      |                                              |
| `decimals`    | integer (min 0, max 36)            | yes      |                                              |
| `settled`     | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Final on chain; includes reserved            |
| `reserved`    | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Settled but held for bills, deals or members |
| `pending`     | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Seen but not final                           |
| `quarantined` | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Arrived without a matching authorization     |

## Freshness

| Field        | Type                                   | Required | Notes                  |
| ------------ | -------------------------------------- | -------- | ---------------------- |
| `observedAt` | ISO-8601 time                          | yes      | UTC ISO-8601 timestamp |
| `source`     | `CHAIN`, `PROVIDER`, `LEDGER`, `CACHE` | yes      |                        |
| `stale`      | boolean                                | yes      |                        |

## MetaRoute

| Field    | Type                     | Required | Notes |
| -------- | ------------------------ | -------- | ----- |
| `id`     | string                   | yes      |       |
| `status` | `PLANNED`, `IMPLEMENTED` | yes      |       |

## Meta

| Field             | Type                                       | Required | Notes |
| ----------------- | ------------------------------------------ | -------- | ----- |
| `contractVersion` | string                                     | yes      |       |
| `routes`          | [MetaRoute](/docs/api/schemas#metaroute)[] | yes      |       |

Example (synthetic fixture):

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

## Device

| Field      | Type                   | Required | Notes                                      |
| ---------- | ---------------------- | -------- | ------------------------------------------ |
| `deviceId` | uuid                   | yes      | Random per-install id kept in the Keychain |
| `name`     | string (max 64, min 1) | yes      |                                            |
| `platform` | `ios`, `web`           | yes      |                                            |

## DeviceSessionRequest

| Field         | Type                               | Required | Notes |
| ------------- | ---------------------------------- | -------- | ----- |
| `challengeId` | uuid                               | yes      |       |
| `signature`   | string (`^0x[0-9a-fA-F]{130}$`)    | yes      |       |
| `device`      | [Device](/docs/api/schemas#device) | yes      |       |

## DeviceCodeSessionRequest

| Field    | Type                               | Required | Notes |
| -------- | ---------------------------------- | -------- | ----- |
| `code`   | string (`^[0-9a-f]{48}$`)          | yes      |       |
| `device` | [Device](/docs/api/schemas#device) | yes      |       |

## RefreshRequest

| Field          | Type                      | Required | Notes |
| -------------- | ------------------------- | -------- | ----- |
| `deviceId`     | uuid                      | yes      |       |
| `refreshToken` | string (`^[0-9a-f]{64}$`) | yes      |       |

## DeviceSession

| Field              | Type                      | Required | Notes                  |
| ------------------ | ------------------------- | -------- | ---------------------- |
| `principalId`      | string (max 80)           | yes      |                        |
| `sessionId`        | uuid                      | yes      |                        |
| `accessToken`      | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `accessExpiresAt`  | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |
| `refreshToken`     | string (`^[0-9a-f]{64}$`) | yes      |                        |
| `refreshExpiresAt` | ISO-8601 time             | yes      | UTC ISO-8601 timestamp |

## SessionSummary

| Field        | Type            | Required | Notes                  |
| ------------ | --------------- | -------- | ---------------------- |
| `sessionId`  | uuid            | yes      |                        |
| `deviceName` | string (max 64) | yes      |                        |
| `platform`   | `ios`, `web`    | yes      |                        |
| `createdAt`  | ISO-8601 time   | yes      | UTC ISO-8601 timestamp |
| `lastSeenAt` | ISO-8601 time   | yes      | UTC ISO-8601 timestamp |
| `current`    | boolean         | yes      |                        |

## SessionList

| Field      | Type                                                 | Required | Notes |
| ---------- | ---------------------------------------------------- | -------- | ----- |
| `sessions` | [SessionSummary](/docs/api/schemas#sessionsummary)[] | yes      |       |

## RevokeAll

| Field     | Type            | Required | Notes |
| --------- | --------------- | -------- | ----- |
| `revoked` | integer (min 0) | yes      |       |

## Context

| Field             | Type                                                         | Required | Notes                                 |
| ----------------- | ------------------------------------------------------------ | -------- | ------------------------------------- |
| `contextId`       | string (max 64)                                              | yes      | "personal" or a business workspace id |
| `kind`            | `PERSONAL`, `BUSINESS`                                       | yes      |                                       |
| `workspaceId`     | uuid or null                                                 | yes      |                                       |
| `displayName`     | string (max 80)                                              | yes      |                                       |
| `role`            | [Role](/docs/api/schemas#role) or null                       | yes      |                                       |
| `workspaceStatus` | [WorkspaceStatus](/docs/api/schemas#workspacestatus) or null | yes      |                                       |
| `unreadCount`     | integer (min 0)                                              | yes      |                                       |

## Contexts

| Field         | Type                                   | Required | Notes                                              |
| ------------- | -------------------------------------- | -------- | -------------------------------------------------- |
| `principalId` | string (max 80)                        | yes      |                                                    |
| `walletHint`  | string (max 16)                        | yes      | Shortened address for display, such as 0x12ab…9f3c |
| `contexts`    | [Context](/docs/api/schemas#context)[] | yes      |                                                    |

Example (synthetic fixture):

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

## WalletBalance

| Field       | Type                                     | Required | Notes       |
| ----------- | ---------------------------------------- | -------- | ----------- |
| `address`   | string (`^0x[0-9a-fA-F]{40}$`)           | yes      | EVM address |
| `label`     | string (max 40)                          | yes      |             |
| `balances`  | [Balance](/docs/api/schemas#balance)[]   | yes      |             |
| `freshness` | [Freshness](/docs/api/schemas#freshness) | yes      |             |

## CircleSummary

| Field            | Type                                                 | Required | Notes                  |
| ---------------- | ---------------------------------------------------- | -------- | ---------------------- |
| `circleId`       | uuid                                                 | yes      | The group workspace id |
| `displayName`    | string (max 80)                                      | yes      |                        |
| `status`         | [WorkspaceStatus](/docs/api/schemas#workspacestatus) | yes      |                        |
| `role`           | [Role](/docs/api/schemas#role)                       | yes      |                        |
| `memberCount`    | integer (min 0)                                      | yes      |                        |
| `threshold`      | integer or null                                      | yes      |                        |
| `vault`          | string (`^0x[0-9a-fA-F]{40}$`) or null               | yes      |                        |
| `myContribution` | [Money](/docs/api/schemas#money) or null             | yes      |                        |
| `held`           | [Balance](/docs/api/schemas#balance) or null         | yes      |                        |
| `openProposals`  | integer (min 0)                                      | yes      |                        |
| `freshness`      | [Freshness](/docs/api/schemas#freshness)             | yes      |                        |

## PersonalVault

| Field         | Type                                                 | Required | Notes |
| ------------- | ---------------------------------------------------- | -------- | ----- |
| `workspaceId` | uuid                                                 | yes      |       |
| `displayName` | string (max 80)                                      | yes      |       |
| `kind`        | [WorkspaceKind](/docs/api/schemas#workspacekind)     | yes      |       |
| `status`      | [WorkspaceStatus](/docs/api/schemas#workspacestatus) | yes      |       |
| `vault`       | string (`^0x[0-9a-fA-F]{40}$`) or null               | yes      |       |
| `balances`    | [Balance](/docs/api/schemas#balance)[]               | yes      |       |

## ActivityItem

| Field         | Type                                                                             | Required | Notes                  |
| ------------- | -------------------------------------------------------------------------------- | -------- | ---------------------- |
| `activityId`  | string (max 80)                                                                  | yes      |                        |
| `kind`        | `CONTRIBUTION`, `REFUND`, `PAYMENT`, `PROPOSAL`, `INVOICE_PAID`, `DEAL`, `OTHER` | yes      |                        |
| `title`       | string (max 140)                                                                 | yes      |                        |
| `workspaceId` | uuid or null                                                                     | yes      |                        |
| `amount`      | [Money](/docs/api/schemas#money) or null                                         | yes      |                        |
| `status`      | `PENDING`, `FINAL`, `FAILED`, `REFUNDED`                                         | yes      |                        |
| `txHash`      | string (`^0x[0-9a-fA-F]{64}$`) or null                                           | yes      |                        |
| `occurredAt`  | ISO-8601 time                                                                    | yes      | UTC ISO-8601 timestamp |

## PersonalOverview

| Field         | Type                                               | Required | Notes |
| ------------- | -------------------------------------------------- | -------- | ----- |
| `principalId` | string (max 80)                                    | yes      |       |
| `wallets`     | [WalletBalance](/docs/api/schemas#walletbalance)[] | yes      |       |
| `circles`     | [CircleSummary](/docs/api/schemas#circlesummary)[] | yes      |       |
| `vaults`      | [PersonalVault](/docs/api/schemas#personalvault)[] | yes      |       |
| `recent`      | [ActivityItem](/docs/api/schemas#activityitem)[]   | yes      |       |

Example (synthetic fixture):

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

## CirclePage

| Field        | Type                                               | Required | Notes |
| ------------ | -------------------------------------------------- | -------- | ----- |
| `items`      | [CircleSummary](/docs/api/schemas#circlesummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                    | yes      |       |

## CircleMember

| Field         | Type                               | Required | Notes                                              |
| ------------- | ---------------------------------- | -------- | -------------------------------------------------- |
| `principalId` | string (max 80)                    | yes      |                                                    |
| `walletHint`  | string (max 16)                    | yes      | Shortened address for display, such as 0x12ab…9f3c |
| `role`        | [Role](/docs/api/schemas#role)     | yes      |                                                    |
| `contributed` | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string       |
| `refunded`    | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string       |

## CircleContribution

| Field            | Type                                                      | Required | Notes                                              |
| ---------------- | --------------------------------------------------------- | -------- | -------------------------------------------------- |
| `contributionId` | string (max 80)                                           | yes      |                                                    |
| `payerHint`      | string (max 16)                                           | yes      | Shortened address for display, such as 0x12ab…9f3c |
| `amount`         | [Money](/docs/api/schemas#money)                          | yes      |                                                    |
| `status`         | `REQUESTED`, `PENDING`, `CREDITED`, `REFUNDED`, `EXPIRED` | yes      |                                                    |
| `txHash`         | string (`^0x[0-9a-fA-F]{64}$`) or null                    | yes      |                                                    |
| `observedAt`     | ISO-8601 time                                             | yes      | UTC ISO-8601 timestamp                             |

## CircleProposal

| Field           | Type                                                                                          | Required | Notes |
| --------------- | --------------------------------------------------------------------------------------------- | -------- | ----- |
| `proposalId`    | string (max 80)                                                                               | yes      |       |
| `kind`          | `PAYMENT`, `REFUND`, `SETTINGS`, `OTHER`                                                      | yes      |       |
| `title`         | string (max 140)                                                                              | yes      |       |
| `amount`        | [Money](/docs/api/schemas#money) or null                                                      | yes      |       |
| `recipientHint` | string (max 16) or null                                                                       | yes      |       |
| `approvals`     | integer (min 0)                                                                               | yes      |       |
| `threshold`     | integer                                                                                       | yes      |       |
| `status`        | `REVIEW`, `READY`, `SUBMITTED`, `CONFIRMED`, `FAILED`, `NEEDS_REVIEW`, `CANCELLED`, `EXPIRED` | yes      |       |
| `txHash`        | string (`^0x[0-9a-fA-F]{64}$`) or null                                                        | yes      |       |

## CircleDetail

| Field           | Type                                                         | Required | Notes |
| --------------- | ------------------------------------------------------------ | -------- | ----- |
| `circle`        | [CircleSummary](/docs/api/schemas#circlesummary)             | yes      |       |
| `members`       | [CircleMember](/docs/api/schemas#circlemember)[]             | yes      |       |
| `contributions` | [CircleContribution](/docs/api/schemas#circlecontribution)[] | yes      |       |
| `proposals`     | [CircleProposal](/docs/api/schemas#circleproposal)[]         | yes      |       |
| `capabilities`  | map of [Capability](/docs/api/schemas#capability)            | yes      |       |

## RunStatus

Enumeration: `PENDING`, `REQUIRES_OWNER`, `AUTHORIZED`, `BROADCAST`, `FINALIZED`, `RECONCILED`, `BLOCKED`, `REJECTED`, `TIMED_OUT`, `REORG_PENDING`, `REVOKED`, `QUARANTINED`

## EventActor

Enumeration: `MODEL`, `DETERMINISTIC`, `HUMAN`, `CHAIN`, `PROVIDER`

## AgentRunSummary

| Field         | Type                                                                                         | Required | Notes                  |
| ------------- | -------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| `runId`       | uuid                                                                                         | yes      |                        |
| `workspaceId` | uuid                                                                                         | yes      |                        |
| `title`       | string (max 140)                                                                             | yes      |                        |
| `trigger`     | `INVOICE_SETTLED`, `DEPOSIT_FINALIZED`, `SCHEDULE`, `OWNER_REQUEST`, `LEAD_MESSAGE`, `OTHER` | yes      |                        |
| `status`      | [RunStatus](/docs/api/schemas#runstatus)                                                     | yes      |                        |
| `amount`      | [Money](/docs/api/schemas#money) or null                                                     | yes      |                        |
| `proofLevel`  | [ProofLevel](/docs/api/schemas#prooflevel)                                                   | yes      |                        |
| `startedAt`   | ISO-8601 time                                                                                | yes      | UTC ISO-8601 timestamp |
| `updatedAt`   | ISO-8601 time                                                                                | yes      | UTC ISO-8601 timestamp |

## AgentEconomicEvent

| Field           | Type                                                                                           | Required | Notes                                       |
| --------------- | ---------------------------------------------------------------------------------------------- | -------- | ------------------------------------------- |
| `eventId`       | uuid                                                                                           | yes      |                                             |
| `workspaceId`   | uuid                                                                                           | yes      |                                             |
| `runId`         | uuid                                                                                           | yes      |                                             |
| `sequence`      | string (`^[0-9]{1,20}$`)                                                                       | yes      | Monotonic per workspace                     |
| `correlationId` | string (max 80)                                                                                | yes      |                                             |
| `causationId`   | string (max 80) or null                                                                        | yes      |                                             |
| `kind`          | `DECISION`, `INTENT`, `GRANT`, `BROADCAST`, `FINALIZED`, `REJECTED`, `RECONCILED`, `ESCALATED` | yes      |                                             |
| `actor`         | [EventActor](/docs/api/schemas#eventactor)                                                     | yes      |                                             |
| `status`        | [RunStatus](/docs/api/schemas#runstatus)                                                       | yes      |                                             |
| `summary`       | string (max 400)                                                                               | yes      | Redacted explanation; never model reasoning |
| `sourceKind`    | string (max 40)                                                                                | yes      |                                             |
| `observedAt`    | ISO-8601 time                                                                                  | yes      | UTC ISO-8601 timestamp                      |
| `effectiveAt`   | ISO-8601 time or null                                                                          | yes      |                                             |
| `evidenceHash`  | string (`^0x[0-9a-fA-F]{64}$`) or null                                                         | yes      |                                             |
| `proofLevel`    | [ProofLevel](/docs/api/schemas#prooflevel)                                                     | yes      |                                             |
| `amount`        | [Money](/docs/api/schemas#money) or null                                                       | yes      |                                             |
| `recipientHint` | string (max 16) or null                                                                        | yes      |                                             |
| `txHash`        | string (`^0x[0-9a-fA-F]{64}$`) or null                                                         | yes      |                                             |
| `chainId`       | integer or null                                                                                | yes      |                                             |

## Receipt

| Field           | Type                              | Required | Notes |
| --------------- | --------------------------------- | -------- | ----- |
| `chainId`       | integer                           | yes      |       |
| `txHash`        | string (`^0x[0-9a-fA-F]{64}$`)    | yes      |       |
| `blockNumber`   | string (`^[0-9]{1,20}$`) or null  | yes      |       |
| `finality`      | `PENDING`, `FINALIZED`, `REORGED` | yes      |       |
| `explorerUrl`   | string or null                    | yes      |       |
| `ledgerEntryId` | string (max 80) or null           | yes      |       |

## AgentRunPage

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `items`      | [AgentRunSummary](/docs/api/schemas#agentrunsummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                        | yes      |       |

## AgentRunDetail

| Field      | Type                                                         | Required | Notes |
| ---------- | ------------------------------------------------------------ | -------- | ----- |
| `run`      | [AgentRunSummary](/docs/api/schemas#agentrunsummary)         | yes      |       |
| `events`   | [AgentEconomicEvent](/docs/api/schemas#agenteconomicevent)[] | yes      |       |
| `receipts` | [Receipt](/docs/api/schemas#receipt)[]                       | yes      |       |

Example (synthetic fixture):

```json
{
  "run": {
    "runId": "00000000-0000-4000-8000-000000000004",
    "workspaceId": "00000000-0000-4000-8000-000000000001",
    "title": "Pay the design contractor after the client deposit",
    "trigger": "DEPOSIT_FINALIZED",
    "status": "RECONCILED",
    "amount": {
      "assetId": "arc-testnet:USDC",
      "symbol": "USDC",
      "chainId": 5042002,
      "decimals": 6,
      "units": "40000000"
    },
    "proofLevel": "LOCAL_FIXTURE",
    "startedAt": "2026-10-17T10:01:00.000Z",
    "updatedAt": "2026-10-17T10:04:00.000Z"
  },
  "events": [
    {
      "eventId": "00000000-0000-4000-8000-00000000001e",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "runId": "00000000-0000-4000-8000-000000000004",
      "sequence": "1",
      "correlationId": "corr-example",
      "causationId": null,
      "kind": "DECISION",
      "actor": "MODEL",
      "status": "PENDING",
      "summary": "Proposed paying the contractor 40 USDC from the deposit.",
      "sourceKind": "CFO_AGENT",
      "observedAt": "2026-10-17T10:01:00.000Z",
      "effectiveAt": null,
      "evidenceHash": null,
      "proofLevel": "NOT_VERIFIED",
      "amount": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "40000000"
      },
      "recipientHint": "0x3333…3333",
      "txHash": null,
      "chainId": null
    },
    {
      "eventId": "00000000-0000-4000-8000-00000000001f",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "runId": "00000000-0000-4000-8000-000000000004",
      "sequence": "2",
      "correlationId": "corr-example",
      "causationId": "00000000-0000-4000-8000-00000000001e",
      "kind": "GRANT",
      "actor": "DETERMINISTIC",
      "status": "AUTHORIZED",
      "summary": "Kernel allowed one payment within the lease.",
      "sourceKind": "KERNEL",
      "observedAt": "2026-10-17T10:02:00.000Z",
      "effectiveAt": "2026-10-17T10:02:00.000Z",
      "evidenceHash": "0x4b752987d6b40957ebe7c23a4f9556d1861eb2d5475b1009482ee4ca4a5309d9",
      "proofLevel": "LOCAL_FIXTURE",
      "amount": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "40000000"
      },
      "recipientHint": "0x3333…3333",
      "txHash": null,
      "chainId": null
    }
  ],
  "receipts": [
    {
      "chainId": 5042002,
      "txHash": "0x96627a7be7cbb4fe72959e6945aeec1f1e44776817ea21a2b753188338a0a91d",
      "blockNumber": "1000",
      "finality": "FINALIZED",
      "explorerUrl": null,
      "ledgerEntryId": "ledger-example"
    }
  ]
}
```

## AgentLease

| Field               | Type                                       | Required | Notes                                        |
| ------------------- | ------------------------------------------ | -------- | -------------------------------------------- |
| `leaseId`           | string (max 80)                            | yes      |                                              |
| `policyHash`        | string (`^0x[0-9a-fA-F]{64}$`)             | yes      |                                              |
| `agentId`           | string (max 80)                            | yes      |                                              |
| `actions`           | string (max 40)[]                          | yes      |                                              |
| `recipients`        | string (max 16)[]                          | yes      |                                              |
| `assetIds`          | string (max 64)[]                          | yes      |                                              |
| `perActionUnits`    | string (`^(0\|[1-9][0-9]{0,77})$`)         | yes      | Integer token base units as a decimal string |
| `availableUnits`    | string (`^(0\|[1-9][0-9]{0,77})$`)         | yes      | Integer token base units as a decimal string |
| `expiresAt`         | ISO-8601 time                              | yes      | UTC ISO-8601 timestamp                       |
| `revokedAt`         | ISO-8601 time or null                      | yes      |                                              |
| `enforcingContract` | string (max 42)                            | yes      |                                              |
| `chainId`           | integer                                    | yes      |                                              |
| `proofLevel`        | [ProofLevel](/docs/api/schemas#prooflevel) | yes      |                                              |

## Mandates

| Field        | Type                                         | Required | Notes |
| ------------ | -------------------------------------------- | -------- | ----- |
| `capability` | [Capability](/docs/api/schemas#capability)   | yes      |       |
| `leases`     | [AgentLease](/docs/api/schemas#agentlease)[] | yes      |       |

Example (synthetic fixture):

```json
{
  "capability": {
    "status": "NOT_CONFIGURED",
    "reason": "No Amane lease is installed for this workspace."
  },
  "leases": []
}
```

## WorkspaceOverview

| Field               | Type                                                           | Required | Notes                                        |
| ------------------- | -------------------------------------------------------------- | -------- | -------------------------------------------- |
| `workspaceId`       | uuid                                                           | yes      |                                              |
| `displayName`       | string (max 80)                                                | yes      |                                              |
| `status`            | [WorkspaceStatus](/docs/api/schemas#workspacestatus)           | yes      |                                              |
| `role`              | [Role](/docs/api/schemas#role)                                 | yes      |                                              |
| `balances`          | [Balance](/docs/api/schemas#balance)[]                         | yes      |                                              |
| `receivables`       | object                                                         | yes      |                                              |
| `receivables.open`  | integer (min 0)                                                | yes      |                                              |
| `receivables.units` | string (`^(0\|[1-9][0-9]{0,77})$`)                             | yes      | Integer token base units as a decimal string |
| `payables`          | object                                                         | yes      |                                              |
| `payables.open`     | integer (min 0)                                                | yes      |                                              |
| `payables.units`    | string (`^(0\|[1-9][0-9]{0,77})$`)                             | yes      | Integer token base units as a decimal string |
| `leads`             | object                                                         | yes      |                                              |
| `leads.open`        | integer (min 0)                                                | yes      |                                              |
| `leads.needsOwner`  | integer (min 0)                                                | yes      |                                              |
| `pendingApprovals`  | integer (min 0)                                                | yes      |                                              |
| `agentHighlights`   | [AgentRunSummary](/docs/api/schemas#agentrunsummary)[] (max 5) | yes      |                                              |
| `capabilities`      | map of [Capability](/docs/api/schemas#capability)              | yes      |                                              |
| `freshness`         | [Freshness](/docs/api/schemas#freshness)                       | yes      |                                              |

Example (synthetic fixture):

```json
{
  "workspaceId": "00000000-0000-4000-8000-000000000001",
  "displayName": "Example Studio",
  "status": "ACTIVE",
  "role": "OWNER",
  "balances": [
    {
      "assetId": "arc-testnet:USDC",
      "symbol": "USDC",
      "chainId": 5042002,
      "decimals": 6,
      "settled": "250000000",
      "reserved": "40000000",
      "pending": "10000000",
      "quarantined": "0"
    }
  ],
  "receivables": {
    "open": 2,
    "units": "120000000"
  },
  "payables": {
    "open": 1,
    "units": "40000000"
  },
  "leads": {
    "open": 4,
    "needsOwner": 1
  },
  "pendingApprovals": 1,
  "agentHighlights": [
    {
      "runId": "00000000-0000-4000-8000-000000000004",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "title": "Pay the design contractor after the client deposit",
      "trigger": "DEPOSIT_FINALIZED",
      "status": "RECONCILED",
      "amount": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "40000000"
      },
      "proofLevel": "LOCAL_FIXTURE",
      "startedAt": "2026-10-17T10:01:00.000Z",
      "updatedAt": "2026-10-17T10:04:00.000Z"
    }
  ],
  "capabilities": {
    "leads": {
      "status": "AVAILABLE",
      "reason": "Private Telegram sessions."
    },
    "agentLeases": {
      "status": "NOT_CONFIGURED",
      "reason": "No Amane lease is installed for this workspace."
    }
  },
  "freshness": {
    "observedAt": "2026-10-17T10:00:00.000Z",
    "source": "CHAIN",
    "stale": false
  }
}
```

## LeadStage

Enumeration: `LEAD_OPEN`, `DISCOVERY`, `QUALIFIED`, `OFFER_DRAFTED`, `OFFER_VALIDATED`, `OFFER_SENT`, `NEGOTIATING`, `AGREED_PENDING_SIGNATURES`, `SIGNED`, `FUNDING_PENDING`, `FUNDED`, `ACTIVE`, `DELIVERED`, `ACCEPTANCE_PENDING`, `RELEASED`, `REFUNDED`, `DISPUTED`, `CANCELLED`

## LeadHandling

Enumeration: `AGENT`, `HUMAN`, `FROZEN`

## LeadSource

Enumeration: `TELEGRAM`, `WEB`, `IMESSAGE`

## LeadSummary

| Field            | Type                                           | Required | Notes                                     |
| ---------------- | ---------------------------------------------- | -------- | ----------------------------------------- |
| `leadId`         | uuid                                           | yes      |                                           |
| `workspaceId`    | uuid                                           | yes      |                                           |
| `label`          | string (max 80)                                | yes      | Redacted display label, never a full name |
| `source`         | [LeadSource](/docs/api/schemas#leadsource)     | yes      |                                           |
| `stage`          | [LeadStage](/docs/api/schemas#leadstage)       | yes      |                                           |
| `handling`       | [LeadHandling](/docs/api/schemas#leadhandling) | yes      |                                           |
| `needsOwner`     | boolean                                        | yes      |                                           |
| `unread`         | integer (min 0)                                | yes      |                                           |
| `lastActivityAt` | ISO-8601 time                                  | yes      | UTC ISO-8601 timestamp                    |

## InboxPage

| Field        | Type                                           | Required | Notes |
| ------------ | ---------------------------------------------- | -------- | ----- |
| `items`      | [LeadSummary](/docs/api/schemas#leadsummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                | yes      |       |

Example (synthetic fixture):

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

## LeadMessage

| Field          | Type                               | Required | Notes                  |
| -------------- | ---------------------------------- | -------- | ---------------------- |
| `messageId`    | uuid                               | yes      |                        |
| `author`       | `LEAD`, `AGENT`, `STAFF`, `SYSTEM` | yes      |                        |
| `text`         | string (max 4000)                  | yes      |                        |
| `offerVersion` | integer or null                    | yes      |                        |
| `createdAt`    | ISO-8601 time                      | yes      | UTC ISO-8601 timestamp |

## OfferLine

| Field         | Type                               | Required | Notes                                        |
| ------------- | ---------------------------------- | -------- | -------------------------------------------- |
| `description` | string (max 200)                   | yes      |                                              |
| `quantity`    | integer                            | yes      |                                              |
| `unitUnits`   | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string |
| `totalUnits`  | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string |

## OfferMilestone

| Field   | Type                               | Required | Notes                                        |
| ------- | ---------------------------------- | -------- | -------------------------------------------- |
| `label` | string (max 120)                   | yes      |                                              |
| `units` | string (`^(0\|[1-9][0-9]{0,77})$`) | yes      | Integer token base units as a decimal string |
| `dueAt` | ISO-8601 time or null              | yes      |                                              |

## OfferVersion

| Field               | Type                                                                                        | Required | Notes                  |
| ------------------- | ------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| `offerId`           | uuid                                                                                        | yes      |                        |
| `version`           | integer                                                                                     | yes      |                        |
| `termsHash`         | string (`^0x[0-9a-fA-F]{64}$`)                                                              | yes      |                        |
| `previousTermsHash` | string (`^0x[0-9a-fA-F]{64}$`) or null                                                      | yes      |                        |
| `policyVersion`     | integer                                                                                     | yes      |                        |
| `status`            | `DRAFTED`, `VALIDATED`, `SENT`, `ACCEPTED`, `REJECTED`, `COUNTERED`, `EXPIRED`, `WITHDRAWN` | yes      |                        |
| `createdBy`         | `AGENT`, `STAFF`                                                                            | yes      |                        |
| `total`             | [Money](/docs/api/schemas#money)                                                            | yes      |                        |
| `lines`             | [OfferLine](/docs/api/schemas#offerline)[]                                                  | yes      |                        |
| `milestones`        | [OfferMilestone](/docs/api/schemas#offermilestone)[]                                        | yes      |                        |
| `expiresAt`         | ISO-8601 time                                                                               | yes      | UTC ISO-8601 timestamp |
| `createdAt`         | ISO-8601 time                                                                               | yes      | UTC ISO-8601 timestamp |

## LeadDetail

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

Example (synthetic fixture):

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

## ClientLeadSummary

| Field            | Type                                     | Required | Notes                  |
| ---------------- | ---------------------------------------- | -------- | ---------------------- |
| `leadId`         | uuid                                     | yes      |                        |
| `businessName`   | string (max 80)                          | yes      |                        |
| `stage`          | [LeadStage](/docs/api/schemas#leadstage) | yes      |                        |
| `lastActivityAt` | ISO-8601 time                            | yes      | UTC ISO-8601 timestamp |

## ClientLeadList

| Field   | Type                                                       | Required | Notes |
| ------- | ---------------------------------------------------------- | -------- | ----- |
| `leads` | [ClientLeadSummary](/docs/api/schemas#clientleadsummary)[] | yes      |       |

Example (synthetic fixture):

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

## ClientOfferVersion

| Field        | Type                                                                                        | Required | Notes                  |
| ------------ | ------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| `offerId`    | uuid                                                                                        | yes      |                        |
| `version`    | integer                                                                                     | yes      |                        |
| `termsHash`  | string (`^0x[0-9a-fA-F]{64}$`)                                                              | yes      |                        |
| `status`     | `DRAFTED`, `VALIDATED`, `SENT`, `ACCEPTED`, `REJECTED`, `COUNTERED`, `EXPIRED`, `WITHDRAWN` | yes      |                        |
| `total`      | [Money](/docs/api/schemas#money)                                                            | yes      |                        |
| `lines`      | [OfferLine](/docs/api/schemas#offerline)[]                                                  | yes      |                        |
| `milestones` | [OfferMilestone](/docs/api/schemas#offermilestone)[]                                        | yes      |                        |
| `expiresAt`  | ISO-8601 time                                                                               | yes      | UTC ISO-8601 timestamp |
| `createdAt`  | ISO-8601 time                                                                               | yes      | UTC ISO-8601 timestamp |

## ClientLeadDetail

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

Example (synthetic fixture):

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

## LeadMessageRequest

| Field  | Type                     | Required | Notes |
| ------ | ------------------------ | -------- | ----- |
| `text` | string (max 4000, min 1) | yes      |       |

## TakeoverRequest

| Field             | Type                                                                         | Required | Notes |
| ----------------- | ---------------------------------------------------------------------------- | -------- | ----- |
| `action`          | `HUMAN_TAKEOVER`, `HAND_BACK_TO_AGENT`, `FREEZE_OFFERS`, `ESCALATE_TO_OWNER` | yes      |       |
| `expectedVersion` | integer (min 0)                                                              | yes      |       |

## TakeoverResult

| Field             | Type                                           | Required | Notes |
| ----------------- | ---------------------------------------------- | -------- | ----- |
| `handling`        | [LeadHandling](/docs/api/schemas#leadhandling) | yes      |       |
| `handlingVersion` | integer (min 0)                                | yes      |       |

## LeadInviteRequest

| Field              | Type                          | Required | Notes |
| ------------------ | ----------------------------- | -------- | ----- |
| `source`           | `TELEGRAM`, `WEB`             | yes      |       |
| `expiresInSeconds` | integer (min 300, max 604800) | yes      |       |

## LeadInvite

| Field         | Type           | Required | Notes                  |
| ------------- | -------------- | -------- | ---------------------- |
| `inviteId`    | uuid           | yes      |                        |
| `telegramUrl` | string or null | yes      |                        |
| `webUrl`      | string         | yes      |                        |
| `expiresAt`   | ISO-8601 time  | yes      | UTC ISO-8601 timestamp |

## LeadInviteRedeem

| Field   | Type                              | Required | Notes |
| ------- | --------------------------------- | -------- | ----- |
| `token` | string (`^[A-Za-z0-9_-]{16,64}$`) | yes      |       |

## LeadInviteRedeemResult

| Field    | Type    | Required | Notes |
| -------- | ------- | -------- | ----- |
| `leadId` | uuid    | yes      |       |
| `bound`  | boolean | yes      |       |

## OfferValidation

| Field             | Type             | Required | Notes |
| ----------------- | ---------------- | -------- | ----- |
| `allowed`         | boolean          | yes      |       |
| `policyVersion`   | integer          | yes      |       |
| `checks`          | object[]         | yes      |       |
| `checks[].rule`   | string (max 60)  | yes      |       |
| `checks[].passed` | boolean          | yes      |       |
| `checks[].detail` | string (max 300) | yes      |       |

## CommercialPolicy

| Field                        | Type                                 | Required | Notes |
| ---------------------------- | ------------------------------------ | -------- | ----- |
| `catalog`                    | object[] (min 1) (max 50)            | yes      |       |
| `catalog[].sku`              | string (`^[a-z0-9][a-z0-9-]{0,39}$`) | yes      |       |
| `catalog[].description`      | string (max 200, min 1)              | yes      |       |
| `catalog[].unitUnits`        | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `catalog[].floorUnits`       | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `catalog[].maxQuantity`      | integer (min 1, max 1000)            | yes      |       |
| `catalog[].leadTimeDays`     | integer (min 0, max 365)             | yes      |       |
| `catalog[].rushSurchargeBps` | integer (min 0, max 10000)           | yes      |       |
| `catalog[].capacity`         | object or null                       | yes      |       |
| `maxDiscountBps`             | integer (min 0, max 5000)            | yes      |       |
| `minDepositBps`              | integer (min 0, max 10000)           | yes      |       |
| `maxMilestones`              | integer (min 1, max 6)               | yes      |       |
| `offerTtlSeconds`            | integer (min 3600, max 2592000)      | yes      |       |
| `ownerApprovalAboveUnits`    | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `capacityFreshSeconds`       | integer (min 3600, max 2592000)      | yes      |       |

## CommercialPolicyView

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `version`    | integer                                                | yes      |       |
| `state`      | `REVIEW`, `ACTIVE`, `SUPERSEDED`                       | yes      |       |
| `policyHash` | string (`^0x[0-9a-fA-F]{64}$`)                         | yes      |       |
| `policy`     | [CommercialPolicy](/docs/api/schemas#commercialpolicy) | yes      |       |
| `approvedBy` | string or null                                         | yes      |       |

## CommercialPolicyList

| Field      | Type                                                             | Required | Notes |
| ---------- | ---------------------------------------------------------------- | -------- | ----- |
| `policies` | [CommercialPolicyView](/docs/api/schemas#commercialpolicyview)[] | yes      |       |

## OfferTerms

| Field                    | Type                                 | Required | Notes |
| ------------------------ | ------------------------------------ | -------- | ----- |
| `lines`                  | object[] (min 1) (max 20)            | yes      |       |
| `lines[].sku`            | string (`^[a-z0-9][a-z0-9-]{0,39}$`) | yes      |       |
| `lines[].quantity`       | integer (min 1, max 1000)            | yes      |       |
| `lines[].unitUnits`      | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `rush`                   | boolean                              | yes      |       |
| `deliveryDays`           | integer (min 1, max 365)             | yes      |       |
| `milestones`             | object[] (min 1) (max 6)             | yes      |       |
| `milestones[].label`     | string (max 120, min 1)              | yes      |       |
| `milestones[].units`     | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `milestones[].dueInDays` | integer (min 0, max 365)             | yes      |       |
| `depositUnits`           | string (`^(0\|[1-9][0-9]{0,30})$`)   | yes      |       |
| `note`                   | string (max 400)                     | yes      |       |

## OfferCheck

| Field    | Type             | Required | Notes |
| -------- | ---------------- | -------- | ----- |
| `rule`   | string (max 60)  | yes      |       |
| `passed` | boolean          | yes      |       |
| `detail` | string (max 300) | yes      |       |

## OfferSendRequest

| Field     | Type                                       | Required | Notes |
| --------- | ------------------------------------------ | -------- | ----- |
| `terms`   | [OfferTerms](/docs/api/schemas#offerterms) | yes      |       |
| `offerId` | uuid                                       | no       |       |

## OfferSendResult

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `sent`       | boolean                                                | yes      |       |
| `checks`     | [OfferCheck](/docs/api/schemas#offercheck)[]           | yes      |       |
| `needsOwner` | boolean                                                | yes      |       |
| `offer`      | [OfferVersion](/docs/api/schemas#offerversion) or null | yes      |       |

## AgreementStatus

Enumeration: `PENDING_SIGNATURES`, `SIGNED`, `FUNDING_PENDING`, `FUNDED`, `VOID`, `EXPIRED`

## ClientWalletTypedData

| Field       | Type                                     | Required | Notes                  |
| ----------- | ---------------------------------------- | -------- | ---------------------- |
| `expiresAt` | ISO-8601 time                            | yes      | UTC ISO-8601 timestamp |
| `typedData` | [TypedData](/docs/api/schemas#typeddata) | yes      |                        |

## ClientWalletLink

| Field       | Type                            | Required | Notes                  |
| ----------- | ------------------------------- | -------- | ---------------------- |
| `wallet`    | string (`^0x[0-9a-fA-F]{40}$`)  | yes      | EVM address            |
| `expiresAt` | ISO-8601 time                   | yes      | UTC ISO-8601 timestamp |
| `signature` | string (`^0x[0-9a-fA-F]{130}$`) | yes      |                        |

## ClientWallet

| Field      | Type                           | Required | Notes                  |
| ---------- | ------------------------------ | -------- | ---------------------- |
| `wallet`   | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address            |
| `linkedAt` | ISO-8601 time                  | yes      | UTC ISO-8601 timestamp |

## AgreementMilestone

| Field       | Type                             | Required | Notes |
| ----------- | -------------------------------- | -------- | ----- |
| `label`     | string (max 120)                 | yes      |       |
| `amount`    | [Money](/docs/api/schemas#money) | yes      |       |
| `dueInDays` | integer (min 0)                  | yes      |       |

## AgreementSignature

| Field      | Type                           | Required | Notes                  |
| ---------- | ------------------------------ | -------- | ---------------------- |
| `wallet`   | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address            |
| `signedAt` | ISO-8601 time                  | yes      | UTC ISO-8601 timestamp |

## AgreementEscrow

| Field          | Type                                         | Required | Notes |
| -------------- | -------------------------------------------- | -------- | ----- |
| `state`        | `PREPARED`, `PENDING_CONFIRMATION`, `FUNDED` | yes      |       |
| `openTxHash`   | string (`^0x[0-9a-fA-F]{64}$`) or null       | yes      |       |
| `escrowDealId` | string or null                               | yes      |       |
| `proofLevel`   | [ProofLevel](/docs/api/schemas#prooflevel)   | yes      |       |

## Agreement

| Field               | Type                                                               | Required | Notes                  |
| ------------------- | ------------------------------------------------------------------ | -------- | ---------------------- |
| `agreementId`       | uuid                                                               | yes      |                        |
| `workspaceId`       | uuid                                                               | yes      |                        |
| `leadId`            | uuid                                                               | yes      |                        |
| `offerId`           | uuid                                                               | yes      |                        |
| `offerVersion`      | integer                                                            | yes      |                        |
| `termsHash`         | string (`^0x[0-9a-fA-F]{64}$`)                                     | yes      |                        |
| `agreementHash`     | string (`^0x[0-9a-fA-F]{64}$`)                                     | yes      |                        |
| `status`            | [AgreementStatus](/docs/api/schemas#agreementstatus)               | yes      |                        |
| `clientWallet`      | string (`^0x[0-9a-fA-F]{40}$`)                                     | yes      | EVM address            |
| `ownerWallet`       | string (`^0x[0-9a-fA-F]{40}$`)                                     | yes      | EVM address            |
| `payee`             | string (`^0x[0-9a-fA-F]{40}$`)                                     | yes      | EVM address            |
| `arbiter`           | string (`^0x[0-9a-fA-F]{40}$`) or null                             | yes      |                        |
| `total`             | [Money](/docs/api/schemas#money)                                   | yes      |                        |
| `milestones`        | [AgreementMilestone](/docs/api/schemas#agreementmilestone)[]       | yes      |                        |
| `expiresAt`         | ISO-8601 time                                                      | yes      | UTC ISO-8601 timestamp |
| `signatures`        | object                                                             | yes      |                        |
| `signatures.client` | [AgreementSignature](/docs/api/schemas#agreementsignature) or null | yes      |                        |
| `signatures.owner`  | [AgreementSignature](/docs/api/schemas#agreementsignature) or null | yes      |                        |
| `typedData`         | [TypedData](/docs/api/schemas#typeddata)                           | yes      |                        |
| `escrow`            | [AgreementEscrow](/docs/api/schemas#agreementescrow) or null       | yes      |                        |

## LeadAgreement

| Field          | Type                                             | Required | Notes                                       |
| -------------- | ------------------------------------------------ | -------- | ------------------------------------------- |
| `clientWallet` | string (`^0x[0-9a-fA-F]{40}$`) or null           | yes      |                                             |
| `agreement`    | [Agreement](/docs/api/schemas#agreement) or null | yes      |                                             |
| `blocked`      | string (max 200) or null                         | yes      | Why no agreement exists yet, when none does |

## AgreementSignatureSubmit

| Field          | Type                            | Required | Notes |
| -------------- | ------------------------------- | -------- | ----- |
| `agreementId`  | uuid                            | yes      |       |
| `offerVersion` | integer                         | yes      |       |
| `termsHash`    | string (`^0x[0-9a-fA-F]{64}$`)  | yes      |       |
| `signature`    | string (`^0x[0-9a-fA-F]{130}$`) | yes      |       |

## EscrowTransaction

| Field   | Type                             | Required | Notes       |
| ------- | -------------------------------- | -------- | ----------- |
| `step`  | `APPROVE`, `OPEN`                | yes      |             |
| `label` | string (max 120)                 | yes      |             |
| `to`    | string (`^0x[0-9a-fA-F]{40}$`)   | yes      | EVM address |
| `data`  | string (`^0x([0-9a-fA-F]{2})*$`) | yes      |             |
| `value` | `"0"`                            | yes      |             |

## EscrowCall

| Field          | Type                                                       | Required | Notes                  |
| -------------- | ---------------------------------------------------------- | -------- | ---------------------- |
| `agreementId`  | uuid                                                       | yes      |                        |
| `chainId`      | integer                                                    | yes      |                        |
| `from`         | string (`^0x[0-9a-fA-F]{40}$`)                             | yes      | EVM address            |
| `transactions` | [EscrowTransaction](/docs/api/schemas#escrowtransaction)[] | yes      |                        |
| `refundAfter`  | ISO-8601 time                                              | yes      | UTC ISO-8601 timestamp |

## EscrowFundingSubmit

| Field        | Type                           | Required | Notes |
| ------------ | ------------------------------ | -------- | ----- |
| `openTxHash` | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |

## AmaneAccountRegister

| Field      | Type                           | Required | Notes       |
| ---------- | ------------------------------ | -------- | ----------- |
| `account`  | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |
| `vendorId` | uuid or null                   | no       |             |

## AmaneAccount

| Field         | Type                           | Required | Notes       |
| ------------- | ------------------------------ | -------- | ----------- |
| `id`          | uuid                           | yes      |             |
| `workspaceId` | uuid                           | yes      |             |
| `chainId`     | integer                        | yes      |             |
| `account`     | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |
| `codeHash`    | string (`^0x[0-9a-fA-F]{64}$`) | yes      |             |
| `token`       | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |
| `recipient`   | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |
| `adapterId`   | string (`^0x[0-9a-fA-F]{64}$`) | yes      |             |
| `rootHash`    | string (`^0x[0-9a-fA-F]{64}$`) | yes      |             |
| `root`        | map of string                  | yes      |             |

## AmaneLeaseRegister

| Field       | Type                           | Required | Notes |
| ----------- | ------------------------------ | -------- | ----- |
| `accountId` | uuid                           | yes      |       |
| `leaseId`   | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |

## AmaneLeaseRegistered

| Field       | Type                           | Required | Notes |
| ----------- | ------------------------------ | -------- | ----- |
| `leaseId`   | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |
| `accountId` | uuid                           | yes      |       |

## AmaneJobCreate

| Field         | Type                            | Required | Notes |
| ------------- | ------------------------------- | -------- | ----- |
| `leaseId`     | string (`^0x[0-9a-fA-F]{64}$`)  | yes      |       |
| `triggerKind` | `INVOICE_PAID`, `OWNER_REQUEST` | yes      |       |
| `triggerRef`  | string (max 80, min 1)          | yes      |       |
| `amount`      | string (`^[1-9][0-9]{0,30}$`)   | yes      |       |
| `purpose`     | string (max 160, min 1)         | yes      |       |

## AmaneJob

| Field         | Type                                                          | Required | Notes |
| ------------- | ------------------------------------------------------------- | -------- | ----- |
| `id`          | uuid                                                          | yes      |       |
| `workspaceId` | uuid                                                          | yes      |       |
| `accountId`   | uuid                                                          | yes      |       |
| `leaseId`     | string (`^0x[0-9a-fA-F]{64}$`)                                | yes      |       |
| `triggerKind` | `INVOICE_PAID`, `OWNER_REQUEST`                               | yes      |       |
| `triggerRef`  | string                                                        | yes      |       |
| `amount`      | string                                                        | yes      |       |
| `purpose`     | string                                                        | yes      |       |
| `state`       | `WAITING`, `READY`, `SENT`, `PAID`, `REFUSED`, `NEEDS_REVIEW` | yes      |       |
| `nonce`       | string or null                                                | yes      |       |
| `txHash`      | string or null                                                | yes      |       |
| `reason`      | string or null                                                | yes      |       |

## AmaneJobList

| Field  | Type                                     | Required | Notes |
| ------ | ---------------------------------------- | -------- | ----- |
| `jobs` | [AmaneJob](/docs/api/schemas#amanejob)[] | yes      |       |

## ApprovalPurpose

Enumeration: `VAULT_SETUP`, `VAULT_ACTION`, `PAYOUT`, `FINANCE_CHANGE`, `REVENUE_POLICY`, `DEAL_TERMS`, `ESCROW`, `LEASE_ISSUE`, `LEASE_REVOKE`, `CIRCLE_REFUND`, `COMMERCIAL_POLICY`

## ApprovalItem

| Field           | Type                                                 | Required | Notes                                 |
| --------------- | ---------------------------------------------------- | -------- | ------------------------------------- |
| `requestId`     | uuid                                                 | yes      |                                       |
| `workspaceId`   | uuid                                                 | yes      |                                       |
| `workspaceName` | string (max 80)                                      | yes      |                                       |
| `purpose`       | [ApprovalPurpose](/docs/api/schemas#approvalpurpose) | yes      |                                       |
| `summary`       | string (max 300)                                     | yes      |                                       |
| `amount`        | [Money](/docs/api/schemas#money) or null             | yes      |                                       |
| `recipientHint` | string (max 16) or null                              | yes      |                                       |
| `approvals`     | integer (min 0)                                      | yes      |                                       |
| `threshold`     | integer                                              | yes      |                                       |
| `expiresAt`     | ISO-8601 time or null                                | yes      | Null when the request does not expire |

## ApprovalPage

| Field        | Type                                             | Required | Notes |
| ------------ | ------------------------------------------------ | -------- | ----- |
| `items`      | [ApprovalItem](/docs/api/schemas#approvalitem)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                  | yes      |       |

Example (synthetic fixture):

```json
{
  "items": [
    {
      "requestId": "00000000-0000-4000-8000-000000000006",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "workspaceName": "Example Studio",
      "purpose": "PAYOUT",
      "summary": "Pay 40 USDC to an allowlisted contractor",
      "amount": {
        "assetId": "arc-testnet:USDC",
        "symbol": "USDC",
        "chainId": 5042002,
        "decimals": 6,
        "units": "40000000"
      },
      "recipientHint": "0x3333…3333",
      "approvals": 1,
      "threshold": 2,
      "expiresAt": "2026-10-17T11:00:00.000Z"
    }
  ],
  "nextCursor": null
}
```

## TypedData

| Field         | Type            | Required | Notes |
| ------------- | --------------- | -------- | ----- |
| `domain`      | map of any      | yes      |       |
| `types`       | map of object[] | yes      |       |
| `primaryType` | string          | yes      |       |
| `message`     | map of any      | yes      |       |

## SigningStep

| Field       | Type                                     | Required | Notes |
| ----------- | ---------------------------------------- | -------- | ----- |
| `label`     | string (max 80)                          | yes      |       |
| `typedData` | [TypedData](/docs/api/schemas#typeddata) | yes      |       |

## SigningRequest

| Field           | Type                                                           | Required | Notes                                                                    |
| --------------- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `request`       | [ApprovalItem](/docs/api/schemas#approvalitem)                 | yes      |                                                                          |
| `signer`        | string (max 16)                                                | yes      | The wallet that must sign (display)                                      |
| `signerAddress` | string (`^0x[0-9a-fA-F]{40}$`)                                 | yes      | Full address of the wallet that must sign; refuse to sign from any other |
| `enforcedBy`    | string (max 120)                                               | yes      | Contract or service that enforces it                                     |
| `steps`         | [SigningStep](/docs/api/schemas#signingstep)[] (min 1) (max 3) | yes      |                                                                          |

Example (synthetic fixture):

```json
{
  "request": {
    "requestId": "00000000-0000-4000-8000-000000000006",
    "workspaceId": "00000000-0000-4000-8000-000000000001",
    "workspaceName": "Example Studio",
    "purpose": "PAYOUT",
    "summary": "Pay 40 USDC to an allowlisted contractor",
    "amount": {
      "assetId": "arc-testnet:USDC",
      "symbol": "USDC",
      "chainId": 5042002,
      "decimals": 6,
      "units": "40000000"
    },
    "recipientHint": "0x3333…3333",
    "approvals": 1,
    "threshold": 2,
    "expiresAt": "2026-10-17T11:00:00.000Z"
  },
  "signer": "0x1111…1111",
  "signerAddress": "0x1111111111111111111111111111111111111111",
  "enforcedBy": "Workspace Safe and its policy guard",
  "steps": [
    {
      "label": "Approve this payment",
      "typedData": {
        "domain": {
          "name": "Example",
          "version": "1",
          "chainId": 5042002
        },
        "types": {
          "Example": [
            {
              "name": "amount",
              "type": "uint256"
            }
          ]
        },
        "primaryType": "Example",
        "message": {
          "amount": "40000000"
        }
      }
    }
  ]
}
```

## SignatureSubmit

| Field        | Type                                              | Required | Notes |
| ------------ | ------------------------------------------------- | -------- | ----- |
| `signatures` | string (`^0x[0-9a-fA-F]{130}$`)[] (min 1) (max 3) | yes      |       |

## SignatureResult

| Field       | Type                                         | Required | Notes |
| ----------- | -------------------------------------------- | -------- | ----- |
| `status`    | `RECORDED`, `READY`, `SUBMITTED`, `REJECTED` | yes      |       |
| `approvals` | integer (min 0)                              | yes      |       |
| `threshold` | integer                                      | yes      |       |

## NotificationCategory

Enumeration: `NEW_LEAD`, `OFFER_ACCEPTED`, `CLIENT_DEPOSIT_FINALIZED`, `AGENT_PAYMENT_FINALIZED`, `PAYMENT_BLOCKED`, `RISK_REVIEW`, `ESCROW_DISPUTED`, `CIRCLE_CONTRIBUTION_RECEIVED`, `FUND_PROPOSAL`, `APPROVAL_REQUESTED`, `LEASE_EXPIRING`, `SECURITY_PAUSE`

## AppNotification

| Field            | Type                                                           | Required | Notes                                   |
| ---------------- | -------------------------------------------------------------- | -------- | --------------------------------------- |
| `notificationId` | uuid                                                           | yes      |                                         |
| `eventId`        | uuid                                                           | yes      |                                         |
| `category`       | [NotificationCategory](/docs/api/schemas#notificationcategory) | yes      |                                         |
| `workspaceId`    | uuid or null                                                   | yes      |                                         |
| `title`          | string (max 120)                                               | yes      | Generic; never a name, price or address |
| `deepLink`       | string (`^\/[A-Za-z0-9/_-]{1,200}$`)                           | yes      | Path on the web host                    |
| `createdAt`      | ISO-8601 time                                                  | yes      | UTC ISO-8601 timestamp                  |
| `readAt`         | ISO-8601 time or null                                          | yes      |                                         |

## NotificationPage

| Field         | Type                                                   | Required | Notes |
| ------------- | ------------------------------------------------------ | -------- | ----- |
| `items`       | [AppNotification](/docs/api/schemas#appnotification)[] | yes      |       |
| `nextCursor`  | string (max 200, min 1) or null                        | yes      |       |
| `unreadCount` | integer (min 0)                                        | yes      |       |

Example (synthetic fixture):

```json
{
  "items": [
    {
      "notificationId": "00000000-0000-4000-8000-000000000028",
      "eventId": "00000000-0000-4000-8000-000000000029",
      "category": "NEW_LEAD",
      "workspaceId": "00000000-0000-4000-8000-000000000001",
      "title": "New enquiry",
      "deepLink": "/w/00000000-0000-4000-8000-000000000001/inbox/00000000-0000-4000-8000-000000000003",
      "createdAt": "2026-10-17T10:03:00.000Z",
      "readAt": null
    }
  ],
  "nextCursor": null,
  "unreadCount": 1
}
```

## MarkRead

| Field             | Type                     | Required | Notes |
| ----------------- | ------------------------ | -------- | ----- |
| `notificationIds` | uuid[] (min 1) (max 200) | yes      |       |

## DeviceRegistration

| Field             | Type                                                             | Required | Notes |
| ----------------- | ---------------------------------------------------------------- | -------- | ----- |
| `deviceId`        | uuid                                                             | yes      |       |
| `apnsToken`       | string (`^[0-9a-f]{64,200}$`)                                    | yes      |       |
| `environment`     | `SANDBOX`, `PRODUCTION`                                          | yes      |       |
| `locale`          | string (max 20)                                                  | yes      |       |
| `mutedCategories` | [NotificationCategory](/docs/api/schemas#notificationcategory)[] | yes      |       |
| `quietHours`      | object or null                                                   | yes      |       |

## DeviceRegistered

| Field          | Type          | Required | Notes                  |
| -------------- | ------------- | -------- | ---------------------- |
| `deviceId`     | uuid          | yes      |                        |
| `registeredAt` | ISO-8601 time | yes      | UTC ISO-8601 timestamp |

## StreamEvent

| Field         | Type                                                                                                                                     | Required | Notes                  |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | -------- | ---------------------- |
| `cursor`      | string (max 200, min 1)                                                                                                                  | yes      |                        |
| `eventId`     | uuid                                                                                                                                     | yes      |                        |
| `type`        | `LEAD_UPDATED`, `LEAD_MESSAGE`, `OFFER_UPDATED`, `AGENT_EVENT`, `APPROVAL_CHANGED`, `BALANCE_CHANGED`, `NOTIFICATION`, `CONTEXT_REVOKED` | yes      |                        |
| `workspaceId` | uuid or null                                                                                                                             | yes      |                        |
| `entityId`    | string (max 80) or null                                                                                                                  | yes      |                        |
| `observedAt`  | ISO-8601 time                                                                                                                            | yes      | UTC ISO-8601 timestamp |

## StreamEventPage

| Field        | Type                                           | Required | Notes |
| ------------ | ---------------------------------------------- | -------- | ----- |
| `items`      | [StreamEvent](/docs/api/schemas#streamevent)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                | yes      |       |
