import {
  encodeFunctionData,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  erc20Abi,
  getAddress,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TransactionSerialized,
} from 'viem';
import {
  admitEscrowGrant,
  escrowTotal,
  type EscrowCall,
  type EscrowOpenCall,
  type EscrowRefundCall,
  type EscrowReleaseCall,
} from '@synq/kernel/arc-escrow';
import type { ExecutionGrant, NonceFence } from '@synq/kernel/arc';
import { contract, token } from '@synq/chain-registry/arc';
import {
  ArcExecutionError,
  verifyCode,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import { signCall, settleSignedCall, type SignedCall } from './cctp.js';
import { MILESTONE_ESCROW_ABI, revertReason, simulate } from './vault.js';

/**
 * Restricted executor for SynqMilestoneEscrow (Deal Room escrow).
 *
 * Value-moving calls (open, release, refund) run only with a Kernel grant for
 * exactly that call (`admitEscrowGrant`): the grant's intent id is the hash of
 * the call, and its value view must match. Before signing, the escrow's
 * deployed bytecode must match the registry pin and the escrow must hold the
 * registry USDC. After each transaction the receipt is proven: the expected
 * escrow event with the expected fields and exactly the expected registry-
 * token Transfer, read back from chain state. A dispute moves no value, so it
 * needs no grant, but it is still simulated and its event proven.
 */

export const ESCROW_VIEW_ABI = parseAbi([
  'function deal(uint256 dealId) view returns ((address payer, address payee, address arbiter, uint64 refundAfter, bool disputed, uint8 milestoneCount, bytes32 termsHash, address disputedBy, uint64 disputeDeadline, bool payerDisputed, bool payeeDisputed))',
  'function milestone(uint256 dealId, uint256 index) view returns ((uint128 amount, uint8 status))',
]);

/** SynqMilestoneEscrow.Status. */
export const ESCROW_STATUS = [
  'None',
  'Funded',
  'Released',
  'Withdrawn',
  'Refunded',
] as const;
export type EscrowStatus = (typeof ESCROW_STATUS)[number];

const lower = (a: string) => a.toLowerCase();

/** The registry escrow, its code verified against the pin and bound to registry USDC. */
export async function verifyEscrow(chain: ArcChain) {
  const entry = contract(chain.profile.name, 'SYNQ_MILESTONE_ESCROW');
  const codeHash = await verifyCode(chain, entry.address, entry.codeHash);
  const usdc = token(chain.profile.name, 'USDC');
  const bound = await chain.client.readContract({
    address: entry.address,
    abi: MILESTONE_ESCROW_ABI,
    functionName: 'token',
  });
  if (lower(bound) !== lower(usdc.address))
    throw new ArcExecutionError(
      'CODE_HASH_MISMATCH',
      `escrow token ${bound} is not registry USDC ${usdc.address}`,
    );
  // The dispute freeze the Deal Room must sign into its terms.
  const disputePeriodSeconds = Number(
    await chain.client.readContract({
      address: entry.address,
      abi: MILESTONE_ESCROW_ABI,
      functionName: 'DISPUTE_PERIOD',
    }),
  );
  return {
    address: entry.address,
    codeHash,
    token: usdc.address,
    usdc,
    disputePeriodSeconds,
  };
}

export async function readEscrowDeal(
  chain: ArcChain,
  escrow: Address,
  dealId: bigint,
) {
  const d = await chain.client.readContract({
    address: escrow,
    abi: ESCROW_VIEW_ABI,
    functionName: 'deal',
    args: [dealId],
  });
  const milestones = [];
  for (let i = 0; i < d.milestoneCount; i++) {
    const m = await chain.client.readContract({
      address: escrow,
      abi: ESCROW_VIEW_ABI,
      functionName: 'milestone',
      args: [dealId, BigInt(i)],
    });
    milestones.push({
      amount: BigInt(m.amount),
      status: ESCROW_STATUS[m.status] ?? 'None',
    });
  }
  const disputeActive = await chain.client.readContract({
    address: escrow,
    abi: MILESTONE_ESCROW_ABI,
    functionName: 'disputeActive',
    args: [dealId],
  });
  return { ...d, milestones, disputeActive };
}

export type EscrowTx = Readonly<{
  label: string;
  hash: Hex;
  from: Address;
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  feeWei: bigint;
  explorer: string;
}>;

export type EscrowExecution = Readonly<{
  op: EscrowCall['op'] | 'DISPUTE';
  escrowDealId: bigint;
  /** Milestone index decoded from the escrow event (null for OPEN and DISPUTE). */
  milestone: number | null;
  txs: readonly EscrowTx[];
  /** Registry-USDC movements the transactions caused (base units). */
  transfers: readonly {
    from: Address;
    to: Address;
    value: bigint;
    logIndex: number;
    hash: Hex;
  }[];
}>;

export type EscrowStep =
  | 'APPROVE'
  | 'OPEN'
  | 'RELEASE'
  | 'WITHDRAW'
  | 'REFUND'
  | 'DISPUTE';

/** One transaction recorded before its broadcast. */
export type EscrowBroadcast = Readonly<{
  /** The Kernel grant the transaction runs under (null for a dispute). */
  grantId: string | null;
  step: EscrowStep;
  label: string;
  hash: Hex;
  from: Address;
  chainId: number;
}>;

/**
 * Pre-broadcast record store (injected port). The executor writes each signed
 * transaction's hash here BEFORE it is broadcast, so a crash or a failed
 * proof afterwards is reconciled from the chain by hash, never re-signed. In
 * production this is a durable outbox; the memory one is for tests and demos.
 */
export interface EscrowBroadcastJournal {
  record(entry: EscrowBroadcast): Promise<void>;
  signed(key: string): Promise<SignedCall | null>;
  storeSigned(key: string, call: SignedCall): Promise<SignedCall>;
  /** Atomically persists a grant admission; repeat admissions recover the same operation. */
  admit?(grant: ExecutionGrant, at: number): Promise<boolean>;
}

export class MemoryEscrowBroadcastJournal implements EscrowBroadcastJournal {
  readonly entries: EscrowBroadcast[] = [];
  private calls = new Map<string, SignedCall>();
  async signed(key: string) {
    return this.calls.get(key) ?? null;
  }
  async storeSigned(key: string, call: SignedCall) {
    if (!this.calls.has(key)) this.calls.set(key, call);
    return this.calls.get(key)!;
  }
  async record(entry: EscrowBroadcast) {
    this.entries.push(entry);
  }
  forGrant(grantId: string) {
    return this.entries.filter((e) => e.grantId === grantId);
  }
}

const calldata = {
  open: (c: EscrowOpenCall) =>
    encodeFunctionData({
      abi: MILESTONE_ESCROW_ABI,
      functionName: 'open',
      args: [
        c.payee,
        c.arbiter,
        BigInt(c.refundAfter),
        c.termsHash,
        c.amounts.map((a) => a),
      ],
    }),
  milestone: (fn: 'release' | 'withdraw' | 'refund', id: bigint, i: number) =>
    encodeFunctionData({
      abi: MILESTONE_ESCROW_ABI,
      functionName: fn,
      args: [id, BigInt(i)],
    }),
  dispute: (id: bigint) =>
    encodeFunctionData({
      abi: MILESTONE_ESCROW_ABI,
      functionName: 'dispute',
      args: [id],
    }),
};

export async function sendEscrowCall(
  chain: ArcChain,
  signer: TransferSigner,
  label: string,
  to: Address,
  data: Hex,
  record: {
    journal: EscrowBroadcastJournal;
    grantId: string | null;
    step: EscrowStep;
  },
): Promise<{ tx: EscrowTx; receipt: TransactionReceipt }> {
  const key = `${record.grantId ?? `dispute:${signer.address}:${keccak256(data)}`}:${record.step}`;
  let signed = await record.journal.signed(key);
  if (!signed) {
    const sim = await simulate(chain, signer.address, to, data);
    if (!sim.ok)
      throw new ArcExecutionError(
        'SIMULATION_FAILED',
        `${label}: ${sim.reason}`,
      );
    signed = await record.journal.storeSigned(
      key,
      await signCall(chain, signer, to, data),
    );
  }
  const tx = parseTransaction(signed.raw);
  if (
    keccak256(signed.raw) !== signed.hash ||
    tx.chainId !== chain.profile.chainId ||
    tx.nonce !== signed.nonce ||
    lower(tx.to ?? '0x') !== lower(to) ||
    lower(
      await recoverTransactionAddress({
        serializedTransaction: signed.raw as TransactionSerialized,
      }),
    ) !== lower(signer.address) ||
    signed.chainId !== chain.profile.chainId ||
    lower(signed.from) !== lower(signer.address) ||
    lower(signed.to) !== lower(to) ||
    tx.data !== data ||
    (tx.value ?? 0n) !== 0n
  )
    throw new ArcExecutionError('TX_MISMATCH', 'recorded escrow call differs');
  const hash = signed.hash;
  await record.journal.record({
    grantId: record.grantId,
    step: record.step,
    label,
    hash,
    from: signer.address,
    chainId: chain.profile.chainId,
  });
  const outcome = await settleSignedCall(chain, signed);
  if (outcome !== 'SUCCESS')
    throw new ArcExecutionError(
      'TX_MISMATCH',
      `${label}: ${outcome}; needs review`,
    );
  const receipt = await chain.client.getTransactionReceipt({ hash });
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice;
  return {
    receipt,
    tx: {
      label,
      hash,
      from: signer.address,
      blockNumber: receipt.blockNumber,
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feeWei,
      explorer: `${chain.profile.explorer}/tx/${hash}`,
    },
  };
}

/** Registry-token Transfer logs only (Arc's 0xffff…fffe native mirror is ignored). */
function usdcTransfers(receipt: TransactionReceipt, tokenAddress: Address) {
  return parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: receipt.logs,
  })
    .filter((l) => lower(l.address) === lower(tokenAddress))
    .map((l) => ({
      from: getAddress(l.args.from),
      to: getAddress(l.args.to),
      value: l.args.value,
      logIndex: l.logIndex,
      hash: receipt.transactionHash,
    }));
}

