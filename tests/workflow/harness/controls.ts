import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import {
  createControlActivities,
  workflowControlDigest,
} from '../../../workers/workflow/src/activities/control.js';
import type { WorkflowControlRequest } from '../../../workers/workflow/src/activities/types.js';
import type { ControlInput } from '../../../workers/workflow/src/workflows/messages.js';

/** Locally generated software signers; no production identity assertion. */
export function fixtureControls(ledgerDirectory: string, groups: string[]) {
  const signers = new Map(
    ['member_ops', 'member_2', 'owner'].map((id) => [
      id,
      privateKeyToAccount(generatePrivateKey()),
    ]),
  );
  const activities = createControlActivities({
    ledgerDirectory,
    directory: async (groupId) =>
      groups.includes(groupId)
        ? {
            membershipEpoch: 4,
            members: [...signers].map(([principalId, account]) => ({
              principalId,
              kind: 'HUMAN',
              signer: account.address,
              active: true,
              owner: true,
            })),
          }
        : null,
  });
  async function sign(
    groupId: string,
    workflowId: string,
    operation: WorkflowControlRequest['operation'],
    reason: string,
    principalId = 'member_ops',
  ): Promise<ControlInput> {
    const signer = signers.get(principalId);
    if (!signer) throw new Error('UNKNOWN_FIXTURE_SIGNER');
    const input: WorkflowControlRequest = {
      groupId,
      workflowId,
      operation,
      requestedBy: { principalId, kind: 'HUMAN' },
      reason,
      authorization: {
        commandId: randomUUID(),
        expiresAt: Math.floor(Date.now() / 1000) + 240,
        membershipEpoch: 4,
        signature: '0x00',
      },
    };
    input.authorization!.signature = await signer.signMessage({
      message: { raw: workflowControlDigest(input) },
    });
    return {
      requestedBy: input.requestedBy,
      reason,
      authorization: input.authorization,
    };
  }
  return { activities, sign };
}
