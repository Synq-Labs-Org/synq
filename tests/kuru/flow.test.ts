import { describe, expect, it } from 'vitest';
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  maxUint256,
  type Hex,
} from 'viem';
import {
  FLOW_SWAP_SELECTOR,
  KuruError,
  decodeFlowSwap,
  encodeFlowSwap,
  exactApproval,
  minimumOutput,
  parseFlowQuote,
  verifyPreparedSwap,
  type PreparedSwap,
  type SwapExpectation,
} from '@synq/plugin-kuru';
import {
  ACCOUNT,
  AUSD,
  T0,
  USDC,
  WMON,
  mainnet,
  rawQuote,
  recordedFlow,
} from './fixtures.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof KuruError) return error.code;
    throw error;
  }
  return 'OK';
};
const codeAsync = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (error) {
    if (error instanceof KuruError) return error.code;
    throw error;
  }
  return 'OK';
};
const request = {
  profile: 'proof/monad-mainnet' as const,
  account: ACCOUNT,
  tokenIn: AUSD.address,
  tokenOut: WMON.address,
  amountIn: 1_000_000n,
  slippageBps: 50,
};
const policy = { maxSlippageBps: 75, maxInputAmount: 1_000_000n, now: T0 };

async function prepared() {
  const { adapter } = recordedFlow();
  const quote = await adapter.quote(request, T0);
  return { quote, prepared: adapter.prepare(quote, policy) };
}
function expectation(p: PreparedSwap, patch: Partial<SwapExpectation> = {}) {
  return {
    profile: 'proof/monad-mainnet' as const,
    account: ACCOUNT,
    tokenIn: p.tokenIn,
    tokenOut: p.tokenOut,
    amountIn: p.amountIn,
    maxInputAmount: p.amountIn,
    minOutputFloor: minimumOutput(p.quotedOutput, 75),
    quotedOutput: p.quotedOutput,
    now: T0,
    ...patch,
  };
}
function mutate(p: PreparedSwap, calldata: Hex): PreparedSwap {
  return {
    ...p,
    swap: { ...p.swap, calldata },
    calldataHash: keccak256(calldata),
  };
}

describe('Kuru Flow quote parsing (live shape with spec fallback)', () => {
  it('parses the recorded live AUSD->WMON response and 0x-prefixes the calldata', () => {
    const raw = rawQuote(AUSD.address, WMON.address) as {
      transaction: { calldata: string; to: string };
    };
    expect(raw.transaction.calldata.startsWith('0x')).toBe(false);
    const parsed = parseFlowQuote(raw);
    expect(parsed.shape).toBe('LIVE');
    expect(parsed.data.startsWith(FLOW_SWAP_SELECTOR)).toBe(true);
    expect(parsed.to).toBe(mainnet.flowEntrypoint);
  });
  it('accepts the OpenAPI buildResponse shape', () => {
    const live = parseFlowQuote(rawQuote(AUSD.address, WMON.address));
    const spec = parseFlowQuote({
      type: 'swap_calculation',
      status: 'success',
      output: live.output.toString(),
      path: {},
      buildResponse: {
        transaction: { to: live.to, data: live.data, value: '0' },
      },
    });
    expect(spec).toMatchObject({
      shape: 'SPEC',
      output: live.output,
      data: live.data,
      minOut: null,
    });
  });
  it('a schema change or an error body fails closed', () => {
    const live = rawQuote(AUSD.address, WMON.address) as Record<
      string,
      unknown
    >;
    for (const changed of [
      { ...live, transaction: undefined },
      { ...live, output: 12.5 },
      {
        ...live,
        transaction: { ...(live.transaction as object), to: 'not-an-address' },
      },
      { result: live },
      null,
      'ok',
    ])
      expect(code(() => parseFlowQuote(changed))).toBe('QUOTE_SCHEMA_CHANGED');
    expect(
      code(() =>
        parseFlowQuote({
          error: 'calculation_failed',
          message: 'no candidate paths available between tokens',
        }),
      ),
    ).toBe('QUOTE_FAILED');
  });
});

