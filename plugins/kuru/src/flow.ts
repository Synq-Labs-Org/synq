import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  stringToHex,
  type Hex,
} from 'viem';
import type { ProfileName } from '@synq/domain';
import type { PreparedAction } from '@synq/plugin-sdk';
import {
  findToken,
  kuruDeployment,
  type Address,
  type KuruDeployment,
  type KuruToken,
} from './deployment.js';
import { KuruError, requireKuru } from './errors.js';
import { decodeFlowSwap, type FlowSwapCall } from './flow-calldata.js';
import type { KuruFlowClient } from './flow-client.js';
import { parseFlowQuote, type NormalizedFlowQuote } from './flow-schema.js';

export const DEFAULT_QUOTE_TTL_MS = 30_000;
export const MAX_UINT256 = (1n << 256n) - 1n;

export type SwapRequest = {
  profile: ProfileName;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  slippageBps: number;
};
export type FlowQuote = {
  venue: 'kuru-flow';
  quoteId: Hex;
  profile: ProfileName;
  chainId: number;
  account: Address;
  tokenIn: KuruToken;
  tokenOut: KuruToken;
  amountIn: bigint;
  slippageBps: number;
  quotedOutput: bigint;
  providerMinOut: bigint | null;
  shape: NormalizedFlowQuote['shape'];
  transaction: { to: Address; data: Hex; value: bigint };
  gasPrices: Record<string, string> | null;
  receivedAt: number;
  expiresAt: number;
};
export type SwapPolicy = {
  maxSlippageBps: number;
  maxInputAmount: bigint;
  minOutputFloor?: bigint;
  now: number;
};
export type PreparedApproval = {
  token: Address;
  spender: Address;
  amount: bigint;
  calldata: Hex;
};
export type PreparedSwap = {
  venue: 'kuru-flow' | 'kuru-skill';
  chainId: number;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  quotedOutput: bigint;
  minOutput: bigint;
  quoteId: Hex;
  expiresAt: number;
  approval: PreparedApproval | null;
  swap: { target: Address; calldata: Hex; value: bigint };
  calldataHash: Hex;
  decoded: FlowSwapCall;
};
export type SwapExpectation = {
  profile: ProfileName;
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  maxInputAmount: bigint;
  minOutputFloor: bigint;
  quotedOutput: bigint;
  now: number;
  existingAllowance?: bigint;
};

