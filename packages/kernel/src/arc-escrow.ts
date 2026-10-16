import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import {
  AuthorityError,
  admitGrant,
  type ExecutionGrant,
  type NonceFence,
  type PaymentIntent,
  type PaymentPurpose,
} from './arc-authority.js';

/**
 * Kernel binding for SynqMilestoneEscrow calls.
 *
 * A Kernel grant authenticates (chain, token, payer, recipient, amount) and
 * its intent id. For an escrow call that is not enough: `open` also fixes the
 * payee, arbiter, refund time, milestone split and the signed terms hash, and
 * `release`/`refund` name an escrow deal and milestone. So an escrow intent's
 * id is derived from a hash of the exact call (`escrowIntentId`), and the
 * executor admits a grant only when the call it is about to sign hashes to
 * that id AND its value view (who pays whom, how much) matches the grant.
 * A grant for milestone 0 cannot release milestone 1; a grant for terms v1
 * cannot open an escrow for terms v2.
 *
 * Value views:
 * - OPEN: the funder pays the escrow contract the milestone total;
 * - RELEASE: the escrow pays the payee one milestone;
 * - REFUND: the escrow pays the original funder one milestone.
 */

export type EscrowOp = 'OPEN' | 'RELEASE' | 'REFUND';

type Base = Readonly<{
  chainId: number;
  escrow: Address;
  token: Address;
  /** Account that sends the transaction. */
  sender: Address;
  /** Signed agreement version hash the escrow deal carries on chain. */
  termsHash: Hex;
}>;

export type EscrowOpenCall = Base &
  Readonly<{
    op: 'OPEN';
    payee: Address;
    arbiter: Address;
    refundAfter: number;
    amounts: readonly bigint[];
  }>;
export type EscrowReleaseCall = Base &
  Readonly<{
    op: 'RELEASE';
    escrowDealId: bigint;
    index: number;
    amount: bigint;
    payee: Address;
  }>;
export type EscrowRefundCall = Base &
  Readonly<{
    op: 'REFUND';
    escrowDealId: bigint;
    index: number;
    amount: bigint;
    /** The deal's original payer: the only possible refund recipient. */
    funder: Address;
  }>;
export type EscrowCall = EscrowOpenCall | EscrowReleaseCall | EscrowRefundCall;

const ZERO = '0x0000000000000000000000000000000000000000' as Address;

export const escrowTotal = (amounts: readonly bigint[]) =>
  amounts.reduce((a, b) => a + b, 0n);

/** keccak256 over every field of the call, including the op. */
export function escrowCallHash(c: EscrowCall): Hex {
  const open = c.op === 'OPEN' ? c : null;
  const moving = c.op === 'OPEN' ? null : c;
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint64' },
        { type: 'uint256[]' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        `synq-escrow:${c.op}`,
        BigInt(c.chainId),
        c.escrow,
        c.token,
        c.sender,
        c.termsHash,
        open?.payee ?? (c.op === 'RELEASE' ? c.payee : ZERO),
        open?.arbiter ?? ZERO,
        BigInt(open?.refundAfter ?? 0),
        [...(open?.amounts ?? [])],
        moving?.escrowDealId ?? 0n,
        BigInt(moving?.index ?? 0),
        moving?.amount ?? 0n,
        c.op === 'REFUND' ? c.funder : ZERO,
      ],
    ),
  );
}

export const escrowIntentId = (c: EscrowCall) =>
  `escrow:${c.op.toLowerCase()}:${escrowCallHash(c)}`;

/** The value movement a grant for this call authorizes. */
export function escrowValueView(c: EscrowCall): {
  chainId: number;
  token: Address;
  payer: Address;
  recipient: Address;
  amount: bigint;
} {
  switch (c.op) {
    case 'OPEN':
      return {
        chainId: c.chainId,
        token: c.token,
        payer: c.sender,
        recipient: c.escrow,
        amount: escrowTotal(c.amounts),
      };
    case 'RELEASE':
      return {
        chainId: c.chainId,
        token: c.token,
        payer: c.escrow,
        recipient: c.payee,
        amount: c.amount,
      };
    case 'REFUND':
      return {
        chainId: c.chainId,
        token: c.token,
        payer: c.escrow,
        recipient: c.funder,
        amount: c.amount,
      };
  }
}

export const ESCROW_PURPOSE: Readonly<Record<EscrowOp, PaymentPurpose>> = {
  OPEN: 'ESCROW_FUNDING',
  RELEASE: 'ESCROW_RELEASE',
  REFUND: 'ESCROW_REFUND',
};

/** Structural checks the Kernel applies before it will evaluate an escrow intent. */
export function validateEscrowCall(c: EscrowCall): void {
  const bad = (why: string) => {
    throw new AuthorityError('GRANT_MISMATCH', `escrow call: ${why}`);
  };
  const lower = (a: string) => a.toLowerCase();
  if (!/^0x[0-9a-f]{64}$/i.test(c.termsHash) || BigInt(c.termsHash) === 0n)
    bad('terms hash missing');
  if (c.op === 'OPEN') {
    if (!c.amounts.length || c.amounts.some((a) => a <= 0n))
      bad('every milestone amount must be positive');
    if (lower(c.payee) === lower(c.sender)) bad('payee is the funder');
    if (
      lower(c.arbiter) === lower(c.sender) ||
      lower(c.arbiter) === lower(c.payee)
    )
      bad('arbiter must be independent of both parties');
    if (!Number.isSafeInteger(c.refundAfter) || c.refundAfter <= 0)
      bad('refundAfter');
  } else {
    if (c.amount <= 0n) bad('amount must be positive');
    if (!Number.isSafeInteger(c.index) || c.index < 0) bad('index');
    if (c.escrowDealId <= 0n) bad('escrow deal id');
  }
}

/**
 * The PaymentIntent the Kernel evaluates for one escrow call. Its id is bound
 * to the call hash, so the resulting grant names exactly this call.
 */
export function escrowIntent(
  c: EscrowCall,
  meta: {
    mandateId: string;
    mandateVersion: number;
    obligationRef: string;
    evidenceHash: Hex;
    proposedBy: string;
  },
): PaymentIntent {
  validateEscrowCall(c);
  const v = escrowValueView(c);
  return {
    intentId: escrowIntentId(c),
    mandateId: meta.mandateId,
    mandateVersion: meta.mandateVersion,
    chainId: v.chainId,
    token: v.token,
    payer: v.payer,
    recipient: v.recipient,
    amount: v.amount,
    purpose: ESCROW_PURPOSE[c.op],
    obligationRef: meta.obligationRef,
    evidenceHash: meta.evidenceHash,
    proposedBy: meta.proposedBy,
  };
}

/**
 * Executor-side admission of an escrow call: the grant must have been issued
 * for an intent whose id is this call's hash, and its value view must match.
 * Consumes the grant nonce (via `admitGrant`).
 */
export async function admitEscrowGrant(input: {
  grantKey: Uint8Array;
  grant: ExecutionGrant;
  call: EscrowCall;
  now: number;
  mandateRevoked: boolean;
  fence: NonceFence;
}): Promise<void> {
  validateEscrowCall(input.call);
  if (input.grant.intentId !== escrowIntentId(input.call))
    throw new AuthorityError(
      'GRANT_MISMATCH',
      'the grant was issued for a different escrow call',
    );
  await admitGrant({
    grantKey: input.grantKey,
    grant: input.grant,
    call: escrowValueView(input.call),
    now: input.now,
    mandateRevoked: input.mandateRevoked,
    fence: input.fence,
  });
}