describe('Kuru Flow calldata verification', () => {
  it('prepares AUSD->WMON with an exact approval to the registry entrypoint and minOut above the policy floor', async () => {
    const { quote, prepared: p } = await prepared();
    expect(p.swap.target).toBe(mainnet.flowEntrypoint);
    expect(p.approval).toMatchObject({
      token: AUSD.address,
      spender: mainnet.flowEntrypoint,
      amount: 1_000_000n,
    });
    expect(p.decoded).toMatchObject({
      tokenIn: AUSD.address,
      tokenOut: WMON.address,
      amountIn: 1_000_000n,
    });
    expect(p.minOutput).toBeGreaterThanOrEqual(
      minimumOutput(quote.quotedOutput, 75),
    );
    expect(p.minOutput).toBe(quote.providerMinOut);
    expect(() => verifyPreparedSwap(p, expectation(p))).not.toThrow();
  });
  it('round-trips the decoder and rejects unknown selectors and non-canonical encodings', async () => {
    const { prepared: p } = await prepared();
    const call = decodeFlowSwap(p.swap.calldata);
    expect(encodeFlowSwap(call)).toBe(p.swap.calldata);
    expect(
      code(() => decodeFlowSwap(`0xdeadbeef${p.swap.calldata.slice(10)}`)),
    ).toBe('CALLDATA_UNKNOWN');
    expect(code(() => decodeFlowSwap('0x1234'))).toBe('CALLDATA_UNKNOWN');
    const dirty =
      `${p.swap.calldata.slice(0, 10 + 64 * 4)}ff${p.swap.calldata.slice(10 + 64 * 4 + 2)}` as Hex;
    expect(code(() => decodeFlowSwap(dirty))).toBe('CALLDATA_UNKNOWN');
  });
  it('TRD-011 wrong spender and wrong target are rejected', async () => {
    const { prepared: p } = await prepared();
    const other = USDC.address;
    expect(
      code(() =>
        verifyPreparedSwap(
          { ...p, approval: exactApproval(AUSD.address, other, p.amountIn) },
          expectation(p),
        ),
      ),
    ).toBe('WRONG_SPENDER');
    expect(
      code(() =>
        verifyPreparedSwap(
          { ...p, swap: { ...p.swap, target: other } },
          expectation(p),
        ),
      ),
    ).toBe('WRONG_TARGET');
  });
  it('TRD-010 unlimited or larger approvals are rejected and never produced', async () => {
    const { prepared: p } = await prepared();
    const unlimited = {
      ...p.approval!,
      amount: maxUint256,
      calldata: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [mainnet.flowEntrypoint!, maxUint256],
      }),
    };
    expect(
      code(() =>
        verifyPreparedSwap({ ...p, approval: unlimited }, expectation(p)),
      ),
    ).toBe('APPROVAL_TOO_LARGE');
    const larger = exactApproval(
      AUSD.address,
      mainnet.flowEntrypoint!,
      p.amountIn + 1n,
    );
    expect(
      code(() =>
        verifyPreparedSwap({ ...p, approval: larger }, expectation(p)),
      ),
    ).toBe('APPROVAL_TOO_LARGE');
    expect(
      code(() =>
        exactApproval(AUSD.address, mainnet.flowEntrypoint!, maxUint256),
      ),
    ).toBe('APPROVAL_TOO_LARGE');
    const smaller = exactApproval(
      AUSD.address,
      mainnet.flowEntrypoint!,
      p.amountIn - 1n,
    );
    expect(
      code(() =>
        verifyPreparedSwap({ ...p, approval: smaller }, expectation(p)),
      ),
    ).toBe('APPROVAL_MISMATCH');
    expect(
      code(() => verifyPreparedSwap({ ...p, approval: null }, expectation(p))),
    ).toBe('APPROVAL_MISMATCH');
  });
  it('calldata mutation is rejected: hash, minOut, amount, token, executor and flags', async () => {
    const { prepared: p } = await prepared();
    const call = decodeFlowSwap(p.swap.calldata);
    const flipped =
      `${p.swap.calldata.slice(0, -2)}${p.swap.calldata.endsWith('00') ? '01' : '00'}` as Hex;
    expect(
      code(() =>
        verifyPreparedSwap(
          { ...p, swap: { ...p.swap, calldata: flipped } },
          expectation(p),
        ),
      ),
    ).toBe('CALLDATA_MUTATED');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, minAmountOut: 1n })),
          expectation(p),
        ),
      ),
    ).toBe('MIN_OUTPUT_BREACH');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, amountIn: call.amountIn * 2n })),
          expectation(p),
        ),
      ),
    ).toBe('MAX_INPUT_BREACH');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, tokenOut: USDC.address })),
          expectation(p),
        ),
      ),
    ).toBe('WRONG_TOKEN');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, executor: USDC.address })),
          expectation(p),
        ),
      ),
    ).toBe('CALLDATA_MISMATCH');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, reserved: [0n, 0n, 0n, 2n] })),
          expectation(p),
        ),
      ),
    ).toBe('CALLDATA_MISMATCH');
    expect(
      code(() =>
        verifyPreparedSwap(
          mutate(p, encodeFlowSwap({ ...call, reserved: [1n, 0n, 0n, 0n] })),
          expectation(p),
        ),
      ),
    ).toBe('CALLDATA_MISMATCH');
    expect(
      code(() =>
        verifyPreparedSwap(
          { ...p, swap: { ...p.swap, value: 1n } },
          expectation(p),
        ),
      ),
    ).toBe('CALLDATA_MISMATCH');
  });
  it('AUSD-021 a prepared trade spending more AUSD than authorized is rejected', async () => {
    const { prepared: p } = await prepared();
    expect(
      code(() =>
        verifyPreparedSwap(
          p,
          expectation(p, { maxInputAmount: p.amountIn - 1n }),
        ),
      ),
    ).toBe('MAX_INPUT_BREACH');
    expect(
      code(() =>
        verifyPreparedSwap(p, expectation(p, { amountIn: p.amountIn - 1n })),
      ),
    ).toBe('MAX_INPUT_BREACH');
    const { adapter } = recordedFlow();
    const quote = await adapter.quote(request, T0);
    expect(
      code(() =>
        adapter.prepare(quote, { ...policy, maxInputAmount: 999_999n }),
      ),
    ).toBe('MAX_INPUT_BREACH');
  });
  it('min-output breach and slippage beyond policy are rejected (TRD-001/TRD-009)', async () => {
    const { prepared: p } = await prepared();
    expect(
      code(() =>
        verifyPreparedSwap(
          p,
          expectation(p, { minOutputFloor: p.minOutput + 1n }),
        ),
      ),
    ).toBe('MIN_OUTPUT_BREACH');
    expect(
      code(() =>
        verifyPreparedSwap(
          p,
          expectation(p, { quotedOutput: p.minOutput - 1n }),
        ),
      ),
    ).toBe('SLIPPAGE_EXCEEDED');
    const { adapter } = recordedFlow();
    const quote = await adapter.quote(request, T0);
    expect(
      code(() => adapter.prepare(quote, { ...policy, maxSlippageBps: 25 })),
    ).toBe('SLIPPAGE_EXCEEDED');
    expect(
      code(() =>
        adapter.prepare(quote, {
          ...policy,
          minOutputFloor: quote.quotedOutput,
        }),
      ),
    ).toBe('MIN_OUTPUT_BREACH');
    expect(
      await codeAsync(() =>
        adapter.quote({ ...request, slippageBps: 1_001 }, T0),
      ),
    ).toBe('SLIPPAGE_EXCEEDED');
    const tampered = recordedFlow((tokenIn, tokenOut) => {
      const raw = rawQuote(
        tokenIn as `0x${string}`,
        tokenOut as `0x${string}`,
      ) as Record<string, unknown>;
      return { ...raw, minOut: '1' };
    });
    const q = await tampered.adapter.quote(request, T0);
    expect(code(() => tampered.adapter.prepare(q, policy))).toBe(
      'CALLDATA_MISMATCH',
    );
  });
  it('TRD-008/TRD-016 quote expiry: a stale quote cannot be prepared or verified', async () => {
    const { adapter } = recordedFlow();
    const quote = await adapter.quote(request, T0);
    expect(quote.expiresAt).toBe(T0 + 30_000);
    expect(
      code(() => adapter.prepare(quote, { ...policy, now: T0 + 30_000 })),
    ).toBe('QUOTE_EXPIRED');
    const p = adapter.prepare(quote, policy);
    expect(
      code(() => verifyPreparedSwap(p, expectation(p, { now: p.expiresAt }))),
    ).toBe('QUOTE_EXPIRED');
  });
  it('wrong token and wrong chain are rejected', async () => {
    const { adapter } = recordedFlow();
    expect(
      await codeAsync(() =>
        adapter.quote({ ...request, tokenOut: ACCOUNT }, T0),
      ),
    ).toBe('TOKEN_NOT_ALLOWED');
    expect(
      await codeAsync(() =>
        adapter.quote({ ...request, tokenOut: AUSD.address }, T0),
      ),
    ).toBe('UNSUPPORTED_PAIR');
    expect(
      await codeAsync(() =>
        adapter.quote({ ...request, profile: 'sandbox/monad-testnet' }, T0),
      ),
    ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
    const { prepared: p } = await prepared();
    expect(
      code(() => verifyPreparedSwap({ ...p, chainId: 10143 }, expectation(p))),
    ).toBe('WRONG_CHAIN');
    expect(
      code(() =>
        verifyPreparedSwap(p, expectation(p, { tokenIn: USDC.address })),
      ),
    ).toBe('WRONG_TOKEN');
    expect(
      code(() =>
        verifyPreparedSwap(
          p,
          expectation(p, { profile: 'sandbox/monad-testnet' }),
        ),
      ),
    ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
  });
  it('accepts the observed stable-pair flag and the recorded USDC->WMON and AUSD->USDC routes', async () => {
    const { adapter } = recordedFlow();
    for (const [tokenIn, tokenOut] of [
      [USDC.address, WMON.address],
      [AUSD.address, USDC.address],
    ] as const) {
      const quote = await adapter.quote({ ...request, tokenIn, tokenOut }, T0);
      const p = adapter.prepare(quote, policy);
      expect(p.decoded.reserved[3]).toBeLessThanOrEqual(1n);
    }
  });
});