export function minimumOutput(quoted: bigint, slippageBps: number): bigint {
  return (quoted * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}

export function flowDeployment(profile: ProfileName): KuruDeployment & {
  flowEntrypoint: Address;
} {
  const deployment = kuruDeployment(profile);
  if (!deployment.flowEntrypoint)
    throw new KuruError(
      'UNAVAILABLE_IN_NETWORK_PROFILE',
      `Kuru Flow has no entrypoint on ${profile}`,
    );
  return { ...deployment, flowEntrypoint: deployment.flowEntrypoint };
}

function allowedToken(deployment: KuruDeployment, address: Address): KuruToken {
  const token = findToken(deployment, address);
  if (!token) throw new KuruError('TOKEN_NOT_ALLOWED', address);
  return token;
}

/**
 * Independent re-verification of a prepared swap against what the caller authorized. Used before a grant is
 * requested and again before signing, so a mutated calldata, target, spender or amount is rejected.
 */
export function verifyPreparedSwap(
  prepared: PreparedSwap,
  expected: SwapExpectation,
): void {
  const deployment = flowDeployment(expected.profile);
  requireKuru(prepared.chainId === deployment.chainId, 'WRONG_CHAIN');
  requireKuru(expected.now < prepared.expiresAt, 'QUOTE_EXPIRED');
  requireKuru(
    prepared.account === expected.account.toLowerCase(),
    'CALLDATA_MISMATCH',
    'account',
  );
  requireKuru(
    prepared.swap.target === deployment.flowEntrypoint,
    'WRONG_TARGET',
    prepared.swap.target,
  );
  requireKuru(
    keccak256(prepared.swap.calldata) === prepared.calldataHash,
    'CALLDATA_MUTATED',
  );
  const call = decodeFlowSwap(prepared.swap.calldata);
  const tokenIn = allowedToken(deployment, call.tokenIn);
  allowedToken(deployment, call.tokenOut);
  requireKuru(
    call.tokenIn === expected.tokenIn.toLowerCase() &&
      call.tokenOut === expected.tokenOut.toLowerCase() &&
      call.tokenIn === prepared.tokenIn &&
      call.tokenOut === prepared.tokenOut,
    'WRONG_TOKEN',
  );
  requireKuru(
    call.amountIn === expected.amountIn &&
      call.amountIn === prepared.amountIn &&
      call.amountIn <= expected.maxInputAmount &&
      call.amountIn > 0n,
    'MAX_INPUT_BREACH',
  );
  requireKuru(
    call.minAmountOut >= expected.minOutputFloor &&
      call.minAmountOut === prepared.minOutput &&
      call.minAmountOut > 0n,
    'MIN_OUTPUT_BREACH',
  );
  requireKuru(call.minAmountOut <= expected.quotedOutput, 'SLIPPAGE_EXCEEDED');
  requireKuru(
    deployment.flowExecutors.includes(call.executor),
    'CALLDATA_MISMATCH',
    'executor',
  );
  requireKuru(
    call.reserved[0] === 0n &&
      call.reserved[1] === 0n &&
      call.reserved[2] === 0n &&
      call.reserved[3] <= 1n &&
      call.referrer === null,
    'CALLDATA_MISMATCH',
    'reserved',
  );
  requireKuru(call.route.length > 2, 'CALLDATA_MISMATCH', 'route');
  requireKuru(
    prepared.swap.value === (tokenIn.native ? call.amountIn : 0n),
    'CALLDATA_MISMATCH',
    'value',
  );
  if (tokenIn.native) {
    requireKuru(prepared.approval === null, 'APPROVAL_MISMATCH');
    return;
  }
  const approval = prepared.approval;
  if (approval === null) {
    requireKuru(
      expected.existingAllowance !== undefined &&
        expected.existingAllowance >= call.amountIn,
      'APPROVAL_MISMATCH',
      'missing approval',
    );
    return;
  }
  requireKuru(approval.token === tokenIn.address, 'WRONG_TOKEN', 'approval');
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: erc20Abi, data: approval.calldata });
    } catch {
      throw new KuruError('APPROVAL_MISMATCH', 'not an approve call');
    }
  })();
  requireKuru(decoded.functionName === 'approve', 'APPROVAL_MISMATCH');
  const [spender, amount] = decoded.args as readonly [Address, bigint];
  requireKuru(
    spender.toLowerCase() === deployment.flowEntrypoint &&
      approval.spender === deployment.flowEntrypoint,
    'WRONG_SPENDER',
    spender,
  );
  requireKuru(
    amount <= call.amountIn && approval.amount <= call.amountIn,
    'APPROVAL_TOO_LARGE',
  );
  requireKuru(
    amount === call.amountIn && approval.amount === call.amountIn,
    'APPROVAL_MISMATCH',
  );
}

export function exactApproval(
  token: Address,
  spender: Address,
  amount: bigint,
): PreparedApproval {
  if (amount <= 0n || amount >= MAX_UINT256)
    throw new KuruError('APPROVAL_TOO_LARGE');
  return {
    token,
    spender,
    amount,
    calldata: encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender, amount],
    }),
  };
}

export function toPreparedActions(
  prepared: PreparedSwap,
  intentHash: Hex,
): PreparedAction[] {
  const actions: PreparedAction[] = [];
  if (prepared.approval)
    actions.push({
      chainId: prepared.chainId,
      account: prepared.account,
      target: prepared.approval.token,
      calldata: prepared.approval.calldata,
      value: '0',
      intentHash,
    });
  actions.push({
    chainId: prepared.chainId,
    account: prepared.account,
    target: prepared.swap.target,
    calldata: prepared.swap.calldata,
    value: prepared.swap.value.toString(),
    intentHash,
  });
  return actions;
}

