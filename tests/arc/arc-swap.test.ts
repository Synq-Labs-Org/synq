import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Address,
  type Hex,
} from 'viem';
import { moneyFromDecimal } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import {
  ADAPTER_EXECUTE_ABI,
  KitTxGuard,
  KitTxGuardError,
  decodeAdapterExecute,
  kitDecimalToUnits,
  unitsToKitDecimal,
} from '@synq/plugin-circle-app-kit';
import {
  SwapError,
  approveSwap,
  normalizeSwapEstimate,
  reconcileSwap,
  swapPlan,
  swapPolicy,
} from '@synq/plugin-arc-swap';
import fixtures from './fixtures/app-kit-executes.json' with { type: 'json' };

const usdc = token('arc-testnet', 'USDC');
const eurc = token('arc-testnet', 'EURC');
const adapter = contract('arc-testnet', 'CIRCLE_APP_KIT_ADAPTER').address;
const swapTx = fixtures.swapExecute.input as Hex;
// The wallet that signed the live swap is the beneficiary of its outputs.
const owner = decodeAdapterExecute(swapTx).tokens[0]!.beneficiary;
const evil = `0x${'7'.repeat(40)}` as Address;

// The kit's estimate for that swap (scripts/arc-swap-proof.ts evidence).
const estimate = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '0.02',
  chainIn: 'Arc_Testnet',
  chainOut: 'Arc_Testnet',
  chain: 'Arc_Testnet',
  fromAddress: owner,
  toAddress: owner,
  stopLimit: { amount: '0.022549', token: 'EURC' },
  estimatedOutput: { amount: '0.022777', token: 'EURC' },
  fees: [
    { token: 'USDC', amount: '0.000004', type: 'provider' },
    { token: 'USDC', amount: '0.02649037125', type: 'gas' },
  ],
};
const policy = swapPolicy({
  chain: 'arc-testnet',
  pairs: [['USDC', 'EURC']],
  maxSlippageBps: 100,
  maxAmountIn: moneyFromDecimal(usdc, '0.02'),
});
const t0 = 1_792_131_000_000;

function livePlan() {
  const quote = normalizeSwapEstimate(estimate, {
    observedAt: t0,
    wallet: owner,
  });
  const approved = approveSwap(quote, policy, t0 + 1_000);
  return {
    approved,
    steps: swapPlan({
      owner,
      approved,
      nowSec: BigInt(fixtures.swapExecute.blockTimestamp - 30),
    }),
  };
}
const reencode = (
  mut: (
    p: ReturnType<
      typeof decodeFunctionData<typeof ADAPTER_EXECUTE_ABI>
    >['args'][0],
  ) => typeof p,
) => {
  const [p, inputs, sig] = decodeFunctionData({
    abi: ADAPTER_EXECUTE_ABI,
    data: swapTx,
  }).args;
  return encodeFunctionData({
    abi: ADAPTER_EXECUTE_ABI,
    functionName: 'execute',
    args: [mut(p), inputs, sig],
  });
};
const executeOnly = () =>
  new KitTxGuard(
    owner,
    livePlan().steps.filter((s) => s.kind === 'EXECUTE'),
  );
const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ACCEPTED';
  } catch (e) {
    return (e as KitTxGuardError | SwapError).code;
  }
};

