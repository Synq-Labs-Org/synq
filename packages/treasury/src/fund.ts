import {
  encodeAbiParameters,
  getAddress,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { sameAsset, type AssetRef } from '@synq/domain';
import {
  canonicalJson,
  launchTermsHash,
  policyHash,
  tally,
  verifyAssent,
  verifySnapshot,
  type AcceptedVote,
  type BallotSnapshot,
  type ContributorAssent,
  type DelegationRecord,
  type EligibleMember,
  type GovernancePolicy,
  type LaunchTerms,
  type TallyResult,
  type VerifiedAssent,
} from '@synq/governance';

/**
 * Group money (gifts, trip and birthday funds, shared purchases, team
 * expenses, contributor pools and recurring contributions).
 *
 * The pool is custody, not consent. A contribution is credited only from a
 * final on-chain transfer that carries the contributor's reference; a pledge
 * or an unconfirmed transfer is never spendable. Contributors are bound to a
 * spend rule only by their own EIP-712 assent to the charter's terms, and a
 * spend needs a signed ballot of the contributors whose money it uses that
 * meets the policy's quorum and approval. A chat poll is recorded as
 * indicative and authorizes nothing; an organizer or admin cannot spend.
 */
export const FUND_KINDS = [
  'GROUP_GIFT',
  'TRIP_FUND',
  'BIRTHDAY_FUND',
  'SHARED_PURCHASE',
  'TEAM_EXPENSE',
  'CONTRIBUTOR_POOL',
  'RECURRING_CONTRIBUTION',
] as const;
export type FundKind = (typeof FUND_KINDS)[number];

/** What every contributor gets, committed into the terms they assent to. */
export type ContributionRights = Readonly<{
  /** Unspent claim can be withdrawn until the terms' refundableUntil. */
  withdrawal: 'UNSPENT_CLAIM_WHILE_REFUNDABLE' | 'LOCKED_UNTIL_CANCEL';
  /** On cancellation every contributor gets their own remaining claim back. */
  cancellation: 'REMAINING_CLAIM';
  /** Spending needs a signed ballot of the contributors whose funds are used. */
  spendApproval: 'SIGNED_BALLOT_OF_BOUND_CONTRIBUTORS';
}>;

export type FundMember = Readonly<{ memberId: string; wallet: Address }>;

export type RecurringSchedule = Readonly<{
  amount: bigint;
  periodSeconds: number;
  startsAt: number;
}>;

export type FundCharter = Readonly<{
  fundId: string;
  groupId: string;
  kind: FundKind;
  purpose: string;
  organizer: string;
  asset: AssetRef;
  /** The custody account contributions are sent to; it holds no one's consent. */
  pool: Address;
  members: readonly FundMember[];
  terms: LaunchTerms;
  /** Formal vote-based spend policy; its termsHash is the launch terms hash. */
  policy: GovernancePolicy;
  rights: ContributionRights;
  minConfirmations: number;
  recurring: RecurringSchedule | null;
}>;

export type TreasuryErrorCode =
  | 'BAD_CHARTER'
  | 'NOT_A_MEMBER'
  | 'FUND_NOT_OPEN'
  | 'WRONG_ASSET'
  | 'WRONG_POOL'
  | 'UNKNOWN_DEPOSIT'
  | 'NOT_FINAL'
  | 'ALREADY_FINAL'
  | 'BAD_AMOUNT'
  | 'UNKNOWN_SPEND'
  | 'SPEND_STATE'
  | 'BALLOT_MISMATCH'
  | 'RESNAPSHOT_REQUIRED'
  | 'VOTE_OPEN'
  | 'QUORUM_NOT_MET'
  | 'NOT_APPROVED'
  | 'BOUND_FUNDS_SHORT'
  | 'EXECUTION_MISMATCH'
  | 'REFUND_NOT_ALLOWED'
  | 'UNKNOWN_REFUND'
  | 'REFUND_STATE'
  | 'BAD_TERMS'
  | 'DUPLICATE_CLAIM'
  | 'CONFLICT'
  | 'TRIP_INVALID'
  | 'DUPLICATE_BOOKING';

export class TreasuryError extends Error {
  constructor(
    readonly code: TreasuryErrorCode,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'TreasuryError';
  }
}
const fail = (code: TreasuryErrorCode, detail?: string): never => {
  throw new TreasuryError(code, detail);
};
const lower = (a: string) => a.toLowerCase();

/** Hash of everything a contributor is bound to besides the amount; it is the terms' allocationHash. */
export function charterAllocationHash(
  c: Omit<FundCharter, 'terms' | 'policy'> & {
    policy: Omit<GovernancePolicy, 'termsHash'>;
  },
): Hex {
  return keccak256(
    toHex(
      canonicalJson({
        kind: 'SynqFundCharter/1',
        fundId: c.fundId,
        groupId: c.groupId,
        fundKind: c.kind,
        purpose: c.purpose,
        organizer: c.organizer,
        asset: c.asset.assetId,
        chainId: c.asset.chainId,
        token: lower(c.asset.address),
        pool: lower(c.pool),
        members: c.members.map((m) => [m.memberId, lower(m.wallet)]),
        rights: c.rights,
        minConfirmations: c.minConfirmations,
        recurring: c.recurring,
        policy: {
          policyId: c.policy.policyId,
          version: c.policy.version,
          quorumBps: c.policy.quorumBps,
          approvalBps: c.policy.approvalBps,
          minYesOfEligibleBps: c.policy.minYesOfEligibleBps,
        },
      }),
    ),
  );
}

/** The Memo reference a contributor's transfer must carry to be credited to them. */
export function contributionRef(fundId: string, memberId: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }, { type: 'string' }],
      ['SynqFundContribution/1', fundId, memberId],
    ),
  );
}

