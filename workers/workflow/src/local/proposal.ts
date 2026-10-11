import { encodeFunctionData, keccak256, type PublicClient } from 'viem';
import {
  BoundActionIntentSchema,
  LOCAL_CHAIN_ID,
  StartActionExecutionSchema,
  type RiskPacket,
  type StartActionExecution,
} from '@synq/schemas';
import { artifactHash, economicIntentHash } from '@synq/kernel';
import { tokenAbi } from '@synq/execution-worker/abi';
import type { LocalWorkflowManifest } from './manifest.js';

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

export async function localNow(
  client: Pick<PublicClient, 'getBlock'>,
): Promise<number> {
  const block = await client.getBlock({ blockTag: 'latest' });
  return Math.max(Number(block.timestamp), Math.floor(Date.now() / 1000));
}

/**
 * Builds the workflow start payload for a local transfer the way a proposer does: bound intent,
 * chain-anchored evidence and risk packet, and the exact inner calldata the grant binds.
 */
export async function localTransferStart(
  manifest: LocalWorkflowManifest,
  client: Pick<PublicClient, 'getBlock'>,
  input: {
    nonce: string;
    amount: bigint;
    proposedIntentId?: string;
    correlationId?: string;
    approvalTimeoutSeconds?: number;
  },
): Promise<StartActionExecution> {
  const now = await localNow(client);
  const latest = Number(
    (await client.getBlock({ blockTag: 'latest' })).timestamp,
  );
  const mandate = manifest.mandate;
  const calldata = encodeFunctionData({
    abi: tokenAbi,
    functionName: 'transfer',
    args: [manifest.recipient, input.amount],
  });
  const base = BoundActionIntentSchema.parse({
    schemaVersion: 1,
    intentId: input.proposedIntentId ?? `local_intent_${input.nonce}`,
    groupId: mandate.groupId,
    mandateId: mandate.mandateId,
    mandateVersion: mandate.version,
    action: 'TRANSFER',
    chainId: LOCAL_CHAIN_ID,
    account: manifest.account,
    operator: manifest.executor,
    recipient: manifest.recipient,
    pluginId: 'local-transfer',
    target: manifest.token,
    selector: '0xa9059cbb',
    calldataHash: keccak256(calldata),
    inputToken: manifest.token,
    maxInputAmount: String(input.amount),
    minOutputAmount: '0',
    nativeValue: '0',
    validAfter: Math.max(mandate.validAfter, Math.min(latest, now) - 30),
    validUntil: Math.min(now + 900, mandate.validUntil),
    nonce: input.nonce,
    evidenceHash: ZERO_HASH,
    riskPacketHash: ZERO_HASH,
  });
  const block = await client.getBlock();
  const risk: RiskPacket = {
    schemaVersion: 1,
    intentHash: economicIntentHash(base),
    evaluatedAt: now,
    quoteAt: now,
    quoteExpiresAt: now + 300,
    slippageBps: 0,
    referenceDeviationBps: 0,
    maxReferenceDeviationBps: 0,
    blocked: false,
    evidence: [
      {
        source: 'local-chain-transfer',
        retrievedAt: now,
        chainId: LOCAL_CHAIN_ID,
        artifactHash: artifactHash({
          blockHash: block.hash,
          token: manifest.token,
        }),
        untrusted: false,
      },
    ],
  };
  const intent = {
    ...base,
    evidenceHash: artifactHash(risk.evidence),
    riskPacketHash: artifactHash(risk),
  };
  return StartActionExecutionSchema.parse({
    schemaVersion: 1,
    intent,
    mandateRef: {
      groupId: mandate.groupId,
      mandateId: mandate.mandateId,
      version: mandate.version,
    },
    evidenceHash: intent.evidenceHash,
    risk,
    calldata,
    requestedBy: { principalId: 'local-proposer', kind: 'AGENT' },
    correlationId: input.correlationId ?? `local_${input.nonce}`,
    executionMode: manifest.executionMode,
    approvalTimeoutSeconds: input.approvalTimeoutSeconds ?? 3600,
  });
}
