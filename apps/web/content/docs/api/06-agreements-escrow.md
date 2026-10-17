---
title: Client agreements and escrow
description: Wallet linking, agreement signing and funding the milestone escrow.
---

After a client accepts an offer, both parties sign the exact agreement with their wallets (typed data), then the client funds the escrow by sending the approve and open transactions from their own wallet. The server never holds the client's key. A deal counts as funded only when the open transaction is proven on chain. See [SynqMilestoneEscrow](/docs/contracts) for the contract.

The client wallet is linked by a signature over a statement the server provides. A wallet that already belongs to a workspace member is refused (`CLIENT_WALLET_IS_MEMBER`). The two escrow routes are registered only when the escrow is connected and answer `AGREEMENT_ESCROW_UNAVAILABLE` (503) otherwise; they are throttled to 30 a minute per principal.

## Routes

### GET /v3/client/leads/{leadId}/wallet-link

The statement the client wallet signs to link itself to a lead.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadWalletTypedData`                             |
| Auth         | Session (bearer or cookie)                               |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Query parameters**

| Field    | Type                           | Required | Notes       |
| -------- | ------------------------------ | -------- | ----------- |
| `wallet` | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address |

**Response** ([ClientWalletTypedData](/docs/api/schemas#clientwallettypeddata))

| Field       | Type                                     | Required | Notes                  |
| ----------- | ---------------------------------------- | -------- | ---------------------- |
| `expiresAt` | ISO-8601 time                            | yes      | UTC ISO-8601 timestamp |
| `typedData` | [TypedData](/docs/api/schemas#typeddata) | yes      |                        |

### POST /v3/client/leads/{leadId}/wallet

Link the wallet that signs and pays, proven by its own signature.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadWalletLink`                                  |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies)  |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Request body** ([ClientWalletLink](/docs/api/schemas#clientwalletlink))

| Field       | Type                            | Required | Notes                  |
| ----------- | ------------------------------- | -------- | ---------------------- |
| `wallet`    | string (`^0x[0-9a-fA-F]{40}$`)  | yes      | EVM address            |
| `expiresAt` | ISO-8601 time                   | yes      | UTC ISO-8601 timestamp |
| `signature` | string (`^0x[0-9a-fA-F]{130}$`) | yes      |                        |

**Response** ([ClientWallet](/docs/api/schemas#clientwallet))

| Field      | Type                           | Required | Notes                  |
| ---------- | ------------------------------ | -------- | ---------------------- |
| `wallet`   | string (`^0x[0-9a-fA-F]{40}$`) | yes      | EVM address            |
| `linkedAt` | ISO-8601 time                  | yes      | UTC ISO-8601 timestamp |

### GET /v3/client/leads/{leadId}/agreement

The agreement for the accepted offer, with the typed data to sign.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadAgreement`                                   |
| Auth         | Session (bearer or cookie)                               |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Response** ([LeadAgreement](/docs/api/schemas#leadagreement))

| Field          | Type                                             | Required | Notes                                       |
| -------------- | ------------------------------------------------ | -------- | ------------------------------------------- |
| `clientWallet` | string (`^0x[0-9a-fA-F]{40}$`) or null           | yes      |                                             |
| `agreement`    | [Agreement](/docs/api/schemas#agreement) or null | yes      |                                             |
| `blocked`      | string (max 200) or null                         | yes      | Why no agreement exists yet, when none does |

### POST /v3/client/leads/{leadId}/agreement/signature

Submit the client wallet's signature over the exact agreement.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadAgreementSign`                               |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies)  |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Request body** ([AgreementSignatureSubmit](/docs/api/schemas#agreementsignaturesubmit))

| Field          | Type                            | Required | Notes |
| -------------- | ------------------------------- | -------- | ----- |
| `agreementId`  | uuid                            | yes      |       |
| `offerVersion` | integer                         | yes      |       |
| `termsHash`    | string (`^0x[0-9a-fA-F]{64}$`)  | yes      |       |
| `signature`    | string (`^0x[0-9a-fA-F]{130}$`) | yes      |       |

**Response** ([Agreement](/docs/api/schemas#agreement))

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

### POST /v3/client/leads/{leadId}/agreement/escrow

The exact escrow approve and open calls the client wallet sends.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadEscrowCall`                                  |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies)  |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Response** ([EscrowCall](/docs/api/schemas#escrowcall))

| Field          | Type                                                       | Required | Notes                  |
| -------------- | ---------------------------------------------------------- | -------- | ---------------------- |
| `agreementId`  | uuid                                                       | yes      |                        |
| `chainId`      | integer                                                    | yes      |                        |
| `from`         | string (`^0x[0-9a-fA-F]{40}$`)                             | yes      | EVM address            |
| `transactions` | [EscrowTransaction](/docs/api/schemas#escrowtransaction)[] | yes      |                        |
| `refundAfter`  | ISO-8601 time                                              | yes      | UTC ISO-8601 timestamp |

### POST /v3/client/leads/{leadId}/agreement/escrow/submit

Submit the open transaction hash; funded only once proven on chain.

|              |                                                          |
| ------------ | -------------------------------------------------------- |
| Route id     | `client.leadEscrowSubmit`                                |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies)  |
| Who may call | the lead's bound web identity (never a workspace member) |
| Status       | IMPLEMENTED                                              |

Path parameters: `leadId` (UUIDs unless stated).

**Request body** ([EscrowFundingSubmit](/docs/api/schemas#escrowfundingsubmit))

| Field        | Type                           | Required | Notes |
| ------------ | ------------------------------ | -------- | ----- |
| `openTxHash` | string (`^0x[0-9a-fA-F]{64}$`) | yes      |       |

**Response** ([Agreement](/docs/api/schemas#agreement))

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

### GET /v3/workspaces/{workspaceId}/leads/{leadId}/agreement

Agreement, signature and escrow status for a lead.

|              |                            |
| ------------ | -------------------------- |
| Route id     | `workspace.leadAgreement`  |
| Auth         | Session (bearer or cookie) |
| Who may call | OWNER, ADMIN               |
| Status       | IMPLEMENTED                |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

**Response** ([LeadAgreement](/docs/api/schemas#leadagreement))

| Field          | Type                                             | Required | Notes                                       |
| -------------- | ------------------------------------------------ | -------- | ------------------------------------------- |
| `clientWallet` | string (`^0x[0-9a-fA-F]{40}$`) or null           | yes      |                                             |
| `agreement`    | [Agreement](/docs/api/schemas#agreement) or null | yes      |                                             |
| `blocked`      | string (max 200) or null                         | yes      | Why no agreement exists yet, when none does |

### POST /v3/workspaces/{workspaceId}/leads/{leadId}/agreement/owner-signature

Submit the owner wallet's signature over the exact agreement.

|              |                                                         |
| ------------ | ------------------------------------------------------- |
| Route id     | `workspace.leadAgreementSign`                           |
| Auth         | Session + `Idempotency-Key` (+ same origin for cookies) |
| Who may call | OWNER                                                   |
| Status       | IMPLEMENTED                                             |

Path parameters: `workspaceId`, `leadId` (UUIDs unless stated).

**Request body** ([AgreementSignatureSubmit](/docs/api/schemas#agreementsignaturesubmit))

| Field          | Type                            | Required | Notes |
| -------------- | ------------------------------- | -------- | ----- |
| `agreementId`  | uuid                            | yes      |       |
| `offerVersion` | integer                         | yes      |       |
| `termsHash`    | string (`^0x[0-9a-fA-F]{64}$`)  | yes      |       |
| `signature`    | string (`^0x[0-9a-fA-F]{130}$`) | yes      |       |

**Response** ([Agreement](/docs/api/schemas#agreement))

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
