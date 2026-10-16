import type { Address, Hex } from 'viem';
import { walletTag, type JournalEntry } from '@synq/ledger';

/**
 * Deal Room books (one workspace view spanning the deal's wallets, so they
 * reconcile wallet by wallet against chain balances):
 *
 * - funding: cash moves client -> escrow wallet; the client gains a claim on
 *   the escrow (ACCOUNTS_RECEIVABLE, counterparty `escrow-claim:<deal>`) and
 *   the escrow owes it out (ESCROW_LIABILITY, counterparty `deal:<deal>`).
 *   Restricted escrow = -ESCROW_LIABILITY, so `availableToSpend` excludes it;
 * - release (withdraw to payee): cash moves escrow -> freelancer, the
 *   liability and the client's claim close, the client books contractor
 *   expense and the freelancer revenue;
 * - refund: cash moves escrow -> original funder, liability and claim close.
 *
 * Each entry is keyed by the chain log that proves it, so replaying the same
 * receipt never posts twice. Gas is booked separately (`arcGasEntry`).
 */

export type DealBooks = Readonly<{
  workspaceId: string;
  dealId: string;
  chainId: number;
  assetId: string;
  escrow: Address;
  client: Address;
  freelancer: Address;
}>;

type Effect = Readonly<{
  txHash: Hex;
  logIndex: number;
  amount: bigint;
  at: number;
}>;

const key = (b: DealBooks, e: Effect) =>
  `chain:${b.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;

export function escrowFundingEntry(b: DealBooks, e: Effect): JournalEntry {
  const deal = `deal:${b.dealId}`;
  return {
    entryId: `je_dealfund_${e.txHash.slice(2, 18)}`,
    workspaceId: b.workspaceId,
    occurredAt: e.at,
    memo: `Deal ${b.dealId}: client funds milestone escrow`,
    source: { kind: 'CHAIN_TX', ref: e.txHash },
    evidence: {
      chainId: b.chainId,
      txHash: e.txHash,
      logIndex: e.logIndex,
      recipient: b.escrow,
    },
    idempotencyKey: key(b, e),
    postings: [
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: walletTag(b.client),
        documentRef: deal,
      },
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: walletTag(b.escrow),
        documentRef: deal,
      },
      {
        account: 'ACCOUNTS_RECEIVABLE',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: `escrow-claim:${b.dealId}`,
        documentRef: deal,
      },
      {
        account: 'ESCROW_LIABILITY',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: deal,
        documentRef: deal,
      },
    ],
    reversalOf: null,
  };
}

export function escrowReleaseEntry(
  b: DealBooks,
  e: Effect & { milestone: number },
): JournalEntry {
  const ref = `deal:${b.dealId}:m${e.milestone}`;
  return {
    entryId: `je_dealrel_${e.txHash.slice(2, 18)}`,
    workspaceId: b.workspaceId,
    occurredAt: e.at,
    memo: `Deal ${b.dealId}: milestone ${e.milestone} released to the freelancer`,
    source: { kind: 'CHAIN_TX', ref: e.txHash },
    evidence: {
      chainId: b.chainId,
      txHash: e.txHash,
      logIndex: e.logIndex,
      recipient: b.freelancer,
    },
    idempotencyKey: key(b, e),
    postings: [
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: walletTag(b.escrow),
        documentRef: ref,
      },
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: walletTag(b.freelancer),
        documentRef: ref,
      },
      {
        account: 'ESCROW_LIABILITY',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: `deal:${b.dealId}`,
        documentRef: ref,
      },
      {
        account: 'ACCOUNTS_RECEIVABLE',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: `escrow-claim:${b.dealId}`,
        documentRef: ref,
      },
      {
        account: 'CONTRACTOR_EXPENSE',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: walletTag(b.freelancer),
        documentRef: ref,
      },
      {
        account: 'REVENUE',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: walletTag(b.client),
        documentRef: ref,
      },
    ],
    reversalOf: null,
  };
}

export function escrowRefundEntry(
  b: DealBooks,
  e: Effect & { milestone: number },
): JournalEntry {
  const ref = `deal:${b.dealId}:m${e.milestone}`;
  return {
    entryId: `je_dealref_${e.txHash.slice(2, 18)}`,
    workspaceId: b.workspaceId,
    occurredAt: e.at,
    memo: `Deal ${b.dealId}: milestone ${e.milestone} refunded to the funder`,
    source: { kind: 'CHAIN_TX', ref: e.txHash },
    evidence: {
      chainId: b.chainId,
      txHash: e.txHash,
      logIndex: e.logIndex,
      recipient: b.client,
    },
    idempotencyKey: key(b, e),
    postings: [
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: walletTag(b.escrow),
        documentRef: ref,
      },
      {
        account: 'CASH_ARC_USDC',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: walletTag(b.client),
        documentRef: ref,
      },
      {
        account: 'ESCROW_LIABILITY',
        assetId: b.assetId,
        amount: e.amount,
        counterpartyId: `deal:${b.dealId}`,
        documentRef: ref,
      },
      {
        account: 'ACCOUNTS_RECEIVABLE',
        assetId: b.assetId,
        amount: -e.amount,
        counterpartyId: `escrow-claim:${b.dealId}`,
        documentRef: ref,
      },
    ],
    reversalOf: null,
  };
}
