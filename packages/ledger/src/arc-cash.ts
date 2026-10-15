import { arcNativeToUsdc, token } from '@synq/chain-registry/arc';
import type { JournalEntry, Posting } from './index.js';

/**
 * Arc cash per wallet, exact to the wei.
 *
 * Every CASH_ARC_USDC line names the wallet it moved (`wallet:<address>`), so
 * the books can be reconciled wallet by wallet against chain balances. Arc
 * gas is paid in native USDC with 18 decimals while the ledger counts 6-decimal
 * base units: a fee is booked as whole base units on the USDC asset plus the
 * sub-unit remainder on a separate dust asset (wei), each line balanced, so
 * nothing is truncated away.
 */

export const NATIVE_WEI_PER_UNIT = 1_000_000_000_000n;
export const walletTag = (address: string) => `wallet:${address.toLowerCase()}`;
/** Asset id for sub-unit native dust (wei) of an Arc USDC asset. */
export const dustAssetId = (assetId: string) => `${assetId}#wei`;

/** NETWORK_FEES / CASH lines for `feeWei` paid by `payer`, split units + dust. */
export function arcGasPostings(input: {
  chain: 'arc-testnet' | 'arc-mainnet';
  payer: string;
  feeWei: bigint;
}): Posting[] {
  const { usdc, dustWei } = arcNativeToUsdc(input.chain, input.feeWei);
  const asset = token(input.chain, 'USDC').assetId;
  const cp = walletTag(input.payer);
  const out: Posting[] = [];
  if (usdc.baseUnits > 0n)
    out.push(
      { account: 'NETWORK_FEES', assetId: asset, amount: usdc.baseUnits },
      {
        account: 'CASH_ARC_USDC',
        assetId: asset,
        amount: -usdc.baseUnits,
        counterpartyId: cp,
      },
    );
  if (dustWei > 0n)
    out.push(
      { account: 'NETWORK_FEES', assetId: dustAssetId(asset), amount: dustWei },
      {
        account: 'CASH_ARC_USDC',
        assetId: dustAssetId(asset),
        amount: -dustWei,
        counterpartyId: cp,
      },
    );
  return out;
}

/** One journal entry for the gas of one Arc transaction (idempotent per tx). */
export function arcGasEntry(input: {
  workspaceId: string;
  chain: 'arc-testnet' | 'arc-mainnet';
  txHash: `0x${string}`;
  payer: string;
  feeWei: bigint;
  at: number;
  memo: string;
}): JournalEntry | null {
  const postings = arcGasPostings(input);
  if (!postings.length) return null;
  const chainId = token(input.chain, 'USDC').chainId;
  return {
    entryId: `je_gas_${input.txHash.slice(2, 18)}`,
    workspaceId: input.workspaceId,
    occurredAt: input.at,
    memo: input.memo,
    source: { kind: 'CHAIN_TX', ref: input.txHash },
    // Gas is not a log: -1 marks the transaction-level fee.
    evidence: { chainId, txHash: input.txHash, logIndex: -1 },
    idempotencyKey: `gas:${chainId}:${input.txHash.toLowerCase()}`,
    postings,
    reversalOf: null,
  };
}

/** Adds the wallet tag to the cash lines of an entry built elsewhere. */
export function tagCash(e: JournalEntry, wallet: string): JournalEntry {
  return {
    ...e,
    postings: e.postings.map((p) =>
      p.account === 'CASH_ARC_USDC' && !p.counterpartyId
        ? { ...p, counterpartyId: walletTag(wallet) }
        : p,
    ),
  };
}

/**
 * Ledger cash per wallet in native wei (base units × 10^12 + dust). Untagged
 * cash lines are reported under `untagged` so a reconciliation can fail on them.
 */
export function walletCashWei(
  entries: readonly JournalEntry[],
  assetId: string,
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  const add = (k: string, v: bigint) => out.set(k, (out.get(k) ?? 0n) + v);
  for (const e of entries)
    for (const p of e.postings) {
      if (p.account !== 'CASH_ARC_USDC') continue;
      const key = p.counterpartyId?.startsWith('wallet:')
        ? p.counterpartyId
        : 'untagged';
      if (p.assetId === assetId) add(key, p.amount * NATIVE_WEI_PER_UNIT);
      else if (p.assetId === dustAssetId(assetId)) add(key, p.amount);
    }
  return out;
}
