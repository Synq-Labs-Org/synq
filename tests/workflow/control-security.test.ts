import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createControlActivities,
  workflowControlDigest,
} from '../../workers/workflow/src/activities/control.js';
import {
  createApprovalActivities,
  mandateApprovalDigest,
} from '../../workers/workflow/src/activities/approval.js';
import type { WorkflowControlRequest } from '../../workers/workflow/src/activities/types.js';
import type { StartMandateApproval } from '@synq/schemas';

describe('workflow authority boundary (SIMULATION)', () => {
  it('binds a signed control to group, workflow, operation and current membership across restart', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const dir = mkdtempSync(join(tmpdir(), 'synq-control-proof-'));
    let active = true;
    const ports = {
      ledgerDirectory: dir,
      now: () => 1000,
      directory: async () => ({
        membershipEpoch: 4,
        members: [
          {
            principalId: 'member_ops',
            kind: 'HUMAN',
            signer: account.address,
            active,
            owner: true,
          },
        ],
      }),
    };
    const input: WorkflowControlRequest = {
      groupId: 'group',
      workflowId: 'workflow',
      operation: 'CANCEL',
      requestedBy: { principalId: 'member_ops', kind: 'HUMAN' },
      reason: 'stop',
      authorization: {
        commandId: 'command001',
        expiresAt: 1100,
        membershipEpoch: 4,
        signature: '0x00',
      },
    };
    input.authorization!.signature = await account.signMessage({
      message: { raw: workflowControlDigest(input) },
    });
    try {
      expect(
        await createControlActivities(ports).authorizeWorkflowControl(input),
      ).toEqual({ authorized: true });
      expect(
        await createControlActivities(ports).authorizeWorkflowControl(input),
      ).toEqual({ authorized: true });
      for (const changed of [
        { workflowId: 'other' },
        { groupId: 'other' },
        { operation: 'RESUME' as const },
        { reason: 'different' },
        { authorization: { ...input.authorization!, membershipEpoch: 3 } },
        { authorization: { ...input.authorization!, expiresAt: 999 } },
      ]) {
        expect(
          await createControlActivities(ports).authorizeWorkflowControl({
            ...input,
            ...changed,
          }),
        ).toEqual({ authorized: false });
      }
      active = false;
      expect(
        await createControlActivities(ports).authorizeWorkflowControl(input),
      ).toEqual({ authorized: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('requires the trusted full proposal context, not a signature over the mandate hash', async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const proposal: StartMandateApproval = {
      schemaVersion: 1,
      proposalId: 'proposal',
      kind: 'SUPERSEDE',
      mandateRef: {
        groupId: 'g' as never,
        mandateId: 'm' as never,
        version: 2,
      },
      mandateHash: `0x${'11'.repeat(32)}`,
      securitySensitive: true,
      approvers: ['member' as never],
      requiredApprovals: 1,
      expiresAt: 1100,
      requestedBy: { principalId: 'member' as never, kind: 'HUMAN' },
      correlationId: 'correlation' as never,
    };
    let context = { proposal, membershipEpoch: 4, requiredApprovals: 1 };
    const acts = createApprovalActivities({
      now: () => 1000,
      resolveProposal: async () => context,
      members: async () => [{ memberId: 'member', signer: account.address }],
      observeMandate: async () => ({ observed: false, block: null }),
      applyMandate: async () => ({ applied: false, version: 2 }),
      notify: async () => ({ delivered: true }),
    });
    const input = {
      proposalId: proposal.proposalId,
      mandateHash: proposal.mandateHash,
      memberId: 'member',
      signature: await account.signMessage({
        message: { raw: mandateApprovalDigest(context) },
      }),
    };
    expect((await acts.verifyMandateApproval(input)).valid).toBe(true);
    context = {
      ...context,
      proposal: {
        ...proposal,
        mandateRef: { ...proposal.mandateRef, version: 3 },
      },
    };
    expect((await acts.verifyMandateApproval(input)).valid).toBe(false);
    context = {
      ...context,
      proposal: { ...proposal, requiredApprovals: 0 },
      requiredApprovals: 0,
    };
    expect(
      await acts.loadMandateProposal({ proposalId: proposal.proposalId }),
    ).toBeNull();
  });
});
