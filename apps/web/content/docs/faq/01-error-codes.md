---
title: Error codes
description: The error codes you may see from Synq, grouped by area, with what they mean and what to do.
---

Errors are stable upper-case codes, usually with an HTTP status. Where a status is not listed the code is raised as a conflict (409). Codes are read from the workspace services in the repository; the API reference section describes the response envelope.

## Sign-in and sessions

| Code                              | Meaning                                                                  | What to do                             |
| --------------------------------- | ------------------------------------------------------------------------ | -------------------------------------- |
| `UNAUTHENTICATED` (401)           | No valid session                                                         | Sign in                                |
| `INVALID_LOGIN` (401)             | Challenge, origin, wallet or signature did not match                     | Request a new challenge and sign again |
| `NATIVE_CHALLENGE_REQUIRED` (401) | A native sign-in needs a native-audience challenge                       | Use the app's flow                     |
| `INVALID_NATIVE_CODE` (401)       | The one-use code is wrong, used or older than 2 minutes                  | Generate a new code                    |
| `SESSION_REVOKED` (401)           | A used refresh token was presented again; the device session was revoked | Sign in again                          |
| `DEVICE_ID_TAKEN` (409)           | The device id belongs to another account                                 | Reinstall or sign out first            |
| `RATE_LIMITED` (429)              | Too many requests                                                        | Wait a minute                          |

## Workspaces and roles

| Code                                      | Meaning                                                  | What to do                 |
| ----------------------------------------- | -------------------------------------------------------- | -------------------------- |
| `WORKSPACE_NOT_FOUND` / `NOT_FOUND` (404) | It does not exist or your role may not see it            | Check the id and your role |
| `OWNER_REQUIRED` (403)                    | Only an owner can do this                                | Ask an owner               |
| `PROPOSER_REQUIRED` (403)                 | Viewers cannot propose                                   | Ask for a different role   |
| `INVALID_INVITE` / `INVITE_INVALID` (404) | Unknown, used or expired invitation                      | Ask for a new one          |
| `ALREADY_MEMBER`                          | You are already in this workspace                        | Nothing to do              |
| `OWNER_SETUP_REQUIRED`                    | Owner invitations need a forming, non-personal workspace | Invite before launching    |
| `OWNER_LIMIT`                             | A workspace has 20 owners already                        | Not possible               |
| `INVALID_OWNERS` (400)                    | Owner count outside 1 to 20                              | Fix the owner list         |
| `WORKSPACE_LIMIT` (429)                   | Too many workspaces created                              | Wait or reuse one          |
| `BUSINESS_WORKSPACE_REQUIRED` (422)       | Leads exist only in business workspaces                  | Use a business workspace   |

## Vault setup and governance

| Code                                                                                      | Meaning                                                                       |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `WORKSPACE_NOT_FORMING`                                                                   | Setup can be proposed only while forming                                      |
| `SETUP_EXPIRED`                                                                           | The setup is older than one hour; propose again                               |
| `SETUP_NOT_SIGNABLE` / `SETUP_NOT_READY`                                                  | The setup is not in a state that accepts or needs signatures                  |
| `INVALID_SETUP_SIGNATURE` (403)                                                           | Signer is not a proposed owner or the data differs                            |
| `SETUP_RECONCILIATION_MISMATCH`                                                           | On-chain result differs from the signed setup; nothing is retried             |
| `SPONSOR_BUDGET_EXHAUSTED` (429) / `VAULT_CREATION_RATE_LIMIT` (429)                      | Gas sponsorship is limited                                                    |
| `ONCHAIN_AUTHORITY_CHANGED` (409) / `VAULT_AUTHORITY_MISMATCH` (409) / `CUSTODY_MISMATCH` | The vault's owners, threshold or policy on chain differ from what Synq stored |
| `ACTION_NOT_FOUND`, `ACTION_NOT_REVIEWABLE`, `ACTION_STALE`, `ACTION_CONFLICT`            | A vault action is missing, closed, outdated or duplicated                     |
| `SAFE_NONCE_PENDING` (409)                                                                | Another Safe transaction is pending; wait                                     |
| `SAFE_QUORUM_SIGNATURES_REQUIRED`                                                         | This payout needs Safe-owner signatures, not a single approval                |
| `INVALID_OWNER_SIGNATURE` (403)                                                           | The signature is not from the signed-in owner's wallet or a current owner     |
| `CURRENT_OWNER_QUORUM_REQUIRED`                                                           | Not enough current owners have signed                                         |

## Finance, payouts and invoices

