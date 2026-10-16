import { randomBytes } from 'node:crypto';
import {
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  decide,
  type AuthorityConfig,
  type Decision,
  type ExecutionGrant,
  type PaymentIntent,
  type PaymentPurpose,
} from '@synq/kernel/arc';
import {
  arcGasEntry,
  walletTag,
  type JournalEntry,
  type Ledger,
} from '@synq/ledger';
import {
  apEntries,
  verifiedAddress,
  type Obligation,
  type Vendor,
  type VendorInvoice,
} from '@synq/payables';
import {
  PolicyError,
  mandateFromPolicy,
  policyHash,
  type SignedRevenuePolicy,
} from './policy.js';
import {
  policyStanding,
  registerPolicy,
  type WorkspaceRegistry,
} from './registry.js';
import {
  TERMINAL,
  holdsOrSpent,
  isCancellable,
  treasuryScope,
  type LegEvidence,
  type LegRecord,
  type LegState,
  type Reservation,
  type SplitRecord,
  type SplitStore,
} from './split.js';
import {
  AllocationError,
  availableLiquidity,
  computeWaterfall,
  type AllocationPlan,
  type CashPosition,
  type FinalReceipt,
  type LegPurpose,
  type Receivable,
  type RecurringBill,
} from './waterfall.js';

/**
 * Durable runner for the split workflow.
 *
 * Every step reads its inputs fresh, writes its result with a
 * compare-and-set transition, and is safe to run again after a crash at any
 * point. Steps that read and change shared state run inside
 * `store.atomically` with a named lock (one Postgres transaction):
 *   - `treasury:<scope>`: rolling holds forward, planning and reserving, and
 *     cancelling, so holds on one treasury never race each other;
 *   - `policy:<policyId>`: the frequency and window limits and every Kernel
 *     grant, so concurrent splits cannot together exceed them;
 *   - `split:<splitId>`: cancellation and the claim each leg makes right
 *     before it is signed.
 * Transfer legs go through the authority chain one at a time: the policy
 * must be signed by a registered owner of the workspace, be its latest
 * registered version and not be revoked; the Kernel issues a grant bound to
 * the exact call and the leg; the executor pays at most once per leg key,
 * recording signed bytes before broadcast and recovering from that record
 * instead of signing again. A leg whose outcome is unknown stops the split
 * for review.
 */

/** Exact call a transfer leg makes: the executor pays only this. */
export type LegCall = Readonly<{
  legKey: string;
  recipient: Address;
  amount: bigint;
  /** On-chain reference (keccak256 of the leg key): links the payment to the receipt. */
  ref: Hex;
}>;

export type LegPayResult = Readonly<{
  state: 'CONFIRMED' | 'FAILED' | 'NEEDS_REVIEW';
  hash: Hex;
  evidence: LegEvidence | null;
  /** True only on the attempt that signed the transaction. */
  signedNow: boolean;
  note: string | null;
}>;

export interface LegExecutor {
  /** True when the payment emits `ref` on chain (vault OperatorPaid). */
  readonly onChainReference: boolean;
  /** Read-only simulation of the exact payment from the treasury. */
  simulate(
    call: LegCall,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The durable signed-transaction record for a leg key, if one exists. */
  recorded(legKey: string): Promise<{ hash: Hex; state: string } | null>;
  /**
   * Pays exactly once per leg key. With a durable record it recovers (reads
   * the receipt or rebroadcasts the same bytes) and never signs. Before
   * signing a new transaction it calls `claim` (the runner re-checks the
   * leg, the split and the policy under lock; it throws to refuse) and then
   * admits the grant, which must be for this leg (`legIntentId`).
   * `onRecorded` runs after the signed bytes are durable, before broadcast.
   */
  pay(
    call: LegCall & {
      grant: ExecutionGrant;
      claim: () => Promise<{ mandateRevoked: boolean }>;
      onRecorded: (hash: Hex) => Promise<void>;
    },
  ): Promise<LegPayResult>;
}

export interface ReceiptVerifier {
  /** Re-reads the receipt on chain; FINAL only at a finalized block. */
  verify(r: FinalReceipt): Promise<FinalReceipt>;
}

/** Real books the waterfall reads (chain, ledger, vendor master, invoices). */
export interface TreasuryBooks {
  /** Finalized treasury balance and restricted buckets; holds come from the split store. */
  position(): Promise<Omit<CashPosition, 'reservations'>>;
  vendors(): Promise<Vendor[]>;
  /** Open vendor invoices (not paid). */
  payables(): Promise<VendorInvoice[]>;
  payableHistory(): Promise<VendorInvoice[]>;
  obligations(): Promise<Obligation[]>;
  bills(): Promise<RecurringBill[]>;
  receivables(): Promise<Receivable[]>;
  /**
   * Holds settled outside the split: a bill occurrence paid
   * (`bill:<id>@<date>` CONSUMED), a tax estimate remitted
   * (`tax:<receiptId>` CONSUMED), or a hold no longer needed (RELEASED).
   */
  settledHolds?(): Promise<
    readonly { holdKey: string; status: 'CONSUMED' | 'RELEASED' }[]
  >;
}

export const legRef = (legKey: string): Hex => keccak256(stringToHex(legKey));
/** Kernel intent id of a leg: grants are bound to exactly one leg through it. */
export const legIntentId = (legKey: string) => `int_${legKey}`;

export function kernelPurposeOf(purpose: LegPurpose): PaymentPurpose {
  return purpose === 'CONTRACTOR_PAYABLE'
    ? 'CONTRACTOR_PAYOUT'
    : purpose === 'DISTRIBUTION'
      ? 'OWNER_DISTRIBUTION'
      : 'VENDOR_INVOICE';
}

export type RunnerDeps = Readonly<{
  store: SplitStore;
  ledger: Ledger;
  executor: LegExecutor;
  receipts: ReceiptVerifier;
  books: TreasuryBooks;
  signedPolicy: SignedRevenuePolicy;
  /** Registered owners and treasury of each workspace (not settable by a policy). */
  registry: WorkspaceRegistry;
  kernel: AuthorityConfig;
  /** Registry asset id of the policy token (ledger asset). */
  assetId: string;
  chain: 'arc-testnet' | 'arc-mainnet';
  now: () => number;
  /** Optional trace of every step (for evidence). */
  trace?: (event: string, detail: Record<string, unknown>) => void;
}>;

const sum = (xs: readonly { amount: bigint }[]) =>
  xs.reduce((a, x) => a + x.amount, 0n);

export class SplitRunner {
  constructor(readonly deps: RunnerDeps) {}

