import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { recoverMessageAddress } from 'viem';
import type { ApprovalActivities, Hex } from './types.js';

export type ApprovalPorts = {
  /** Current approver set for the group; a signature only counts from a listed member's signer. */
  members(
    proposalId: string,
  ): Promise<readonly { memberId: string; signer: Hex }[]>;
  observeMandate: ApprovalActivities['observeMandateOnchain'];
  applyMandate: ApprovalActivities['applyMandateToKernel'];
  notify: ApprovalActivities['notify'];
};

/** Members approve a mandate proposal by signing its artifact hash (EIP-191 over the 32 bytes). */
export function createApprovalActivities(
  ports: ApprovalPorts,
): ApprovalActivities {
  return {
    async verifyMandateApproval({
      proposalId,
      mandateHash,
      memberId,
      signature,
    }) {
      const member = (await ports.members(proposalId)).find(
        (m) => m.memberId === memberId,
      );
      if (!member)
        return { valid: false, signer: null, reason: 'NOT_A_MEMBER' };
      let signer: Hex;
      try {
        signer = (
          await recoverMessageAddress({
            message: { raw: mandateHash },
            signature,
          })
        ).toLowerCase() as Hex;
      } catch {
        return { valid: false, signer: null, reason: 'SIGNATURE_INVALID' };
      }
      return signer === member.signer.toLowerCase()
        ? { valid: true, signer, reason: null }
        : { valid: false, signer: null, reason: 'SIGNER_MISMATCH' };
    },
    observeMandateOnchain: (input) => ports.observeMandate(input),
    applyMandateToKernel: (input) => ports.applyMandate(input),
    notify: (input) => ports.notify(input),
  };
}

/** Append-only JSONL outbox; a delivery service drains it. */
export function outboxNotifier(path: string): ApprovalActivities['notify'] {
  return async (input) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ...input, at: new Date().toISOString() })}\n`,
    );
    return { delivered: true };
  };
}
