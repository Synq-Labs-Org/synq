import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import {
  DealRoomError,
  type AttestationKind,
  type Evidence,
  type Party,
  type ProvenanceMap,
  type Terms,
} from './schema.js';

/**
 * EIP-712 messages of the Deal Room, all in the `Synq DealRoom` domain bound
 * to the chain id and the escrow contract:
 *
 * - `DealTerms`: the full economic terms of one version. Its EIP-712 digest is
 *   the version's `termsHash`, and it is what goes on chain as the escrow's
 *   `termsHash`. A party ACCEPTS a version by signing exactly this message, so
 *   the wallet shows every amount, deadline, payee and the arbiter.
 * - `DealDecision`: a party's signed REJECT of one version.
 * - `MilestoneAttestation`: a human statement about one milestone (delivered,
 *   accept-and-release, dispute, arbiter resolution) bound to the terms hash,
 *   the evidence hash, a one-use nonce and a deadline.
 */

export const DEALROOM_DOMAIN_NAME = 'Synq DealRoom';
export const DEALROOM_DOMAIN_VERSION = '1';

export const dealDomain = (chainId: number, escrow: Address) => ({
  name: DEALROOM_DOMAIN_NAME,
  version: DEALROOM_DOMAIN_VERSION,
  chainId,
  verifyingContract: escrow,
});

export const DEAL_TERMS_TYPES = {
  Party: [
    { name: 'role', type: 'string' },
    { name: 'principalId', type: 'string' },
    { name: 'wallet', type: 'address' },
  ],
  Milestone: [
    { name: 'index', type: 'uint256' },
    { name: 'title', type: 'string' },
    { name: 'amount', type: 'uint256' },
    { name: 'deadline', type: 'uint64' },
    { name: 'acceptanceCondition', type: 'string' },
    { name: 'evidenceType', type: 'string' },
    { name: 'payee', type: 'address' },
  ],
  DealTerms: [
    { name: 'dealId', type: 'string' },
    { name: 'version', type: 'uint256' },
    { name: 'parentTermsHash', type: 'bytes32' },
    { name: 'title', type: 'string' },
    { name: 'scope', type: 'string' },
    { name: 'deliverables', type: 'string[]' },
    { name: 'client', type: 'Party' },
    { name: 'freelancer', type: 'Party' },
    { name: 'arbiter', type: 'Party' },
    { name: 'token', type: 'address' },
    { name: 'total', type: 'uint256' },
    { name: 'deposit', type: 'uint256' },
    { name: 'milestones', type: 'Milestone[]' },
    { name: 'refundAfter', type: 'uint64' },
    { name: 'disputePeriod', type: 'uint64' },
    { name: 'refundPolicy', type: 'string' },
    { name: 'cancellation', type: 'string' },
    { name: 'expiresAt', type: 'uint64' },
    { name: 'provenanceHash', type: 'bytes32' },
  ],
} as const;

const ZERO32 = `0x${'00'.repeat(32)}` as Hex;
const party = (p: Party) => ({
  role: p.role,
  principalId: p.principalId,
  wallet: p.wallet,
});

/** Stable JSON: sorted keys, bigint as decimal strings. */
export function canonical(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(v.toString());
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v as object)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(v);
}

export const provenanceHash = (p: ProvenanceMap): Hex =>
  keccak256(toHex(canonical(p)));

export function dealTermsTypedData(input: {
  dealId: string;
  version: number;
  parentTermsHash: Hex | null;
  terms: Terms;
  provenanceHash: Hex;
}) {
  const t = input.terms;
  return {
    domain: dealDomain(t.asset.chainId, t.escrow),
    types: DEAL_TERMS_TYPES,
    primaryType: 'DealTerms' as const,
    message: {
      dealId: input.dealId,
      version: BigInt(input.version),
      parentTermsHash: input.parentTermsHash ?? ZERO32,
      title: t.title,
      scope: t.scope,
      deliverables: [...t.deliverables],
      client: party(t.client),
      freelancer: party(t.freelancer),
      arbiter: party(t.arbiter),
      token: t.asset.token,
      total: t.total,
      deposit: t.deposit,
      milestones: t.milestones.map((m) => ({
        index: BigInt(m.index),
        title: m.title,
        amount: m.amount,
        deadline: BigInt(m.deadline),
        acceptanceCondition: m.acceptanceCondition,
        evidenceType: m.evidenceType,
        payee: m.payee,
      })),
      refundAfter: BigInt(t.refundAfter),
      disputePeriod: BigInt(t.dispute.periodSeconds),
      refundPolicy: t.refundPolicy,
      cancellation: t.cancellation,
      expiresAt: BigInt(t.expiresAt),
      provenanceHash: input.provenanceHash,
    },
  };
}

