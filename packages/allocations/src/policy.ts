import { recoverTypedDataAddress, type Address, type Hex } from 'viem';
import {
  mandateHash,
  verifyMandateSignature,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  parsePolicy,
  PolicyError,
  mandateFromPolicy,
  hashOf,
  policyTypedData,
  policyHash,
  type RevenuePolicy,
} from './policy-data.js';
export * from './policy-data.js';

export type SignedRevenuePolicy = Readonly<{
  policy: RevenuePolicy;
  policySignature: Hex;
  mandate: PaymentMandate;
  mandateSignature: Hex;
}>;

/**
 * Both signatures recover to the policy owner, and the mandate is exactly
 * the one the policy implies. Throws otherwise.
 */
export async function verifySignedPolicy(
  s: SignedRevenuePolicy,
  now: number,
): Promise<{ policyHash: Hex; mandateHash: Hex }> {
  const p = parsePolicy(s.policy);
  let signer: Address | null = null;
  try {
    signer = await recoverTypedDataAddress({
      ...policyTypedData(p),
      signature: s.policySignature,
    });
  } catch {
    signer = null;
  }
  if (!signer || signer !== p.owner)
    throw new PolicyError(
      'NOT_SIGNED_BY_OWNER',
      `policy signed by ${signer ?? 'nobody'}, owner ${p.owner}`,
    );
  const expected = mandateFromPolicy(p);
  if (hashOf(expected) !== hashOf(s.mandate))
    throw new PolicyError(
      'MANDATE_MISMATCH',
      'mandate is not the one this policy implies',
    );
  try {
    await verifyMandateSignature(s.mandate, s.mandateSignature);
  } catch (e) {
    throw new PolicyError('NOT_SIGNED_BY_OWNER', (e as Error).message);
  }
  if (now < p.validFrom || now >= p.validUntil)
    throw new PolicyError(
      'POLICY_NOT_ACTIVE',
      `valid ${p.validFrom}..${p.validUntil}`,
    );
  return { policyHash: policyHash(p), mandateHash: mandateHash(expected) };
}
