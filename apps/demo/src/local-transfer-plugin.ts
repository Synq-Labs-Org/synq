import { keccak256, type Hex } from 'viem';
import { artifactHash } from '@synq/kernel';
import type { SynqPlugin } from '@synq/plugin-sdk';
import { ExecutionReceiptSchema, SimulationSchema } from '@synq/schemas';
import type { SandboxContext } from './sandbox.js';

export function localTransferPlugin(
  client: SandboxContext['client'],
  calldata: Hex,
): SynqPlugin {
  return {
    manifest: {
      id: 'local-transfer',
      version: '0.1.0',
      capabilities: ['TRANSFER'],
      chains: [31337],
      environments: ['local/anvil'],
      riskClass: 'FINANCIAL_EXECUTION',
      requiresSimulation: true,
      maxGrantTtlSeconds: 120,
      dependencies: { viem: '2.57.4' },
      sourceIds: ['SYNQ-006'],
      health: { maxStalenessSeconds: 60, checks: ['RPC'] },
    },
    async health(context) {
      const chainId = await client.getChainId();
      return {
        available: chainId === context.network.chainId,
        checkedAt: context.now,
        ...(chainId === context.network.chainId
          ? {}
          : { reason: 'RPC chain id differs from profile' }),
      };
    },
    async prepare(_context, grant) {
      if (keccak256(calldata) !== grant.calldataHash)
        throw new Error('PREPARED_CALL_MISMATCH');
      return [
        {
          chainId: grant.chainId,
          account: grant.account,
          target: grant.target,
          calldata,
          value: grant.nativeValue,
          intentHash: grant.intentHash,
        },
      ];
    },
    async simulate(context, actions) {
      const [action] = actions;
      if (!action || actions.length !== 1 || action.chainId !== 31337)
        throw new Error('SIMULATION_SCOPE');
      const block = await client.getBlock();
      const result = await client.call({
        account: action.account,
        to: action.target,
        data: action.calldata,
        blockNumber: block.number,
      });
      return SimulationSchema.parse({
        intentHash: action.intentHash,
        calldataHash: keccak256(action.calldata),
        chainId: action.chainId,
        account: action.account,
        target: action.target,
        succeeded: true,
        simulatedAt: context.now,
        blockNumber: String(block.number),
        artifactHash: artifactHash({
          blockHash: block.hash,
          result: result.data ?? null,
        }),
      });
    },
    async execute(_context, grant, actions, executor) {
      return executor.execute(grant, actions);
    },
    async reconcile(_context, receipt) {
      const observed = await client.getTransactionReceipt({
        hash: receipt.transactionHash,
      });
      return ExecutionReceiptSchema.parse({
        ...receipt,
        state: 'RECONCILED',
        outcome: observed.status === 'success' ? 'SUCCESS' : 'REVERTED',
        blockNumber: String(observed.blockNumber),
      });
    },
  };
}