function mustTransfer(
  label: string,
  got: ReturnType<typeof usdcTransfers>,
  want: { from: Address; to: Address; value: bigint },
) {
  if (
    got.length !== 1 ||
    lower(got[0]!.from) !== lower(want.from) ||
    lower(got[0]!.to) !== lower(want.to) ||
    got[0]!.value !== want.value
  )
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `${label}: expected exactly ${want.value} ${want.from} -> ${want.to}, got ${got.length} transfers`,
    );
}

function checkSigner(signer: TransferSigner, call: { sender: Address }) {
  if (lower(signer.address) !== lower(call.sender))
    throw new ArcExecutionError(
      'SIGNER_MISMATCH',
      `${signer.address} != ${call.sender}`,
    );
}

type Granted<C extends EscrowCall> = {
  chain: ArcChain;
  signer: TransferSigner;
  call: C;
  grant: ExecutionGrant;
  grantKey: Uint8Array;
  fence: NonceFence;
  mandateRevoked: boolean;
  now: number;
  /** Pre-broadcast record store; written before every broadcast. */
  journal: EscrowBroadcastJournal;
};

async function admit<C extends EscrowCall>(input: Granted<C>) {
  const { chain, call } = input;
  checkSigner(input.signer, call);
  if (call.chainId !== chain.profile.chainId)
    throw new ArcExecutionError('WRONG_CHAIN', String(call.chainId));
  const escrow = await verifyEscrow(chain);
  if (lower(call.escrow) !== lower(escrow.address))
    throw new ArcExecutionError(
      'TX_MISMATCH',
      `${call.escrow} is not the registry escrow`,
    );
  if (lower(call.token) !== lower(escrow.token))
    throw new ArcExecutionError('TX_MISMATCH', 'wrong escrow asset');
  await admitEscrowGrant({
    grantKey: input.grantKey,
    grant: input.grant,
    call,
    now: input.now,
    mandateRevoked: input.mandateRevoked,
    fence: input.journal.admit
      ? {
          consume: () => Promise.resolve(false),
          consumeGrant: (grant, at) => input.journal.admit!(grant, at),
        }
      : input.fence,
  });
  return escrow;
}

