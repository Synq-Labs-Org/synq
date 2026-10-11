import { encodeFunctionData, keccak256, parseAbi } from 'viem';
import {
  StartActionExecutionSchema,
  type StartActionExecution,
} from '../../../packages/schemas/src/index.js';
import { artifactHash } from '../../../packages/kernel/src/index.js';

const ACCOUNT = '0x1111111111111111111111111111111111111111';
const OPERATOR = '0x2222222222222222222222222222222222222222';
const RECIPIENT = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x4444444444444444444444444444444444444444';
const LOCAL = 31337;

/** A schema-valid StartActionExecution for workflow tests whose Activities are fakes. */
export function startFixture(
  nonce: string,
  overrides: { amount?: bigint; proposedId?: string; now?: number } = {},
): StartActionExecution {
  const amount = overrides.amount ?? 1_000_000n;
  const calldata = encodeFunctionData({
    abi: parseAbi(['function transfer(address,uint256) returns (bool)']),
    functionName: 'transfer',
    args: [RECIPIENT, amount],
  });
  const now = overrides.now ?? Math.floor(Date.now() / 1000);
  const risk = {
    schemaVersion: 1 as const,
    intentHash: `0x${'ab'.repeat(32)}` as const,
    evaluatedAt: now,
    quoteAt: now,
    quoteExpiresAt: now + 300,
    slippageBps: 0,
    referenceDeviationBps: 0,
    maxReferenceDeviationBps: 0,
    blocked: false,
    evidence: [
      {
        source: 'test-evidence',
        retrievedAt: now,
        chainId: LOCAL,
        artifactHash: `0x${'cd'.repeat(32)}` as const,
        untrusted: false,
      },
    ],
  };
  const evidenceHash = artifactHash(risk.evidence);
  return StartActionExecutionSchema.parse({
    schemaVersion: 1,
    intent: {
      schemaVersion: 1,
      intentId: overrides.proposedId ?? `proposal_${nonce}`,
      groupId: 'wf_group',
      mandateId: 'wf_mandate',
      mandateVersion: 1,
      action: 'TRANSFER',
      chainId: LOCAL,
      account: ACCOUNT,
      operator: OPERATOR,
      recipient: RECIPIENT,
      pluginId: 'local-transfer',
      target: TOKEN,
      selector: '0xa9059cbb',
      calldataHash: keccak256(calldata),
      inputToken: TOKEN,
      maxInputAmount: amount.toString(),
      minOutputAmount: '0',
      nativeValue: '0',
      validAfter: now - 10,
      validUntil: now + 600,
      nonce,
      evidenceHash,
      riskPacketHash: artifactHash(risk),
    },
    mandateRef: { groupId: 'wf_group', mandateId: 'wf_mandate', version: 1 },
    evidenceHash,
    risk,
    calldata,
    requestedBy: { principalId: 'brain', kind: 'AGENT' },
    correlationId: `corr_${nonce}`,
    executionMode: 'SIMULATION',
    approvalTimeoutSeconds: 3600,
  });
}
