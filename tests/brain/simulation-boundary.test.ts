import { describe, expect, it } from 'vitest';
import { encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { networkProfileForChain } from '@synq/schemas';
import { ChainSimulation } from '../../apps/api/src/brain-runtime.js';
import { intent, RECIPIENT } from '../../tests/kernel/fixtures.js';
describe('independent simulation boundary observations', () => {
  const network = networkProfileForChain(10143);
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [RECIPIENT, 60n],
  });
  const transfer = intent({
    chainId: network.chainId,
    calldataHash: keccak256(data),
  });
  it('refuses an explicit ERC20 false response', async () => {
    const s = new ChainSimulation(
      {
        getChainId: async () => network.chainId,
        getBlockNumber: async () => 42n,
        call: async () => ({ data: `0x${'0'.repeat(64)}` }),
      } as never,
      { now: () => 1000 },
      network,
    );
    expect(await s.simulate(transfer)).toMatchObject({
      succeeded: false,
      blockNumber: '42',
    });
  });
  it('attests only a canonical ERC20 true return', async () => {
    for (const response of [
      `0x${'0'.repeat(63)}1`,
      '0x',
      `0x${'0'.repeat(63)}2`,
    ]) {
      const s = new ChainSimulation(
        {
          getChainId: async () => network.chainId,
          getBlockNumber: async () => 42n,
          call: async () => ({ data: response }),
        } as never,
        { now: () => 1000 },
        network,
      );
      expect((await s.simulate(transfer)).succeeded).toBe(
        response === `0x${'0'.repeat(63)}1`,
      );
    }
  });
  it('does fail closed on chain mismatch and calldata tampering', async () => {
    const s = new ChainSimulation(
      {
        getChainId: async () => network.chainId,
        getBlockNumber: async () => 42n,
        call: async () => ({ data: '0x' }),
      } as never,
      { now: () => 1000 },
      network,
    );
    await expect(s.simulate({ ...transfer, chainId: 31337 })).rejects.toThrow(
      'SIMULATION_CHAIN_MISMATCH',
    );
    await expect(
      s.simulate({ ...transfer, calldataHash: `0x${'1'.repeat(64)}` }),
    ).rejects.toThrow('SIMULATION_CALLDATA_MISMATCH');
  });
});