  private get policy() {
    return this.deps.signedPolicy.policy;
  }
  private get scope() {
    return treasuryScope(this.policy);
  }
  private trace(event: string, detail: Record<string, unknown> = {}) {
    this.deps.trace?.(event, detail);
  }

  /**
   * Starts a split for one receipt. Refuses a receipt that is not final on
   * chain; a second trigger for the same receipt returns the existing split.
   */
  async trigger(
    receipt: FinalReceipt,
  ): Promise<{ split: SplitRecord; duplicate: boolean }> {
    const existing = await this.deps.store.byReceipt(receipt.receiptId);
    if (existing) return { split: existing, duplicate: true };
    const verified = await this.deps.receipts.verify(receipt);
    if (verified.finality !== 'FINAL')
      throw new AllocationError(
        'RECEIPT_NOT_FINAL',
        `${receipt.receiptId} is not final on chain`,
      );
    if (
      verified.amount !== receipt.amount ||
      getAddress(verified.recipient) !== getAddress(receipt.recipient)
    )
      throw new AllocationError(
        'RECEIPT_NOT_FINAL',
        'chain receipt differs from the reported receipt',
      );
    const at = this.deps.now();
    const r = await this.deps.store.create({
      splitId: `spl_${randomBytes(8).toString('hex')}`,
      workspaceId: this.policy.workspaceId,
      receiptId: verified.receiptId,
      invoiceId: verified.invoiceId,
      policyId: this.policy.policyId,
      policyVersion: this.policy.version,
      state: 'RECEIPT_FINAL',
      rev: 1,
      receipt: verified,
      plan: null,
      note: `receipt ${verified.txHash} log ${verified.logIndex} final at block ${verified.blockNumber}`,
      createdAt: at,
      updatedAt: at,
    });
    this.trace('split.triggered', {
      splitId: r.split.splitId,
      receiptId: verified.receiptId,
      duplicate: !r.created,
    });
    return { split: r.split, duplicate: !r.created };
  }

  /** Runs every non-terminal split (restart recovery); FAILED splits are retried. */
  async resume(): Promise<SplitRecord[]> {
    const out: SplitRecord[] = [];
    for (const s of await this.deps.store.open())
      if (s.policyId === this.policy.policyId)
        out.push(await this.run(s.splitId));
    return out;
  }

  /**
   * Cancels before execution, atomically: in one transaction holding the
   * split and treasury locks, the split is compare-and-set to CANCELLED
   * first, and only then are its holds released and its legs cancelled. A
   * cancel that lost the race to execution changes nothing.
   */
  async cancel(splitId: string, reason: string): Promise<SplitRecord> {
    const at = this.deps.now();
    return this.deps.store.atomically(
      [`split:${splitId}`, `treasury:${this.scope}`],
      async (tx) => {
        const s = await tx.get(splitId);
        if (!s) throw new AllocationError('NOT_FOUND', splitId);
        if (!isCancellable(s.state))
          throw new AllocationError(
            'WRONG_STATE',
            `${s.state}: cancellation is only allowed before execution`,
          );
        const done = await tx.advance(
          splitId,
          { state: s.state, rev: s.rev },
          { state: 'CANCELLED', note: reason },
          at,
        );
        const holds = await tx.reservations(this.scope);
        for (const leg of await tx.legs(splitId)) {
          const h = holds.find(
            (x) => x.reservationId === leg.legKey && x.status === 'ACTIVE',
          );
          if (h) await tx.setReservation(h.reservationId, 'RELEASED', at);
          await tx.updateLeg(leg.legKey, leg.state, {
            state: 'CANCELLED',
            note: reason,
            updatedAt: at,
          });
        }
        return done;
      },
    );
  }

  /** Advances the split as far as it can go. Idempotent and crash-safe. */
  async run(
    splitId: string,
    opts: { stopAt?: SplitRecord['state'] } = {},
  ): Promise<SplitRecord> {
    for (let guard = 0; guard < 20; guard++) {
      const s = await this.must(this.deps.store, splitId);
      if (TERMINAL.includes(s.state) || s.state === opts.stopAt) return s;
      const next = await this.step(s);
      if (next.state === s.state && next.rev === s.rev) return next;
      if (next.state === 'FAILED' && s.state === 'EXECUTING') return next;
    }
    throw new AllocationError('WRONG_STATE', `${splitId} did not settle`);
  }