export type SpendRequest = Readonly<{
  spendId: string;
  payee: Address;
  amount: bigint;
  purpose: string;
}>;

/** What a spend ballot decides: exactly this payee, amount and purpose under these terms. */
export function spendProposalHash(
  fundId: string,
  s: SpendRequest,
  termsHash: Hex,
): Hex {
  return keccak256(
    toHex(
      canonicalJson({
        kind: 'SynqFundSpend/1',
        fundId,
        spendId: s.spendId,
        payee: lower(s.payee),
        amount: s.amount,
        purpose: s.purpose,
        termsHash,
      }),
    ),
  );
}

export const cancelProposalHash = (fundId: string, termsHash: Hex): Hex =>
  keccak256(
    toHex(canonicalJson({ kind: 'SynqFundCancel/1', fundId, termsHash })),
  );

/** One ERC-20 transfer read from a receipt (registry token logs only). */
export type ObservedTransfer = Readonly<{
  chainId: number;
  token: Address;
  txHash: Hex;
  logIndex: number;
  from: Address;
  to: Address;
  amount: bigint;
  /** Memo id paired with this transfer, if any. */
  paymentRef: Hex | null;
  blockNumber: bigint;
}>;

export const transferKey = (
  t: Pick<ObservedTransfer, 'chainId' | 'txHash' | 'logIndex'>,
) => `chain:${t.chainId}:${lower(t.txHash)}:${t.logIndex}`;

export type SpendAuthorization = Readonly<{
  snapshotId: Hex;
  resultHash: Hex;
  eligible: number;
  yes: number;
  no: number;
  abstain: number;
  notVoted: number;
  participationBps: number;
  yesOfEligibleBps: number;
  /** Only wallets whose signed YES counted; silence is never recorded as approval. */
  approvedBy: readonly Address[];
  final: boolean;
  summary: string;
}>;

export type FundEvent =
  | { type: 'OPENED'; charter: FundCharter; at: number }
  | {
      type: 'PLEDGED';
      pledgeId: string;
      memberId: string;
      amount: bigint;
      at: number;
    }
  | {
      type: 'DEPOSIT_SEEN';
      key: string;
      transfer: ObservedTransfer;
      memberId: string | null;
      reason: string | null;
      at: number;
    }
  | { type: 'DEPOSIT_FINAL'; key: string; confirmations: number; at: number }
  | { type: 'DEPOSIT_REORGED'; key: string; at: number }
  | {
      type: 'ASSENTED';
      memberId: string;
      assent: VerifiedAssent;
      at: number;
    }
  | { type: 'TERMS_AMENDED'; terms: LaunchTerms; at: number }
  | {
      type: 'SPEND_PROPOSED';
      spend: SpendRequest;
      termsHash: Hex;
      proposalHash: Hex;
      at: number;
    }
  | {
      type: 'SPEND_AUTHORIZED';
      spendId: string;
      allocation: Readonly<Record<string, bigint>>;
      authorization: SpendAuthorization;
      at: number;
    }
  | { type: 'SPEND_EXECUTION_STARTED'; spendId: string; at: number }
  | { type: 'REFUND_EXECUTION_STARTED'; refundId: string; at: number }
  | {
      type: 'SPEND_EXECUTED';
      spendId: string;
      key: string;
      transfer: ObservedTransfer;
      at: number;
    }
  | {
      type: 'REFUND_AUTHORIZED';
      refundId: string;
      memberId: string;
      amount: bigint;
      reason: string;
      at: number;
    }
  | {
      type: 'REFUND_EXECUTED';
      refundId: string;
      key: string;
      transfer: ObservedTransfer;
      at: number;
    }
  | {
      type: 'CANCELLED';
      reason: string;
      authorization: SpendAuthorization;
      released: readonly string[];
      at: number;
    }
  | {
      type: 'SOCIAL_POLL';
      pollId: string;
      question: string;
      yes: number;
      no: number;
      at: number;
    }
  | {
      type: 'TRIP_REGISTERED';
      tripId: string;
      spendId: string;
      travelers: readonly { memberId: string; travelerRef: string }[];
      at: number;
    }
  | {
      type: 'TRIP_BOOKED';
      tripId: string;
      providerId: string;
      providerRef: string;
      at: number;
    };

export type MemberPosition = {
  memberId: string;
  wallet: Address;
  pledged: bigint;
  /** Seen on chain, not yet final: never spendable or refundable. */
  pending: bigint;
  contributed: bigint;
  spent: bigint;
  refunded: bigint;
  /** Committed to an authorized spend or refund not yet executed. */
  reserved: bigint;
  assented: Hex[];
};
export const claimOf = (m: MemberPosition) =>
  m.contributed - m.spent - m.refunded - m.reserved;

export type DepositRecord = {
  key: string;
  transfer: ObservedTransfer;
  memberId: string | null;
  reason: string | null;
  status: 'PENDING' | 'FINAL' | 'REORGED';
};
export type SpendRecord = {
  spend: SpendRequest;
  termsHash: Hex;
  proposalHash: Hex;
  status: 'PROPOSED' | 'AUTHORIZED' | 'EXECUTING' | 'EXECUTED' | 'RELEASED';
  allocation: Record<string, bigint>;
  authorization: SpendAuthorization | null;
  execution: ObservedTransfer | null;
};
export type RefundRecord = {
  refundId: string;
  memberId: string;
  amount: bigint;
  reason: string;
  status: 'AUTHORIZED' | 'EXECUTING' | 'EXECUTED';
  execution: ObservedTransfer | null;
};
export type TripRecord = {
  tripId: string;
  spendId: string;
  travelers: { memberId: string; travelerRef: string }[];
  booking: { providerId: string; providerRef: string } | null;
};

