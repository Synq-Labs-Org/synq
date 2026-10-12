import {
  formatUnits,
  keccak256,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import {
  assertExactTransfer,
  ausdBalance,
  transferCalldata,
  verifiedContributionMandate,
  verifiedTransfer,
} from './chain.js';
import { SynqPluginError, fail } from './errors.js';
import {
  membershipOf,
  memberApi,
  resolveSpender,
  verifiedGroup,
  type Deps,
} from './group.js';
import type { TxRequest } from './host.js';
import type { ContributionJournal, JournalEntry } from './journal.js';
import { NETWORK, explorerTxUrl, sameAddress } from './network.js';
import type { FundingSession } from './synq-api.js';

export type ContributeInput = {
  groupId: string;
  amount: string;
  mandateId?: string;
  requestId?: string;
  from?: string;
  dryRun?: boolean;
};

export type ContributeOptions = {
  journal: ContributionJournal;
  /** Plugin-level cap in AUSD base units; never above the network hard cap. */
  capBaseUnits?: bigint;
  reconcileAttempts?: number;
  reconcileDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
};

export type ContributionPlan = {
  mode: 'DRY_RUN';
  groupId: string;
  chainGroupId: string;
  safe: Address;
  spender: Address;
  memberId: string;
  token: Address;
  amount: string;
  amountFormatted: string;
  requestId: string;
  fundingSessionId: string;
  quoteExpiresAt: number;
  transaction: { chainId: number; to: Address; data: Hex; value: '0' };
};

export type ContributionReceipt = {
  mode: 'REAL_TESTNET';
  groupId: string;
  chainGroupId: string;
  safe: Address;
  spender: Address;
  memberId: string;
  token: Address;
  amount: string;
  amountFormatted: string;
  requestId: string;
  fundingSessionId: string;
  fundingState: string;
  reconciled: boolean;
  txHash: Hex;
  blockNumber: string;
  logIndex: number;
  explorerUrl: string;
  walletStatus: string;
};

export function parseAmount(amount: string): bigint {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(amount))
    fail('INVALID_AMOUNT', `amount ${amount} is not a decimal AUSD amount`);
  const [, frac = ''] = amount.split('.');
  if (frac.length > NETWORK.ausd.decimals)
    fail(
      'INVALID_AMOUNT',
      `AUSD has ${NETWORK.ausd.decimals} decimals; ${amount} is too precise`,
    );
  const units = parseUnits(amount, NETWORK.ausd.decimals);
  if (units <= 0n) fail('INVALID_AMOUNT', 'amount must be positive');
  return units;
}

export function capFromEnv(env: Record<string, string | undefined>): bigint {
  const raw = env.SYNQ_MM_MAX_CONTRIBUTION;
  if (!raw) return NETWORK.maxContributionBaseUnits;
  const cap = parseAmount(raw);
  return cap < NETWORK.maxContributionBaseUnits
    ? cap
    : NETWORK.maxContributionBaseUnits;
}

/** Same group, wallet, amount and mandate reuse one request id unless the caller picks a new one. */
export const defaultRequestId = (
  chainGroupId: string,
  spender: string,
  amount: bigint,
  mandateId: string | undefined,
) =>
  `mm-synq-${keccak256(
    stringToHex(
      [
        chainGroupId.toLowerCase(),
        spender.toLowerCase(),
        amount.toString(),
        mandateId?.toLowerCase() ?? '',
      ].join('|'),
    ),
  ).slice(2, 34)}`;

const AFTER_SUBMISSION: readonly string[] = [
  'SOURCE_SUBMITTED',
  'BRIDGE_PENDING',
  'INTENT_PENDING',
  'DESTINATION_RECEIVED',
  'INDEXED',
  'CREDITED',
  'INCOMPLETE_DEPOSIT',
  'RECONCILIATION_REQUIRED',
  'REFUNDED',
];

