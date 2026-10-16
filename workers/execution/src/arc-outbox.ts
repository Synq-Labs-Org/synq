import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Hex } from 'viem';
import type { Money } from '@synq/domain';
import {
  AuthorityError,
  verifyGrant,
  type ExecutionGrant,
  type NonceFence,
} from '@synq/kernel/arc';
import {
  ArcExecutionError,
  prepareTransfer,
  reconcileTransfer,
  signPrepared,
  type ArcChain,
  type PreparedTransfer,
  type TransferEvidence,
  type TransferSigner,
} from './arc.js';
import { writeDurableJson } from './persistence.js';

/**
 * Exactly-once Arc payouts across worker crashes.
 *
 * The signed bytes and their hash are durably recorded under the payment's
 * idempotency key BEFORE the network can see them. Every later attempt for the
 * same key — retry, restart, duplicate message — recovers from that record:
 * it reads the receipt, or rebroadcasts the very same signed bytes (same hash,
 * same nonce: the chain accepts it at most once). It never prepares or signs a
 * second transaction for a key. If the nonce was consumed by something else,
 * the record stops at NEEDS_REVIEW; nothing pays again automatically.
 */

export type OutboxState = 'SIGNED' | 'CONFIRMED' | 'FAILED' | 'NEEDS_REVIEW';

export type OutboxRecord = Readonly<{
  key: string;
  state: OutboxState;
  prepared: PreparedTransfer;
  raw: Hex;
  hash: Hex;
  evidence: TransferEvidence | null;
  note: string | null;
  updatedAt: number;
}>;

export interface OutboxStore {
  get(key: string): Promise<OutboxRecord | null>;
  /** Inserts only if absent; false means another attempt already recorded the key. */
  create(r: OutboxRecord): Promise<boolean>;
  update(r: OutboxRecord): Promise<void>;
  /**
   * Optional: records the signed payout AND the grant's consumption in one
   * transaction, so a crash can never leave a consumed grant with no record
   * (or a record whose grant could be admitted again).
   */
  createConsumingGrant?(
    r: OutboxRecord,
    grant: ExecutionGrant,
    at: number,
  ): Promise<'CREATED' | 'KEY_EXISTS' | 'GRANT_REPLAYED'>;
}

export class MemoryOutboxStore implements OutboxStore {
  private rows = new Map<string, OutboxRecord>();
  async get(key: string) {
    return this.rows.get(key) ?? null;
  }
  async create(r: OutboxRecord) {
    if (this.rows.has(r.key)) return false;
    this.rows.set(r.key, r);
    return true;
  }
  async update(r: OutboxRecord) {
    this.rows.set(r.key, r);
  }
}

const big = (_k: string, v: unknown) =>
  typeof v === 'bigint' ? { $big: v.toString() } : v;
const unbig = (_k: string, v: unknown) =>
  v && typeof v === 'object' && '$big' in v
    ? BigInt((v as { $big: string }).$big)
    : v;

/** One fsynced JSON file per key; survives process death. */
export class FileOutboxStore implements OutboxStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private path(key: string) {
    return join(
      this.dir,
      `${createHash('sha256').update(key).digest('hex')}.json`,
    );
  }
  async get(key: string) {
    const p = this.path(key);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'), unbig) as OutboxRecord;
  }
  async create(r: OutboxRecord) {
    if (existsSync(this.path(r.key))) return false;
    await this.update(r);
    return true;
  }
  async update(r: OutboxRecord) {
    writeDurableJson(this.path(r.key), JSON.parse(JSON.stringify(r, big)));
  }
}

export type PayOnceResult = Readonly<{
  record: OutboxRecord;
  /** True only on the attempt that first signed the transaction. */
  signedNow: boolean;
}>;

export async function payOnce(input: {
  store: OutboxStore;
  key: string;
  chain: ArcChain;
  signer: TransferSigner;
  transfer: {
    from: PreparedTransfer['from'];
    to: PreparedTransfer['to'];
    amount: Money;
  };
  now: () => number;
  /** Test seam: runs after the record is durable and before broadcast. */
  afterRecord?: (r: OutboxRecord) => Promise<void> | void;
}): Promise<PayOnceResult> {
  const existing = await input.store.get(input.key);
  if (existing) {
    assertSamePayment(existing, input.transfer);
    return {
      record: await recover(input.store, input.chain, existing, input.now),
      signedNow: false,
    };
  }
  const prepared = await prepareTransfer(input.chain, input.transfer);
  const { raw, hash } = await signPrepared(input.signer, prepared);
  const record: OutboxRecord = {
    key: input.key,
    state: 'SIGNED',
    prepared,
    raw,
    hash,
    evidence: null,
    note: null,
    updatedAt: input.now(),
  };
  if (!(await input.store.create(record))) {
    // Lost a race with a concurrent attempt: discard our unsent signature.
    const winner = (await input.store.get(input.key))!;
    return {
      record: await recover(input.store, input.chain, winner, input.now),
      signedNow: false,
    };
  }
  await input.afterRecord?.(record);
  await input.chain.client.sendRawTransaction({ serializedTransaction: raw });
  const evidence = await reconcileTransfer(input.chain, prepared, hash);
  const done: OutboxRecord = {
    ...record,
    state: 'CONFIRMED',
    evidence,
    updatedAt: input.now(),
  };
  await input.store.update(done);
  return { record: done, signedNow: true };
}

