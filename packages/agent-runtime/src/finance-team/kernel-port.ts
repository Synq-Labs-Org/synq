import type { Hex } from 'viem';
import {
  decide,
  type AuthorityConfig,
  type Decision,
  type MandateState,
  type PaymentIntent,
  type PaymentMandate,
  type RiskInput,
} from '@synq/kernel/arc';

/**
 * The only door from the finance team to money movement. Agents hand a typed
 * PaymentIntent plus deterministic risk flags to the Kernel; the Kernel
 * returns ALLOW (with an ExecutionGrant for the restricted executor),
 * REQUIRE_OWNER_APPROVAL or DENY with every reason. The grant key, mandate
 * signature and owner approvals stay inside this closure and never reach a
 * prompt or an agent output other than the MAC'd grant itself.
 */
export interface PaymentKernelPort {
  decide(input: {
    intent: PaymentIntent;
    risk: RiskInput;
    /** Owner EIP-712 signature over `intentApprovalTypedData(intent)`. */
    ownerApproval?: Hex;
    /** Confirmation step: without `ownerApproval` nothing is granted. */
    requireOwnerApproval?: boolean;
  }): Promise<Decision>;
}

/**
 * Atomic one-grant-per-obligation fence. `reserve` returns false when the
 * obligation was already granted. Back it with a unique constraint in
 * production; the default is in-memory per Kernel port.
 */
export interface ObligationFence {
  reserve(obligationRef: string): Promise<boolean>;
}
export class MemoryObligationFence implements ObligationFence {
  private readonly held = new Set<string>();
  async reserve(ref: string) {
    if (this.held.has(ref)) return false;
    this.held.add(ref);
    return true;
  }
}

export function arcPaymentKernel(input: {
  config: AuthorityConfig;
  mandate: PaymentMandate;
  mandateSignature: Hex;
  state: () => MandateState | Promise<MandateState>;
  /** Independent simulation of the exact transfer; false or a throw denies. */
  simulate: (intent: PaymentIntent) => Promise<boolean>;
  now: () => number;
  ownerApproval?: (intent: PaymentIntent) => Hex | undefined;
  obligations?: ObligationFence;
}): PaymentKernelPort {
  const fence = input.obligations ?? new MemoryObligationFence();
  return {
    async decide({ intent, risk, ownerApproval, requireOwnerApproval }) {
      const simulationOk = await input.simulate(intent).catch(() => false);
      const approval = ownerApproval ?? input.ownerApproval?.(intent);
      const decision = await decide({
        config: input.config,
        mandate: input.mandate,
        mandateSignature: input.mandateSignature,
        state: await input.state(),
        intent,
        risk,
        simulationOk,
        now: input.now(),
        ...(approval ? { ownerApproval: approval } : {}),
        ...(requireOwnerApproval ? { requireOwnerApproval: true } : {}),
      });
      if (decision.outcome !== 'ALLOW') return decision;
      // The minted grant never leaves this closure unless the obligation is new.
      if (!(await fence.reserve(intent.obligationRef)))
        return {
          outcome: 'DENY',
          reasons: [
            `obligation ${intent.obligationRef} already has a grant; a second payment is refused`,
          ],
        };
      return decision;
    },
  };
}
