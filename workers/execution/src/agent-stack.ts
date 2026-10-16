import {
  encodeFunctionData,
  decodeFunctionResult,
  erc20Abi,
  isAddressEqual,
  keccak256,
  toHex,
  zeroAddress,
  type Hex,
} from 'viem';
import { chainProfile, contract, token } from '@synq/chain-registry/arc';
import {
  admitAgentJobGrant,
  type AgentJobCall,
} from '@synq/kernel/arc-agent-jobs';
import type { ExecutionGrant, NonceFence } from '@synq/kernel/arc';
import { verifyCode, type ArcChain, type TransferSigner } from './arc.js';
import { sendEscrowCall, type EscrowBroadcastJournal } from './escrow.js';
import { AGENT_JOBS_ABI, MULTICALL_FROM_ABI } from './agent-stack-abi.js';
export { AGENT_JOBS_ABI } from './agent-stack-abi.js';

export const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as Hex;
export async function verifyAgentStackContract(
  chain: ArcChain,
  kind: 'ERC8004_IDENTITY_REGISTRY' | 'ERC8183_AGENTIC_COMMERCE',
) {
  if (
    chain.profile.chainId !== chainProfile('arc-testnet').chainId ||
    chain.profile.name !== 'arc-testnet'
  )
    throw new Error('AGENT_STACK_TESTNET_ONLY');
  if ((await chain.client.getChainId()) !== chainProfile('arc-testnet').chainId)
    throw new Error('AGENT_STACK_RPC_CHAIN_CHANGED');
  const entry = contract('arc-testnet', kind),
    implementation = contract('arc-testnet', `${kind}_IMPLEMENTATION`);
  await verifyCode(chain, entry.address, entry.codeHash);
  await verifyCode(chain, implementation.address, implementation.codeHash);
  const slot = await chain.client.getStorageAt({
    address: entry.address,
    slot: IMPLEMENTATION_SLOT,
  });
  if (!slot || !isAddressEqual(`0x${slot.slice(-40)}`, implementation.address))
    throw new Error('AGENT_STACK_IMPLEMENTATION_CHANGED');
  return entry;
}
export async function readAgentJob(chain: ArcChain, jobId: bigint) {
  const target = await verifyAgentStackContract(
    chain,
    'ERC8183_AGENTIC_COMMERCE',
  );
  return chain.client.readContract({
    address: target.address,
    abi: AGENT_JOBS_ABI,
    functionName: 'getJob',
    args: [jobId],
  });
}
export async function executeAgentJob(input: {
  chain: ArcChain;
  signer: TransferSigner;
  call: AgentJobCall;
  grant: ExecutionGrant;
  grantKey: Uint8Array;
  now: number;
  mandateRevoked: boolean;
  fence: NonceFence;
  journal: EscrowBroadcastJournal;
}) {
  const { chain, call: c, signer } = input;
  const target = await verifyAgentStackContract(
    chain,
    'ERC8183_AGENTIC_COMMERCE',
  );
  const usdc = token('arc-testnet', 'USDC');
  if (
    !isAddressEqual(c.contract, target.address) ||
    c.chainId !== chainProfile('arc-testnet').chainId ||
    !isAddressEqual(c.token, usdc.address) ||
    !isAddressEqual(signer.address, c.sender) ||
    !isAddressEqual(c.hook, zeroAddress) ||
    c.budget <= 0n ||
    c.budget > 10000n
  )
    throw new Error('AGENT_JOB_CALL_REFUSED');
  const [job, paymentToken, platformFee, evaluatorFee, treasury] =
    await Promise.all([
      readAgentJob(chain, c.jobId),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'paymentToken',
      }),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'platformFeeBP',
      }),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'evaluatorFeeBP',
      }),
      chain.client.readContract({
        address: target.address,
        abi: AGENT_JOBS_ABI,
        functionName: 'platformTreasury',
      }),
    ]);
  if (
    !isAddressEqual(paymentToken, usdc.address) ||
    job.id !== c.jobId ||
    !isAddressEqual(job.client, c.client) ||
    !isAddressEqual(job.provider, c.provider) ||
    !isAddressEqual(job.evaluator, c.evaluator) ||
    !isAddressEqual(job.hook, c.hook) ||
    job.budget !== c.budget ||
    job.expiredAt !== c.expiredAt ||
    keccak256(toHex(job.description)) !== c.descriptionHash ||
    platformFee !== c.platformFeeBps ||
    evaluatorFee !== c.evaluatorFeeBps ||
    !isAddressEqual(treasury, c.platformTreasury)
  )
    throw new Error('AGENT_JOB_STATE_DIFFERS_FROM_APPROVAL');
  const step = c.op === 'FUND' ? 'JOB_FUND' : 'JOB_COMPLETE';
  const prior = await input.journal.signed(`${input.grant.grantId}:${step}`);
  if (!prior && job.status !== (c.op === 'FUND' ? 0 : 2))
    throw new Error('AGENT_JOB_WRONG_STATE');
  await admitAgentJobGrant(input);
  if (c.op === 'FUND' && !prior) {
    // Deployed reference fund(jobId,bytes) lacks expectedBudget. Exact allowance
    // bounds its pull even if the provider changes an open job's budget.
    await sendEscrowCall(
      chain,
      signer,
      'bounded job allowance',
      usdc.address,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [target.address, c.budget],
      }),
      {
        journal: input.journal,
        grantId: input.grant.grantId,
        step: 'JOB_APPROVE',
      },
    );
    const allowance = await chain.client.readContract({
      address: usdc.address,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [c.client, target.address],
    });
    if (allowance !== c.budget)
      throw new Error('AGENT_JOB_ALLOWANCE_NOT_EXACT');
  }
  const data =
    c.op === 'FUND'
      ? encodeFunctionData({
          abi: AGENT_JOBS_ABI,
          functionName: 'fund',
          args: [c.jobId, '0x'],
        })
      : encodeFunctionData({
          abi: AGENT_JOBS_ABI,
          functionName: 'complete',
          args: [c.jobId, c.reason, '0x'],
        });
  return sendEscrowCall(
    chain,
    signer,
    `agent job ${c.op.toLowerCase()}`,
    target.address,
    data,
    { journal: input.journal, grantId: input.grant.grantId, step },
  );
}

