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
  type ExecutionGrant,
  type PaymentIntent,
} from '@synq/kernel/arc';
import {
  CashReservations,
  LedgerError,
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
  verifySignedPolicy,
  type SignedRevenuePolicy,
} from './policy.js';
import {
  GRANTED_STATES,
  TERMINAL,
  isCancellable,
  type LegEvidence,
  type LegRecord,
  type LegState,
  type SplitRecord,
  type SplitStore,
} from './split.js';
import {
  AllocationError,
  computeWaterfall,
  type AllocationPlan,
  type CashPosition,
  type FinalReceipt,
  type Receivable,
  type RecurringBill,
} from './waterfall.js';

/**
 * Durable runner for the split workflow.
 *
 * Every step reads its inputs fresh, writes its result with a
 * compare-and-set transition, and is safe to run again after a crash at any
 * point. Transfer legs go through the authority chain one at a time: the
 * owner-signed policy is the mandate, the Kernel issues a grant bound to the
 * exact call for each leg, and the executor pays it at most once per leg key
 * (`<receiptId>#<legIndex>`), recording signed bytes before broadcast and
 * recovering from that record on restart instead of signing again. A leg
 * already paid is never paid again; a leg whose outcome is unknown stops the
 * split for review rather than being retried.
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
  /** Read-only simulation of the exact payment from the treasury. */
  simulate(
    call: LegCall,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** The durable signed-transaction record for a leg key, if one exists. */
  recorded(legKey: string): Promise<{ hash: Hex; state: string } | null>;
  /**
   * Pays exactly once per leg key. With a durable record it recovers (reads
   * the receipt or rebroadcasts the same bytes) and never signs; the grant
   * is admitted only before signing a new transaction. `onRecorded` runs
   * after the signed bytes are durable and before broadcast.
   */
  pay(
    call: LegCall & {
      grant: ExecutionGrant;
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
  /** Finalized treasury balance and restricted buckets; reservations come from the split store. */
  position(): Promise<Omit<CashPosition, 'reservations'>>;
  vendors(): Promise<Vendor[]>;
  /** Open vendor invoices (not paid, not held by another split). */
  payables(): Promise<VendorInvoice[]>;
  payableHistory(): Promise<VendorInvoice[]>;
  obligations(): Promise<Obligation[]>;
  bills(): Promise<RecurringBill[]>;
  receivables(): Promise<Receivable[]>;
}

export const legRef = (legKey: string): Hex => keccak256(stringToHex(legKey));

export type RunnerDeps = Readonly<{
  store: SplitStore;
  ledger: Ledger;
  executor: LegExecutor;
  receipts: ReceiptVerifier;
  books: TreasuryBooks;
  signedPolicy: SignedRevenuePolicy;
  kernel: AuthorityConfig;
  /** Registry asset id of the policy token (ledger asset). */
  assetId: string;
  chain: 'arc-testnet' | 'arc-mainnet';
  now: () => number;
  /** Optional trace of every step (for evidence). */
  trace?: (event: string, detail: Record<string, unknown>) => void;
}>;

export class SplitRunner {
  constructor(readonly deps: RunnerDeps) {}

  private get policy() {
    return this.deps.signedPolicy.policy;
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

  /** Cancels before execution: releases every reservation; nothing was signed. */
  async cancel(splitId: string, reason: string): Promise<SplitRecord> {
    const s = await this.must(splitId);
    if (!isCancellable(s.state))
      throw new AllocationError(
        'WRONG_STATE',
        `${s.state}: cancellation is only allowed before execution`,
      );
    const at = this.deps.now();
    for (const leg of await this.deps.store.legs(splitId)) {
      if (leg.kind !== 'FREE_CASH')
        await this.deps.store
          .setReservation(leg.legKey, 'RELEASED', at)
          .catch(() => undefined);
      await this.deps.store.updateLeg(leg.legKey, leg.state, {
        state: 'CANCELLED',
        note: reason,
        updatedAt: at,
      });
    }
    return this.deps.store.advance(
      splitId,
      { state: s.state, rev: s.rev },
      { state: 'CANCELLED', note: reason },
      at,
    );
  }

  /** Advances the split as far as it can go. Idempotent and crash-safe. */
  async run(
    splitId: string,
    opts: { stopAt?: SplitRecord['state'] } = {},
  ): Promise<SplitRecord> {
    for (let guard = 0; guard < 20; guard++) {
      const s = await this.must(splitId);
      if (TERMINAL.includes(s.state) || s.state === opts.stopAt) return s;
      const next = await this.step(s);
      if (next.state === s.state && next.rev === s.rev) return next;
      if (next.state === 'FAILED' && s.state === 'EXECUTING') return next;
    }
    throw new AllocationError('WRONG_STATE', `${splitId} did not settle`);
  }

  private async must(splitId: string) {
    const s = await this.deps.store.get(splitId);
    if (!s) throw new AllocationError('NOT_FOUND', splitId);
    return s;
  }

  private advance(
    s: SplitRecord,
    state: SplitRecord['state'],
    note: string | null,
    plan?: AllocationPlan,
  ) {
    this.trace('split.advance', {
      splitId: s.splitId,
      from: s.state,
      to: state,
      note,
    });
    return this.deps.store.advance(
      s.splitId,
      { state: s.state, rev: s.rev },
      { state, note, ...(plan ? { plan } : {}) },
      this.deps.now(),
    );
  }

  private async step(s: SplitRecord): Promise<SplitRecord> {
    switch (s.state) {
      case 'RECEIPT_FINAL':
        return this.reconcileLiabilities(s);
      case 'LIABILITIES_RECONCILED':
        return this.createReservations(s);
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
        const waiting = (await this.deps.store.legs(s.splitId)).filter(
          (l) => l.state === 'AWAITING_APPROVAL',
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

  /** The receipt is in the books, the position is fresh, and the plan is computed. */
  private async reconcileLiabilities(s: SplitRecord): Promise<SplitRecord> {
    const { books, store, ledger } = this.deps;
    const r = s.receipt;
    const entries = await ledger.store.entries(s.workspaceId);
    const booked = entries.find((e) => e.idempotencyKey === r.receiptId);
    const cash = booked?.postings.find(
      (p) =>
        p.account === 'CASH_ARC_USDC' &&
        p.assetId === this.deps.assetId &&
        p.counterpartyId === walletTag(r.recipient),
    );
    if (!booked || cash?.amount !== r.amount)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `receipt ${r.receiptId} is not booked to the treasury in the ledger`,
      );
    const held = (await store.reservations(s.workspaceId)).filter(
      (x) => x.status === 'ACTIVE' && x.splitId !== s.splitId,
    );
    const pos = await books.position();
    const position: CashPosition = {
      ...pos,
      reservations: held.reduce((a, x) => a + x.amount, 0n),
    };
    // Payables another split already holds, granted or paid are not planned again.
    const otherLegs = (
      await Promise.all(
        [...new Set(held.map((h) => h.splitId))].map((id) => store.legs(id)),
      )
    ).flat();
    const taken = new Set(
      [...(await store.grantedLegs(this.policy.policyId)), ...otherLegs]
        .filter((l) => l.splitId !== s.splitId && l.state !== 'CANCELLED')
        .map((l) => l.obligationRef),
    );
    const payables = (await books.payables()).filter(
      (i) => !taken.has(`payable:${i.vendorInvoiceId}`),
    );
    const plan = computeWaterfall({
      policy: this.policy,
      policyHash: policyHash(this.policy),
      receipt: r,
      position,
      asOf: this.deps.now(),
      vendors: await books.vendors(),
      payables,
      payableHistory: await books.payableHistory(),
      obligations: await books.obligations(),
      bills: await books.bills(),
      receivables: await books.receivables(),
    });
    return this.advance(
      s,
      'LIABILITIES_RECONCILED',
      `plan ${plan.planHash.slice(0, 10)}: ${plan.legs.length} legs, free cash ${plan.remainder}`,
      plan,
    );
  }

  /** Each reserve and transfer leg holds its cash; admission against confirmed cash. */
  private async createReservations(s: SplitRecord): Promise<SplitRecord> {
    const { store } = this.deps;
    const plan = s.plan!;
    const at = this.deps.now();
    await store.putLegs(
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
    const others = (await store.reservations(s.workspaceId)).filter(
      (x) => x.status === 'ACTIVE' && x.splitId !== s.splitId,
    );
    const holds = new CashReservations();
    const view = {
      confirmedCash:
        plan.position.onChainFinalized - plan.position.committedOutgoing,
      escrow: plan.position.escrowLiabilities + plan.position.refundLiabilities,
      minimumReserve: 0n,
    };
    try {
      for (const o of others) holds.reserve(o.reservationId, o.amount, view);
      for (const l of plan.legs)
        if (l.kind !== 'FREE_CASH') holds.reserve(l.legKey, l.amount, view);
    } catch (e) {
      if (e instanceof LedgerError)
        return this.advance(
          s,
          'NEEDS_REVIEW',
          `reservation refused: ${e.message}`,
        );
      throw e;
    }
    for (const leg of await store.legs(s.splitId)) {
      if (leg.kind === 'FREE_CASH') {
        if (leg.state === 'PLANNED')
          await store.updateLeg(leg.legKey, 'PLANNED', {
            state: 'FREE',
            updatedAt: at,
          });
        continue;
      }
      await store.reserve({
        reservationId: leg.legKey,
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
        await store.updateLeg(leg.legKey, 'PLANNED', {
          state: 'RESERVED',
          updatedAt: at,
        });
    }
    return this.advance(
      s,
      'RESERVATIONS_CREATED',
      `${plan.legs.filter((l) => l.kind !== 'FREE_CASH').length} reservations held`,
    );
  }

  /**
   * The policy and its mandate are signed by the owner and active, the plan
   * was computed under this exact policy, every payee is still an allowed
   * and verified beneficiary, and the frequency and window limits hold.
   */
  private async validatePolicy(s: SplitRecord): Promise<SplitRecord> {
    const { store, books } = this.deps;
    const p = this.policy;
    const now = this.deps.now();
    let hashes: { policyHash: Hex };
    try {
      hashes = await verifySignedPolicy(this.deps.signedPolicy, now);
    } catch (e) {
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `policy rejected: ${(e as PolicyError).code ?? 'ERROR'} ${(e as Error).message}`,
      );
    }
    if (hashes.policyHash !== s.plan!.policyHash)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        'plan was computed under another policy',
      );
    const since = now - p.limits.windowSeconds;
    const recent = (await store.splitsSince(p.policyId, since)).filter(
      (x) => x.splitId !== s.splitId && x.state !== 'CANCELLED',
    );
    if (recent.length + 1 > p.limits.maxSplitsPerWindow)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `frequency limit: ${recent.length} split(s) already in this ${p.limits.windowSeconds}s window (max ${p.limits.maxSplitsPerWindow})`,
      );
    const vendors = await books.vendors();
    const problems: string[] = [];
    let windowSpend = (await store.transfersSince(p.policyId, since))
      .filter((l) => l.splitId !== s.splitId)
      .reduce((a, l) => a + l.amount, 0n);
    for (const leg of await store.legs(s.splitId)) {
      if (leg.kind !== 'TRANSFER' || leg.state !== 'RESERVED') continue;
      const listed = p.allowedBeneficiaries.find(
        (b) => b.beneficiaryId === leg.beneficiaryId,
      );
      const vendor = vendors.find((v) => v.vendorId === leg.beneficiaryId);
      const verified = vendor ? verifiedAddress(vendor, p.chainId) : null;
      if (
        !listed ||
        !leg.payTo ||
        listed.address !== getAddress(leg.payTo) ||
        !verified ||
        getAddress(verified) !== listed.address
      ) {
        problems.push(
          `${leg.legKey}: beneficiary ${leg.beneficiaryId} is not an allowed, verified payee (${verified ?? 'unverified'})`,
        );
        continue;
      }
      const overLeg = leg.amount > p.limits.maxAutonomousPerLeg;
      const overWindow =
        windowSpend + leg.amount > p.limits.maxAutonomousPerWindow;
      if (overLeg || overWindow) {
        await store.updateLeg(leg.legKey, 'RESERVED', {
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
    if (problems.length)
      return this.advance(s, 'NEEDS_REVIEW', problems.join('; '));
    return this.advance(
      s,
      'POLICY_VALIDATED',
      `policy ${p.policyId} v${p.version} signed by ${p.owner}`,
    );
  }

  /** One Kernel decision per autonomous transfer leg; each ALLOW is an exact-call grant. */
  private async authorize(s: SplitRecord): Promise<SplitRecord> {
    const denied: string[] = [];
    for (const leg of await this.deps.store.legs(s.splitId)) {
      if (leg.kind !== 'TRANSFER' || leg.state !== 'RESERVED') continue;
      const d = await this.decideLeg(leg);
      if (d.outcome === 'ALLOW')
        await this.deps.store.updateLeg(leg.legKey, 'RESERVED', {
          state: 'AUTHORIZED',
          grant: d.grant,
          authorizedAt: this.deps.now(),
          reasons: d.reasons,
          updatedAt: this.deps.now(),
        });
      else {
        denied.push(`${leg.legKey}: ${d.reasons.join('; ')}`);
        await this.deps.store.updateLeg(leg.legKey, 'RESERVED', {
          state: d.outcome === 'DENY' ? 'FAILED' : 'AWAITING_APPROVAL',
          reasons: d.reasons,
          updatedAt: this.deps.now(),
        });
      }
    }
    if (denied.length)
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `Kernel refused: ${denied.join(' | ')}`,
      );
    return this.advance(
      s,
      'SPLIT_AUTHORIZED',
      'every autonomous leg holds an exact-call grant',
    );
  }

  private async decideLeg(leg: LegRecord) {
    const p = this.policy;
    const { signedPolicy, store } = this.deps;
    const now = this.deps.now();
    const since = now - p.limits.windowSeconds;
    const spends = (await store.transfersSince(p.policyId, since))
      .filter((l) => l.legKey !== leg.legKey)
      .map((l) => ({ amount: l.amount, at: l.authorizedAt ?? now }));
    const settled = (await store.grantedLegs(p.policyId))
      .filter((l) => l.legKey !== leg.legKey && l.obligationRef)
      .map((l) => l.obligationRef!);
    const sim = await this.deps.executor.simulate(this.callOf(leg));
    const intent: PaymentIntent = {
      intentId: `int_${leg.legKey}`,
      mandateId: signedPolicy.mandate.mandateId,
      mandateVersion: signedPolicy.mandate.version,
      chainId: p.chainId,
      token: p.token,
      payer: p.treasury,
      recipient: leg.payTo!,
      amount: leg.amount,
      purpose:
        leg.purpose === 'CONTRACTOR_PAYABLE'
          ? 'CONTRACTOR_PAYOUT'
          : 'VENDOR_INVOICE',
      obligationRef: leg.obligationRef ?? leg.legKey,
      evidenceHash: legRef(`${leg.legKey}|${leg.splitId}`),
      proposedBy: `allocations:${p.policyId}`,
    };
    const d = await decide({
      config: this.deps.kernel,
      mandate: signedPolicy.mandate,
      mandateSignature: signedPolicy.mandateSignature,
      state: {
        revoked: false,
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

  private callOf(leg: LegRecord): LegCall {
    return {
      legKey: leg.legKey,
      recipient: leg.payTo!,
      amount: leg.amount,
      ref: legRef(leg.legKey),
    };
  }

  /**
   * Pays transfer legs in order. A confirmed leg is skipped; a leg with a
   * durable record is recovered, never re-signed. The first failure stops
   * the split: FAILED when nothing is unknown (safe to resume), NEEDS_REVIEW
   * when the chain outcome needs a human.
   */
  private async execute(s: SplitRecord): Promise<SplitRecord> {
    const { store, executor } = this.deps;
    for (const leg0 of await store.legs(s.splitId)) {
      let leg = leg0;
      if (leg.kind !== 'TRANSFER') continue;
      if (!['AUTHORIZED', 'SUBMITTED'].includes(leg.state)) continue;
      const record = await executor.recorded(leg.legKey);
      if (!record && leg.grant && this.deps.now() >= leg.grant.expiresAt) {
        // Nothing was signed under the old grant: ask the Kernel again.
        const d = await this.decideLeg(leg);
        if (d.outcome !== 'ALLOW') {
          await store.updateLeg(leg.legKey, leg.state, {
            state: 'FAILED',
            reasons: d.reasons,
            updatedAt: this.deps.now(),
          });
          return this.advance(
            s,
            'NEEDS_REVIEW',
            `re-authorization refused for ${leg.legKey}`,
          );
        }
        leg = await store.updateLeg(leg.legKey, leg.state, {
          state: leg.state,
          grant: d.grant,
          reasons: d.reasons,
          updatedAt: this.deps.now(),
        });
      }
      let result: LegPayResult;
      try {
        result = await executor.pay({
          ...this.callOf(leg),
          grant: leg.grant!,
          onRecorded: async (hash) => {
            const cur = (await store.legs(s.splitId)).find(
              (l) => l.legKey === leg.legKey,
            )!;
            if (cur.state === 'AUTHORIZED')
              await store.updateLeg(leg.legKey, 'AUTHORIZED', {
                state: 'SUBMITTED',
                txHash: hash,
                updatedAt: this.deps.now(),
              });
          },
        });
      } catch (e) {
        this.trace('leg.error', {
          legKey: leg.legKey,
          error: (e as Error).message,
        });
        return this.advance(
          s,
          'FAILED',
          `${leg.legKey}: ${(e as Error).message}`.slice(0, 500),
        );
      }
      const cur = (await store.legs(s.splitId)).find(
        (l) => l.legKey === leg.legKey,
      )!;
      this.trace('leg.paid', {
        legKey: leg.legKey,
        state: result.state,
        hash: result.hash,
        signedNow: result.signedNow,
      });
      if (result.state === 'CONFIRMED') {
        await store.updateLeg(leg.legKey, cur.state, {
          state: 'CONFIRMED',
          txHash: result.hash,
          evidence: result.evidence,
          updatedAt: this.deps.now(),
        });
        continue;
      }
      await store.updateLeg(leg.legKey, cur.state, {
        state: result.state === 'FAILED' ? 'FAILED' : 'NEEDS_REVIEW',
        txHash: result.hash,
        note: result.note,
        updatedAt: this.deps.now(),
      });
      return this.advance(
        s,
        'NEEDS_REVIEW',
        `${leg.legKey}: ${result.state} ${result.note ?? ''}`.trim(),
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
    const { store, ledger, books } = this.deps;
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
        ev.ref !== legRef(leg.legKey) && 'on-chain reference differs',
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
  legs.filter((l) => GRANTED_STATES.includes(l.state));

/** The policy's Kernel mandate (owner signs it together with the policy). */
export { mandateFromPolicy };
