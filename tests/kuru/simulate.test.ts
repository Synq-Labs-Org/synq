import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, type Hex } from 'viem';
import {
  describeFlowRevert,
  simulateSwap,
  type Address,
} from '@synq/plugin-kuru';
import { ACCOUNT, AUSD, WMON, mainnet } from './fixtures.js';

const SLOT =
  '0x57ee271a509650e7dc42844e5cedef9c673464f3c257a61a0c28c7607936cb2a' as Hex;
const word = (v: bigint) => encodeAbiParameters([{ type: 'uint256' }], [v]);

function fakeClient(swap: { status: 'success' | 'failure'; data: Hex }) {
  let probe = 0n;
  return {
    getBlockNumber: async () => 100n,
    request: async () => ({
      [AUSD.address.toLowerCase()]: { storage: { [SLOT]: '0x0' } },
    }),
    simulateCalls: async (args: {
      calls: unknown[];
      stateOverrides?: { stateDiff: { value: Hex }[] }[];
    }) => {
      if (args.calls.length === 1) {
        probe = BigInt(args.stateOverrides![0]!.stateDiff[0]!.value);
        return { results: [{ status: 'success', data: word(probe) }] };
      }
      const ok = (v: bigint) => ({
        status: 'success',
        data: word(v),
        gasUsed: 1n,
      });
      return {
        results: [
          ok(1_000_000n),
          ok(0n),
          ok(1n),
          { ...swap, gasUsed: 1n, error: new Error('execution reverted') },
          ok(0n),
          ok(1_000_000n),
          ok(0n),
        ],
      };
    },
  } as never;
}

const input = {
  account: ACCOUNT,
  tokenIn: AUSD.address,
  tokenOut: WMON.address,
  amountIn: 1_000_000n,
  approval: {
    token: AUSD.address,
    calldata: '0x' as Hex,
    spender: mainnet.flowEntrypoint as Address,
  },
  swap: {
    target: mainnet.flowEntrypoint as Address,
    calldata: '0x' as Hex,
    value: 0n,
  },
};

describe('Flow simulation revert decoding (MAINNET_SIMULATION harness)', () => {
  it('names the entrypoint min-output revert and ERC20 custom errors', () => {
    expect(describeFlowRevert('0x5264a63f')).toBe(
      'OUTPUT_BELOW_MIN_AMOUNT_OUT (0x5264a63f)',
    );
    expect(describeFlowRevert('0x7939f424')).toBe(
      'TRANSFER_FROM_FAILED (0x7939f424)',
    );
    expect(describeFlowRevert('0xdeadbeef')).toBe(
      'UNKNOWN_REVERT (0xdeadbeef)',
    );
    expect(describeFlowRevert('0x')).toBeNull();
  });

  it('a swap reverting below minAmountOut fails the simulation with the decoded reason', async () => {
    const result = await simulateSwap(
      fakeClient({ status: 'failure', data: '0x5264a63f' }),
      input,
    );
    expect(result.succeeded).toBe(false);
    expect(result.failure).toBe(
      'swap: OUTPUT_BELOW_MIN_AMOUNT_OUT (0x5264a63f)',
    );
  });
});