export type FundView = Readonly<{
  fundId: string;
  status: 'OPEN' | 'CANCELLED';
  termsVersion: number;
  pledged: bigint;
  pending: bigint;
  /** Unreserved claims of contributors bound to the current terms. */
  free: bigint;
  /** Unreserved claims of contributors who have not assented: refundable under their original terms. */
  refundableUnbound: bigint;
  /** Authorized, not yet executed spends. */
  committed: bigint;
  /** Authorized, not yet executed refunds. */
  refundInFlight: bigint;
  spent: bigint;
  refunded: bigint;
  /** What the pool must hold for contributors (final contributions less spends and refunds). */
  custody: bigint;
  /** Transfers into the pool that credit nobody (no or wrong reference). */
  unapplied: bigint;
}>;

/** Pro-rata split of `amount` over claims with deterministic largest-remainder rounding. */
export function proRata(
  claims: readonly { memberId: string; claim: bigint }[],
  amount: bigint,
): Record<string, bigint> {
  const total = claims.reduce((s, c) => s + c.claim, 0n);
  if (amount <= 0n || amount > total)
    fail('BOUND_FUNDS_SHORT', `${amount} of ${total} bound`);
  const sorted = [...claims]
    .filter((c) => c.claim > 0n)
    .sort((a, b) => (a.memberId < b.memberId ? -1 : 1));
  const out: Record<string, bigint> = {};
  let given = 0n;
  const rema: { id: string; r: bigint; cap: bigint }[] = [];
  for (const c of sorted) {
    const share = (amount * c.claim) / total;
    out[c.memberId] = share;
    given += share;
    rema.push({ id: c.memberId, r: (amount * c.claim) % total, cap: c.claim });
  }
  rema.sort((a, b) =>
    a.r === b.r ? (a.id < b.id ? -1 : 1) : a.r > b.r ? -1 : 1,
  );
  for (let left = amount - given, i = 0; left > 0n; i = (i + 1) % rema.length) {
    const x = rema[i]!;
    if (out[x.id]! < x.cap) {
      out[x.id] = out[x.id]! + 1n;
      left--;
    }
  }
  return out;
}

/**
 * Builds a charter whose terms commit to it: allocationHash covers the
 * charter and the policy governs exactly those terms.
 */
export function draftCharter(input: {
  base: Omit<FundCharter, 'terms' | 'policy'>;
  policy: Omit<GovernancePolicy, 'termsHash'>;
  terms: Omit<LaunchTerms, 'campaignId' | 'allocationHash' | 'asset'>;
}): FundCharter {
  const terms: LaunchTerms = {
    ...input.terms,
    campaignId: input.base.fundId,
    asset: input.base.asset,
    allocationHash: charterAllocationHash({
      ...input.base,
      policy: input.policy,
    }),
  };
  const charter: FundCharter = {
    ...input.base,
    terms,
    policy: { ...input.policy, termsHash: launchTermsHash(terms) },
  };
  validateCharter(charter);
  return charter;
}

export function validateCharter(c: FundCharter): void {
  const bad = (why: string) => fail('BAD_CHARTER', why);
  if (!c.fundId || !c.groupId || !c.purpose) bad('ids and purpose required');
  if (!FUND_KINDS.includes(c.kind)) bad('kind');
  if (!sameAsset(c.asset, c.terms.asset)) bad('terms name another asset');
  if (c.policy.chainId !== c.asset.chainId) bad('policy chain differs');
  if (c.terms.campaignId !== c.fundId) bad('terms campaign must be the fund');
  if (c.policy.termsHash !== launchTermsHash(c.terms))
    bad('policy does not govern these terms');
  if (c.terms.allocationHash !== charterAllocationHash(c))
    bad('terms allocation hash does not commit to this charter');
  policyHash(c.policy);
  if (!Number.isInteger(c.minConfirmations) || c.minConfirmations < 1)
    bad('at least one confirmation');
  const ids = new Set(c.members.map((m) => m.memberId));
  const wallets = new Set(c.members.map((m) => lower(m.wallet)));
  if (
    !c.members.length ||
    ids.size !== c.members.length ||
    wallets.size !== c.members.length
  )
    bad('members must be distinct ids and wallets');
  if (!ids.has(c.organizer)) bad('organizer must be a member');
  if (wallets.has(lower(c.pool))) bad('the pool cannot be a member wallet');
  if (
    c.recurring &&
    (c.recurring.amount <= 0n || c.recurring.periodSeconds < 3_600)
  )
    bad('recurring schedule');
}

const deepCopy = <T>(v: T): T => structuredClone(v);

/**
 * Event-sourced group fund. Commands validate against the folded state and
 * return the events to persist; `apply` is the only place state changes.
 */