  private async must(store: SplitStore, splitId: string) {
    const s = await store.get(splitId);
    if (!s) throw new AllocationError('NOT_FOUND', splitId);
    return s;
  }

  private advance(
    s: SplitRecord,
    state: SplitRecord['state'],
    note: string | null,
    plan?: AllocationPlan,
    store: SplitStore = this.deps.store,
  ) {
    this.trace('split.advance', {
      splitId: s.splitId,
      from: s.state,
      to: state,
      note,
    });
    return store.advance(
      s.splitId,
      { state: s.state, rev: s.rev },
      { state, note, ...(plan ? { plan } : {}) },
      this.deps.now(),
    );
  }

  private async step(s: SplitRecord): Promise<SplitRecord> {
    switch (s.state) {
      case 'RECEIPT_FINAL':
        return this.planAndReserve(s);
      case 'LIABILITIES_RECONCILED':
        return this.deps.store.atomically(
          [`treasury:${this.scope}`],
          async (tx) => {
            const cur = await this.must(tx, s.splitId);
            return cur.rev === s.rev ? this.createReservations(tx, cur) : cur;
          },
        );
      case 'RESERVATIONS_CREATED':
        return this.validatePolicy(s);
      case 'POLICY_VALIDATED':
        return this.authorize(s);
      case 'SPLIT_AUTHORIZED':
        return this.advance(
          s,
          'EXECUTING',
          'execution started; cancellation closed',
        );
      case 'FAILED':
        return this.advance(s, 'EXECUTING', 'resumed after a failure');
      case 'EXECUTING':
        return this.execute(s);
      case 'EACH_LEG_RECONCILED': {
        const legs = await this.deps.store.legs(s.splitId);
        const waiting = legs.filter((l) => l.state === 'AWAITING_APPROVAL');
        const cancelled = legs.filter(
          (l) => l.kind === 'TRANSFER' && l.state === 'CANCELLED',
        );
        if (cancelled.length)
          return this.advance(
            s,
            'NEEDS_REVIEW',
            `${cancelled.length} transfer leg(s) were cancelled during execution: ${cancelled.map((l) => l.legKey).join(', ')}`,
          );
        return waiting.length
          ? this.advance(
              s,
              'NEEDS_REVIEW',
              `${waiting.length} leg(s) need a fresh owner approval: ${waiting.map((l) => l.legKey).join(', ')}`,
            )
          : this.advance(s, 'COMPLETED', 'all legs reconciled');
      }
      default:
        return s;
    }
  }

  /** This workspace's booked cash in the treasury wallet (cash sub-ledger). */
  private async workspaceCash(workspaceId: string): Promise<bigint> {
    const tag = walletTag(this.policy.treasury);
    let cash = 0n;
    for (const e of await this.deps.ledger.store.entries(workspaceId))
      for (const p of e.postings)
        if (
          p.account === 'CASH_ARC_USDC' &&
          p.assetId === this.deps.assetId &&
          p.counterpartyId === tag
        )
          cash += p.amount;
    return cash;
  }

  /** A payee is payable now: on the policy allowlist and verified in the vendor master. */
  private payeeOk(vendors: readonly Vendor[], beneficiaryId: string | null) {
    const p = this.policy;
    const listed = p.allowedBeneficiaries.find(
      (b) => b.beneficiaryId === beneficiaryId,
    );
    const vendor = vendors.find((v) => v.vendorId === beneficiaryId);
    const verified = vendor ? verifiedAddress(vendor, p.chainId) : null;
    return !!listed && !!verified && getAddress(verified) === listed.address;
  }

  /**
   * Holds that move no money are settled or rolled forward before planning:
   * bills paid or tax remitted (from the books) are consumed; a held payable
   * whose payee is now verified, or that is no longer open, is released so
   * the payable is planned afresh; a held distribution whose payee is now
   * verified is released to free cash; a bill no longer on the books is
   * released; floor holds above the policy floor are released, newest first.
   */
  private async rollForward(
    tx: SplitStore,
    ctx: {
      vendors: readonly Vendor[];
      open: readonly VendorInvoice[];
      bills: readonly RecurringBill[];
      settled: readonly { holdKey: string; status: 'CONSUMED' | 'RELEASED' }[];
    },
  ) {
    const p = this.policy;
    const at = this.deps.now();
    const mine = (await tx.reservations(this.scope)).filter(
      (h) => h.status === 'ACTIVE' && h.workspaceId === p.workspaceId,
    );
    const settle = async (h: Reservation, status: Reservation['status']) => {
      await tx.setReservation(h.reservationId, status, at);
      const leg = (await tx.legs(h.splitId)).find(
        (l) => l.legKey === h.reservationId,
      );
      if (leg && leg.state === 'RESERVED')
        await tx.updateLeg(leg.legKey, 'RESERVED', {
          state: 'RELEASED',
          note: `hold ${status.toLowerCase()} by roll-forward`,
          updatedAt: at,
        });
      this.trace('hold.settled', { holdKey: h.holdKey, status });
    };
    const floors: Reservation[] = [];
    for (const h of mine) {
      const done = ctx.settled.find((x) => x.holdKey === h.holdKey);
      if (done) {
        await settle(h, done.status);
        continue;
      }
      if (h.purpose === 'PAYABLE_HELD') {
        const id = h.holdKey.replace(/^payable:/, '');
        const inv = ctx.open.find((i) => i.vendorInvoiceId === id);
        if (
          !inv ||
          (this.payeeOk(ctx.vendors, inv.vendorId) &&
            inv.token &&
            getAddress(inv.token) === p.token)
        )
          await settle(h, 'RELEASED');
      } else if (h.purpose === 'UPCOMING_BILL') {
        const billId = h.holdKey.replace(/^bill:/, '').split('@')[0];
        if (!ctx.bills.some((b) => b.billId === billId))
          await settle(h, 'RELEASED');
      } else if (h.purpose === 'DISTRIBUTION') {
        const leg = (await tx.legs(h.splitId)).find(
          (l) => l.legKey === h.reservationId,
        );
        if (
          leg?.kind === 'RESERVE' &&
          this.payeeOk(ctx.vendors, leg.beneficiaryId)
        )
          await settle(h, 'RELEASED');
      } else if (h.purpose === 'OPERATING_FLOOR') floors.push(h);
    }
    let floor = sum(floors);
    for (const h of [...floors].sort((a, b) => b.createdAt - a.createdAt)) {
      if (floor <= p.operatingFloor) break;
      await settle(h, 'RELEASED');
      floor -= h.amount;
    }
  }

