import { hashTypedData, type Address, type Hex } from 'viem';
import { addMoney, money, type AssetRef, type Money } from '@synq/domain';
import {
  addr,
  deepFreeze,
  governanceDomain,
  recoverSigner,
  sameAddress,
} from './common.js';
import { GovernanceError } from './errors.js';

/**
 * Contributor rights. A deposit funds a campaign under the terms in force when
 * it was made; it is never consent to different terms. The only assent is a
 * contributor's EIP-712 signature over the exact terms hash. A ballot vote, a
 * chat reply or a further deposit does not count. Contributors who have not
 * assented to new terms keep their original terms, including refunds.
 */
export type LaunchTerms = Readonly<{
  campaignId: string;
  version: number;
  asset: AssetRef;
  targetBaseUnits: bigint;
  /** Contributions are refundable under these terms until this time. */
  refundableUntil: number;
  /** Hash of the allocation/use-of-funds schedule. */
  allocationHash: Hex;
  summary: string;
}>;

export function launchTermsTypedData(t: LaunchTerms) {
  return {
    domain: governanceDomain(t.asset.chainId),
    types: {
      LaunchTerms: [
        { name: 'campaignId', type: 'string' },
        { name: 'version', type: 'uint64' },
        { name: 'token', type: 'address' },
        { name: 'decimals', type: 'uint8' },
        { name: 'targetBaseUnits', type: 'uint256' },
        { name: 'refundableUntil', type: 'uint64' },
        { name: 'allocationHash', type: 'bytes32' },
        { name: 'summary', type: 'string' },
      ],
    },
    primaryType: 'LaunchTerms' as const,
    message: {
      campaignId: t.campaignId,
      version: BigInt(t.version),
      token: t.asset.address,
      decimals: t.asset.decimals,
      targetBaseUnits: t.targetBaseUnits,
      refundableUntil: BigInt(t.refundableUntil),
      allocationHash: t.allocationHash,
      summary: t.summary,
    },
  };
}
export function launchTermsHash(t: LaunchTerms): Hex {
  if (!t.campaignId || t.version < 1 || t.targetBaseUnits <= 0n)
    throw new GovernanceError(
      'BAD_TERMS',
      'campaign, version and target required',
    );
  return hashTypedData(launchTermsTypedData(t));
}

/** A confirmed deposit. It records funding, not consent. */
export type Contribution = Readonly<{
  contributionId: string;
  campaignId: string;
  contributor: Address;
  amount: Money;
  /** Terms in force when the deposit was made. */
  termsHash: Hex;
  txHash: Hex;
  at: number;
}>;

export type ContributorAssent = Readonly<{
  campaignId: string;
  chainId: number;
  contributor: Address;
  termsHash: Hex;
  termsVersion: number;
  issuedAt: number;
  nonce: Hex;
}>;
export type VerifiedAssent = Readonly<
  ContributorAssent & { signature: Hex; digest: Hex }
>;

export function assentTypedData(a: ContributorAssent) {
  return {
    domain: governanceDomain(a.chainId),
    types: {
      ContributorAssent: [
        { name: 'campaignId', type: 'string' },
        { name: 'contributor', type: 'address' },
        { name: 'termsHash', type: 'bytes32' },
        { name: 'termsVersion', type: 'uint64' },
        { name: 'issuedAt', type: 'uint64' },
        { name: 'nonce', type: 'bytes32' },
      ],
    },
    primaryType: 'ContributorAssent' as const,
    message: {
      campaignId: a.campaignId,
      contributor: a.contributor,
      termsHash: a.termsHash,
      termsVersion: BigInt(a.termsVersion),
      issuedAt: BigInt(a.issuedAt),
      nonce: a.nonce,
    },
  };
}

