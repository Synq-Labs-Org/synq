/**
 * Document-linked double-entry ledger for a workspace.
 *
 * Amounts are signed base units of one registry asset (debit positive, credit
 * negative); every entry balances per asset. An entry that records a chain or
 * provider effect carries its external evidence (chain, tx hash, log index)
 * and an idempotency key derived from it, so replaying the same chain event
 * never posts twice. Balanced is not enough: AP payouts are also checked
 * against the vendor's verified payout address (`checkCounterparties`), and
 * spendable cash excludes reservations, escrow, reserves and in-flight
 * cross-chain value (`availableToSpend`). Corrections are reversals; nothing
 * is deleted.
 */

export const ACCOUNTS = [
  'CASH_ARC_USDC',
  'CCTP_IN_FLIGHT',
  'GATEWAY_POSITION',
  'ACCOUNTS_RECEIVABLE',
  'ACCOUNTS_PAYABLE',
  'UNAPPLIED_RECEIPTS',
  'REFUND_LIABILITY',
  'ESCROW_LIABILITY',
  'OPERATIONAL_RESERVE',
  'REVENUE',
  'CONTRACTOR_EXPENSE',
  'NETWORK_FEES',
  'OWNER_EQUITY',
] as const;
export type Account = (typeof ACCOUNTS)[number];

export type Posting = Readonly<{
  account: Account;
  assetId: string;
  /** Signed base units: debit > 0, credit < 0. */
  amount: bigint;
  counterpartyId?: string;
  documentRef?: string;
}>;

export type ExternalEvidence = Readonly<{
  chainId: number;
  txHash: `0x${string}`;
  logIndex: number;
  /** Destination the funds actually went to (for payouts). */
  recipient?: `0x${string}`;
}>;

export type JournalEntry = Readonly<{
  entryId: string;
  workspaceId: string;
  occurredAt: number;
  memo: string;
  source: Readonly<{
    kind:
      | 'CHAIN_TX'
      | 'INVOICE'
      | 'PAYABLE'
      | 'RESERVATION'
      | 'ADJUSTMENT'
      | 'REVERSAL';
    ref: string;
  }>;
  evidence: ExternalEvidence | null;
  /** Unique per logical effect; reposting with the same key is a no-op. */
  idempotencyKey: string;
  postings: readonly Posting[];
  reversalOf: string | null;
}>;