export class GroupFund {
  charter!: FundCharter;
  terms!: LaunchTerms;
  status: 'OPEN' | 'CANCELLED' = 'OPEN';
  seq = 0;
  readonly members = new Map<string, MemberPosition>();
  readonly deposits = new Map<string, DepositRecord>();
  readonly spends = new Map<string, SpendRecord>();
  readonly refunds = new Map<string, RefundRecord>();
  readonly trips = new Map<string, TripRecord>();
  readonly polls: {
    pollId: string;
    question: string;
    yes: number;
    no: number;
  }[] = [];
  /** Every transfer key this fund has used (deposits, spends, refunds). */
  readonly usedKeys = new Set<string>();

  static open(charter: FundCharter, at: number): FundEvent[] {
    validateCharter(charter);
    return [{ type: 'OPENED', charter, at }];
  }

  static fold(events: readonly FundEvent[]): GroupFund {
    const f = new GroupFund();
    for (const e of events) f.apply(e);
    return f;
  }

  get fundId() {
    return this.charter.fundId;
  }
  get termsHash(): Hex {
    return launchTermsHash(this.terms);
  }

  apply(e: FundEvent): void {
    this.seq++;
    switch (e.type) {
      case 'OPENED':
        this.charter = deepCopy(e.charter);
        this.terms = e.charter.terms;
        for (const m of e.charter.members)
          this.members.set(m.memberId, {
            memberId: m.memberId,
            wallet: getAddress(m.wallet),
            pledged: 0n,
            pending: 0n,
            contributed: 0n,
            spent: 0n,
            refunded: 0n,
            reserved: 0n,
            assented: [],
          });
        return;
      case 'PLEDGED':
        this.member(e.memberId).pledged += e.amount;
        return;
      case 'DEPOSIT_SEEN':
        this.deposits.set(e.key, {
          key: e.key,
          transfer: e.transfer,
          memberId: e.memberId,
          reason: e.reason,
          status: 'PENDING',
        });
        this.usedKeys.add(e.key);
        if (e.memberId) this.member(e.memberId).pending += e.transfer.amount;
        return;
      case 'DEPOSIT_FINAL': {
        const d = this.deposits.get(e.key)!;
        d.status = 'FINAL';
        if (d.memberId) {
          const m = this.member(d.memberId);
          m.pending -= d.transfer.amount;
          m.contributed += d.transfer.amount;
          m.pledged =
            m.pledged > d.transfer.amount ? m.pledged - d.transfer.amount : 0n;
        }
        return;
      }
      case 'DEPOSIT_REORGED': {
        const d = this.deposits.get(e.key)!;
        d.status = 'REORGED';
        if (d.memberId) this.member(d.memberId).pending -= d.transfer.amount;
        this.usedKeys.delete(e.key);
        return;
      }
      case 'ASSENTED': {
        const m = this.member(e.memberId);
        if (!m.assented.includes(e.assent.termsHash))
          m.assented.push(e.assent.termsHash);
        return;
      }
      case 'TERMS_AMENDED':
        this.terms = e.terms;
        return;
      case 'SPEND_PROPOSED':
        this.spends.set(e.spend.spendId, {
          spend: e.spend,
          termsHash: e.termsHash,
          proposalHash: e.proposalHash,
          status: 'PROPOSED',
          allocation: {},
          authorization: null,
          execution: null,
        });
        return;
      case 'SPEND_AUTHORIZED': {
        const s = this.spends.get(e.spendId)!;
        s.status = 'AUTHORIZED';
        s.allocation = { ...e.allocation };
        s.authorization = e.authorization;
        for (const [id, v] of Object.entries(e.allocation))
          this.member(id).reserved += v;
        return;
      }
      case 'SPEND_EXECUTION_STARTED':
        this.spends.get(e.spendId)!.status = 'EXECUTING';
        return;
      case 'REFUND_EXECUTION_STARTED':
        this.refunds.get(e.refundId)!.status = 'EXECUTING';
        return;
      case 'SPEND_EXECUTED': {
        const s = this.spends.get(e.spendId)!;
        s.status = 'EXECUTED';
        s.execution = e.transfer;
        this.usedKeys.add(e.key);
        for (const [id, v] of Object.entries(s.allocation)) {
          const m = this.member(id);
          m.reserved -= v;
          m.spent += v;
        }
        return;
      }
      case 'REFUND_AUTHORIZED':
        this.refunds.set(e.refundId, {
          refundId: e.refundId,
          memberId: e.memberId,
          amount: e.amount,
          reason: e.reason,
          status: 'AUTHORIZED',
          execution: null,
        });
        this.member(e.memberId).reserved += e.amount;
        return;
      case 'REFUND_EXECUTED': {
        const r = this.refunds.get(e.refundId)!;
        r.status = 'EXECUTED';
        r.execution = e.transfer;
        this.usedKeys.add(e.key);
        const m = this.member(r.memberId);
        m.reserved -= r.amount;
        m.refunded += r.amount;
        return;
      }
      case 'CANCELLED':
        this.status = 'CANCELLED';
        for (const id of e.released) {
          const s = this.spends.get(id)!;
          if (s.status === 'AUTHORIZED')
            for (const [mid, v] of Object.entries(s.allocation))
              this.member(mid).reserved -= v;
          s.status = 'RELEASED';
        }
        return;
      case 'SOCIAL_POLL':
        this.polls.push({
          pollId: e.pollId,
          question: e.question,
          yes: e.yes,
          no: e.no,
        });
        return;
      case 'TRIP_REGISTERED':
        this.trips.set(e.tripId, {
          tripId: e.tripId,
          spendId: e.spendId,
          travelers: [...e.travelers],
          booking: null,
        });
        return;
      case 'TRIP_BOOKED':
        this.trips.get(e.tripId)!.booking = {
          providerId: e.providerId,
          providerRef: e.providerRef,
        };
        return;
    }
  }

