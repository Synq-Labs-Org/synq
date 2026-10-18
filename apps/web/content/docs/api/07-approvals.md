---
title: Approvals
description: The signing inbox: exact typed data a wallet signs.
---

Approvals are requests waiting for a wallet signature. The server returns the exact typed data (EIP-712) to sign, the signer address and which contract enforces the result. The signature is verified against the required signer; the app never approves on a login alone. The list is paged with an opaque cursor.

## Routes

### GET /v3/approvals

Requests waiting for this wallet's signature, across workspaces.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `approvals.list`           |
| Auth         | Session (bearer or cookie) |
| Who may call | principal                  |
| Status       | IMPLEMENTED                |

**Query parameters**

| Field    | Type                     | Required | Notes |
| -------- | ------------------------ | -------- | ----- |
| `cursor` | string (max 200, min 1)  | no       |       |
| `limit`  | integer (min 1, max 100) | no       |       |

**Response** ([ApprovalPage](/docs/api/schemas#approvalpage))

| Field        | Type                                             | Required | Notes |
| ------------ | ------------------------------------------------ | -------- | ----- |
| `items`      | [ApprovalItem](/docs/api/schemas#approvalitem)[] | yes      |       |
| `nextCursor` | string (max 200, min 1) or null                  | yes      |       |

Example response (synthetic fixture):

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

### GET /v3/approvals/{requestId}

Exact typed data to sign.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `approvals.get`            |
| Auth         | Session (bearer or cookie) |
| Who may call | a required signer          |
| Status       | IMPLEMENTED                |

Path parameters: `requestId` (UUIDs unless stated).

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

### POST /v3/approvals/{requestId}/signature

Submit a wallet signature; the server verifies the signer.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `approvals.sign`                                        |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | a required signer                                       |
| Status       | IMPLEMENTED                                             |

Path parameters: `requestId` (UUIDs unless stated).

**Request body** ([SignatureSubmit](/docs/api/schemas#signaturesubmit))

| Field        | Type                                              | Required | Notes |
| ------------ | ------------------------------------------------- | -------- | ----- |
| `signatures` | string (`^0x[0-9a-fA-F]{130}$`)[] (min 1) (max 3) | yes      |       |

**Response** ([SignatureResult](/docs/api/schemas#signatureresult))

| Field       | Type                                         | Required | Notes |
| ----------- | -------------------------------------------- | -------- | ----- |
| `status`    | `RECORDED`, `READY`, `SUBMITTED`, `REJECTED` | yes      |       |
| `approvals` | integer (min 0)                              | yes      |       |
| `threshold` | integer                                      | yes      |       |
