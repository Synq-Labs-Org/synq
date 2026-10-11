import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  numberToHex,
  pad,
  type Hex,
  type PublicClient,
} from 'viem';
import type { Address } from './deployment.js';
import { KuruError } from './errors.js';

type SimClient = Pick<
  PublicClient,
  'simulateCalls' | 'request' | 'getBlockNumber'
>;

export type SwapSimulationInput = {
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  approval: { token: Address; calldata: Hex; spender: Address } | null;
  swap: { target: Address; calldata: Hex; value: bigint };
};
export type SwapSimulation = {
  executionMode: 'MAINNET_SIMULATION';
  method: 'eth_simulateV1';
  blockNumber: string;
  balanceSlot: Hex;
  balanceShift: number;
  inputBalanceBefore: string;
  outputBalanceBefore: string;
  outputBalanceAfter: string;
  outputAmount: string;
  residualAllowance: string | null;
  inputBalanceAfter: string;
  calls: { label: string; status: string; gasUsed: string }[];
  succeeded: boolean;
  failure: string | null;
};

/**
 * Custom errors of the deployed KuruFlowEntrypoint (not source-verified), identified from its bytecode and confirmed by
 * eth_simulateV1 on Monad mainnet (2026-10-10): 0x5264a63f is raised when the routed output is below the calldata's
 * minAmountOut; 0x7939f424 is TransferFromFailed() when it cannot pull tokenIn.
 */
export const FLOW_REVERTS: Readonly<Record<string, string>> = {
  '0x5264a63f': 'OUTPUT_BELOW_MIN_AMOUNT_OUT',
  '0x7939f424': 'TRANSFER_FROM_FAILED',
  '0xfb8f41b2': 'ERC20_INSUFFICIENT_ALLOWANCE',
  '0xe450d38c': 'ERC20_INSUFFICIENT_BALANCE',
};

export function describeFlowRevert(data: Hex | undefined): string | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  return `${FLOW_REVERTS[selector] ?? 'UNKNOWN_REVERT'} (${selector})`;
}

/**
 * Finds the storage slot that holds `owner`'s balance by tracing `balanceOf(owner)` with the prestate tracer and
 * probing each slot the token reads. Tokens that pack flags next to the balance (AUSD keeps a frozen flag in the
 * low byte) are handled by probing bit offsets until the overridden value reads back exactly.
 */
export async function findBalanceSlot(
  client: SimClient,
  token: Address,
  owner: Address,
  probe = 123_456_789n,
): Promise<{ slot: Hex; shift: number }> {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner],
  });
  const trace = (await client.request({
    method: 'debug_traceCall' as never,
    params: [
      { to: token, data },
      'latest',
      { tracer: 'prestateTracer' },
    ] as never,
  })) as Record<string, { storage?: Record<string, Hex> }>;
  const storage = trace[token.toLowerCase()]?.storage ?? {};
  for (const slot of Object.keys(storage) as Hex[])
    for (const shift of [0, 8, 16, 32, 64, 96, 128, 160]) {
      const results = await client.simulateCalls({
        calls: [{ to: token, data }],
        stateOverrides: [
          {
            address: token,
            stateDiff: [
              { slot, value: pad(numberToHex(probe << BigInt(shift))) },
            ],
          },
        ],
      });
      const result = results.results[0];
      if (result?.status !== 'success' || result.data.length !== 66) break;
      const value = decodeFunctionResult({
        abi: erc20Abi,
        functionName: 'balanceOf',
        data: result.data,
      });
      if (value === probe) return { slot, shift };
      if (value === 0n) break;
    }
  throw new KuruError('SIMULATION_FAILED', 'balance slot not found');
}

/**
 * Simulates [approve, swap] from the account with its input-token balance overridden to exactly `amountIn`
 * (eth_simulateV1; nothing is signed or sent) and reads the output balance and residual allowance afterwards.
 */