  /**
   * Under the treasury lock: roll holds forward, plan against the treasury's
   * holds (every workspace) and this workspace's own cash sub-ledger, and
   * reserve, all in one transaction.
   */
  private async planAndReserve(s: SplitRecord): Promise<SplitRecord> {
    const { books, ledger } = this.deps;
    const p = this.policy;
    const r = s.receipt;
    const entries = await ledger.store.entries(s.workspaceId);
    const booked = entries.find((e) => e.idempotencyKey === r.receiptId);
    const cash = booked?.postings.find(
      (x) =>
        x.account === 'CASH_ARC_USDC' &&
        x.assetId === this.deps.assetId &&
        x.counterpartyId === walletTag(r.recipient),
    );
    if (!booked || cash?.amount !== r.amount)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `receipt ${r.receiptId} is not booked to the treasury in the ledger`,
      );
    const [pos, vendors, open, history, obligations, bills, receivables] =
      await Promise.all([
        books.position(),
        books.vendors(),
        books.payables(),
        books.payableHistory(),
        books.obligations(),
        books.bills(),
        books.receivables(),
      ]);
    const settled = (await books.settledHolds?.()) ?? [];
    return this.deps.store.atomically(
      [`treasury:${this.scope}`],
      async (tx) => {
        const cur = await this.must(tx, s.splitId);
        if (cur.state !== 'RECEIPT_FINAL' || cur.rev !== s.rev) return cur;
        await this.rollForward(tx, { vendors, open, bills, settled });
        const all = (await tx.reservations(this.scope)).filter(
          (h) => h.splitId !== s.splitId,
        );
        const active = all.filter((h) => h.status === 'ACTIVE');
        const mineActive = active.filter(
          (h) => h.workspaceId === s.workspaceId,
        );
        const mineAll = all.filter(
          (h) => h.workspaceId === s.workspaceId && h.status !== 'RELEASED',
        );
        const position: CashPosition = {
          ...pos,
          reservations: sum(active),
          workspaceCash: await this.workspaceCash(s.workspaceId),
          workspaceReservations: sum(mineActive),
        };
        // Payables held, granted or paid elsewhere are not planned again.
        const taken = new Set<string | null>([
          ...mineAll
            .filter((h) => h.holdKey.startsWith('payable:'))
            .map((h) => h.holdKey),
          ...(await tx.grantedLegs(p.policyId))
            .filter((l) => l.splitId !== s.splitId)
            .map((l) => l.obligationRef),
        ]);
        let plan: AllocationPlan;
        try {
          plan = computeWaterfall({
            policy: p,
            policyHash: policyHash(p),
            receipt: r,
            position,
            asOf: this.deps.now(),
            vendors,
            payables: open.filter(
              (i) => !taken.has(`payable:${i.vendorInvoiceId}`),
            ),
            payableHistory: history,
            obligations,
            bills,
            receivables,
            held: {
              billKeys: new Set(
                mineAll
                  .filter((h) => h.holdKey.startsWith('bill:'))
                  .map((h) => h.holdKey),
              ),
              floorReserved: sum(
                mineActive.filter((h) => h.purpose === 'OPERATING_FLOOR'),
              ),
            },
          });
        } catch (e) {
          if (e instanceof AllocationError && e.code === 'OVER_COMMITTED')
            return this.advance(
              cur,
              'NEEDS_REVIEW',
              `OVER_COMMITTED: cash is over-committed: ${e.message}`,
              undefined,
              tx,
            );
          throw e;
        }
        const next = await this.advance(
          cur,
          'LIABILITIES_RECONCILED',
          `plan ${plan.planHash.slice(0, 10)}: ${plan.legs.length} legs, free cash ${plan.remainder}`,
          plan,
          tx,
        );
        return this.createReservations(tx, next);
      },
    );
  }