export class LedgerError extends Error {
  constructor(
    readonly code:
      | 'UNBALANCED'
      | 'EMPTY'
      | 'ZERO_POSTING'
      | 'MISSING_EVIDENCE'
      | 'UNKNOWN_ENTRY'
      | 'ALREADY_REVERSED'
      | 'IDEMPOTENCY_CONFLICT'
      | 'OVER_RESERVED'
      | 'WRONG_VENDOR',
    message: string = code,
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export const evidenceKey = (e: ExternalEvidence) =>
  `chain:${e.chainId}:${e.txHash.toLowerCase()}:${e.logIndex}`;

/** Balanced per asset, no zero lines, chain effects carry evidence. */
export function validateEntry(e: JournalEntry): void {
  if (!e.postings.length) throw new LedgerError('EMPTY', e.entryId);
  const sums = new Map<string, bigint>();
  for (const p of e.postings) {
    if (p.amount === 0n)
      throw new LedgerError('ZERO_POSTING', `${e.entryId} ${p.account}`);
    sums.set(p.assetId, (sums.get(p.assetId) ?? 0n) + p.amount);
  }
  for (const [asset, sum] of sums)
    if (sum !== 0n)
      throw new LedgerError(
        'UNBALANCED',
        `${e.entryId}: ${asset} off by ${sum}`,
      );
  const touchesCash = e.postings.some(
    (p) => p.account === 'CASH_ARC_USDC' || p.account === 'CCTP_IN_FLIGHT',
  );
  if (touchesCash && e.source.kind === 'CHAIN_TX' && !e.evidence)
    throw new LedgerError('MISSING_EVIDENCE', e.entryId);
}

export type VendorDirectory = {
  /** Verified payout address for a counterparty on a chain, if any. */
  verifiedPayout(counterpartyId: string, chainId: number): `0x${string}` | null;
};

/**
 * A balanced AP payout can still pay the wrong party. Every AP debit with a
 * counterparty must be settled by evidence whose recipient is that vendor's
 * verified address.
 */
export function checkCounterparties(
  e: JournalEntry,
  vendors: VendorDirectory,
): void {
  for (const p of e.postings) {
    if (p.account !== 'ACCOUNTS_PAYABLE' || p.amount <= 0n || !p.counterpartyId)
      continue;
    if (!e.evidence?.recipient)
      throw new LedgerError(
        'WRONG_VENDOR',
        `${e.entryId}: AP settlement without recipient evidence`,
      );
    const verified = vendors.verifiedPayout(
      p.counterpartyId,
      e.evidence.chainId,
    );
    if (
      !verified ||
      verified.toLowerCase() !== e.evidence.recipient.toLowerCase()
    )
      throw new LedgerError(
        'WRONG_VENDOR',
        `${e.entryId}: paid ${e.evidence.recipient}, ${p.counterpartyId} verified ${verified ?? 'none'}`,
      );
  }
}

export interface LedgerStore {
  migrate(): Promise<void>;
  /** Inserts unless the idempotency key exists; returns the stored entry. */
  insert(e: JournalEntry): Promise<{ entry: JournalEntry; created: boolean }>;
  get(entryId: string): Promise<JournalEntry | null>;
  reversed(entryId: string): Promise<boolean>;
  entries(workspaceId: string): Promise<JournalEntry[]>;
}

export class Ledger {
  constructor(
    readonly store: LedgerStore,
    readonly vendors: VendorDirectory = { verifiedPayout: () => null },
  ) {}

  async post(
    e: JournalEntry,
  ): Promise<{ entry: JournalEntry; created: boolean }> {
    validateEntry(e);
    checkCounterparties(e, this.vendors);
    const r = await this.store.insert(e);
    if (
      !r.created &&
      JSON.stringify(normalize(r.entry.postings)) !==
        JSON.stringify(normalize(e.postings))
    )
      throw new LedgerError(
        'IDEMPOTENCY_CONFLICT',
        `${e.idempotencyKey} already posted with different lines`,
      );
    return r;
  }

  /** Corrections never delete: a reversal mirrors every line. */
  async reverse(entryId: string, reason: string, at: number) {
    const original = await this.store.get(entryId);
    if (!original) throw new LedgerError('UNKNOWN_ENTRY', entryId);
    if (await this.store.reversed(entryId))
      throw new LedgerError('ALREADY_REVERSED', entryId);
    return this.post({
      entryId: `${entryId}:rev`,
      workspaceId: original.workspaceId,
      occurredAt: at,
      memo: `Reversal: ${reason}`,
      source: { kind: 'REVERSAL', ref: entryId },
      evidence: null,
      idempotencyKey: `reversal:${entryId}`,
      postings: original.postings.map((p) => ({ ...p, amount: -p.amount })),
      reversalOf: entryId,
    });
  }

  async balance(
    workspaceId: string,
    account: Account,
    assetId: string,
  ): Promise<bigint> {
    let total = 0n;
    for (const e of await this.store.entries(workspaceId))
      for (const p of e.postings)
        if (p.account === account && p.assetId === assetId) total += p.amount;
    return total;
  }

  async balances(
    workspaceId: string,
    assetId: string,
  ): Promise<Record<Account, bigint>> {
    const out = Object.fromEntries(ACCOUNTS.map((a) => [a, 0n])) as Record<
      Account,
      bigint
    >;
    for (const e of await this.store.entries(workspaceId))
      for (const p of e.postings)
        if (p.assetId === assetId) out[p.account] += p.amount;
    return out;
  }
}

function normalize(ps: readonly Posting[]) {
  return [...ps]
    .map((p) => [
      p.account,
      p.assetId,
      String(p.amount),
      p.counterpartyId ?? '',
      p.documentRef ?? '',
    ])
    .sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/**
 * Spendable Arc cash: confirmed cash minus active reservations, escrow and the
 * reserve floor. In-flight CCTP value and Gateway positions are separate
 * buckets and never add to it. Never negative; over-reservation is an error.
 */
export function availableToSpend(input: {
  confirmedCash: bigint;
  reservations: bigint;
  escrow: bigint;
  minimumReserve: bigint;
}): bigint {
  const committed = input.reservations + input.escrow;
  if (committed > input.confirmedCash)
    throw new LedgerError(
      'OVER_RESERVED',
      `${committed} committed > ${input.confirmedCash} confirmed`,
    );
  const free = input.confirmedCash - committed - input.minimumReserve;
  return free > 0n ? free : 0n;
}

export class MemoryLedgerStore implements LedgerStore {
  private byId = new Map<string, JournalEntry>();
  private byKey = new Map<string, string>();
  async migrate() {}
  async insert(e: JournalEntry) {
    const existing = this.byKey.get(e.idempotencyKey);
    if (existing) return { entry: this.byId.get(existing)!, created: false };
    this.byId.set(e.entryId, e);
    this.byKey.set(e.idempotencyKey, e.entryId);
    return { entry: e, created: true };
  }
  async get(id: string) {
    return this.byId.get(id) ?? null;
  }
  async reversed(id: string) {
    return [...this.byId.values()].some((e) => e.reversalOf === id);
  }
  async entries(workspaceId: string) {
    return [...this.byId.values()].filter((e) => e.workspaceId === workspaceId);
  }
}

export * from './postgres.js';
