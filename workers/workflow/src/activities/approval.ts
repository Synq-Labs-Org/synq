import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { recoverMessageAddress } from 'viem';
import { artifactHash } from '@synq/kernel';
import type { StartMandateApproval } from '@synq/schemas';
import type { ApprovalActivities, Hex } from './types.js';

export type TrustedMandateProposal = {
  proposal: StartMandateApproval;
  membershipEpoch: number;
  requiredApprovals: number;
};
export const mandateApprovalDigest = (context: TrustedMandateProposal): Hex =>
  artifactHash({
    domain: 'SynqMandateApproval/v1',
    proposal: context.proposal,
    membershipEpoch: context.membershipEpoch,
  });

export type ApprovalPorts = {
  resolveProposal?(proposalId: string): Promise<TrustedMandateProposal | null>;
  now?: () => number;
  /** Current approver set for the group; a signature only counts from a listed member's signer. */
  members(
    proposalId: string,
  ): Promise<readonly { memberId: string; signer: Hex }[]>;
  observeMandate: ApprovalActivities['observeMandateOnchain'];
  applyMandate: ApprovalActivities['applyMandateToKernel'];
  notify: ApprovalActivities['notify'];
};

/** Current members sign the full stored proposal context and membership epoch. */
export function createApprovalActivities(
  ports: ApprovalPorts,
): ApprovalActivities {
  const resolve = async (proposalId: string) => {
    const context = await ports.resolveProposal?.(proposalId);
    if (
      !context ||
      context.proposal.proposalId !== proposalId ||
      context.proposal.expiresAt <=
        (ports.now?.() ?? Math.floor(Date.now() / 1000)) ||
      context.proposal.requiredApprovals !== context.requiredApprovals
    )
      return null;
    const members = await ports.members(proposalId);
    if (
      context.requiredApprovals <= 0 ||
      context.requiredApprovals > members.length ||
      context.proposal.approvers.some(
        (id) => !members.some((m) => m.memberId === id),
      )
    )
      return null;
    return context;
  };
  return {
    async loadMandateProposal({ proposalId }) {
      const context = await resolve(proposalId);
      return context
        ? { proposal: context.proposal, digest: mandateApprovalDigest(context) }
        : null;
    },
    async verifyMandateApproval({
      proposalId,
      mandateHash,
      memberId,
      signature,
    }) {
      const context = await resolve(proposalId);
      if (
        !context ||
        context.proposal.mandateHash !== mandateHash ||
        !context.proposal.approvers.includes(memberId as never)
      )
        return {
          valid: false,
          signer: null,
          reason: 'PROPOSAL_UNAVAILABLE_OR_MISMATCH',
        };
      const member = (await ports.members(proposalId)).find(
        (m) => m.memberId === memberId,
      );
      if (!member)
        return { valid: false, signer: null, reason: 'NOT_A_MEMBER' };
      let signer: Hex;
      try {
        signer = (
          await recoverMessageAddress({
            message: { raw: mandateApprovalDigest(context) },
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
