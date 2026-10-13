import type { EconomicGrantAuthority } from '@synq/kernel';
import {
  BITREFILL,
  BITREFILL_HOSTS,
  DENY_ALL_APPROVALS,
  RealMoneyGate,
  bitrefillInvoiceOfferId,
  type RealMoneyApprovalVerifier,
} from '@synq/plugin-commerce';

type Env = Readonly<Record<string, string | undefined>>;

/** ISO 4217 minor units the Bitrefill invoice amounts are expressed in. */
const MINOR_UNITS: Readonly<Record<string, number>> = { USD: 2, EUR: 2 };

/**
 * Real-money approvals backed by the Kernel's economic grant authority. A
 * reference is accepted only if it names a Kernel grant that the Kernel itself
 * issued (id, HMAC, mandate version, expiry) for Bitrefill, for exactly this
 * invoice, currency and amount; it is then consumed once, atomically, in the
 * Kernel's grant ledger. Mera approvals and anything else are refused.
 */
export class KernelGrantRealMoneyVerifier implements RealMoneyApprovalVerifier {
  constructor(private readonly authority: EconomicGrantAuthority) {}

  async verifyAndConsume(input: {
    reference: { kind: 'KERNEL_GRANT' | 'MERA_APPROVAL'; id: string };
    invoiceId: string;
    amountMinor: bigint;
    currency: string;
    now: number;
  }): Promise<boolean> {
    if (input.reference.kind !== 'KERNEL_GRANT') return false;
    const decimals = MINOR_UNITS[input.currency];
    if (decimals === undefined || input.amountMinor <= 0n) return false;
    const grant = await this.authority.grant(input.reference.id);
    if (!grant) return false;
    const g = grant.execution;
    if (
      g.providerId !== BITREFILL ||
      !BITREFILL_HOSTS.includes(g.host) ||
      g.offerId !== bitrefillInvoiceOfferId(input.invoiceId) ||
      g.maxAmount.currency !== input.currency ||
      g.maxAmount.decimals !== decimals ||
      BigInt(g.maxAmount.amount) !== input.amountMinor
    )
      return false;
    try {
      // Re-verifies id, MAC, expiry and mandate, then inserts the one-time
      // consumption row (unique on grant and intent).
      await this.authority.consume(
        grant,
        {
          ...g,
          maxAmount: {
            amount: String(input.amountMinor),
            currency: input.currency,
            decimals,
          },
        },
        input.now,
      );
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * The Bitrefill real-money gate the runtime hands out. Deny-all unless
 * SYNQ_BITREFILL_APPROVALS=kernel-grant and a Kernel authority is available;
 * even then the broadcast flag and canary cap apply, and `payInvoice` has no
 * payer behind an allowed decision (NO_BROADCAST_PATH).
 */
export function bitrefillRealMoneyGate(
  env: Env,
  authority: EconomicGrantAuthority | null,
): { gate: RealMoneyGate; verifier: 'DENY_ALL' | 'KERNEL_GRANT' } {
  const kernel = env.SYNQ_BITREFILL_APPROVALS === 'kernel-grant' && authority;
  return kernel
    ? {
        gate: new RealMoneyGate(
          env,
          new KernelGrantRealMoneyVerifier(authority),
        ),
        verifier: 'KERNEL_GRANT',
      }
    : {
        gate: new RealMoneyGate(env, DENY_ALL_APPROVALS),
        verifier: 'DENY_ALL',
      };
}