/** Actual read-only execution, including bounded approval when funding. */
export async function simulateAgentJob(chain: ArcChain, c: AgentJobCall) {
  await verifyAgentStackContract(chain, 'ERC8183_AGENTIC_COMMERCE');
  const fund = encodeFunctionData({
    abi: AGENT_JOBS_ABI,
    functionName: 'fund',
    args: [c.jobId, '0x'],
  });
  if (c.op === 'FUND') {
    const multicall = contract('arc-testnet', 'MULTICALL3_FROM');
    await verifyCode(chain, multicall.address, multicall.codeHash);
    const data = encodeFunctionData({
      abi: MULTICALL_FROM_ABI,
      functionName: 'aggregate3',
      args: [
        [
          {
            target: c.token,
            allowFailure: false,
            callData: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [c.contract, c.budget],
            }),
          },
          { target: c.contract, allowFailure: false, callData: fund },
        ],
      ],
    });
    const out = await chain.client.call({
      account: c.sender,
      to: multicall.address,
      data,
    });
    const results = decodeFunctionResult({
      abi: MULTICALL_FROM_ABI,
      functionName: 'aggregate3',
      data: out.data!,
    });
    if (
      results.length !== 2 ||
      results.some((x) => !x.success) ||
      !decodeFunctionResult({
        abi: erc20Abi,
        functionName: 'approve',
        data: results[0]!.returnData,
      })
    )
      throw new Error('JOB_SIMULATION_FAILED');
  } else
    await chain.client.call({
      account: c.sender,
      to: c.contract,
      data: encodeFunctionData({
        abi: AGENT_JOBS_ABI,
        functionName: 'complete',
        args: [c.jobId, c.reason, '0x'],
      }),
    });
  return {
    ok: true,
    method: 'eth_call',
    blockNumber: await chain.client.getBlockNumber({ cacheTime: 0 }),
  } as const;
}