/** Accepts only the contributor's own signature over exactly these terms. */
export async function verifyAssent(input: {
  assent: ContributorAssent;
  signature: unknown;
  terms: LaunchTerms;
  now: number;
}): Promise<VerifiedAssent> {
  const { assent: a, terms } = input;
  if (
    a.campaignId !== terms.campaignId ||
    a.chainId !== terms.asset.chainId ||
    a.termsVersion !== terms.version ||
    a.termsHash !== launchTermsHash(terms)
  )
    throw new GovernanceError('BAD_ASSENT', 'assent names other terms');
  if (a.issuedAt > input.now)
    throw new GovernanceError('BAD_ASSENT', 'assent from the future');
  const typed = assentTypedData(a);
  const signer = await recoverSigner(typed, input.signature);
  if (!signer || !sameAddress(signer, a.contributor))
    throw new GovernanceError(
      'BAD_ASSENT',
      'assent must be signed by the contributor wallet',
    );
  return deepFreeze({
    ...a,
    contributor: signer,
    signature: input.signature as Hex,
    digest: hashTypedData(typed),
  });
}

export const hasAssented = (
  assents: readonly VerifiedAssent[],
  contributor: Address,
  termsHash: Hex,
) =>
  assents.some(
    (a) => a.termsHash === termsHash && sameAddress(a.contributor, contributor),
  );

export type ContributorPosition = Readonly<{
  contributor: Address;
  contributed: Money;
  /** Distinct terms hashes the deposits were made under. */
  depositedUnder: readonly Hex[];
  status: 'ASSENTED' | 'REFUNDABLE_UNDER_ORIGINAL_TERMS';
}>;

/**
 * Who is bound by `terms`. Funds of contributors without a signed assent to
 * this exact terms hash stay under their original terms and refundable.
 */
export function launchReadiness(input: {
  terms: LaunchTerms;
  contributions: readonly Contribution[];
  assents: readonly VerifiedAssent[];
}): Readonly<{
  termsHash: Hex;
  positions: readonly ContributorPosition[];
  bound: Money;
  refundable: Money;
  pending: readonly Address[];
  allAssented: boolean;
}> {
  const { terms } = input;
  const termsHash = launchTermsHash(terms);
  const zero = money(terms.asset, 0n);
  const by = new Map<string, { contributed: Money; under: Set<Hex> }>();
  for (const c of input.contributions) {
    if (c.campaignId !== terms.campaignId) continue;
    const key = addr(c.contributor);
    const entry = by.get(key) ?? { contributed: zero, under: new Set<Hex>() };
    entry.contributed = addMoney(entry.contributed, c.amount);
    entry.under.add(c.termsHash);
    by.set(key, entry);
  }
  let bound = zero;
  let refundable = zero;
  const positions: ContributorPosition[] = [];
  for (const [contributor, e] of by) {
    const assented = hasAssented(
      input.assents,
      contributor as Address,
      termsHash,
    );
    if (assented) bound = addMoney(bound, e.contributed);
    else refundable = addMoney(refundable, e.contributed);
    positions.push({
      contributor: contributor as Address,
      contributed: e.contributed,
      depositedUnder: [...e.under],
      status: assented ? 'ASSENTED' : 'REFUNDABLE_UNDER_ORIGINAL_TERMS',
    });
  }
  const pending = positions
    .filter((p) => p.status !== 'ASSENTED')
    .map((p) => p.contributor);
  return deepFreeze({
    termsHash,
    positions,
    bound,
    refundable,
    pending,
    allAssented: pending.length === 0,
  });
}

/** Use of a contributor's funds under `terms` requires their own signed assent. */
export function requireAssent(input: {
  terms: LaunchTerms;
  contributor: Address;
  assents: readonly VerifiedAssent[];
}): void {
  if (
    !hasAssented(input.assents, input.contributor, launchTermsHash(input.terms))
  )
    throw new GovernanceError(
      'BAD_ASSENT',
      `${input.contributor} has not signed assent to ${input.terms.campaignId} v${input.terms.version}; a deposit is not assent`,
    );
}
