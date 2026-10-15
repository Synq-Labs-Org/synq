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
  decide(input: { intent: PaymentIntent; risk: RiskInput }): Promise<Decision>;
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
}): PaymentKernelPort {
  return {
    async decide({ intent, risk }) {
      const simulationOk = await input.simulate(intent).catch(() => false);
      const approval = input.ownerApproval?.(intent);
      return decide({
        config: input.config,
        mandate: input.mandate,
        mandateSignature: input.mandateSignature,
        state: await input.state(),
        intent,
        risk,
        simulationOk,
        now: input.now(),
        ...(approval ? { ownerApproval: approval } : {}),
      });
    },
  };
}
