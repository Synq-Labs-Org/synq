import {
  hexToBigInt,
  hexToNumber,
  slice,
  size,
  type Address,
  type Hex,
} from 'viem';
import {
  CHAINS,
  chainProfile,
  token,
  type ChainName,
} from '@synq/chain-registry/arc';

/**
 * Circle CCTP V2 (burn on the source chain, Circle attestation, mint on Arc)
 * as an economic saga. This package plans, decodes and tracks; it never signs.
 * The restricted executor performs each leg, and every leg has its own receipt
 * and idempotency key. A source burn whose outcome is unknown is never
 * resubmitted: recovery reads the chain and Circle, it does not retry writes.
 *
 * Invoice binding: the payer burns with `depositForBurnWithHook` and the
 * invoice payment reference as `hookData`. No hook contract is targeted, so
 * nothing executes on mint; the reference is data inside the attested message,
 * and the invoice settles only after the destination mint is final and its
 * recipient, amount and reference all match.
 */

export const IRIS_SANDBOX = 'https://iris-api-sandbox.circle.com';
export const FAST_FINALITY = 1000;
export const STANDARD_FINALITY = 2000;

export const CCTP_STATES = [
  'QUOTED',
  'APPROVED',
  'SOURCE_SUBMITTED',
  'SOURCE_CONFIRMED',
  'ATTESTATION_PENDING',
  'ATTESTED',
  'DEST_SUBMITTED',
  'DEST_FINAL',
  'MATCHED',
  'RECONCILED',
  'FAILED',
] as const;
export type CctpState = (typeof CCTP_STATES)[number];

const NEXT: Record<CctpState, readonly CctpState[]> = {
  QUOTED: ['APPROVED', 'FAILED'],
  APPROVED: ['SOURCE_SUBMITTED', 'FAILED'],
  SOURCE_SUBMITTED: ['SOURCE_CONFIRMED', 'FAILED'],
  SOURCE_CONFIRMED: ['ATTESTATION_PENDING', 'ATTESTED'],
  ATTESTATION_PENDING: ['ATTESTED'],
  ATTESTED: ['DEST_SUBMITTED', 'DEST_FINAL'],
  DEST_SUBMITTED: ['DEST_FINAL'],
  DEST_FINAL: ['MATCHED', 'RECONCILED'],
  MATCHED: ['RECONCILED'],
  RECONCILED: [],
  FAILED: [],
};

export class CctpError extends Error {
  constructor(
    readonly code:
      | 'UNSUPPORTED_ROUTE'
      | 'UNSUPPORTED_WALLET'
      | 'BAD_TRANSITION'
      | 'BAD_MESSAGE'
      | 'WRONG_DESTINATION'
      | 'WRONG_RECIPIENT'
      | 'WRONG_REFERENCE'
      | 'FEE_TOO_HIGH'
      | 'IRIS_UNAVAILABLE',
    message: string = code,
  ) {
    super(message);
    this.name = 'CctpError';
  }
}

export type CctpTransfer = Readonly<{
  transferId: string;
  state: CctpState;
  source: ChainName;
  destination: ChainName;
  payer: Address;
  recipient: Address;
  /** Base units burned on the source chain (the payer's gross). */
  amount: bigint;
  maxFee: bigint;
  minFinalityThreshold: number;
  /** Invoice payment reference carried as hookData (data only). */
  reference: Hex | null;
  burnTx: Hex | null;
  messageHash: Hex | null;
  nonce: Hex | null;
  message: Hex | null;
  attestation: Hex | null;
  mintTx: Hex | null;
  minted: bigint | null;
  feeExecuted: bigint | null;
  history: readonly { state: CctpState; at: number; note: string }[];
}>;

export function advance(
  t: CctpTransfer,
  state: CctpState,
  at: number,
  note: string,
  patch: Partial<CctpTransfer> = {},
): CctpTransfer {
  if (t.state === state) return { ...t, ...patch };
  if (!NEXT[t.state].includes(state))
    throw new CctpError('BAD_TRANSITION', `${t.state} -> ${state}`);
  return {
    ...t,
    ...patch,
    state,
    history: [...t.history, { state, at, note }],
  };
}