function assertQuote(
  session: FundingSession,
  expected: {
    safe: Address;
    spender: Address;
    amount: bigint;
    nowSeconds: number;
  },
) {
  const q = session.quote;
  if (
    q.source.chainId !== NETWORK.chainId ||
    q.destination.chainId !== NETWORK.chainId
  )
    fail('WRONG_CHAIN', 'Synq quoted a cross-chain route');
  if (
    !sameAddress(q.source.address, NETWORK.ausd.address) ||
    !sameAddress(q.destination.address, NETWORK.ausd.address)
  )
    fail('INVALID_TOKEN', `Synq quoted token ${q.source.address}, not AUSD`);
  if (!sameAddress(q.recipient, expected.safe))
    fail(
      'WRONG_SAFE',
      `Synq quote pays ${q.recipient}, not the registered Safe ${expected.safe}`,
    );
  if (!sameAddress(q.sourceSender, expected.spender))
    fail(
      'WRONG_SPENDER',
      `Synq quote expects sender ${q.sourceSender ?? 'unset'}`,
    );
  if (
    BigInt(q.amountIn) !== expected.amount ||
    BigInt(q.amountOut) !== expected.amount
  )
    fail(
      BigInt(q.amountIn) > expected.amount ? 'OVER_CAP' : 'INTENT_MISMATCH',
      `Synq quote amount ${q.amountIn} differs from ${expected.amount}`,
    );
  if (session.state === 'EXPIRED' || q.expiresAt <= expected.nowSeconds)
    fail('INTENT_EXPIRED', `funding quote expired at ${q.expiresAt}`);
  if (session.sourceTransactionHash || AFTER_SUBMISSION.includes(session.state))
    fail(
      'DUPLICATE_CONTRIBUTION',
      `funding session ${session.sessionId} already has a source transaction${session.sourceTransactionHash ? ` ${session.sourceTransactionHash}` : ''}`,
    );
  if (session.state !== 'QUOTED' && session.state !== 'USER_AUTHORIZED')
    fail('INTENT_MISMATCH', `funding session is ${session.state}`);
}