describe('Arc App Kit swap (P15)', () => {
  it('normalises the quote to integer registry units and computes the floor', () => {
    const { approved } = livePlan();
    expect(approved.quote.amountIn.baseUnits).toBe(20_000n);
    expect(approved.quote.amountIn.asset.address).toBe(usdc.address);
    expect(approved.quote.estimatedOut.asset.address).toBe(eurc.address);
    expect(approved.minOut.baseUnits).toBe(22_549n);
    expect(approved.impliedSlippageBps).toBe(100);
    expect(approved.quote.providerFee?.baseUnits).toBe(4n);
    expect(kitDecimalToUnits('0.000001', 6)).toBe(1n);
    expect(unitsToKitDecimal(49_999n, 6)).toBe('0.049999');
    expect(() => kitDecimalToUnits('0.0000001', 6)).toThrow(KitTxGuardError);
    expect(() => kitDecimalToUnits('1e-6', 6)).toThrow(KitTxGuardError);
  });

  it('P15-06 the live execute passes; changed recipient, selector, target, min output or fee are refused', () => {
    expect(
      code(() =>
        executeOnly().check({ from: owner, to: adapter, data: swapTx }),
      ),
    ).toBe('ACCEPTED');
    const cases: Record<string, () => unknown> = {
      recipient: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: reencode((p) => ({
            ...p,
            tokens: p.tokens.map((t) => ({ ...t, beneficiary: evil })),
          })),
        }),
      oneOutputRedirected: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: reencode((p) => ({
            ...p,
            tokens: p.tokens.map((t, i) =>
              i === p.tokens.length - 1 ? { ...t, beneficiary: evil } : t,
            ),
          })),
        }),
      slippage: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: reencode((p) => ({
            ...p,
            instructions: p.instructions.map((i) =>
              i.minTokenOut > 0n
                ? { ...i, minTokenOut: i.minTokenOut - 1n }
                : i,
            ),
          })),
        }),
      fee: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: reencode((p) => ({
            ...p,
            instructions: p.instructions.map((i) =>
              i.minTokenOut === 0n
                ? { ...i, amountToApprove: i.amountToApprove + 1n }
                : i,
            ),
          })),
        }),
      selector: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: `0xdeadbeef${swapTx.slice(10)}` as Hex,
        }),
      target: () =>
        executeOnly().check({ from: owner, to: evil, data: swapTx }),
      sender: () =>
        executeOnly().check({ from: evil, to: adapter, data: swapTx }),
      nativeValue: () =>
        executeOnly().check({
          from: owner,
          to: adapter,
          data: swapTx,
          value: 1n,
        }),
    };
    const results = Object.fromEntries(
      Object.entries(cases).map(([k, fn]) => [k, code(fn)]),
    );
    expect(results).toEqual({
      recipient: 'RECIPIENT_MISMATCH',
      oneOutputRedirected: 'RECIPIENT_MISMATCH',
      slippage: 'MIN_OUT_BELOW_FLOOR',
      fee: 'AMOUNT_EXCEEDS_PLAN',
      selector: 'SELECTOR_NOT_ALLOWED',
      target: 'TARGET_NOT_ALLOWED',
      sender: 'FROM_MISMATCH',
      nativeValue: 'VALUE_NOT_ZERO',
    });
  });

  it('P15-06 the allowance step binds spender and amount; extra steps and signatures are refused', () => {
    const allowance = (spender: Address, amount: bigint) =>
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender, amount],
      });
    const g = new KitTxGuard(owner, livePlan().steps);
    expect(
      code(() =>
        g.check({
          from: owner,
          to: usdc.address,
          data: allowance(evil, 20_000n),
        }),
      ),
    ).toBe('SPENDER_MISMATCH');
    expect(
      code(() =>
        new KitTxGuard(owner, livePlan().steps).check({
          from: owner,
          to: usdc.address,
          data: allowance(adapter, 20_001n),
        }),
      ),
    ).toBe('APPROVAL_EXCEEDS_PLAN');
    const ok = new KitTxGuard(owner, livePlan().steps);
    ok.check({
      from: owner,
      to: usdc.address,
      data: allowance(adapter, 20_000n),
    });
    ok.check({ from: owner, to: adapter, data: swapTx });
    ok.assertComplete();
    expect(
      code(() => ok.check({ from: owner, to: adapter, data: swapTx })),
    ).toBe('UNEXPECTED_STEP');
    expect(code(() => ok.refuseSignature('eth_signTypedData_v4'))).toBe(
      'SIGNATURE_REFUSED',
    );
  });

  it('P15-06 policy: slippage ceiling, pair, cap, stale quote, recipient and empty liquidity fail closed', () => {
    expect(() => swapPolicy({ ...policy, maxSlippageBps: 500 })).toThrow(
      /slippage must be/,
    );
    const tooLoose = {
      ...estimate,
      stopLimit: { amount: '0.020000', token: 'EURC' },
    };
    expect(
      code(() =>
        approveSwap(
          normalizeSwapEstimate(tooLoose, { observedAt: t0, wallet: owner }),
          policy,
          t0,
        ),
      ),
    ).toBe('SLIPPAGE_ABOVE_POLICY');
    expect(
      code(() =>
        approveSwap(
          normalizeSwapEstimate(
            { ...estimate, amountIn: '0.03' },
            { observedAt: t0, wallet: owner },
          ),
          policy,
          t0,
        ),
      ),
    ).toBe('AMOUNT_ABOVE_CAP');
    expect(
      code(() =>
        approveSwap(
          normalizeSwapEstimate(estimate, { observedAt: t0, wallet: owner }),
          policy,
          t0 + 120_000,
        ),
      ),
    ).toBe('STALE_QUOTE');
    expect(
      code(() =>
        normalizeSwapEstimate(
          { ...estimate, toAddress: evil },
          { observedAt: t0, wallet: owner },
        ),
      ),
    ).toBe('RECIPIENT_MISMATCH');
    const reverse = {
      ...estimate,
      tokenIn: 'EURC',
      tokenOut: 'USDC',
      stopLimit: { amount: '0.01', token: 'USDC' },
      estimatedOutput: { amount: '0.01', token: 'USDC' },
    };
    expect(
      code(() =>
        approveSwap(
          normalizeSwapEstimate(reverse, { observedAt: t0, wallet: owner }),
          policy,
          t0,
        ),
      ),
    ).toBe('PAIR_NOT_ALLOWED');
    const dry = {
      ...estimate,
      stopLimit: { amount: '0', token: 'EURC' },
      estimatedOutput: { amount: '0', token: 'EURC' },
    };
    expect(
      code(() =>
        approveSwap(
          normalizeSwapEstimate(dry, { observedAt: t0, wallet: owner }),
          policy,
          t0,
        ),
      ),
    ).toBe('NO_LIQUIDITY');
    // USYC or arbitrary tokens cannot even be named.
    expect(() =>
      normalizeSwapEstimate(
        { ...estimate, tokenOut: 'USYC' },
        { observedAt: t0, wallet: owner },
      ),
    ).toThrow();
  });

  it('reconciles the live fill: exact input, at least the floor out', () => {
    const { approved } = livePlan();
    expect(
      reconcileSwap({ approved, spentIn: 20_000n, receivedOut: 22_777n }).ok,
    ).toBe(true);
    expect(
      reconcileSwap({ approved, spentIn: 20_000n, receivedOut: 22_548n }).ok,
    ).toBe(false);
    expect(
      reconcileSwap({ approved, spentIn: 20_001n, receivedOut: 22_777n }).ok,
    ).toBe(false);
  });
});