function assertSamePayment(
  r: OutboxRecord,
  t: { from: string; to: string; amount: Money },
) {
  const p = r.prepared;
  if (
    p.from.toLowerCase() !== t.from.toLowerCase() ||
    p.to.toLowerCase() !== t.to.toLowerCase() ||
    p.amount.baseUnits !== t.amount.baseUnits ||
    p.amount.asset.assetId !== t.amount.asset.assetId
  )
    throw new ArcExecutionError(
      'TX_MISMATCH',
      `idempotency key ${r.key} already used for a different payment`,
    );
}

/** Reads the chain for a recorded payment and settles its state. Never signs. */
export async function recover(
  store: OutboxStore,
  chain: ArcChain,
  r: OutboxRecord,
  now: () => number,
): Promise<OutboxRecord> {
  if (r.state !== 'SIGNED') return r;
  const receipt = await chain.client
    .getTransactionReceipt({ hash: r.hash })
    .catch(() => null);
  let next: OutboxRecord;
  if (receipt) {
    next =
      receipt.status === 'success'
        ? {
            ...r,
            state: 'CONFIRMED',
            evidence: await reconcileTransfer(chain, r.prepared, r.hash),
            updatedAt: now(),
          }
        : { ...r, state: 'FAILED', note: 'receipt reverted', updatedAt: now() };
  } else {
    const mined = await chain.client.getTransactionCount({
      address: r.prepared.from,
      blockTag: 'latest',
    });
    if (mined > r.prepared.nonce) {
      next = {
        ...r,
        state: 'NEEDS_REVIEW',
        note: `nonce ${r.prepared.nonce} consumed by another transaction; not re-paying`,
        updatedAt: now(),
      };
    } else {
      // Same signed bytes: if the first broadcast landed in a mempool this is a no-op.
      await chain.client
        .sendRawTransaction({ serializedTransaction: r.raw })
        .catch((e: Error) => {
          if (!/known|already|underpriced|nonce too low/i.test(e.message))
            throw e;
        });
      next = {
        ...r,
        state: 'CONFIRMED',
        evidence: await reconcileTransfer(chain, r.prepared, r.hash),
        updatedAt: now(),
      };
    }
  }
  await store.update(next);
  return next;
}

/** Outbox key of the payout a Kernel grant authorises: one grant, one payout. */
export const grantOutboxKey = (grantId: string) => `grant:${grantId}`;

/**
 * The durable executor path for a Kernel-granted Arc transfer. The grant is
 * verified against the exact prepared transfer, the transaction is signed,
 * and then the signed bytes and the grant's consumption are recorded together
 * (atomically when the store supports it) before anything is broadcast. A
 * restart recovers from the record without re-admitting or re-signing; a
 * replayed grant is refused before its signature leaves the process.
 */
export async function payGrantOnce(input: {
  /** Stable application idempotency key, unchanged across reauthorization. */
  key?: string;
  store: OutboxStore;
  fence: NonceFence;
  grant: ExecutionGrant;
  grantKey: Uint8Array;
  mandateRevoked: boolean;
  chain: ArcChain;
  signer: TransferSigner;
  transfer: {
    from: PreparedTransfer['from'];
    to: PreparedTransfer['to'];
    amount: Money;
  };
  now: () => number;
  afterRecord?: (r: OutboxRecord) => Promise<void> | void;
}): Promise<PayOnceResult> {
  const key = input.key ?? grantOutboxKey(input.grant.grantId);
  const existing = await input.store.get(key);
  if (existing) {
    assertSamePayment(existing, input.transfer);
    return {
      record: await recover(input.store, input.chain, existing, input.now),
      signedNow: false,
    };
  }
  const prepared = await prepareTransfer(input.chain, input.transfer);
  const at = input.now();
  verifyGrant({
    grantKey: input.grantKey,
    grant: input.grant,
    call: {
      chainId: prepared.chainId,
      token: prepared.token,
      payer: prepared.from,
      recipient: prepared.to,
      amount: prepared.amount.baseUnits,
    },
    now: at,
    mandateRevoked: input.mandateRevoked,
  });
  const { raw, hash } = await signPrepared(input.signer, prepared);
  const record: OutboxRecord = {
    key,
    state: 'SIGNED',
    prepared,
    raw,
    hash,
    evidence: null,
    note: null,
    updatedAt: at,
  };
  let outcome: 'CREATED' | 'KEY_EXISTS' | 'GRANT_REPLAYED';
  if (input.store.createConsumingGrant)
    outcome = await input.store.createConsumingGrant(record, input.grant, at);
  else {
    const fresh = input.fence.consumeGrant
      ? await input.fence.consumeGrant(input.grant, at)
      : await input.fence.consume(input.grant.nonce);
    outcome = !fresh
      ? 'GRANT_REPLAYED'
      : (await input.store.create(record))
        ? 'CREATED'
        : 'KEY_EXISTS';
  }
  if (outcome === 'GRANT_REPLAYED') throw new AuthorityError('GRANT_REPLAYED');
  if (outcome === 'KEY_EXISTS') {
    const winner = (await input.store.get(key))!;
    return {
      record: await recover(input.store, input.chain, winner, input.now),
      signedNow: false,
    };
  }
  await input.afterRecord?.(record);
  await input.chain.client.sendRawTransaction({ serializedTransaction: raw });
  const evidence = await reconcileTransfer(input.chain, prepared, hash);
  const done: OutboxRecord = {
    ...record,
    state: 'CONFIRMED',
    evidence,
    updatedAt: input.now(),
  };
  await input.store.update(done);
  return { record: done, signedNow: true };
}