  member(id: string): MemberPosition {
    return this.members.get(id) ?? fail('NOT_A_MEMBER', id);
  }
  private memberByWallet(wallet: string): MemberPosition | null {
    for (const m of this.members.values())
      if (lower(m.wallet) === lower(wallet)) return m;
    return null;
  }
  private requireOpen() {
    if (this.status !== 'OPEN') fail('FUND_NOT_OPEN', this.status);
  }
  /** Bound = assented to the current terms; only bound money can be spent. */
  isBound(m: MemberPosition): boolean {
    return m.assented.includes(this.termsHash);
  }
  private checkTransferAsset(t: ObservedTransfer) {
    if (
      t.chainId !== this.charter.asset.chainId ||
      lower(t.token) !== lower(this.charter.asset.address)
    )
      fail('WRONG_ASSET', `${t.chainId}/${t.token}`);
    if (t.amount <= 0n) fail('BAD_AMOUNT');
  }

  pledge(
    input: { pledgeId: string; memberId: string; amount: bigint },
    at: number,
  ): FundEvent[] {
    this.requireOpen();
    this.member(input.memberId);
    if (input.amount <= 0n) fail('BAD_AMOUNT');
    return [{ type: 'PLEDGED', ...input, at }];
  }

  /** Recurring contribution instructions due by `at`; a due period is a pledge, never funds. */
  recurringDue(
    memberId: string,
    at: number,
  ): { period: number; amount: bigint; ref: Hex }[] {
    const r = this.charter.recurring;
    if (!r || at < r.startsAt) return [];
    const periods = Math.floor((at - r.startsAt) / r.periodSeconds) + 1;
    const m = this.member(memberId);
    const paidPeriods = Number((m.contributed + m.pending) / r.amount);
    const out = [];
    for (let p = paidPeriods; p < periods; p++)
      out.push({
        period: p,
        amount: r.amount,
        ref: contributionRef(this.fundId, memberId),
      });
    return out;
  }

  /**
   * Records a transfer into the pool. It is credited (as pending) only when the
   * sender is the member's linked wallet and the Memo reference is theirs;
   * anything else is kept as unapplied and credits nobody.
   */
  observeDeposit(t: ObservedTransfer, at: number): FundEvent[] {
    const key = transferKey(t);
    if (this.deposits.has(key)) return [];
    if (this.usedKeys.has(key)) fail('DUPLICATE_CLAIM', key);
    this.checkTransferAsset(t);
    if (lower(t.to) !== lower(this.charter.pool)) fail('WRONG_POOL', t.to);
    const m = this.memberByWallet(t.from);
    let reason: string | null = null;
    if (!m) reason = 'sender is not a member wallet';
    else if (
      !t.paymentRef ||
      lower(t.paymentRef) !== lower(contributionRef(this.fundId, m.memberId))
    )
      reason = 'transfer does not carry the contributor reference';
    else if (this.status !== 'OPEN') reason = 'fund is not open';
    return [
      {
        type: 'DEPOSIT_SEEN',
        key,
        transfer: t,
        memberId: reason ? null : m!.memberId,
        reason,
        at,
      },
    ];
  }

  finalizeDeposit(key: string, headBlock: bigint, at: number): FundEvent[] {
    const d = this.deposits.get(key) ?? fail('UNKNOWN_DEPOSIT', key);
    if (d.status === 'FINAL') return [];
    if (d.status !== 'PENDING') fail('UNKNOWN_DEPOSIT', `${key} ${d.status}`);
    const confirmations = Number(headBlock - d.transfer.blockNumber + 1n);
    if (confirmations < this.charter.minConfirmations)
      fail(
        'NOT_FINAL',
        `${confirmations} of ${this.charter.minConfirmations} confirmations`,
      );
    return [{ type: 'DEPOSIT_FINAL', key, confirmations, at }];
  }

  reorgDeposit(key: string, at: number): FundEvent[] {
    const d = this.deposits.get(key) ?? fail('UNKNOWN_DEPOSIT', key);
    if (d.status === 'FINAL') fail('ALREADY_FINAL', key);
    return d.status === 'PENDING' ? [{ type: 'DEPOSIT_REORGED', key, at }] : [];
  }

  async recordAssent(input: {
    memberId: string;
    assent: ContributorAssent;
    signature: unknown;
    now: number;
  }): Promise<FundEvent[]> {
    const m = this.member(input.memberId);
    if (lower(input.assent.contributor) !== lower(m.wallet))
      fail('NOT_A_MEMBER', 'assent is for another wallet');
    const verified = await verifyAssent({
      assent: input.assent,
      signature: input.signature,
      terms: this.terms,
      now: input.now,
    });
    return [
      {
        type: 'ASSENTED',
        memberId: m.memberId,
        assent: verified,
        at: input.now,
      },
    ];
  }

  /**
   * New terms take effect for nobody until each contributor signs assent;
   * the unassented keep their original terms and can withdraw at any time.
   */
  amendTerms(terms: LaunchTerms, at: number): FundEvent[] {
    this.requireOpen();
    if (
      terms.campaignId !== this.fundId ||
      terms.version !== this.terms.version + 1
    )
      fail('BAD_TERMS', 'next version of this fund required');
    if (!sameAsset(terms.asset, this.terms.asset)) fail('BAD_TERMS', 'asset');
    launchTermsHash(terms);
    return [{ type: 'TERMS_AMENDED', terms, at }];
  }

