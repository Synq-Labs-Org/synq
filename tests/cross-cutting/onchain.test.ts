import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Address, Hex } from 'viem';
import { AmountError, moneyFromDecimal } from '@synq/domain';
import {
  arcNativeToUsdc,
  chainProfile,
  contract,
  token,
  usdcToArcNativeWei,
} from '@synq/chain-registry/arc';
import {
  PaymasterError,
  assertEntryPoint,
  paymasterFor,
} from '@synq/plugin-circle-paymaster';
import { arcMaxSendable, planNativeGas } from '@synq/plugin-circle-gas';
import {
  NATIVE_WEI_PER_UNIT,
  arcGasEntry,
  dustAssetId,
  validateEntry,
  walletCashWei,
} from '@synq/ledger';

/**
 * Cross-cutting ONCHAIN rows that live in TypeScript (X-ONC-01, X-ONC-02).
 * X-ONC-03..07 are Foundry tests in
 * contracts/test/unit/CrossCuttingOnchain.t.sol.
 */

const usdc = token('arc-testnet', 'USDC');
const payer = `0x${'7a'.repeat(20)}` as Address;

describe('cross-cutting ONCHAIN (X-ONC, TypeScript half)', () => {
  it('X-ONC-01 an unsupported ERC-4337 EntryPoint or paymaster version is refused', () => {
    // Arc has no Circle Paymaster; an unlisted version/chain pair is refused too.
    for (const v of ['0.7', '0.8'] as const)
      expect(() => paymasterFor('arc-testnet', v)).toThrow(PaymasterError);
    expect(() => paymasterFor('eth-sepolia', '0.7')).toThrow(
      /not listed for eth-sepolia/,
    );
    const route = paymasterFor('base-sepolia', '0.8');
    const v07 = contract('base-sepolia', 'ERC4337_ENTRYPOINT_V07');
    const good = {
      entryPoint: route.entryPoint.address,
      paymasterEntryPoint: route.entryPoint.address,
      paymasterToken: route.usdc.address,
      entryPointCodeHash: route.entryPoint.codeHash as Hex,
      paymasterCodeHash: route.paymaster.codeHash as Hex,
      bundlerEntryPoints: [route.entryPoint.address],
    };
    expect(assertEntryPoint(route, good)).toBe(true);
    const code = (o: Partial<typeof good>) => {
      try {
        assertEntryPoint(route, { ...good, ...o });
        return 'ACCEPTED';
      } catch (e) {
        return (e as PaymasterError).code;
      }
    };
    // v0.7 EntryPoint (and its bytecode) for a v0.8 paymaster.
    expect(code({ entryPoint: v07.address })).toBe('WRONG_ENTRYPOINT');
    expect(code({ paymasterEntryPoint: v07.address })).toBe('WRONG_ENTRYPOINT');
    expect(code({ entryPointCodeHash: v07.codeHash as Hex })).toBe(
      'CODE_HASH_MISMATCH',
    );
    expect(code({ paymasterCodeHash: `0x${'00'.repeat(32)}` })).toBe(
      'CODE_HASH_MISMATCH',
    );
    // A bundler that only serves v0.7 cannot carry the operation.
    expect(code({ bundlerEntryPoints: [v07.address] })).toBe(
      'WRONG_ENTRYPOINT',
    );
    expect(code({ paymasterToken: payer })).toBe('WRONG_PAYMASTER');
  });

  it('X-ONC-02 Arc 18-decimal native and 6-decimal ERC-20 conversions never create or lose value', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 128n }), (wei) => {
        const { usdc: units, dustWei } = arcNativeToUsdc('arc-testnet', wei);
        expect(dustWei >= 0n && dustWei < NATIVE_WEI_PER_UNIT).toBe(true);
        expect(usdcToArcNativeWei(units) + dustWei).toBe(wei);
      }),
      { numRuns: 500 },
    );
    // Gas entries book the whole fee: whole units plus wei dust, each balanced.
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 10n ** 24n }), (feeWei) => {
        const e = arcGasEntry({
          workspaceId: 'w',
          chain: 'arc-testnet',
          txHash: `0x${'11'.repeat(32)}`,
          payer,
          feeWei,
          at: 1,
          memo: 'gas',
        })!;
        validateEntry(e);
        const cash = walletCashWei([e], usdc.assetId);
        expect(cash.get(`wallet:${payer.toLowerCase()}`)).toBe(-feeWei);
        for (const p of e.postings)
          expect([usdc.assetId, dustAssetId(usdc.assetId)]).toContain(
            p.assetId,
          );
      }),
      { numRuns: 300 },
    );
    // Worst-case gas shown in USDC rounds up, and the max sendable leaves room for it.
    const profile = chainProfile('arc-testnet');
    fc.assert(
      fc.property(
        fc.bigInt({ min: 21_000n, max: 5_000_000n }),
        fc.bigInt({ min: 0n, max: 500n * 10n ** 9n }),
        fc.bigInt({ min: 0n, max: 10n ** 22n }),
        (gas, maxFee, balance) => {
          const plan = planNativeGas({
            profile,
            gas,
            fees: { maxFeePerGas: maxFee },
            nativeBalance: 10n ** 30n,
            valueWei: 0n,
          });
          if (!plan.ok) throw new Error(plan.code);
          expect(plan.maxFeePerGas >= profile.minMaxFeePerGasWei!).toBe(true);
          const shown = plan.maxGasCostUsdc!.baseUnits * NATIVE_WEI_PER_UNIT;
          expect(shown >= plan.maxGasCostWei).toBe(true);
          expect(shown - plan.maxGasCostWei < NATIVE_WEI_PER_UNIT).toBe(true);
          const sendable = arcMaxSendable(balance, plan.maxGasCostWei);
          expect(sendable >= 0n).toBe(true);
          if (sendable > 0n)
            expect(
              sendable * NATIVE_WEI_PER_UNIT + plan.maxGasCostWei <= balance,
            ).toBe(true);
        },
      ),
      { numRuns: 300 },
    );
    // A 7th decimal on the 6-decimal interface is refused, never rounded.
    expect(() => moneyFromDecimal(usdc, '0.0000001')).toThrow(AmountError);
    // Only Arc USDC has a native view.
    expect(() =>
      usdcToArcNativeWei(moneyFromDecimal(token('arc-testnet', 'EURC'), '1')),
    ).toThrow(/only Arc USDC/);
    expect(() =>
      usdcToArcNativeWei(moneyFromDecimal(token('eth-sepolia', 'USDC'), '1')),
    ).toThrow(/only Arc USDC/);
  });
});
