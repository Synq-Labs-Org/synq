import { contentHash } from './canonical.js';
import { FundingError } from './errors.js';
import type { FundingRoute, NormalizedQuote } from './types.js';

export const FUNDING_STATES = [
  'QUOTED',
  'USER_AUTHORIZED',
  'SOURCE_SUBMITTED',
  'BRIDGE_PENDING',
  'INTENT_PENDING',
  'DESTINATION_RECEIVED',
  'INDEXED',
  'CREDITED',
  'EXPIRED',
  'INCOMPLETE_DEPOSIT',
  'REFUNDED',
  'FAILED',
  'RECONCILIATION_REQUIRED',
] as const;
export type FundingState = (typeof FUNDING_STATES)[number];
export const TERMINAL_FUNDING_STATES: readonly FundingState[] = [
  'CREDITED',
  'EXPIRED',
  'REFUNDED',
  'FAILED',
];
/** States whose destination value is in flight: shown as pending, never free. */
export const PENDING_FUNDING_STATES: readonly FundingState[] = [
  'USER_AUTHORIZED',
  'SOURCE_SUBMITTED',
  'BRIDGE_PENDING',
  'INTENT_PENDING',
  'DESTINATION_RECEIVED',
  'INDEXED',
  'INCOMPLETE_DEPOSIT',
  'RECONCILIATION_REQUIRED',
];

const NEXT: Record<FundingState, readonly FundingState[]> = {
  QUOTED: ['USER_AUTHORIZED', 'EXPIRED', 'FAILED'],
  USER_AUTHORIZED: ['SOURCE_SUBMITTED', 'EXPIRED', 'FAILED'],
  SOURCE_SUBMITTED: [
    'BRIDGE_PENDING',
    'INTENT_PENDING',
    'DESTINATION_RECEIVED',
    'INCOMPLETE_DEPOSIT',
    'REFUNDED',
    'FAILED',
    'RECONCILIATION_REQUIRED',
  ],
  BRIDGE_PENDING: ['DESTINATION_RECEIVED', 'FAILED', 'RECONCILIATION_REQUIRED'],
  INTENT_PENDING: [
    'DESTINATION_RECEIVED',
    'INCOMPLETE_DEPOSIT',
    'REFUNDED',
    'FAILED',
    'RECONCILIATION_REQUIRED',
  ],
  INCOMPLETE_DEPOSIT: ['INTENT_PENDING', 'REFUNDED', 'RECONCILIATION_REQUIRED'],
  DESTINATION_RECEIVED: ['INDEXED', 'RECONCILIATION_REQUIRED'],
  INDEXED: ['CREDITED'],
  RECONCILIATION_REQUIRED: [
    'BRIDGE_PENDING',
    'INTENT_PENDING',
    'DESTINATION_RECEIVED',
    'REFUNDED',
    'FAILED',
  ],
  CREDITED: [],
  EXPIRED: [],
  REFUNDED: [],
  FAILED: [],
};

export type ProviderStatus =
  | 'PENDING_DEPOSIT'
  | 'KNOWN_DEPOSIT_TX'
  | 'INCOMPLETE_DEPOSIT'
  | 'PROCESSING'
  | 'SUCCESS'
  | 'REFUNDED'
  | 'FAILED';

export type DestinationReceipt = {
  chainId: number;
  token: `0x${string}`;
  to: `0x${string}`;
  amount: string;
  transactionHash: `0x${string}`;
  logIndex: number;
  blockNumber: number;
};

export type FundingTransition = {
  from: FundingState | null;
  to: FundingState;
  at: number;
  cause: string;
};

export type FundingSession = {
  sessionId: `0x${string}`;
  groupId: string;
  route: FundingRoute;
  /** Idempotency key: provider deposit address, else the correlation id. */
  idempotencyKey: string;
  quote: NormalizedQuote;
  state: FundingState;
  sourceTransactionHash: `0x${string}` | null;
  providerStatus: ProviderStatus | null;
  providerUpdates: string[];
  receipt: DestinationReceipt | null;
  /** Actual received amount; never the promised quote amount. */
  receivedAmount: string | null;
  shortfall: string | null;
  creditId: string | null;
  creditedAmount: string | null;
  history: FundingTransition[];
};

export const idempotencyKeyFor = (quote: NormalizedQuote): string =>
  quote.depositAddress
    ? `deposit:${quote.depositAddress.toLowerCase()}`
    : `correlation:${quote.correlationId ?? quote.quoteId}`;

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