export async function simulateSwap(
  client: SimClient,
  input: SwapSimulationInput,
): Promise<SwapSimulation> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const { slot, shift } = await findBalanceSlot(
    client,
    input.tokenIn,
    input.account,
  );
  const balanceOf = (token: Address) => ({
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [input.account],
    }),
  });
  const labelled: {
    label: string;
    call: { to: Address; data: Hex; value?: bigint };
  }[] = [
    { label: 'inputBalanceBefore', call: balanceOf(input.tokenIn) },
    { label: 'outputBalanceBefore', call: balanceOf(input.tokenOut) },
    ...(input.approval
      ? [
          {
            label: 'approve',
            call: { to: input.approval.token, data: input.approval.calldata },
          },
        ]
      : []),
    {
      label: 'swap',
      call: {
        to: input.swap.target,
        data: input.swap.calldata,
        value: input.swap.value,
      },
    },
    { label: 'outputBalanceAfter', call: balanceOf(input.tokenOut) },
    { label: 'inputBalanceAfter', call: balanceOf(input.tokenIn) },
    ...(input.approval
      ? [
          {
            label: 'residualAllowance',
            call: {
              to: input.approval.token,
              data: encodeFunctionData({
                abi: erc20Abi,
                functionName: 'allowance',
                args: [input.account, input.approval.spender],
              }),
            },
          },
        ]
      : []),
  ];
  const simulated = await client.simulateCalls({
    account: input.account,
    blockNumber,
    calls: labelled.map((l) => l.call),
    stateOverrides: [
      {
        address: input.tokenIn,
        stateDiff: [
          { slot, value: pad(numberToHex(input.amountIn << BigInt(shift))) },
        ],
      },
    ],
  });
  const results = simulated.results;
  const word = (label: string) => {
    const index = labelled.findIndex((l) => l.label === label);
    const r = results[index];
    if (!r || r.status !== 'success' || r.data.length < 66) return null;
    return BigInt(r.data.slice(0, 66));
  };
  const calls = labelled.map((l, i) => ({
    label: l.label,
    status: results[i]?.status ?? 'missing',
    gasUsed: (results[i]?.gasUsed ?? 0n).toString(),
  }));
  const failed = calls.find((c) => c.status !== 'success');
  const before = word('outputBalanceBefore') ?? 0n;
  const after = word('outputBalanceAfter') ?? 0n;
  const swapIndex = labelled.findIndex((l) => l.label === 'swap');
  const swapResult = results[swapIndex];
  return {
    executionMode: 'MAINNET_SIMULATION',
    method: 'eth_simulateV1',
    blockNumber: blockNumber.toString(),
    balanceSlot: slot,
    balanceShift: shift,
    inputBalanceBefore: (word('inputBalanceBefore') ?? 0n).toString(),
    outputBalanceBefore: before.toString(),
    outputBalanceAfter: after.toString(),
    outputAmount: (after - before).toString(),
    inputBalanceAfter: (word('inputBalanceAfter') ?? 0n).toString(),
    residualAllowance: input.approval
      ? (word('residualAllowance') ?? 0n).toString()
      : null,
    calls,
    succeeded: failed === undefined,
    failure: failed
      ? `${failed.label}: ${swapResult && swapResult.status !== 'success' ? (describeFlowRevert(swapResult.data) ?? String(swapResult.error?.message ?? 'reverted').slice(0, 200)) : 'failed'}`
      : null,
  };
}

export type AssetChangeSimulation = {
  executionMode: 'MAINNET_SIMULATION';
  method: 'eth_simulateV1';
  blockNumber: string;
  calls: { label: string; status: string; error: string | null }[];
  assetChanges: { token: Address; pre: string; post: string; diff: string }[];
  succeeded: boolean;
};

/** Simulates labelled calls with a funded input-token balance and reports every asset change (native included). */
export async function simulateWithAssetChanges(
  client: SimClient,
  input: {
    account: Address;
    fundToken: Address;
    fundAmount: bigint;
    calls: { label: string; to: Address; data: Hex; value?: bigint }[];
  },
): Promise<AssetChangeSimulation> {
  const blockNumber = await client.getBlockNumber({ cacheTime: 0 });
  const { slot, shift } = await findBalanceSlot(
    client,
    input.fundToken,
    input.account,
  );
  const simulated = await client.simulateCalls({
    account: input.account,
    blockNumber,
    traceAssetChanges: true,
    calls: input.calls.map(({ to, data, value }) => ({ to, data, value })),
    stateOverrides: [
      {
        address: input.fundToken,
        stateDiff: [
          { slot, value: pad(numberToHex(input.fundAmount << BigInt(shift))) },
        ],
      },
    ],
  });
  const calls = input.calls.map((c, i) => {
    const r = simulated.results[i];
    return {
      label: c.label,
      status: r?.status ?? 'missing',
      error:
        r && r.status !== 'success'
          ? String(r.error?.message ?? r.data).slice(0, 200)
          : null,
    };
  });
  return {
    executionMode: 'MAINNET_SIMULATION',
    method: 'eth_simulateV1',
    blockNumber: blockNumber.toString(),
    calls,
    assetChanges: simulated.assetChanges.map((a) => ({
      token: a.token.address.toLowerCase() as Address,
      pre: a.value.pre.toString(),
      post: a.value.post.toString(),
      diff: a.value.diff.toString(),
    })),
    succeeded: calls.every((c) => c.status === 'success'),
  };
}
