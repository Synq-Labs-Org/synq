import { encodeAbiParameters, keccak256, type Address, type Hex } from 'viem';
import {
  admitGrant,
  AuthorityError,
  type ExecutionGrant,
  type NonceFence,
} from './arc-authority.js';

export type AgentJobCall = Readonly<{
  op: 'FUND' | 'COMPLETE';
  chainId: number;
  contract: Address;
  token: Address;
  sender: Address;
  jobId: bigint;
  client: Address;
  provider: Address;
  evaluator: Address;
  budget: bigint;
  expiredAt: bigint;
  descriptionHash: Hex;
  hook: Address;
  reason: Hex;
  platformFeeBps: bigint;
  evaluatorFeeBps: bigint;
  platformTreasury: Address;
}>;
export function agentJobIntentId(c: AgentJobCall) {
  return `agent-job:${keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'address' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        c.op,
        BigInt(c.chainId),
        c.contract,
        c.token,
        c.sender,
        c.jobId,
        c.client,
        c.provider,
        c.evaluator,
        c.budget,
        c.expiredAt,
        c.descriptionHash,
        c.hook,
        c.reason,
        c.platformFeeBps,
        c.evaluatorFeeBps,
        c.platformTreasury,
      ],
    ),
  )}`;
}
export function agentJobValue(c: AgentJobCall) {
  return {
    chainId: c.chainId,
    token: c.token,
    payer: c.op === 'FUND' ? c.client : c.contract,
    recipient: c.op === 'FUND' ? c.contract : c.provider,
    amount: c.budget,
  };
}
export async function admitAgentJobGrant(input: {
  call: AgentJobCall;
  grant: ExecutionGrant;
  grantKey: Uint8Array;
  now: number;
  mandateRevoked: boolean;
  fence: NonceFence;
}) {
  const c = input.call;
  if (
    input.grant.intentId !== agentJobIntentId(c) ||
    c.sender.toLowerCase() !==
      (c.op === 'FUND' ? c.client : c.evaluator).toLowerCase()
  )
    throw new AuthorityError('GRANT_MISMATCH', 'job call or evaluator differs');
  await admitGrant({ ...input, call: agentJobValue(c) });
}