function move(
  s: FundingSession,
  to: FundingState,
  at: number,
  cause: string,
): FundingSession {
  if (s.state === to) return s;
  if (!NEXT[s.state].includes(to))
    throw new FundingError('INVALID_TRANSITION', `${s.state} -> ${to}`);
  return {
    ...s,
    state: to,
    history: [...s.history, { from: s.state, to, at, cause }],
  };
}

export function openSession(input: {
  groupId: string;
  quote: NormalizedQuote;
  now: number;
}): FundingSession {
  if (input.quote.expiresAt <= input.now)
    throw new FundingError('QUOTE_EXPIRED');
  const idempotencyKey = idempotencyKeyFor(input.quote);
  return {
    sessionId: contentHash({
      kind: 'FundingSession',
      groupId: input.groupId,
      idempotencyKey,
      quoteId: input.quote.quoteId,
    }),
    groupId: input.groupId,
    route: input.quote.route,
    idempotencyKey,
    quote: input.quote,
    state: 'QUOTED',
    sourceTransactionHash: null,
    providerStatus: null,
    providerUpdates: [],
    receipt: null,
    receivedAmount: null,
    shortfall: null,
    creditId: null,
    creditedAmount: null,
    history: [{ from: null, to: 'QUOTED', at: input.now, cause: 'quote' }],
  };
}

/** USER_AUTHORIZED only before quote expiry; an expired quote must be requoted before any source debit. */
export function authorizeSession(
  s: FundingSession,
  now: number,
): FundingSession {
  if (s.state === 'USER_AUTHORIZED') return s;
  if (now >= s.quote.expiresAt) return move(s, 'EXPIRED', now, 'quote expired');
  return move(s, 'USER_AUTHORIZED', now, 'user authorized quote');
}

export function recordSourceSubmission(
  s: FundingSession,
  transactionHash: `0x${string}`,
  now: number,
): FundingSession {
  if (s.sourceTransactionHash !== null) {
    if (same(s.sourceTransactionHash, transactionHash)) return s;
    throw new FundingError(
      'IDEMPOTENCY_CONFLICT',
      'a different source transaction is already recorded',
    );
  }
  if (s.state === 'QUOTED' || s.state === 'EXPIRED')
    throw new FundingError('INVALID_TRANSITION', 'source before authorization');
  if (now >= s.quote.expiresAt)
    return move(s, 'EXPIRED', now, 'quote expired before source submission');
  const submitted = move(
    { ...s, sourceTransactionHash: transactionHash },
    'SOURCE_SUBMITTED',
    now,
    `source ${transactionHash}`,
  );
  if (s.route === 'AUSD_OFT')
    return move(submitted, 'BRIDGE_PENDING', now, 'OFT message in flight');
  if (s.route === 'AURORA_INTENTS' || s.route === 'BRIDGE_TO_USDC_THEN_CONVERT')
    return move(submitted, 'INTENT_PENDING', now, 'intent in flight');
  return submitted;
}

/**
 * Provider callbacks/polls are advisory: duplicates are no-ops and SUCCESS
 * never credits. Only an observed destination receipt moves value.
 */
export function applyProviderStatus(
  s: FundingSession,
  update: { status: ProviderStatus; updatedAt: string },
  now: number,
): FundingSession {
  const key = `${update.status}@${update.updatedAt}`;
  if (s.providerUpdates.includes(key)) return s;
  const recorded = {
    ...s,
    providerStatus: update.status,
    providerUpdates: [...s.providerUpdates, key],
  };
  if (TERMINAL_FUNDING_STATES.includes(s.state)) return recorded;
  if (update.status === 'REFUNDED' && s.state !== 'DESTINATION_RECEIVED')
    return move(recorded, 'REFUNDED', now, 'provider refunded');
  if (update.status === 'INCOMPLETE_DEPOSIT' && s.state === 'INTENT_PENDING')
    return move(recorded, 'INCOMPLETE_DEPOSIT', now, 'source underpaid');
  if (update.status === 'FAILED' && s.state === 'INTENT_PENDING')
    return move(recorded, 'RECONCILIATION_REQUIRED', now, 'provider failed');
  if (
    s.state === 'INCOMPLETE_DEPOSIT' &&
    (update.status === 'PROCESSING' || update.status === 'KNOWN_DEPOSIT_TX')
  )
    return move(recorded, 'INTENT_PENDING', now, 'deposit topped up');
  return recorded;
}