| Code                                                                        | Meaning                                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `VENDOR_NOT_VERIFIED` / `VERIFIED_VENDOR_REQUIRED`                          | The vendor is unknown or not verified                                                                    |
| `VENDOR_COOLING`                                                            | A new or changed vendor address has not waited 24 hours                                                  |
| `SIGNED_BUDGET_REQUIRED`                                                    | No signed budget exists                                                                                  |
| `SIGNED_MANDATE_REQUIRED`                                                   | The payout needs a signed payment mandate                                                                |
| `BUDGET_CHANGED`, `PAYOUT_ADDRESS_CHANGED`, `PAYOUT_VAULT_MISMATCH`         | Something changed since the payout was proposed; propose again                                           |
| `DAILY_BUDGET_EXHAUSTED`                                                    | Daily budget used up                                                                                     |
| `OBLIGATION_ALREADY_PROPOSED`                                               | A live payout already exists for that reference                                                          |
| `IDEMPOTENCY_CONFLICT`                                                      | Same key, different details                                                                              |
| `APPROVAL_EXPIRED`                                                          | The approval deadline passed                                                                             |
| `PAYOUT_NOT_REVIEWABLE`, `PAYOUT_NOT_CANCELLABLE`, `PAYOUT_NOT_FOUND` (404) | The payout is in another state or missing                                                                |
| `SIGNED_PAYOUT_REQUIRES_RECONCILIATION`                                     | A signed transaction exists; reconcile before cancelling                                                 |
| `PAYOUT_USES_VAULT_POLICY`                                                  | This payout follows the vault-policy route, not the Safe route                                           |
| `STALE_CHANGE`, `STALE_REVISION`, `CHANGE_NOT_FOUND` (404)                  | A finance change is outdated or unknown                                                                  |
| `PAYABLE_EXISTS`, `PAYABLE_NOT_OPEN`, `BILL_NOT_ACTIVE`                     | The record is a duplicate or closed                                                                      |
| `INVOICE_NOT_FOUND` (404)                                                   | Unknown invoice                                                                                          |
| `INVOICE_ISSUER_SIGNATURE_REQUIRED` (403)                                   | Only the issuer wallet can issue                                                                         |
| `INVOICE_ISSUER_AUTHORITY_CHANGED` (403)                                    | The issuer is no longer a current owner of the vault                                                     |
| `INVOICE_AMOUNT_OVERFLOW` (400)                                             | The total is too large                                                                                   |
| `REVENUE_*`                                                                 | Revenue policy is not found, expired, superseded, not active, or the quorum, vendor or authority changed |

## Leads, offers and agreements

| Code                                                                                               | Meaning                                                             |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `TELEGRAM_NOT_CONFIGURED` (503)                                                                    | No bot is connected for Telegram invitations                        |
| `MEMBERS_CANNOT_BE_LEADS` (422)                                                                    | A workspace member opened a lead invitation                         |
| `AGENT_NOT_HANDLING` (409)                                                                         | The lead is not in agent handling (a person took over)              |
| `TAKEOVER_REQUIRED` (409)                                                                          | Staff can only write or send offers while handling is HUMAN         |
| `VERSION_CONFLICT` (409)                                                                           | Handling changed since you loaded it                                |
| `COMMERCIAL_POLICY_REQUIRED` (422)                                                                 | No active commercial policy                                         |
| `POLICY_NOT_IN_REVIEW` (409), `INVALID_POLICY_SIGNATURE` (403)                                     | The policy version is not awaiting signature or the signer is wrong |
| `OFFER_STALE` (409), `OFFER_ALREADY_ACCEPTED` (409)                                                | Accept the newest open version only                                 |
| `CLIENT_WALLET_IS_MEMBER` (422), `CLIENT_WALLET_LOCKED` (409)                                      | The wallet is a member or already linked to this lead               |
| `WALLET_LINK_EXPIRED` (409), `WALLET_LINK_WINDOW_TOO_LONG` (400), `INVALID_WALLET_SIGNATURE` (403) | The wallet-link signature is old, too long-dated or wrong           |
| `AGREEMENT_NOT_SIGNED`, `AGREEMENT_EXPIRED`, `AGREEMENT_ALREADY_FUNDED` (409)                      | Funding cannot proceed in this state                                |
| `AGREEMENT_STALE`, `AGREEMENT_TERMS_TAMPERED`                                                      | The agreement no longer matches the accepted offer                  |

## Agent payments (Amane)

| Code                                                                               | Meaning                                                                 |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `AMANE_NOT_CONFIGURED` (503)                                                       | Not enabled on this server                                              |
| `AMANE_NOT_CONTROLLER` (403)                                                       | You do not control that account on chain                                |
| `AMANE_ACCOUNT_REGISTERED` (409)                                                   | Already attached to a workspace                                         |
| `AMANE_CODE_MISMATCH` (422)                                                        | Not the expected Amane contract                                         |
| `LEASE_AGENT_MISMATCH`, `LEASE_NOT_LIVE` (422), `LEASE_REGISTERED_ELSEWHERE` (409) | The lease does not name Synq's agent, is not live, or is used elsewhere |
| `ABOVE_LEASE_PER_ACTION` (422)                                                     | The job amount exceeds the lease's per-action limit                     |
| `JOB_EXISTS` (409)                                                                 | One job per trigger and lease                                           |

## Chat and channels

| Code                                   | Meaning                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------ |
| `VERIFIED_CHANNEL_LINK_REQUIRED` (403) | Link your Telegram identity first                                        |
| `CHANNEL_ADMIN_REQUIRED` (403)         | Group binding needs an owner who is a Telegram group admin               |
| `CHANNEL_ALREADY_BOUND`                | That chat belongs to another workspace                                   |
| `CHANNEL_LINK_MISMATCH` (403)          | The link challenge belongs to a different wallet or workspace            |
| `PRIVATE_DATA_REFUSED` (400)           | The message looked like private data (for example a key) and was refused |

## General

| Code                                                                                                                  | Meaning                  |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `INVALID_ADDRESS`, `INVALID_CURSOR`, `INVALID_DEEP_LINK` (400)                                                        | Malformed input          |
| `NOTHING_DELIVERED`, `NOTHING_TO_REFUND`, `REFUND_NOT_FOUND`, `REFUND_NOT_PENDING`, `REFUNDS_IN_PROGRESS`             | Group-fund refund states |
| `CONTRIBUTOR_ROLE_REQUIRED`, `CONTRACTING_PARTY_REQUIRED`, `DEAL_PARTY_ROLE_REQUIRED`, `INDEPENDENT_ARBITER_REQUIRED` | Deal role rules          |