  recordSocialPoll(
    input: { pollId: string; question: string; yes: number; no: number },
    at: number,
  ): FundEvent[] {
    return [{ type: 'SOCIAL_POLL', ...input, at }];
  }

  proposeSpend(spend: SpendRequest, at: number): FundEvent[] {
    this.requireOpen();
    if (this.spends.has(spend.spendId))
      fail('SPEND_STATE', 'duplicate spend id');
    if (spend.amount <= 0n) fail('BAD_AMOUNT');
    const payee = getAddress(spend.payee);
    if (lower(payee) === lower(this.charter.pool))
      fail('BAD_AMOUNT', 'pool cannot pay itself');
    const s = { ...spend, payee };
    return [
      {
        type: 'SPEND_PROPOSED',
        spend: s,
        termsHash: this.termsHash,
        proposalHash: spendProposalHash(this.fundId, s, this.termsHash),
        at,
      },
    ];
  }

  /** Contributors with an unreserved claim under the current terms: the spend electorate. */
  electorate(): EligibleMember[] {
    return [...this.members.values()]
      .filter((m) => this.isBound(m) && claimOf(m) > 0n)
      .map((m) => ({
        memberId: m.memberId,
        wallet: m.wallet,
        channelIds: [],
        weight: 1n,
      }));
  }

  private async decide(input: {
    proposalHash: Hex;
    snapshot: BallotSnapshot;
    votes: readonly AcceptedVote[];
    delegations: readonly DelegationRecord[];
    now: number;
  }): Promise<{ result: TallyResult; authorization: SpendAuthorization }> {
    const { snapshot } = input;
    if (snapshot.proposalHash !== input.proposalHash)
      fail('BALLOT_MISMATCH', 'ballot decides another proposal');
    if (snapshot.policyHash !== policyHash(this.charter.policy))
      fail('BALLOT_MISMATCH', 'ballot is under another policy');
    verifySnapshot(snapshot, this.charter.policy);
    const want = new Set(this.electorate().map((m) => lower(m.wallet)));
    const got = new Set(snapshot.members.map((m) => lower(m.wallet)));
    if (want.size !== got.size || [...want].some((w) => !got.has(w)))
      fail(
        'RESNAPSHOT_REQUIRED',
        'ballot electorate is not the bound contributors',
      );
    // Votes are re-verified (signatures, window, eligibility) by the tally.
    const result = await tally({
      snapshot,
      policy: this.charter.policy,
      votes: input.votes,
      delegations: input.delegations,
      at: input.now,
    });
    // Decided once the window closed, or once every eligible member has voted
    // (no remaining vote can change it; a cast vote cannot be changed).
    const decided = result.final || result.notVoted.count === 0;
    if (!decided) fail('VOTE_OPEN', result.summary);
    if (!result.quorumMet) fail('QUORUM_NOT_MET', result.summary);
    if (!result.approvalMet) fail('NOT_APPROVED', result.summary);
    const yesVoters = input.votes.filter((v) => v.choice === 'YES');
    return {
      result,
      authorization: {
        snapshotId: snapshot.snapshotId,
        resultHash: result.resultHash,
        eligible: result.eligible.count,
        yes: result.yes.count,
        no: result.no.count,
        abstain: result.abstain.count,
        notVoted: result.notVoted.count,
        participationBps: result.participationBps,
        yesOfEligibleBps: result.yesOfEligibleBps,
        approvedBy: yesVoters.map((v) => getAddress(v.voter)),
        final: result.final,
        summary: result.summary,
      },
    };
  }

  /** Authorizes a proposed spend from a signed ballot; nothing else can. */
  async authorizeSpend(input: {
    spendId: string;
    snapshot: BallotSnapshot;
    votes: readonly AcceptedVote[];
    delegations?: readonly DelegationRecord[];
    now: number;
  }): Promise<FundEvent[]> {
    this.requireOpen();
    const s =
      this.spends.get(input.spendId) ?? fail('UNKNOWN_SPEND', input.spendId);
    if (s.status !== 'PROPOSED') fail('SPEND_STATE', s.status);
    if (s.termsHash !== this.termsHash)
      fail('BALLOT_MISMATCH', 'terms changed since the proposal');
    const { authorization } = await this.decide({
      proposalHash: s.proposalHash,
      snapshot: input.snapshot,
      votes: input.votes,
      delegations: input.delegations ?? [],
      now: input.now,
    });
    const allocation = proRata(
      [...this.members.values()]
        .filter((m) => this.isBound(m))
        .map((m) => ({ memberId: m.memberId, claim: claimOf(m) })),
      s.spend.amount,
    );
    return [
      {
        type: 'SPEND_AUTHORIZED',
        spendId: s.spend.spendId,
        allocation,
        authorization,
        at: input.now,
      },
    ];
  }

  /** Persist before signing; cancellation cannot release an ambiguous transfer. */
  beginSpendExecution(spendId: string, at: number): FundEvent[] {
    this.requireOpen();
    const s = this.spends.get(spendId) ?? fail('UNKNOWN_SPEND', spendId);
    if (s.status !== 'AUTHORIZED') fail('SPEND_STATE', s.status);
    return [{ type: 'SPEND_EXECUTION_STARTED', spendId, at }];
  }
  beginRefundExecution(refundId: string, at: number): FundEvent[] {
    const r = this.refunds.get(refundId) ?? fail('UNKNOWN_REFUND', refundId);
    if (r.status !== 'AUTHORIZED') fail('REFUND_STATE', r.status);
    return [{ type: 'REFUND_EXECUTION_STARTED', refundId, at }];
  }