/** The version's identity: EIP-712 digest of its DealTerms. */
export const termsHashOf = (input: Parameters<typeof dealTermsTypedData>[0]) =>
  hashTypedData(dealTermsTypedData(input)).toLowerCase() as Hex;

export const DEAL_DECISION_TYPES = {
  DealDecision: [
    { name: 'dealId', type: 'string' },
    { name: 'version', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'role', type: 'string' },
    { name: 'decision', type: 'string' },
    { name: 'reason', type: 'string' },
  ],
} as const;

export function dealDecisionTypedData(input: {
  chainId: number;
  escrow: Address;
  dealId: string;
  version: number;
  termsHash: Hex;
  role: string;
  decision: 'REJECT' | 'CANCEL';
  reason: string;
}) {
  return {
    domain: dealDomain(input.chainId, input.escrow),
    types: DEAL_DECISION_TYPES,
    primaryType: 'DealDecision' as const,
    message: {
      dealId: input.dealId,
      version: BigInt(input.version),
      termsHash: input.termsHash,
      role: input.role,
      decision: input.decision,
      reason: input.reason,
    },
  };
}

export const ATTESTATION_TYPES = {
  MilestoneAttestation: [
    { name: 'dealId', type: 'string' },
    { name: 'version', type: 'uint256' },
    { name: 'termsHash', type: 'bytes32' },
    { name: 'milestone', type: 'uint256' },
    { name: 'kind', type: 'string' },
    { name: 'role', type: 'string' },
    { name: 'evidenceHash', type: 'bytes32' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'deadline', type: 'uint64' },
  ],
} as const;

export function attestationTypedData(input: {
  chainId: number;
  escrow: Address;
  dealId: string;
  version: number;
  termsHash: Hex;
  milestone: number;
  kind: AttestationKind;
  role: string;
  evidenceHash: Hex;
  nonce: Hex;
  deadline: number;
}) {
  return {
    domain: dealDomain(input.chainId, input.escrow),
    types: ATTESTATION_TYPES,
    primaryType: 'MilestoneAttestation' as const,
    message: {
      dealId: input.dealId,
      version: BigInt(input.version),
      termsHash: input.termsHash,
      milestone: BigInt(input.milestone),
      kind: input.kind,
      role: input.role,
      evidenceHash: input.evidenceHash,
      nonce: input.nonce,
      deadline: BigInt(input.deadline),
    },
  };
}

/**
 * The part of evidence a party asserts and signs: what was delivered, not who
 * checked it or when (`verifiedBy` / `checkedAt` are set only by the server).
 */
export const evidenceClaim = (e: Evidence) => ({
  type: e.type,
  url: e.url,
  repo: e.repo,
  commitSha: e.commitSha,
  prNumber: e.prNumber,
  sha256: e.sha256,
});

/** keccak over the evidence claim's canonical JSON; zero when an attestation carries none. */
export const evidenceHashOf = (e: Evidence | null): Hex =>
  e ? keccak256(toHex(canonical(evidenceClaim(e)))) : ZERO32;

/** Recovers the signer of typed data; a malformed signature is BAD_SIGNATURE. */
export async function recoverSigner(
  typed: Parameters<typeof recoverTypedDataAddress>[0],
): Promise<Address> {
  try {
    return await recoverTypedDataAddress(typed);
  } catch {
    throw new DealRoomError('BAD_SIGNATURE', 'unrecoverable signature');
  }
}