export async function contribute(
  deps: Deps,
  input: ContributeInput,
  options: ContributeOptions,
): Promise<ContributionPlan | ContributionReceipt> {
  const cap = options.capBaseUnits ?? NETWORK.maxContributionBaseUnits;
  const amount = parseAmount(input.amount);
  if (amount > cap || amount > NETWORK.maxContributionBaseUnits)
    fail(
      'OVER_CAP',
      `${input.amount} AUSD exceeds the contribution cap of ${formatUnits(cap, NETWORK.ausd.decimals)} AUSD`,
    );
  if (
    input.mandateId !== undefined &&
    !/^0x[0-9a-fA-F]{64}$/.test(input.mandateId)
  )
    fail('INVALID_INPUT', '--mandate-id must be a bytes32 hex value');
  if (
    input.requestId !== undefined &&
    !/^[A-Za-z0-9_.:-]{8,128}$/.test(input.requestId)
  )
    fail('INVALID_INPUT', '--request-id must be 8-128 of [A-Za-z0-9_.:-]');

  const verified = await verifiedGroup(deps, input.groupId);
  const { group, safe, client } = verified;
  const spender = resolveSpender(deps.host, input.from);
  const member = membershipOf(group, spender);
  const api = await memberApi(deps, verified, input.from);
  const nowSeconds = () => Math.floor(deps.now() / 1000);
  if (input.mandateId)
    await verifiedContributionMandate(
      client,
      safe,
      input.mandateId as Hex,
      BigInt(nowSeconds()),
    );

  const requestId =
    input.requestId ??
    defaultRequestId(group.chainGroupId, spender, amount, input.mandateId);
  const prior = await options.journal.get(requestId);
  if (prior && (prior.txHash || prior.state !== 'PREPARED'))
    fail(
      'DUPLICATE_CONTRIBUTION',
      `request ${requestId} was already submitted${prior.txHash ? ` as ${prior.txHash}` : ''}`,
    );

  const token = {
    chainId: NETWORK.chainId,
    address: NETWORK.ausd.address.toLowerCase(),
    symbol: NETWORK.ausd.symbol,
    decimals: NETWORK.ausd.decimals,
  };
  let session = await api.quote({
    requestId,
    groupId: group.groupId,
    destination: {
      chainId: NETWORK.chainId,
      account: safe.toLowerCase(),
      token,
    },
    source: {
      token,
      amount: amount.toString(),
      sender: spender.toLowerCase(),
      refundTo: spender.toLowerCase(),
    },
    maxSlippageBps: 0,
    now: nowSeconds(),
  });
  assertQuote(session, { safe, spender, amount, nowSeconds: nowSeconds() });

  const balance = await ausdBalance(client, spender);
  if (balance < amount)
    fail(
      'INSUFFICIENT_BALANCE',
      `${spender} holds ${formatUnits(balance, NETWORK.ausd.decimals)} AUSD, needs ${input.amount}`,
    );

  const tx: TxRequest = {
    chainId: NETWORK.chainId,
    to: NETWORK.ausd.address,
    data: transferCalldata(safe, amount),
    value: 0n,
    summary: `Contribute ${formatUnits(amount, NETWORK.ausd.decimals)} AUSD to Synq group Safe ${safe}`,
    details: {
      group: group.groupId,
      safe,
      member: member.memberId,
      fundingSession: session.sessionId,
    },
  };
  assertExactTransfer(tx, { safe, amount });

  const base = {
    groupId: group.groupId,
    chainGroupId: group.chainGroupId,
    safe,
    spender,
    memberId: member.memberId,
    token: NETWORK.ausd.address,
    amount: amount.toString(),
    amountFormatted: formatUnits(amount, NETWORK.ausd.decimals),
    requestId,
    fundingSessionId: session.sessionId,
  };
  if (input.dryRun)
    return {
      mode: 'DRY_RUN',
      ...base,
      quoteExpiresAt: session.quote.expiresAt,
      transaction: {
        chainId: tx.chainId,
        to: tx.to,
        data: tx.data,
        value: '0',
      },
    };

  const entry: JournalEntry = {
    requestId,
    groupId: group.groupId,
    chainGroupId: group.chainGroupId,
    safe,
    spender,
    amount: amount.toString(),
    sessionId: session.sessionId,
    txHash: null,
    state: 'PREPARED',
    updatedAt: deps.now(),
  };
  const claimed = await options.journal.claim(entry);
  if (claimed && (claimed.txHash || claimed.state !== 'PREPARED'))
    fail('DUPLICATE_CONTRIBUTION', `request ${requestId} is already in flight`);

  if (session.state === 'QUOTED')
    session = await api.authorize(session.sessionId);
  if (session.state === 'EXPIRED')
    fail('INTENT_EXPIRED', 'funding quote expired before authorization');
  if (session.state !== 'USER_AUTHORIZED')
    fail(
      'INTENT_MISMATCH',
      `funding session is ${session.state}, not USER_AUTHORIZED`,
    );
  if (session.quote.expiresAt <= nowSeconds())
    fail('INTENT_EXPIRED', 'funding quote expired before submission');

  if (!(await options.journal.lockSubmission(requestId)))
    fail(
      'DUPLICATE_CONTRIBUTION',
      `request ${requestId} was already submitted`,
    );
  await options.journal.update(requestId, {
    state: 'SUBMITTED',
    updatedAt: deps.now(),
  });
  const submission = await deps.host.submit(tx);
  if (!submission.hash || submission.failureCode) {
    await options.journal.update(requestId, {
      state: 'FAILED',
      updatedAt: deps.now(),
    });
    fail(
      'SUBMISSION_FAILED',
      `Agent Wallet returned ${submission.status}${submission.failureCode ? ` (${submission.failureCode}: ${submission.failureDescription ?? ''})` : ''}`,
    );
  }
  const hash = submission.hash as Hex;
  await options.journal.update(requestId, {
    txHash: hash,
    updatedAt: deps.now(),
  });

  const receipt = await client.waitForTransactionReceipt({
    hash,
    confirmations: NETWORK.confirmationDepth,
    timeout: 180_000,
  });
  const transfer = verifiedTransfer(receipt, { spender, safe, amount });
  await options.journal.update(requestId, {
    state: 'MINED',
    updatedAt: deps.now(),
  });

  session = await api.recordSource(session.sessionId, hash);
  const attempts = options.reconcileAttempts ?? 10;
  const sleep =
    options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let i = 0; i < attempts && session.state !== 'CREDITED'; i++) {
    try {
      session = await api.reconcile(session.sessionId);
    } catch (error) {
      if (
        !(error instanceof SynqPluginError) ||
        error.code !== 'SYNQ_API_ERROR'
      )
        throw error;
    }
    if (session.state !== 'CREDITED')
      await sleep(options.reconcileDelayMs ?? 6_000);
  }
  const reconciled = session.state === 'CREDITED';
  await options.journal.update(requestId, {
    state: reconciled ? 'CREDITED' : 'RECONCILIATION_PENDING',
    updatedAt: deps.now(),
  });
  return {
    mode: 'REAL_TESTNET',
    ...base,
    fundingState: session.state,
    reconciled,
    txHash: hash,
    blockNumber: transfer.blockNumber.toString(),
    logIndex: transfer.logIndex,
    explorerUrl: explorerTxUrl(hash),
    walletStatus: submission.status,
  };
}