  /** The exact transfer the pool signer may make for an authorized spend. */
  spendInstruction(spendId: string): { to: Address; amount: bigint } {
    const s = this.spends.get(spendId) ?? fail('UNKNOWN_SPEND', spendId);
    if (s.status !== 'EXECUTING')
      fail('SPEND_STATE', `${spendId} is ${s.status}`);
    this.requireOpen();
    return { to: s.spend.payee, amount: s.spend.amount };
  }

  recordSpendExecution(
    spendId: string,
    t: ObservedTransfer,
    at: number,
  ): FundEvent[] {
    const s = this.spends.get(spendId) ?? fail('UNKNOWN_SPEND', spendId);
    const key = transferKey(t);
    if (
      s.status === 'EXECUTED' &&
      s.execution &&
      transferKey(s.execution) === key
    )
      return [];
    if (s.status !== 'EXECUTING') fail('SPEND_STATE', s.status);
    if (this.usedKeys.has(key)) fail('DUPLICATE_CLAIM', key);
    this.checkTransferAsset(t);
    if (
      lower(t.from) !== lower(this.charter.pool) ||
      lower(t.to) !== lower(s.spend.payee) ||
      t.amount !== s.spend.amount
    )
      fail('EXECUTION_MISMATCH', 'transfer differs from the authorized spend');
    return [{ type: 'SPEND_EXECUTED', spendId, key, transfer: t, at }];
  }

  /**
   * A contributor's own withdrawal of their unspent claim: allowed while the
   * terms are refundable, at any time when they never assented to the current
   * terms, and always after cancellation.
   */
  requestRefund(
    input: { refundId: string; memberId: string; reason: string },
    now: number,
  ): FundEvent[] {
    const m = this.member(input.memberId);
    if (this.refunds.has(input.refundId))
      fail('REFUND_STATE', 'duplicate refund id');
    const claim = claimOf(m);
    if (claim <= 0n) fail('REFUND_NOT_ALLOWED', 'no unspent claim');
    const allowed =
      this.status === 'CANCELLED' ||
      !this.isBound(m) ||
      (this.charter.rights.withdrawal === 'UNSPENT_CLAIM_WHILE_REFUNDABLE' &&
        now <= this.terms.refundableUntil);
    if (!allowed) fail('REFUND_NOT_ALLOWED', 'terms are no longer refundable');
    return [
      {
        type: 'REFUND_AUTHORIZED',
        refundId: input.refundId,
        memberId: m.memberId,
        amount: claim,
        reason: input.reason,
        at: now,
      },
    ];
  }

  refundInstruction(refundId: string): { to: Address; amount: bigint } {
    const r = this.refunds.get(refundId) ?? fail('UNKNOWN_REFUND', refundId);
    if (r.status !== 'EXECUTING') fail('REFUND_STATE', r.status);
    return { to: this.member(r.memberId).wallet, amount: r.amount };
  }

  recordRefundExecution(
    refundId: string,
    t: ObservedTransfer,
    at: number,
  ): FundEvent[] {
    const r = this.refunds.get(refundId) ?? fail('UNKNOWN_REFUND', refundId);
    const key = transferKey(t);
    if (
      r.status === 'EXECUTED' &&
      r.execution &&
      transferKey(r.execution) === key
    )
      return [];
    if (r.status !== 'EXECUTING') fail('REFUND_STATE', r.status);
    if (this.usedKeys.has(key)) fail('DUPLICATE_CLAIM', key);
    this.checkTransferAsset(t);
    if (
      lower(t.from) !== lower(this.charter.pool) ||
      lower(t.to) !== lower(this.member(r.memberId).wallet) ||
      t.amount !== r.amount
    )
      fail('EXECUTION_MISMATCH', 'transfer differs from the authorized refund');
    return [{ type: 'REFUND_EXECUTED', refundId, key, transfer: t, at }];
  }

  /** Cancels by signed ballot; authorized-but-unexecuted spends are released. */
  async cancel(input: {
    reason: string;
    snapshot: BallotSnapshot;
    votes: readonly AcceptedVote[];
    delegations?: readonly DelegationRecord[];
    now: number;
  }): Promise<FundEvent[]> {
    this.requireOpen();
    if ([...this.spends.values()].some((s) => s.status === 'EXECUTING'))
      fail(
        'SPEND_STATE',
        'unreconciled spend execution; funds remain reserved',
      );
    const { authorization } = await this.decide({
      proposalHash: cancelProposalHash(this.fundId, this.termsHash),
      snapshot: input.snapshot,
      votes: input.votes,
      delegations: input.delegations ?? [],
      now: input.now,
    });
    const released = [...this.spends.values()]
      .filter((s) => s.status === 'AUTHORIZED' || s.status === 'PROPOSED')
      .map((s) => s.spend.spendId);
    return [
      {
        type: 'CANCELLED',
        reason: input.reason,
        authorization,
        released,
        at: input.now,
      },
    ];
  }

  /** Each contributor's own refund after cancellation: exactly their remaining claim. */
  cancellationClaims(): {
    memberId: string;
    wallet: Address;
    amount: bigint;
  }[] {
    if (this.status !== 'CANCELLED')
      fail('FUND_NOT_OPEN', 'fund is not cancelled');
    return [...this.members.values()]
      .filter((m) => claimOf(m) > 0n)
      .map((m) => ({
        memberId: m.memberId,
        wallet: m.wallet,
        amount: claimOf(m),
      }));
  }