/**
 * Funds a deal: exact-amount approve, then `open`. Proves DealOpened carries
 * the agreed payee, arbiter, refund time, terms hash and total, that exactly
 * the total moved funder -> escrow, that each milestone is Funded with the
 * agreed amount, and that no allowance is left behind.
 */
export async function executeEscrowOpen(
  input: Granted<EscrowOpenCall>,
): Promise<EscrowExecution> {
  const { chain, signer, call } = input;
  const escrow = await admit(input);
  const total = escrowTotal(call.amounts);
  const balance = await chain.client.readContract({
    address: escrow.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [signer.address],
  });
  if (
    balance < total &&
    !(await input.journal.signed(`${input.grant.grantId}:OPEN`))
  )
    throw new ArcExecutionError('INSUFFICIENT_FUNDS', `${balance} < ${total}`);
  const approve = await sendEscrowCall(
    chain,
    signer,
    'escrow approve (exact total)',
    escrow.token,
    encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [escrow.address, total],
    }),
    { journal: input.journal, grantId: input.grant.grantId, step: 'APPROVE' },
  );
  const opened = await sendEscrowCall(
    chain,
    signer,
    'escrow open',
    escrow.address,
    calldata.open(call),
    { journal: input.journal, grantId: input.grant.grantId, step: 'OPEN' },
  );
  const events = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'DealOpened',
    logs: opened.receipt.logs,
  }).filter((l) => lower(l.address) === lower(escrow.address));
  const ev = events[0];
  if (
    events.length !== 1 ||
    !ev ||
    lower(ev.args.payer) !== lower(call.sender) ||
    lower(ev.args.payee) !== lower(call.payee) ||
    lower(ev.args.arbiter) !== lower(call.arbiter) ||
    lower(ev.args.termsHash) !== lower(call.termsHash) ||
    ev.args.total !== total ||
    ev.args.refundAfter !== BigInt(call.refundAfter)
  )
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      'DealOpened does not carry the agreed terms',
    );
  const transfers = usdcTransfers(opened.receipt, escrow.token);
  mustTransfer('escrow open', transfers, {
    from: call.sender,
    to: escrow.address,
    value: total,
  });
  const dealId = ev.args.dealId;
  const state = await readEscrowDeal(chain, escrow.address, dealId);
  if (
    state.milestones.length !== call.amounts.length ||
    state.milestones.some(
      (m, i) => m.amount !== call.amounts[i] || m.status !== 'Funded',
    )
  )
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      'escrow milestones differ from the agreed split',
    );
  const left = await chain.client.readContract({
    address: escrow.token,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [signer.address, escrow.address],
  });
  if (left !== 0n)
    throw new ArcExecutionError(
      'TRANSFER_MISMATCH',
      `allowance ${left} left after open`,
    );
  return {
    op: 'OPEN',
    escrowDealId: dealId,
    milestone: null,
    txs: [approve.tx, opened.tx],
    transfers,
  };
}