/** A source-side timeout never re-debits; it moves to reconciliation. */
export function timeoutSession(s: FundingSession, now: number): FundingSession {
  if (
    s.state === 'SOURCE_SUBMITTED' ||
    s.state === 'BRIDGE_PENDING' ||
    s.state === 'INTENT_PENDING'
  )
    return move(s, 'RECONCILIATION_REQUIRED', now, 'timeout');
  return s;
}

export function observeDestination(
  s: FundingSession,
  receipt: DestinationReceipt,
  now: number,
): FundingSession {
  if (s.receipt) {
    if (
      s.receipt.transactionHash === receipt.transactionHash &&
      s.receipt.logIndex === receipt.logIndex
    )
      return s;
    throw new FundingError(
      'IDEMPOTENCY_CONFLICT',
      'second destination receipt',
    );
  }
  const destination = s.quote.destination;
  if (
    receipt.chainId !== destination.chainId ||
    destination.address === 'native' ||
    !same(receipt.token, destination.address) ||
    !same(receipt.to, s.quote.recipient)
  )
    throw new FundingError(
      'DESTINATION_MISMATCH',
      `${receipt.chainId}:${receipt.token}->${receipt.to}`,
    );
  const amount = BigInt(receipt.amount);
  const min = BigInt(s.quote.minAmountOut);
  return move(
    {
      ...s,
      receipt,
      receivedAmount: receipt.amount,
      shortfall: amount < min ? String(min - amount) : null,
    },
    'DESTINATION_RECEIVED',
    now,
    `destination ${receipt.transactionHash}:${receipt.logIndex}`,
  );
}

export function markIndexed(
  s: FundingSession,
  indexed: { indexedThroughBlock: number; eventPresent: boolean },
  now: number,
): FundingSession {
  if (s.state !== 'DESTINATION_RECEIVED') return s;
  if (
    !s.receipt ||
    !indexed.eventPresent ||
    indexed.indexedThroughBlock < s.receipt.blockNumber
  )
    return s;
  return move(
    s,
    'INDEXED',
    now,
    `indexed through ${indexed.indexedThroughBlock}`,
  );
}

/** Credits exactly the observed amount once; the credit id is the chain event identity. */
export function creditSession(s: FundingSession, now: number): FundingSession {
  if (s.state === 'CREDITED') return s;
  if (s.state !== 'INDEXED' || !s.receipt)
    throw new FundingError('INVALID_TRANSITION', `credit from ${s.state}`);
  return move(
    {
      ...s,
      creditId: `${s.receipt.chainId}:${s.receipt.transactionHash}:${s.receipt.logIndex}`,
      creditedAmount: s.receivedAmount,
    },
    'CREDITED',
    now,
    'credited observed amount',
  );
}

export interface FundingSessionStore {
  byKey(key: string): Promise<FundingSession | null>;
  get(sessionId: string): Promise<FundingSession | null>;
  /** Inserts a new session or returns the existing one for the same idempotency key and quote. */
  open(session: FundingSession): Promise<FundingSession>;
  save(session: FundingSession): Promise<void>;
  list(groupId: string): Promise<FundingSession[]>;
}

export class MemoryFundingSessionStore implements FundingSessionStore {
  private readonly sessions = new Map<string, FundingSession>();
  async byKey(key: string) {
    for (const s of this.sessions.values())
      if (s.idempotencyKey === key) return structuredClone(s);
    return null;
  }
  async get(sessionId: string) {
    const s = this.sessions.get(sessionId);
    return s ? structuredClone(s) : null;
  }
  async open(session: FundingSession) {
    const existing = await this.byKey(session.idempotencyKey);
    if (existing) {
      if (existing.quote.quoteId !== session.quote.quoteId)
        throw new FundingError(
          'IDEMPOTENCY_CONFLICT',
          `${session.idempotencyKey} bound to another quote`,
        );
      return existing;
    }
    this.sessions.set(session.sessionId, structuredClone(session));
    return structuredClone(session);
  }
  async save(session: FundingSession) {
    const existing = this.sessions.get(session.sessionId);
    if (!existing)
      throw new FundingError('INVALID_TRANSITION', 'unknown session');
    if (existing.history.length > session.history.length)
      throw new FundingError('IDEMPOTENCY_CONFLICT', 'stale session write');
    this.sessions.set(session.sessionId, structuredClone(session));
  }
  async list(groupId: string) {
    return [...this.sessions.values()]
      .filter((s) => s.groupId === groupId)
      .map((s) => structuredClone(s));
  }
}