/** Wallet kinds that can sign the source burn today; others are refused, not bypassed. */
export const SUPPORTED_SIGNERS = ['EOA'] as const;

export function planTransfer(input: {
  transferId: string;
  source: ChainName;
  destination: ChainName;
  payer: Address;
  payerKind: string;
  recipient: Address;
  amount: bigint;
  maxFee: bigint;
  fast: boolean;
  reference: Hex | null;
  at: number;
}): CctpTransfer {
  const src = chainProfile(input.source);
  const dst = chainProfile(input.destination);
  if (
    src.cctpDomain === null ||
    dst.cctpDomain === null ||
    src.chainId === dst.chainId
  )
    throw new CctpError(
      'UNSUPPORTED_ROUTE',
      `${input.source} -> ${input.destination}`,
    );
  if (!src.mutationEnabled || !dst.mutationEnabled)
    throw new CctpError('UNSUPPORTED_ROUTE', 'read-only chain');
  token(input.source, 'USDC');
  token(input.destination, 'USDC');
  if (!(SUPPORTED_SIGNERS as readonly string[]).includes(input.payerKind))
    throw new CctpError(
      'UNSUPPORTED_WALLET',
      `${input.payerKind} cannot sign a CCTP burn here`,
    );
  if (input.amount <= 0n)
    throw new CctpError('UNSUPPORTED_ROUTE', 'amount must be positive');
  if (input.maxFee >= input.amount)
    throw new CctpError('FEE_TOO_HIGH', `${input.maxFee} >= ${input.amount}`);
  if (input.reference && size(input.reference) !== 32)
    throw new CctpError('WRONG_REFERENCE', 'reference must be 32 bytes');
  return {
    transferId: input.transferId,
    state: 'QUOTED',
    source: input.source,
    destination: input.destination,
    payer: input.payer,
    recipient: input.recipient,
    amount: input.amount,
    maxFee: input.maxFee,
    minFinalityThreshold: input.fast ? FAST_FINALITY : STANDARD_FINALITY,
    reference: input.reference,
    burnTx: null,
    messageHash: null,
    nonce: null,
    message: null,
    attestation: null,
    mintTx: null,
    minted: null,
    feeExecuted: null,
    history: [
      { state: 'QUOTED', at: input.at, note: `max fee ${input.maxFee}` },
    ],
  };
}

/** Max fee from Iris' published minimum fee (bps) for the chosen finality, rounded up, plus slack. */
export function maxFeeFor(
  amount: bigint,
  minimumFeeBps: number,
  slackUnits = 0n,
): bigint {
  const scaled = BigInt(Math.round(minimumFeeBps * 100)); // 1 bps → 100 / 1e6
  return (amount * scaled + 999_999n) / 1_000_000n + slackUnits;
}

export type IrisFee = { finalityThreshold: number; minimumFee: number };