/** Escrow deal checks shared by release and refund: terms hash, milestone amount, status. */
async function checkMilestone(
  chain: ArcChain,
  escrow: Address,
  call: EscrowReleaseCall | EscrowRefundCall,
) {
  const state = await readEscrowDeal(chain, escrow, call.escrowDealId);
  if (lower(state.termsHash) !== lower(call.termsHash))
    throw new ArcExecutionError(
      'TX_MISMATCH',
      'escrow deal carries a different terms hash',
    );
  const m = state.milestones[call.index];
  if (!m || m.amount !== call.amount)
    throw new ArcExecutionError('TX_MISMATCH', 'milestone amount differs');
  return state;
}

/**
 * Releases one milestone (sender: the deal's payer or arbiter), then
 * withdraws it to the payee. Proves MilestoneReleased and exactly one
 * escrow -> payee Transfer of the milestone amount.
 */
export async function executeEscrowRelease(
  input: Granted<EscrowReleaseCall>,
): Promise<EscrowExecution> {
  const { chain, signer, call } = input;
  const escrow = await admit(input);
  const state = await checkMilestone(chain, escrow.address, call);
  if (lower(state.payee) !== lower(call.payee))
    throw new ArcExecutionError('TX_MISMATCH', 'payee differs from the deal');
  const released = await sendEscrowCall(
    chain,
    signer,
    `escrow release milestone ${call.index}`,
    escrow.address,
    calldata.milestone('release', call.escrowDealId, call.index),
    { journal: input.journal, grantId: input.grant.grantId, step: 'RELEASE' },
  );
  const rel = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'MilestoneReleased',
    logs: released.receipt.logs,
  }).filter((l) => lower(l.address) === lower(escrow.address));
  if (
    rel.length !== 1 ||
    rel[0]!.args.dealId !== call.escrowDealId ||
    rel[0]!.args.milestone !== BigInt(call.index) ||
    rel[0]!.args.amount !== call.amount ||
    lower(rel[0]!.args.by) !== lower(call.sender)
  )
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'MilestoneReleased');
  if (usdcTransfers(released.receipt, escrow.token).length !== 0)
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'release moved funds');
  const withdrawn = await sendEscrowCall(
    chain,
    signer,
    `escrow withdraw milestone ${call.index} to payee`,
    escrow.address,
    calldata.milestone('withdraw', call.escrowDealId, call.index),
    { journal: input.journal, grantId: input.grant.grantId, step: 'WITHDRAW' },
  );
  const wd = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'MilestoneWithdrawn',
    logs: withdrawn.receipt.logs,
  }).filter((l) => lower(l.address) === lower(escrow.address));
  if (
    wd.length !== 1 ||
    wd[0]!.args.dealId !== call.escrowDealId ||
    wd[0]!.args.milestone !== BigInt(call.index) ||
    wd[0]!.args.amount !== call.amount ||
    lower(wd[0]!.args.payee) !== lower(call.payee)
  )
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'MilestoneWithdrawn');
  const transfers = usdcTransfers(withdrawn.receipt, escrow.token);
  mustTransfer('escrow withdraw', transfers, {
    from: escrow.address,
    to: call.payee,
    value: call.amount,
  });
  return {
    op: 'RELEASE',
    escrowDealId: call.escrowDealId,
    milestone: Number(wd[0]!.args.milestone),
    txs: [released.tx, withdrawn.tx],
    transfers,
  };
}

