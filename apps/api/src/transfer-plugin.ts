import { keccak256, type Hex, type PublicClient } from 'viem';
import { artifactHash } from '@synq/kernel';
import type { SynqPlugin } from '@synq/plugin-sdk';
import {
  ExecutionReceiptSchema,
  PluginError,
  SimulationSchema,
  type ChainId,
  type ProfileName,
} from '@synq/domain';

export type TransferPluginClient = Pick<
  PublicClient,
  'getChainId' | 'getBlock' | 'call' | 'getTransactionReceipt'
>;

/**
 * ERC-20 transfer plugin shared by the local and testnet verticals. Simulation
 * runs `eth_call` from the group account at a pinned block; the artifact hash
 * binds the block hash and the call result.
 */
export function erc20TransferPlugin(input: {
  id: string;
  chainId: ChainId;
  environment: ProfileName;
  client: TransferPluginClient;
  calldataFor: (hash: Hex) => Hex | undefined;
}): SynqPlugin {
  const { client, calldataFor } = input;
  return {
    manifest: {
      id: input.id,
      version: '0.1.0',
      capabilities: ['TRANSFER'],
      chains: [input.chainId],
      environments: [input.environment],
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
      const calldata = calldataFor(grant.calldataHash);
      if (!calldata || keccak256(calldata) !== grant.calldataHash)
        throw new PluginError('PREPARED_CALL_MISMATCH');
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
      if (!action || actions.length !== 1 || action.chainId !== input.chainId)
        throw new PluginError('SIMULATION_SCOPE');
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
