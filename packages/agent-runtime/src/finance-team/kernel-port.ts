import type { Hex } from 'viem';
import {
  decide,
  type AuthorityConfig,
  type Decision,
  type MandateState,
  type OwnerApproval,
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
    /** Owner EIP-712 signature over `intentApprovalTypedData(intent, terms)`, with the terms. */
    ownerApproval?: OwnerApproval;
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

/**
 * One-use owner approvals across processes: `redeem` returns false when the
 * approval nonce was already redeemed. Optional; the port always also keeps
 * its own in-process set.
 */
export interface ApprovalNonceFence {
  redeem(nonce: Hex): Promise<boolean>;
}

export function arcPaymentKernel(input: {
  config: AuthorityConfig;
  mandate: PaymentMandate;
  mandateSignature: Hex;
  state: () => MandateState | Promise<MandateState>;
  /** Independent simulation of the exact transfer; false or a throw denies. */
  simulate: (intent: PaymentIntent) => Promise<boolean>;
  now: () => number;
  obligations?: ObligationFence;
  approvals?: ApprovalNonceFence;
}): PaymentKernelPort {
  const fence = input.obligations ?? new MemoryObligationFence();
  // Owner-approval nonces redeemed through this port: each approval works once.
  const redeemed = new Set<Hex>();
  return {
    async decide({ intent, risk, ownerApproval, requireOwnerApproval }) {
      const simulationOk = await input.simulate(intent).catch(() => false);
      const approval = ownerApproval;
      const state = await input.state();
      const decision = await decide({
        config: input.config,
        mandate: input.mandate,
        mandateSignature: input.mandateSignature,
        state: {
          ...state,
          usedApprovalNonces: [
            ...(state.usedApprovalNonces ?? []),
            ...redeemed,
          ],
        },
        intent,
        risk,
        simulationOk,
        now: input.now(),
        ...(approval ? { ownerApproval: approval } : {}),
        ...(requireOwnerApproval ? { requireOwnerApproval: true } : {}),
      });
      if (decision.outcome !== 'ALLOW') return decision;
      if (approval) {
        if (input.approvals && !(await input.approvals.redeem(approval.nonce)))
          return {
            outcome: 'DENY',
            reasons: ['owner approval already used'],
          };
        redeemed.add(approval.nonce);
      }
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