/** Refunds one unreleased milestone; proves exactly escrow -> original funder. */
export async function executeEscrowRefund(
  input: Granted<EscrowRefundCall>,
): Promise<EscrowExecution> {
  const { chain, signer, call } = input;
  const escrow = await admit(input);
  const state = await checkMilestone(chain, escrow.address, call);
  if (lower(state.payer) !== lower(call.funder))
    throw new ArcExecutionError(
      'TX_MISMATCH',
      `refund recipient ${call.funder} is not the deal's funder ${state.payer}`,
    );
  const refunded = await sendEscrowCall(
    chain,
    signer,
    `escrow refund milestone ${call.index} to funder`,
    escrow.address,
    calldata.milestone('refund', call.escrowDealId, call.index),
    { journal: input.journal, grantId: input.grant.grantId, step: 'REFUND' },
  );
  const ev = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'MilestoneRefunded',
    logs: refunded.receipt.logs,
  }).filter((l) => lower(l.address) === lower(escrow.address));
  if (
    ev.length !== 1 ||
    ev[0]!.args.dealId !== call.escrowDealId ||
    ev[0]!.args.milestone !== BigInt(call.index) ||
    lower(ev[0]!.args.payer) !== lower(call.funder) ||
    ev[0]!.args.amount !== call.amount
  )
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'MilestoneRefunded');
  const transfers = usdcTransfers(refunded.receipt, escrow.token);
  mustTransfer('escrow refund', transfers, {
    from: escrow.address,
    to: call.funder,
    value: call.amount,
  });
  return {
    op: 'REFUND',
    escrowDealId: call.escrowDealId,
    milestone: Number(ev[0]!.args.milestone),
    txs: [refunded.tx],
    transfers,
  };
}