  /** Each reserve and transfer leg holds its cash; admission against the current holds. */
  private async createReservations(
    tx: SplitStore,
    s: SplitRecord,
  ): Promise<SplitRecord> {
    const plan = s.plan!;
    const at = this.deps.now();
    await tx.putLegs(
      plan.legs.map((l) => ({
        ...l,
        splitId: s.splitId,
        receiptId: s.receiptId,
        policyId: s.policyId,
        state: 'PLANNED' as LegState,
        grant: null,
        authorizedAt: null,
        reasons: [],
        txHash: null,
        evidence: null,
        note: null,
        updatedAt: at,
      })),
    );
    const others = (await tx.reservations(this.scope)).filter(
      (h) => h.status === 'ACTIVE' && h.splitId !== s.splitId,
    );
    const holding = sum(plan.legs.filter((l) => l.kind !== 'FREE_CASH'));
    let free: bigint;
    try {
      free = availableLiquidity({
        ...plan.position,
        treasury: this.policy.treasury,
        reservations: sum(others),
        workspaceReservations: sum(
          others.filter((h) => h.workspaceId === s.workspaceId),
        ),
        workspaceCash: await this.workspaceCash(s.workspaceId),
      });
    } catch (e) {
      if (e instanceof AllocationError)
        return this.advance(
          s,
          'NEEDS_REVIEW',
          `reservation refused: ${e.message}`,
          undefined,
          tx,
        );
      throw e;
    }
    if (holding > free)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `reservation refused: ${holding} to hold > ${free} free`,
        undefined,
        tx,
      );
    for (const leg of await tx.legs(s.splitId)) {
      if (leg.kind === 'FREE_CASH') {
        if (leg.state === 'PLANNED')
          await tx.updateLeg(leg.legKey, 'PLANNED', {
            state: 'FREE',
            updatedAt: at,
          });
        continue;
      }
      await tx.reserve({
        reservationId: leg.legKey,
        scope: this.scope,
        holdKey: leg.holdKey ?? `leg:${leg.legKey}`,
        workspaceId: s.workspaceId,
        splitId: s.splitId,
        purpose: leg.purpose,
        amount: leg.amount,
        status: 'ACTIVE',
        remitted: false,
        createdAt: at,
        updatedAt: at,
      });
      if (leg.state === 'PLANNED')
        await tx.updateLeg(leg.legKey, 'PLANNED', {
          state: 'RESERVED',
          updatedAt: at,
        });
    }
    return this.advance(
      s,
      'RESERVATIONS_CREATED',
      `${plan.legs.filter((l) => l.kind !== 'FREE_CASH').length} reservations held`,
      undefined,
      tx,
    );
  }

  /**
   * The policy is signed by a registered owner of the workspace for its
   * registered treasury, is the latest registered version and is not
   * revoked; the plan was computed under it; every payee is still allowed
   * and verified; and, under the policy lock, the frequency and window
   * limits hold counting every split and leg already admitted.
   */
  private async validatePolicy(s: SplitRecord): Promise<SplitRecord> {
    const { store, books } = this.deps;
    const p = this.policy;
    const now = this.deps.now();
    try {
      await registerPolicy(
        store,
        this.deps.registry,
        this.deps.signedPolicy,
        now,
      );
    } catch (e) {
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `policy rejected: ${(e as PolicyError).code ?? 'ERROR'} ${(e as Error).message}`,
      );
    }
    const vendors = await books.vendors();
    return store.atomically([`policy:${p.policyId}`], async (tx) => {
      const cur = await this.must(tx, s.splitId);
      if (cur.state !== s.state || cur.rev !== s.rev) return cur;
      const review = (note: string) =>
        this.advance(cur, 'NEEDS_REVIEW', note, undefined, tx);
      const standing = await policyStanding(tx, this.deps.signedPolicy);
      if (!standing.usable)
        return review(`policy rejected: ${standing.reason}`);
      if (policyHash(p) !== cur.plan!.policyHash)
        return review('plan was computed under another policy');
      const since = now - p.limits.windowSeconds;
      const validated = (await tx.validatedSince(p.policyId, since)).filter(
        (id) => id !== s.splitId,
      );
      if (validated.length + 1 > p.limits.maxSplitsPerWindow)
        return review(
          `frequency limit: ${validated.length} split(s) already validated in this ${p.limits.windowSeconds}s window (max ${p.limits.maxSplitsPerWindow})`,
        );
      const problems: string[] = [];
      let windowSpend = sum(
        (await tx.transfersSince(p.policyId, since)).filter(
          (l) => l.splitId !== s.splitId,
        ),
      );
      for (const leg of await tx.legs(s.splitId)) {
        if (leg.kind !== 'TRANSFER' || leg.state !== 'RESERVED') continue;
        const listed = p.allowedBeneficiaries.find(
          (b) => b.beneficiaryId === leg.beneficiaryId,
        );
        if (
          !this.payeeOk(vendors, leg.beneficiaryId) ||
          !leg.payTo ||
          listed!.address !== getAddress(leg.payTo)
        ) {
          problems.push(
            `${leg.legKey}: beneficiary ${leg.beneficiaryId} is not an allowed, verified payee`,
          );
          continue;
        }
        const overLeg = leg.amount > p.limits.maxAutonomousPerLeg;
        const overWindow =
          windowSpend + leg.amount > p.limits.maxAutonomousPerWindow;
        if (overLeg || overWindow) {
          await tx.updateLeg(leg.legKey, 'RESERVED', {
            state: 'AWAITING_APPROVAL',
            autonomy: 'OWNER_APPROVAL_REQUIRED',
            reasons: [
              overLeg
                ? `amount ${leg.amount} above the autonomous per-leg limit ${p.limits.maxAutonomousPerLeg}`
                : `window spend ${windowSpend + leg.amount} above the autonomous window limit ${p.limits.maxAutonomousPerWindow}`,
            ],
            updatedAt: now,
          });
          continue;
        }
        windowSpend += leg.amount;
      }
      if (problems.length) return review(problems.join('; '));
      return this.advance(
        cur,
        'POLICY_VALIDATED',
        `policy ${p.policyId} v${p.version} signed by registered owner ${p.owner}`,
        undefined,
        tx,
      );
    });
  }

  /**
   * One Kernel decision per autonomous transfer leg under the policy lock,
   * so the spend window counts every grant already issued; each ALLOW is a
   * grant for the exact call and this leg only.
   */
  private async authorize(s: SplitRecord): Promise<SplitRecord> {
    const { store } = this.deps;
    const sims = new Map<
      string,
      Awaited<ReturnType<LegExecutor['simulate']>>
    >();
    for (const leg of await store.legs(s.splitId))
      if (leg.kind === 'TRANSFER' && leg.state === 'RESERVED')
        sims.set(
          leg.legKey,
          await this.deps.executor.simulate(this.callOf(leg)),
        );
    return store.atomically([`policy:${this.policy.policyId}`], async (tx) => {
      const cur = await this.must(tx, s.splitId);
      if (cur.state !== s.state || cur.rev !== s.rev) return cur;
      const standing = await policyStanding(tx, this.deps.signedPolicy);
      if (!standing.usable)
        return this.advance(
          cur,
          'NEEDS_REVIEW',
          `policy rejected: ${standing.reason}`,
          undefined,
          tx,
        );
      const denied: string[] = [];
      for (const leg of await tx.legs(s.splitId)) {
        if (leg.kind !== 'TRANSFER' || leg.state !== 'RESERVED') continue;
        const d = await this.decideLeg(tx, leg, sims.get(leg.legKey)!);
        if (d.outcome === 'ALLOW')
          await tx.updateLeg(leg.legKey, 'RESERVED', {
            state: 'AUTHORIZED',
            grant: d.grant,
            authorizedAt: this.deps.now(),
            reasons: d.reasons,
            updatedAt: this.deps.now(),
          });
        else {
          denied.push(`${leg.legKey}: ${d.reasons.join('; ')}`);
          await tx.updateLeg(leg.legKey, 'RESERVED', {
            state: d.outcome === 'DENY' ? 'FAILED' : 'AWAITING_APPROVAL',
            reasons: d.reasons,
            updatedAt: this.deps.now(),
          });
        }
      }
      if (denied.length)
        return this.advance(
          cur,
          'NEEDS_REVIEW',
          `Kernel refused: ${denied.join(' | ')}`,
          undefined,
          tx,
        );
      return this.advance(
        cur,
        'SPLIT_AUTHORIZED',
        'every autonomous leg holds an exact-call grant',
        undefined,
        tx,
      );
    });
  }

  private async decideLeg(
    tx: SplitStore,
    leg: LegRecord,
    sim: Awaited<ReturnType<LegExecutor['simulate']>>,
  ): Promise<Decision> {
    const p = this.policy;
    const { signedPolicy } = this.deps;
    const now = this.deps.now();
    const since = now - p.limits.windowSeconds;
    const spends = (await tx.transfersSince(p.policyId, since))
      .filter((l) => l.legKey !== leg.legKey)
      .map((l) => ({ amount: l.amount, at: l.authorizedAt ?? now }));
    const settled = (await tx.grantedLegs(p.policyId))
      .filter((l) => l.legKey !== leg.legKey && l.obligationRef)
      .map((l) => l.obligationRef!);
    const standing = await policyStanding(tx, signedPolicy);
    const intent: PaymentIntent = {
      intentId: legIntentId(leg.legKey),
      mandateId: signedPolicy.mandate.mandateId,
      mandateVersion: signedPolicy.mandate.version,
      chainId: p.chainId,
      token: p.token,
      payer: p.treasury,
      recipient: leg.payTo!,
      amount: leg.amount,
      purpose: kernelPurposeOf(leg.purpose),
      obligationRef: leg.obligationRef ?? leg.legKey,
      evidenceHash: legRef(`${leg.legKey}|${leg.splitId}`),
      proposedBy: `allocations:${p.policyId}`,
    };
    const d = await decide({
      config: this.deps.kernel,
      mandate: signedPolicy.mandate,
      mandateSignature: signedPolicy.mandateSignature,
      state: {
        revoked: !standing.usable,
        spends,
        settledObligations: settled,
      },
      intent,
      risk: { flags: leg.flags, available: true },
      simulationOk: sim.ok,
      now,
    });
    if (!sim.ok && d.outcome === 'DENY')
      d.reasons.push(`simulation: ${sim.reason}`);
    this.trace('leg.decision', {
      legKey: leg.legKey,
      outcome: d.outcome,
      reasons: d.reasons,
    });
    return d;
  }

  /** A fresh grant for a leg that holds none usable (expired or burned) and has no record. */
  private async reauthorize(
    s: SplitRecord,
    leg: LegRecord,
  ): Promise<LegRecord | string> {
    const sim = await this.deps.executor.simulate(this.callOf(leg));
    return this.deps.store.atomically(
      [`policy:${this.policy.policyId}`],
      async (tx) => {
        const cur = (await tx.legs(s.splitId)).find(
          (l) => l.legKey === leg.legKey,
        )!;
        if (cur.state !== 'AUTHORIZED')
          return `${leg.legKey} is ${cur.state}, not AUTHORIZED`;
        const d = await this.decideLeg(tx, cur, sim);
        if (d.outcome !== 'ALLOW') {
          await tx.updateLeg(leg.legKey, 'AUTHORIZED', {
            state: 'FAILED',
            reasons: d.reasons,
            updatedAt: this.deps.now(),
          });
          return `re-authorization refused for ${leg.legKey}: ${d.reasons.join('; ')}`;
        }
        return tx.updateLeg(leg.legKey, 'AUTHORIZED', {
          state: 'AUTHORIZED',
          grant: d.grant,
          reasons: d.reasons,
          updatedAt: this.deps.now(),
        });
      },
    );
  }

  /**
   * Right before a new signature, under the split lock: the split is still
   * EXECUTING, the leg is still AUTHORIZED (not cancelled, not paid), and the
   * policy is still the latest unrevoked version.
   */
  private claim(splitId: string, legKey: string) {
    return this.deps.store.atomically([`split:${splitId}`], async (tx) => {
      const split = await this.must(tx, splitId);
      if (split.state !== 'EXECUTING')
        throw new AllocationError(
          'LEG_NOT_PAYABLE',
          `split is ${split.state}, not EXECUTING`,
        );
      const leg = (await tx.legs(splitId)).find((l) => l.legKey === legKey);
      if (!leg || leg.state !== 'AUTHORIZED')
        throw new AllocationError(
          'LEG_NOT_PAYABLE',
          `${legKey} is ${leg?.state ?? 'missing'}, not AUTHORIZED`,
        );
      const standing = await policyStanding(tx, this.deps.signedPolicy);
      if (!standing.usable)
        throw new PolicyError('POLICY_REVOKED', standing.reason!);
      return { mandateRevoked: false };
    });
  }

  private callOf(leg: LegRecord): LegCall {
    return {
      legKey: leg.legKey,
      recipient: leg.payTo!,
      amount: leg.amount,
      ref: legRef(leg.legKey),
    };
  }

  private async freshLeg(splitId: string, legKey: string) {
    return (await this.deps.store.legs(splitId)).find(
      (l) => l.legKey === legKey,
    )!;
  }

  /**
   * Pays transfer legs in order. A confirmed leg is skipped; a leg with a
   * durable record is recovered, never re-signed; a leg that is no longer
   * AUTHORIZED or SUBMITTED is never paid and never overwritten. The first
   * failure stops the split: FAILED when nothing is unknown (safe to
   * resume), NEEDS_REVIEW when the chain outcome or the authority needs a
   * human.
   */
  private async execute(s: SplitRecord): Promise<SplitRecord> {
    const { store, executor } = this.deps;
    legs: for (const { legKey, kind } of await store.legs(s.splitId)) {
      if (kind !== 'TRANSFER') continue;
      let leg = await this.freshLeg(s.splitId, legKey);
      if (!['AUTHORIZED', 'SUBMITTED'].includes(leg.state)) continue;
      let result: LegPayResult | null = null;
      for (let attempt = 0; !result; attempt++) {
        const record = await executor.recorded(legKey);
        if (!record && leg.grant && this.deps.now() >= leg.grant.expiresAt) {
          const r = await this.reauthorize(s, leg);
          if (typeof r === 'string') return this.advance(s, 'NEEDS_REVIEW', r);
          leg = r;
        }
        try {
          result = await executor.pay({
            ...this.callOf(leg),
            grant: leg.grant!,
            claim: () => this.claim(s.splitId, legKey),
            onRecorded: async (hash) => {
              const cur = await this.freshLeg(s.splitId, legKey);
              if (cur.state === 'AUTHORIZED')
                await store.updateLeg(legKey, 'AUTHORIZED', {
                  state: 'SUBMITTED',
                  txHash: hash,
                  updatedAt: this.deps.now(),
                });
            },
          });
        } catch (e) {
          const code = (e as { code?: string }).code;
          this.trace('leg.error', {
            legKey,
            code,
            error: (e as Error).message,
          });
          if (
            e instanceof PolicyError ||
            (e instanceof AllocationError && e.code === 'LEG_NOT_PAYABLE')
          ) {
            if ((await this.freshLeg(s.splitId, legKey)).state === 'CANCELLED')
              continue legs;
            return this.advance(
              s,
              'NEEDS_REVIEW',
              `${legKey}: not signed: ${(e as Error).message}`,
            );
          }
          // A grant burned without a record (crash between admission and
          // recording): nothing was broadcast, so ask the Kernel again.
          if (
            attempt === 0 &&
            (code === 'GRANT_REPLAYED' || code === 'GRANT_EXPIRED') &&
            !(await executor.recorded(legKey))
          ) {
            const r = await this.reauthorize(s, leg);
            if (typeof r === 'string')
              return this.advance(s, 'NEEDS_REVIEW', r);
            leg = r;
            continue;
          }
          return this.advance(
            s,
            'FAILED',
            `${legKey}: ${(e as Error).message}`.slice(0, 500),
          );
        }
      }
      const cur = await this.freshLeg(s.splitId, legKey);
      this.trace('leg.paid', {
        legKey,
        state: result.state,
        hash: result.hash,
        signedNow: result.signedNow,
      });
      if (cur.state !== 'AUTHORIZED' && cur.state !== 'SUBMITTED')
        // Never overwrite a leg that moved on (e.g. CANCELLED) while paying.
        return this.advance(
          s,
          'NEEDS_REVIEW',
          `${legKey} is ${cur.state} but payment ${result.hash} is ${result.state}`,
        );
      if (result.state === 'CONFIRMED') {
        await store.updateLeg(legKey, cur.state, {
          state: 'CONFIRMED',
          txHash: result.hash,
          evidence: result.evidence,
          updatedAt: this.deps.now(),
        });
        continue;
      }
      await store.updateLeg(legKey, cur.state, {
        state: result.state === 'FAILED' ? 'FAILED' : 'NEEDS_REVIEW',
        txHash: result.hash,
        note: result.note,
        updatedAt: this.deps.now(),
      });
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `${legKey}: ${result.state} ${result.note ?? ''}`.trim(),
      );
    }
    return this.reconcileLegs(s);
  }

  /**
   * Each confirmed leg is checked against its evidence and booked: the AP
   * settlement (or distribution) on the treasury wallet, the operator's gas,
   * and the reservation consumed. Ledger entries are keyed by the chain log,
   * so this step is idempotent.
   */
  private async reconcileLegs(s: SplitRecord): Promise<SplitRecord> {
    const { store, ledger, books, executor } = this.deps;
    const p = this.policy;
    const at = this.deps.now();
    const vendors = await books.vendors();
    const history = await books.payableHistory();
    for (const leg of await store.legs(s.splitId)) {
      if (leg.kind !== 'TRANSFER' || leg.state !== 'CONFIRMED') continue;
      const ev = leg.evidence!;
      const problems = [
        getAddress(ev.from) !== p.treasury && 'payer is not the treasury',
        getAddress(ev.to) !== getAddress(leg.payTo!) && 'recipient differs',
        ev.amount !== leg.amount && 'amount differs',
        ev.logIndex < 0 && 'no transfer log',
        executor.onChainReference
          ? ev.ref !== legRef(leg.legKey) && 'on-chain reference differs'
          : ev.ref !== null && 'unexpected on-chain reference',
      ].filter(Boolean);
      if (problems.length) {
        await store.updateLeg(leg.legKey, 'CONFIRMED', {
          state: 'NEEDS_REVIEW',
          note: problems.join(', '),
          updatedAt: at,
        });
        return this.advance(
          s,
          'NEEDS_REVIEW',
          `${leg.legKey}: ${problems.join(', ')}`,
        );
      }
      const entries: JournalEntry[] = [];
      if (leg.purpose === 'CONTRACTOR_PAYABLE') {
        const invoice = history.find(
          (i) => i.vendorInvoiceId === leg.documentRef,
        );
        const vendor = vendors.find((v) => v.vendorId === leg.beneficiaryId);
        if (!invoice || !vendor)
          return this.advance(
            s,
            'NEEDS_REVIEW',
            `${leg.legKey}: payable record missing`,
          );
        entries.push(
          ...apEntries({
            workspaceId: s.workspaceId,
            vendor,
            invoice,
            assetId: this.deps.assetId,
            settlement: {
              txHash: ev.txHash,
              logIndex: ev.logIndex,
              recipient: ev.to,
              feeBaseUnits: 0n,
              payer: p.treasury,
            },
            at,
          }).map((e) => withLegRef(e, leg)),
        );
      } else
        entries.push({
          entryId: `je_split_${ev.txHash.slice(2, 18)}_${ev.logIndex}`,
          workspaceId: s.workspaceId,
          occurredAt: at,
          memo: `Distribution ${leg.documentRef} from receipt ${s.receiptId}`,
          source: { kind: 'CHAIN_TX', ref: leg.legKey },
          evidence: {
            chainId: p.chainId,
            txHash: ev.txHash,
            logIndex: ev.logIndex,
            recipient: ev.to,
          },
          idempotencyKey: `chain:${p.chainId}:${ev.txHash.toLowerCase()}:${ev.logIndex}`,
          postings: [
            {
              account: 'OWNER_EQUITY',
              assetId: this.deps.assetId,
              amount: leg.amount,
              counterpartyId: `beneficiary:${leg.beneficiaryId}`,
              documentRef: leg.legKey,
            },
            {
              account: 'CASH_ARC_USDC',
              assetId: this.deps.assetId,
              amount: -leg.amount,
              counterpartyId: walletTag(p.treasury),
              documentRef: leg.legKey,
            },
          ],
          reversalOf: null,
        });
      const gas = arcGasEntry({
        workspaceId: s.workspaceId,
        chain: this.deps.chain,
        txHash: ev.txHash,
        payer: ev.gasPayer,
        feeWei: ev.feeWei,
        at,
        memo: `Gas for split leg ${leg.legKey}`,
      });
      if (gas) entries.push(gas);
      for (const e of entries) await ledger.post(e);
      await store.setReservation(leg.legKey, 'CONSUMED', at);
      await store.updateLeg(leg.legKey, 'CONFIRMED', {
        state: 'RECONCILED',
        updatedAt: at,
      });
    }
    return this.advance(
      s,
      'EACH_LEG_RECONCILED',
      'transfer legs booked against their chain receipts',
    );
  }
}

/** Links an AP entry to the split leg (and so to the receipt) in its document refs. */
function withLegRef(e: JournalEntry, leg: LegRecord): JournalEntry {
  return {
    ...e,
    memo: `${e.memo} (split leg ${leg.legKey})`,
    postings: e.postings.map((p) =>
      p.account === 'CASH_ARC_USDC' ? { ...p, documentRef: leg.legKey } : p,
    ),
  };
}

export const legsHoldingGrants = (legs: readonly LegRecord[]) =>
  legs.filter(holdsOrSpent);

/** The policy's Kernel mandate (owner signs it together with the policy). */
export { mandateFromPolicy };