export async function irisFees(
  source: ChainName,
  destination: ChainName,
  fetchImpl: typeof fetch = fetch,
): Promise<IrisFee[]> {
  const s = chainProfile(source).cctpDomain;
  const d = chainProfile(destination).cctpDomain;
  const res = await fetchImpl(`${IRIS_SANDBOX}/v2/burn/USDC/fees/${s}/${d}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new CctpError('IRIS_UNAVAILABLE', `fees ${res.status}`);
  return (await res.json()) as IrisFee[];
}

export type IrisMessage = {
  status: string;
  message: Hex | null;
  attestation: Hex | null;
  eventNonce?: string;
};

/**
 * One read of Iris for a burn transaction. Callers poll this; it never
 * triggers any write, so a slow or expired attestation only repeats reads.
 */
export async function irisMessage(
  source: ChainName,
  burnTx: Hex,
  fetchImpl: typeof fetch = fetch,
): Promise<IrisMessage | null> {
  const s = chainProfile(source).cctpDomain;
  const res = await fetchImpl(
    `${IRIS_SANDBOX}/v2/messages/${s}?transactionHash=${burnTx}`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (res.status === 404) return null;
  if (!res.ok)
    throw new CctpError('IRIS_UNAVAILABLE', `messages ${res.status}`);
  const body = (await res.json()) as {
    messages?: {
      status: string;
      message: string;
      attestation: string;
      eventNonce?: string;
    }[];
  };
  const m = body.messages?.[0];
  if (!m) return null;
  const hex = (v: string) =>
    v && v !== 'PENDING' && v.startsWith('0x') ? (v as Hex) : null;
  return {
    status: m.status,
    message: hex(m.message),
    attestation: hex(m.attestation),
    ...(m.eventNonce ? { eventNonce: m.eventNonce } : {}),
  };
}

export type DecodedMessage = Readonly<{
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  nonce: Hex;
  sender: Address;
  recipient: Address;
  destinationCaller: Address;
  minFinalityThreshold: number;
  finalityThresholdExecuted: number;
  burn: Readonly<{
    burnToken: Address;
    mintRecipient: Address;
    amount: bigint;
    messageSender: Address;
    maxFee: bigint;
    feeExecuted: bigint;
    expirationBlock: bigint;
    hookData: Hex;
  }>;
}>;

const addr = (b: Hex) => `0x${b.slice(-40)}` as Address;

/** MessageV2 (148-byte header) + BurnMessageV2 body (228 bytes + hookData). */
export function decodeMessage(message: Hex): DecodedMessage {
  if (size(message) < 148 + 228)
    throw new CctpError('BAD_MESSAGE', `too short (${size(message)})`);
  const body = slice(message, 148);
  return {
    version: hexToNumber(slice(message, 0, 4)),
    sourceDomain: hexToNumber(slice(message, 4, 8)),
    destinationDomain: hexToNumber(slice(message, 8, 12)),
    nonce: slice(message, 12, 44),
    sender: addr(slice(message, 44, 76)),
    recipient: addr(slice(message, 76, 108)),
    destinationCaller: addr(slice(message, 108, 140)),
    minFinalityThreshold: hexToNumber(slice(message, 140, 144)),
    finalityThresholdExecuted: hexToNumber(slice(message, 144, 148)),
    burn: {
      burnToken: addr(slice(body, 4, 36)),
      mintRecipient: addr(slice(body, 36, 68)),
      amount: hexToBigInt(slice(body, 68, 100)),
      messageSender: addr(slice(body, 100, 132)),
      maxFee: hexToBigInt(slice(body, 132, 164)),
      feeExecuted: hexToBigInt(slice(body, 164, 196)),
      expirationBlock: hexToBigInt(slice(body, 196, 228)),
      hookData: size(body) > 228 ? slice(body, 228) : '0x',
    },
  };
}

/**
 * The attested message must say exactly what we burned: same domains, token,
 * recipient, amount and reference. Checked before any mint is submitted and
 * again before an invoice is credited.
 */
export function checkMessage(t: CctpTransfer, m: DecodedMessage): void {
  const src = CHAINS[t.source];
  const dst = CHAINS[t.destination];
  if (
    m.sourceDomain !== src.cctpDomain ||
    m.destinationDomain !== dst.cctpDomain
  )
    throw new CctpError(
      'WRONG_DESTINATION',
      `domains ${m.sourceDomain}->${m.destinationDomain}`,
    );
  if (
    m.burn.burnToken.toLowerCase() !==
    token(t.source, 'USDC').address.toLowerCase()
  )
    throw new CctpError('BAD_MESSAGE', 'burn token is not registry USDC');
  if (m.burn.mintRecipient.toLowerCase() !== t.recipient.toLowerCase())
    throw new CctpError(
      'WRONG_RECIPIENT',
      `${m.burn.mintRecipient} != ${t.recipient}`,
    );
  if (m.burn.amount !== t.amount)
    throw new CctpError('BAD_MESSAGE', 'amount differs');
  const ref = m.burn.hookData === '0x' ? null : m.burn.hookData;
  if ((ref ?? '').toLowerCase() !== (t.reference ?? '').toLowerCase())
    throw new CctpError('WRONG_REFERENCE', `hookData ${ref ?? 'none'}`);
}

/** What the payee actually receives: burned amount less the fee Circle executed. */
export const netMinted = (m: DecodedMessage) =>
  m.burn.amount - m.burn.feeExecuted;