/** Kuru Flow aggregator adapter: any supported pair (including AUSD->WMON), mainnet only. */
export class KuruFlowAdapter {
  constructor(
    private readonly client: KuruFlowClient,
    private readonly options: { quoteTtlMs?: number } = {},
  ) {}

  async quote(request: SwapRequest, now: number): Promise<FlowQuote> {
    const deployment = flowDeployment(request.profile);
    const tokenIn = allowedToken(deployment, request.tokenIn);
    const tokenOut = allowedToken(deployment, request.tokenOut);
    requireKuru(tokenIn.address !== tokenOut.address, 'UNSUPPORTED_PAIR');
    requireKuru(
      request.amountIn > 0n && request.amountIn < 1n << 128n,
      'INVALID_AMOUNT',
    );
    requireKuru(
      Number.isInteger(request.slippageBps) &&
        request.slippageBps > 0 &&
        request.slippageBps <= 1_000,
      'SLIPPAGE_EXCEEDED',
    );
    const raw = await this.client.quote({
      userAddress: request.account.toLowerCase() as Address,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amount: request.amountIn,
      slippageBps: request.slippageBps,
    });
    const quote = parseFlowQuote(raw);
    return {
      venue: 'kuru-flow',
      quoteId: keccak256(stringToHex(canonicalJson(raw))),
      profile: request.profile,
      chainId: deployment.chainId,
      account: request.account.toLowerCase() as Address,
      tokenIn,
      tokenOut,
      amountIn: request.amountIn,
      slippageBps: request.slippageBps,
      quotedOutput: quote.output,
      providerMinOut: quote.minOut,
      shape: quote.shape,
      transaction: { to: quote.to, data: quote.data, value: quote.value },
      gasPrices: quote.gasPrices,
      receivedAt: now,
      expiresAt: now + (this.options.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS),
    };
  }

  prepare(quote: FlowQuote, policy: SwapPolicy): PreparedSwap {
    requireKuru(policy.now < quote.expiresAt, 'QUOTE_EXPIRED');
    requireKuru(
      quote.slippageBps <= policy.maxSlippageBps,
      'SLIPPAGE_EXCEEDED',
    );
    requireKuru(quote.amountIn <= policy.maxInputAmount, 'MAX_INPUT_BREACH');
    const deployment = flowDeployment(quote.profile);
    const call = decodeFlowSwap(quote.transaction.data);
    requireKuru(
      quote.providerMinOut === null ||
        quote.providerMinOut === call.minAmountOut,
      'CALLDATA_MISMATCH',
      'quoted minOut differs from calldata',
    );
    const floor = [
      minimumOutput(quote.quotedOutput, policy.maxSlippageBps),
      policy.minOutputFloor ?? 0n,
    ].reduce((a, b) => (a > b ? a : b));
    const prepared: PreparedSwap = {
      venue: 'kuru-flow',
      chainId: quote.chainId,
      account: quote.account,
      tokenIn: quote.tokenIn.address,
      tokenOut: quote.tokenOut.address,
      amountIn: quote.amountIn,
      quotedOutput: quote.quotedOutput,
      minOutput: call.minAmountOut,
      quoteId: quote.quoteId,
      expiresAt: quote.expiresAt,
      approval: quote.tokenIn.native
        ? null
        : exactApproval(
            quote.tokenIn.address,
            deployment.flowEntrypoint,
            quote.amountIn,
          ),
      swap: {
        target: quote.transaction.to,
        calldata: quote.transaction.data,
        value: quote.transaction.value,
      },
      calldataHash: keccak256(quote.transaction.data),
      decoded: call,
    };
    verifyPreparedSwap(prepared, {
      profile: quote.profile,
      account: quote.account,
      tokenIn: quote.tokenIn.address,
      tokenOut: quote.tokenOut.address,
      amountIn: quote.amountIn,
      maxInputAmount: policy.maxInputAmount,
      minOutputFloor: floor,
      quotedOutput: quote.quotedOutput,
      now: policy.now,
    });
    return prepared;
  }
}
