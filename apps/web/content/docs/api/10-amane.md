---
title: Amane routes
description: Registering Amane accounts and leases, and paying jobs.
---

These routes connect a workspace to an Amane account so that Synq's agent can pay contractors inside an on-chain lease. The server checks the account code and controller on chain before it accepts a registration, and reads each lease back from chain. The routes exist only when the server has an agent key and a pinned account release; otherwise `GET /v3/workspaces/{workspaceId}/mandates` reports `NOT_CONFIGURED` and the write routes are absent. See [Amane](/docs/amane).

## Routes

### POST /v3/workspaces/{workspaceId}/amane/accounts

Attach an Amane account after checking its code and controller on chain.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.amaneAccountRegister`                        |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER who controls the Amane account on chain           |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId` (UUIDs unless stated).

**Request body** ([AmaneAccountRegister](/docs/api/schemas#amaneaccountregister))

| Field      | Type                           | Required | Notes       |
| ---------- | ------------------------------ | -------- | ----------- |
| `account`  | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |
| `vendorId` | uuid or null                   | no       |             |

**Response** ([AmaneAccount](/docs/api/schemas#amaneaccount))

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

### POST /v3/workspaces/{workspaceId}/amane/leases

Record a live lease to Synq’s agent, read back from chain.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.amaneLeaseRegister`                          |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER                                                   |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId` (UUIDs unless stated).

**Request body** ([AmaneLeaseRegister](/docs/api/schemas#amaneleaseregister))

| Field       | Type                           | Required | Notes |
| ----------- | ------------------------------ | -------- | ----- |
| `accountId` | uuid                           | yes      |       |
| `leaseId`   | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |

**Response** ([AmaneLeaseRegistered](/docs/api/schemas#amaneleaseregistered))

| Field       | Type                           | Required | Notes |
| ----------- | ------------------------------ | -------- | ----- |
| `leaseId`   | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |
| `accountId` | uuid                           | yes      |       |

### GET /v3/workspaces/{workspaceId}/amane/jobs

Contractor jobs the agent pays inside a lease.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.amaneJobs`      |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN               |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId` (UUIDs unless stated).

**Response** ([AmaneJobList](/docs/api/schemas#amanejoblist))

| Field  | Type                                     | Required | Notes |
| ------ | ---------------------------------------- | -------- | ----- |
| `jobs` | [AmaneJob](/docs/api/schemas#amanejob)[] | yes      |       |

### POST /v3/workspaces/{workspaceId}/amane/jobs

Pay a contractor inside a lease once an invoice settles (or on request).

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.amaneJobCreate`                              |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER                                                   |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId` (UUIDs unless stated).

**Request body** ([AmaneJobCreate](/docs/api/schemas#amanejobcreate))

| Field         | Type                            | Required | Notes |
| ------------- | ------------------------------- | -------- | ----- |
| `leaseId`     | string (`^0x[0-9a-fA-F]{64}$`)  | yes      |       |
| `triggerKind` | `INVOICE_PAID`, `OWNER_REQUEST` | yes      |       |
| `triggerRef`  | string (max 80, min 1)          | yes      |       |
| `amount`      | string (`^[1-9][0-9]{0,30}$`)   | yes      |       |
| `purpose`     | string (max 160, min 1)         | yes      |       |

**Response** ([AmaneJob](/docs/api/schemas#amanejob))

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