  /** Registers the travelers of a trip paid by one spend; each member holds at most one seat. */
  registerTrip(
    input: {
      tripId: string;
      spendId: string;
      travelers: { memberId: string; travelerRef: string }[];
    },
    at: number,
  ): FundEvent[] {
    if (this.trips.has(input.tripId))
      fail('TRIP_INVALID', 'trip already registered');
    const s =
      this.spends.get(input.spendId) ?? fail('UNKNOWN_SPEND', input.spendId);
    if (s.status === 'RELEASED') fail('TRIP_INVALID', 'spend released');
    for (const t of this.trips.values())
      if (t.spendId === input.spendId)
        fail('TRIP_INVALID', 'spend already pays another trip');
    const ids = input.travelers.map((t) => t.memberId);
    if (!ids.length || new Set(ids).size !== ids.length)
      fail('TRIP_INVALID', 'each member holds at most one seat');
    for (const id of ids) this.member(id);
    if (
      input.travelers.some(
        (t) => !/^pv_[A-Za-z0-9_-]{1,160}$/.test(t.travelerRef),
      )
    )
      fail('TRIP_INVALID', 'opaque ProfileVault traveler refs required');
    if (new Set(input.travelers.map((t) => t.travelerRef)).size !== ids.length)
      fail('TRIP_INVALID', 'traveler profiles must be distinct');
    return [{ type: 'TRIP_REGISTERED', ...input, at }];
  }

  /** Deterministic provider idempotency key: one logical booking per trip. */
  tripBookingKey(tripId: string): string {
    if (!this.trips.has(tripId)) fail('TRIP_INVALID', 'unknown trip');
    return `synq-trip-${keccak256(toHex(canonicalJson({ fundId: this.fundId, tripId }))).slice(2, 34)}`;
  }

  recordTripBooking(
    input: { tripId: string; providerId: string; providerRef: string },
    at: number,
  ): FundEvent[] {
    const t =
      this.trips.get(input.tripId) ?? fail('TRIP_INVALID', 'unknown trip');
    if (t.booking) {
      if (
        t.booking.providerId === input.providerId &&
        t.booking.providerRef === input.providerRef
      )
        return [];
      fail(
        'DUPLICATE_BOOKING',
        `trip already booked as ${t.booking.providerRef}`,
      );
    }
    const s = this.spends.get(t.spendId)!;
    if (s.status !== 'AUTHORIZED' && s.status !== 'EXECUTED')
      fail('SPEND_STATE', 'trip spend is not authorized');
    return [{ type: 'TRIP_BOOKED', ...input, at }];
  }

  /** Seat rights belong to travelers; funders hold their financial share of the spend. */
  tripRights(tripId: string) {
    const t = this.trips.get(tripId) ?? fail('TRIP_INVALID', 'unknown trip');
    const s = this.spends.get(t.spendId)!;
    return {
      tripId,
      booking: t.booking,
      seats: t.travelers.map((x) => ({
        memberId: x.memberId,
        travelerRef: x.travelerRef,
      })),
      funding: Object.entries(s.allocation).map(([memberId, amount]) => ({
        memberId,
        amount,
      })),
    };
  }

  view(): FundView {
    let pledged = 0n,
      pending = 0n,
      free = 0n,
      refundableUnbound = 0n,
      spent = 0n,
      refunded = 0n,
      contributed = 0n;
    for (const m of this.members.values()) {
      pledged += m.pledged;
      pending += m.pending;
      spent += m.spent;
      refunded += m.refunded;
      contributed += m.contributed;
      if (this.isBound(m)) free += claimOf(m);
      else refundableUnbound += claimOf(m);
    }
    let committed = 0n;
    for (const s of this.spends.values())
      if (s.status === 'AUTHORIZED' || s.status === 'EXECUTING')
        committed += s.spend.amount;
    let refundInFlight = 0n;
    for (const r of this.refunds.values())
      if (r.status === 'AUTHORIZED' || r.status === 'EXECUTING')
        refundInFlight += r.amount;
    let unapplied = 0n;
    for (const d of this.deposits.values())
      if (!d.memberId && d.status !== 'REORGED') unapplied += d.transfer.amount;
    return {
      fundId: this.fundId,
      status: this.status,
      termsVersion: this.terms.version,
      pledged,
      pending,
      free,
      refundableUnbound,
      committed,
      refundInFlight,
      spent,
      refunded,
      custody: contributed - spent - refunded,
      unapplied,
    };
  }

  /** Per-contributor books; the claims sum to the custody the pool must hold. */
  statement() {
    return [...this.members.values()].map((m) => ({
      memberId: m.memberId,
      wallet: m.wallet,
      contributed: m.contributed,
      pending: m.pending,
      spent: m.spent,
      refunded: m.refunded,
      reserved: m.reserved,
      claim: claimOf(m),
      bound: this.isBound(m),
    }));
  }
}

/** A member's custody across funds: each fund counts only its own final, credited deposits. */
export function memberCustody(wallet: Address, funds: readonly GroupFund[]) {
  const per = funds.flatMap((f) =>
    [...f.members.values()]
      .filter((m) => lower(m.wallet) === lower(wallet))
      .map((m) => ({
        fundId: f.fundId,
        claim: claimOf(m) + m.reserved,
        pending: m.pending,
      })),
  );
  return {
    wallet: getAddress(wallet),
    funds: per,
    total: per.reduce((s, x) => s + x.claim, 0n),
    pending: per.reduce((s, x) => s + x.pending, 0n),
  };
}
