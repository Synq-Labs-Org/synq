---
title: Workspace routes
description: Business overview, agent runs, mandates and commercial policies.
---

Routes under `/v3/workspaces/{workspaceId}` require workspace membership. Someone who is not a member, or who asks for another tenant's id, receives `404 NOT_FOUND` rather than `403`, so ids do not leak. Workspace routes are throttled to 240 requests a minute per workspace in addition to the per-principal limit.

## Routes

### GET /v3/workspaces/{workspaceId}/overview

Balances, receivables, payables, leads, approvals, agent highlights.

|              |                              |
| ------------ | ---------------------------- |
| Route id     | `workspace.overview`         |
| Auth         | Session (bearer or cookie)   |
| Who may call | OWNER, ADMIN, MEMBER, VIEWER |
| Status       | IMPLEMENTED                  |

Path parameters: `workspaceId` (UUIDs unless stated).

**Response** ([WorkspaceOverview](/docs/api/schemas#workspaceoverview))

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

Example response (synthetic fixture):

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

### GET /v3/workspaces/{workspaceId}/commercial-policies

Commercial policy versions, newest first.

|              |                                |
| ------------ | ------------------------------ |
| Route id     | `workspace.commercialPolicies` |
| Auth         | Session (bearer or cookie)     |
| Who may call | OWNER, ADMIN                   |
| Status       | IMPLEMENTED                    |

Path parameters: `workspaceId` (UUIDs unless stated).

**Response** ([CommercialPolicyList](/docs/api/schemas#commercialpolicylist))

| Field      | Type                                                             | Required | Notes |
| ---------- | ---------------------------------------------------------------- | -------- | ----- |
| `policies` | [CommercialPolicyView](/docs/api/schemas#commercialpolicyview)[] | yes      |       |

### POST /v3/workspaces/{workspaceId}/commercial-policies

Propose the next policy version; an owner signs it from the approvals inbox.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.commercialPolicyPropose`                     |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER, ADMIN                                            |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId` (UUIDs unless stated).

**Request body** ([CommercialPolicy](/docs/api/schemas#commercialpolicy))

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

**Response** ([CommercialPolicyView](/docs/api/schemas#commercialpolicyview))

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `version`    | integer                                                | yes      |       |
| `state`      | `REVIEW`, `ACTIVE`, `SUPERSEDED`                       | yes      |       |
| `policyHash` | string (`^0x[0-9a-fA-F]{64}$`)                         | yes      |       |
| `policy`     | [CommercialPolicy](/docs/api/schemas#commercialpolicy) | yes      |       |
| `approvedBy` | string or null                                         | yes      |       |

### GET /v3/workspaces/{workspaceId}/agent-runs

Agent runs, newest first.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.agentRuns`      |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN, MEMBER       |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId` (UUIDs unless stated).

**Query parameters**

| Field    | Type                     | Required | Notes |
| -------- | ------------------------ | -------- | ----- |
| `cursor` | string (max 200, min 1)  | no       |       |
| `limit`  | integer (min 1, max 100) | no       |       |

**Response** ([AgentRunPage](/docs/api/schemas#agentrunpage))

| Field        | Type                                                   | Required | Notes |
| ------------ | ------------------------------------------------------ | -------- | ----- |
| `items`      | [AgentRunSummary](/docs/api/schemas#agentrunsummary)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                        | yes      |       |

### GET /v3/workspaces/{workspaceId}/agent-runs/{runId}

Typed events and chain receipts of one run.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.agentRun`       |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN, MEMBER       |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId`, `runId` (UUIDs unless stated).

**Response** ([AgentRunDetail](/docs/api/schemas#agentrundetail))

| Field      | Type                                                         | Required | Notes |
| ---------- | ------------------------------------------------------------ | -------- | ----- |
| `run`      | [AgentRunSummary](/docs/api/schemas#agentrunsummary)         | yes      |       |
| `events`   | [AgentEconomicEvent](/docs/api/schemas#agenteconomicevent)[] | yes      |       |
| `receipts` | [Receipt](/docs/api/schemas#receipt)[]                       | yes      |       |

Example response (synthetic fixture):

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

### GET /v3/workspaces/{workspaceId}/mandates

Agent leases with on-chain remaining limits.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.mandates`       |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN               |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId` (UUIDs unless stated).

**Response** ([Mandates](/docs/api/schemas#mandates))

| Field        | Type                                         | Required | Notes |
| ------------ | -------------------------------------------- | -------- | ----- |
| `capability` | [Capability](/docs/api/schemas#capability)   | yes      |       |
| `leases`     | [AgentLease](/docs/api/schemas#agentlease)[] | yes      |       |

Example response (synthetic fixture):

```json
{
  "capability": {
    "status": "NOT_CONFIGURED",
    "reason": "No Amane lease is installed for this workspace."
  },
  "leases": []
}
```

### POST /v3/workspaces/{workspaceId}/mandates/{leaseId}/revoke-intent

Prepare a revoke for the issuer to sign; not revoked until on chain.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.mandateRevoke`                               |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER with lease-issuer authority                       |
| Status       | PLANNED                                                 |

Path parameters: `workspaceId`, `leaseId` (UUIDs unless stated).

**Response** ([SigningRequest](/docs/api/schemas#signingrequest))

| Field           | Type                                                           | Required | Notes                                                                    |
| --------------- | -------------------------------------------------------------- | -------- | ------------------------------------------------------------------------ |
| `request`       | [ApprovalItem](/docs/api/schemas#approvalitem)                 | yes      |                                                                          |
| `signer`        | string (max 16)                                                | yes      | The wallet that must sign (display)                                      |
| `signerAddress` | string (`^0x[0-9a-fA-F]{40}$`)                                 | yes      | Full address of the wallet that must sign; refuse to sign from any other |
| `enforcedBy`    | string (max 120)                                               | yes      | Contract or service that enforces it                                     |
| `steps`         | [SigningStep](/docs/api/schemas#signingstep)[] (min 1) (max 3) | yes      |                                                                          |

Example response (synthetic fixture):

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
