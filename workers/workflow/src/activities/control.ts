import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { recoverMessageAddress } from 'viem';
import { z } from 'zod';
import { artifactHash } from '@synq/kernel';
import type { ControlActivities, WorkflowControlRequest } from './types.js';

const ProofSchema = z.strictObject({
  commandId: z.string().min(8).max(128),
  expiresAt: z.number().int().positive(),
  membershipEpoch: z.number().int().nonnegative(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
});

export function workflowControlDigest(
  input: WorkflowControlRequest,
): `0x${string}` {
  const proof = ProofSchema.parse(input.authorization);
  return artifactHash({
    domain: 'SynqWorkflowControl/v1',
    groupId: input.groupId,
    workflowId: input.workflowId,
    operation: input.operation,
    requestedBy: input.requestedBy,
    reason: input.reason,
    commandId: proof.commandId,
    expiresAt: proof.expiresAt,
    membershipEpoch: proof.membershipEpoch,
  });
}

export function createControlActivities(ports: {
  directory(groupId: string): Promise<{
    membershipEpoch: number;
    members: readonly {
      principalId: string;
      kind: string;
      signer: `0x${string}`;
      active: boolean;
      owner: boolean;
    }[];
  } | null>;
  ledgerDirectory: string;
  now?: () => number;
}): ControlActivities {
  const now = ports.now ?? (() => Math.floor(Date.now() / 1000));
  return {
    async authorizeWorkflowControl(input) {
      const proof = ProofSchema.safeParse(input.authorization);
      if (
        !proof.success ||
        proof.data.expiresAt <= now() ||
        proof.data.expiresAt > now() + 300
      )
        return { authorized: false };
      const directory = await ports.directory(input.groupId);
      const member = directory?.members.find(
        (m) =>
          m.active &&
          m.principalId === input.requestedBy.principalId &&
          m.kind === input.requestedBy.kind,
      );
      if (
        !directory ||
        directory.membershipEpoch !== proof.data.membershipEpoch ||
        !member ||
        !['HUMAN', 'SMART_ACCOUNT'].includes(member.kind)
      )
        return { authorized: false };
      if (input.operation === 'RESUME_EMERGENCY' && !member.owner)
        return { authorized: false };
      const digest = workflowControlDigest(input);
      try {
        const signer = await recoverMessageAddress({
          message: { raw: digest },
          signature: proof.data.signature as `0x${string}`,
        });
        if (signer.toLowerCase() !== member.signer.toLowerCase())
          return { authorized: false };
      } catch {
        return { authorized: false };
      }
      mkdirSync(ports.ledgerDirectory, { recursive: true, mode: 0o700 });
      const path = join(
        ports.ledgerDirectory,
        artifactHash({
          groupId: input.groupId,
          commandId: proof.data.commandId,
        }),
      );
      let fd: number;
      try {
        fd = openSync(path, 'wx', 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        return { authorized: readFileSync(path, 'utf8') === digest };
      }
      try {
        writeFileSync(fd, digest);
      } finally {
        closeSync(fd);
      }
      return { authorized: true };
    },
  };
}