/** Raises the deal's dispute (payer or payee). Moves no value; proves Disputed. */
export async function executeEscrowDispute(input: {
  chain: ArcChain;
  signer: TransferSigner;
  escrowDealId: bigint;
  journal: EscrowBroadcastJournal;
}): Promise<EscrowExecution> {
  const escrow = await verifyEscrow(input.chain);
  const d = await sendEscrowCall(
    input.chain,
    input.signer,
    'escrow dispute',
    escrow.address,
    calldata.dispute(input.escrowDealId),
    { journal: input.journal, grantId: null, step: 'DISPUTE' },
  );
  const ev = parseEventLogs({
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'Disputed',
    logs: d.receipt.logs,
  }).filter((l) => lower(l.address) === lower(escrow.address));
  if (
    ev.length !== 1 ||
    lower(ev[0]!.args.by) !== lower(input.signer.address) ||
    ev[0]!.args.dealId !== input.escrowDealId
  )
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'Disputed');
  if (usdcTransfers(d.receipt, escrow.token).length)
    throw new ArcExecutionError('TRANSFER_MISMATCH', 'dispute moved funds');
  return {
    op: 'DISPUTE',
    escrowDealId: input.escrowDealId,
    milestone: null,
    txs: [d.tx],
    transfers: [],
  };
}

/**
 * After a failed funding attempt: did the recorded `open` land, and which
 * escrow deals did this payer open with this terms hash since `fromBlock`?
 * The Deal Room returns a deal to ACCEPTED only on REVERTED + none.
 */
export async function probeEscrowFunding(
  chain: ArcChain,
  input: {
    openHash: Hex | null;
    payer: Address;
    termsHash: Hex;
    fromBlock: bigint;
  },
): Promise<{
  openReceipt: 'SUCCESS' | 'REVERTED' | 'NOT_FOUND';
  openedDealIds: bigint[];
}> {
  const escrow = contract(chain.profile.name, 'SYNQ_MILESTONE_ESCROW').address;
  let openReceipt: 'SUCCESS' | 'REVERTED' | 'NOT_FOUND' = 'NOT_FOUND';
  if (input.openHash)
    try {
      const r = await chain.client.getTransactionReceipt({
        hash: input.openHash,
      });
      openReceipt = r.status === 'success' ? 'SUCCESS' : 'REVERTED';
    } catch {
      openReceipt = 'NOT_FOUND';
    }
  const logs = await chain.client.getContractEvents({
    address: escrow,
    abi: MILESTONE_ESCROW_ABI,
    eventName: 'DealOpened',
    args: { payer: input.payer },
    fromBlock: input.fromBlock,
  });
  const openedDealIds = logs
    .filter((l) => lower(l.args.termsHash ?? '') === lower(input.termsHash))
    .map((l) => l.args.dealId!);
  return { openReceipt, openedDealIds };
}

/** eth_call of an escrow function from `from`: what a would-be caller would hit. */
export async function simulateEscrow(
  chain: ArcChain,
  from: Address,
  fn: 'release' | 'withdraw' | 'refund',
  escrowDealId: bigint,
  index: number,
) {
  const escrow = contract(chain.profile.name, 'SYNQ_MILESTONE_ESCROW').address;
  return simulate(
    chain,
    from,
    escrow,
    calldata.milestone(fn, escrowDealId, index),
  );
}

export { revertReason };