describe('Kuru Flow client: 1 rps limiter, token cache and errors', () => {
  it('spaces requests at least 1.1 s apart and reuses the JWT', async () => {
    const { adapter, calls } = recordedFlow();
    await adapter.quote(request, T0);
    await adapter.quote(request, T0);
    expect(calls.map((c) => c.path)).toEqual([
      '/generate-token',
      '/quote',
      '/quote',
    ]);
    for (let i = 1; i < calls.length; i++)
      expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1100);
  });
  it('a 429 is retried once, then surfaces as RATE_LIMITED; HTTP failures are PROVIDER_UNAVAILABLE', async () => {
    let quotes = 0;
    const { fakeFlow } = await import('./fixtures.js');
    const limited = fakeFlow((path) =>
      path === '/generate-token'
        ? { body: { token: 'test-token-not-a-secret-value' } }
        : (quotes++, { status: 429, body: { error: 'too_many_requests' } }),
    );
    expect(await codeAsync(() => limited.adapter.quote(request, T0))).toBe(
      'RATE_LIMITED',
    );
    expect(quotes).toBe(2);
    const down = fakeFlow(() => ({ status: 503, body: 'down' }));
    expect(await codeAsync(() => down.adapter.quote(request, T0))).toBe(
      'PROVIDER_UNAVAILABLE',
    );
  });
});
