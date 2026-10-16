import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  maxUint256,
  parseAbi,
  slice,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  ARC_PAYMASTER_REFUSAL,
  PaymasterError,
  USER_OPERATION_EVENT_ABI,
  USER_OPERATION_SPONSORED_ABI,
  accountUserOp,
  assertEntryPoint,
  encodePaymasterData,
  paymasterFor,
  paymasterPermitTypedData,
} from '@synq/plugin-circle-paymaster';
import {
  GAS_STATION_LIVE_STATUS,
  arcMaxSendable,
  decideSponsorship,
  planNativeGas,
  sourceGasRequirement,
  utcDayStart,
  type GasStationPolicy,
} from '@synq/plugin-circle-gas';

const code = (fn: () => unknown) => {
  try {
    fn();
    return 'ACCEPTED';
  } catch (e) {
    return (e as PaymasterError).code;
  }
};
const sender = `0x${'5'.repeat(40)}` as Address;
const recipient = `0x${'6'.repeat(40)}` as Address;
const userOpHash = `0x${'ab'.repeat(32)}` as Hex;

describe('Arc gas and Circle Paymaster scope (P16)', () => {
  it('P16-01 Arc native gas in USDC: amount + worst-case fee must fit one balance, 20 gwei floor', () => {
    const arc = CHAINS['arc-testnet'];
    const amountWei = 50_000n * 10n ** 12n; // 0.05 USDC
    const gas = 60_000n;
    // Provider suggests below Arc's floor: raised to 20 gwei.
    const ok = planNativeGas({
      profile: arc,
      gas,
      fees: { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 0n },
      nativeBalance: amountWei + gas * 20_000_000_000n,
      valueWei: amountWei,
    });
    expect(ok).toMatchObject({
      ok: true,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
    });
    if (ok.ok) {
      expect(ok.maxGasCostWei).toBe(1_200_000_000_000_000n);
      expect(ok.maxGasCostUsdc?.baseUnits).toBe(1_200n); // 0.0012 USDC, 6-decimal view
      expect(ok.maxGasCostUsdc?.asset.address).toBe(
        token('arc-testnet', 'USDC').address,
      );
    }
    // One wei short of amount + fee: refused before signing.
    const short = planNativeGas({
      profile: arc,
      gas,
      fees: {
        maxFeePerGas: 25_000_000_000n,
        maxPriorityFeePerGas: 2_000_000_000n,
      },
      nativeBalance: amountWei + gas * 25_000_000_000n - 1n,
      valueWei: amountWei,
    });
    expect(short).toMatchObject({
      ok: false,
      code: 'INSUFFICIENT_GAS',
      shortfallWei: 1n,
    });
    // Rounded-up fee view and max sendable never overspend.
    expect(
      arcMaxSendable(1_000_000_000_000_000_000n, 1_200_000_000_000_001n),
    ).toBe(998_799n);
    expect(arcMaxSendable(1n, 2n)).toBe(0n);
    expect(
      planNativeGas({
        profile: arc,
        gas,
        fees: { maxFeePerGas: 30_000_000_000n },
        nativeBalance: 10n ** 18n,
        valueWei: 0n,
        maxGasCostWei: 1n,
      }),
    ).toMatchObject({ ok: false, code: 'FEE_ABOVE_CAP' });
    // On Sepolia gas is ETH: an ERC-20 transfer draws no native value.
    expect(
      planNativeGas({
        profile: CHAINS['eth-sepolia'],
        gas,
        fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1n },
        nativeBalance: gas * 1_000_000_000n,
        valueWei: 0n,
      }),
    ).toMatchObject({ ok: true, maxGasCostUsdc: null });
  });

  it('P16-02 Circle Paymaster on Arc (or an unlisted chain/version) is refused with a clear message', () => {
    for (const c of ['arc-testnet', 'arc-mainnet'] as const)
      for (const v of ['0.7', '0.8'] as const) {
        expect(code(() => paymasterFor(c, v))).toBe('NOT_ON_ARC');
      }
    expect(ARC_PAYMASTER_REFUSAL).toMatch(
      /not deployed on Arc.*does not need it.*native USDC/,
    );
    expect(code(() => paymasterFor('eth-sepolia', '0.7'))).toBe(
      'UNSUPPORTED_CHAIN',
    );
    const r = paymasterFor('eth-sepolia', '0.8');
    expect(r.paymaster.address).toBe(
      contract('eth-sepolia', 'CIRCLE_PAYMASTER_V08').address,
    );
    expect(r.entryPoint.address).toBe(
      contract('eth-sepolia', 'ERC4337_ENTRYPOINT_V08').address,
    );
    expect(paymasterFor('base-sepolia', '0.7').entryPoint.address).toBe(
      contract('base-sepolia', 'ERC4337_ENTRYPOINT_V07').address,
    );
  });

  it('P16-03 a wrong EntryPoint version, binding or bytecode is rejected', () => {
    const route = paymasterFor('eth-sepolia', '0.8');
    const good = {
      entryPoint: route.entryPoint.address,
      paymasterEntryPoint: route.entryPoint.address,
      paymasterToken: route.usdc.address,
      entryPointCodeHash: route.entryPoint.codeHash!,
      paymasterCodeHash: route.paymaster.codeHash!,
      bundlerEntryPoints: [
        contract('eth-sepolia', 'ERC4337_ENTRYPOINT_V07').address,
        route.entryPoint.address,
      ],
    };
    expect(assertEntryPoint(route, good)).toBe(true);
    const v07 = contract('eth-sepolia', 'ERC4337_ENTRYPOINT_V07');
    expect(
      code(() => assertEntryPoint(route, { ...good, entryPoint: v07.address })),
    ).toBe('WRONG_ENTRYPOINT');
    expect(
      code(() =>
        assertEntryPoint(route, { ...good, paymasterEntryPoint: v07.address }),
      ),
    ).toBe('WRONG_ENTRYPOINT');
    expect(
      code(() =>
        assertEntryPoint(route, { ...good, bundlerEntryPoints: [v07.address] }),
      ),
    ).toBe('WRONG_ENTRYPOINT');
    expect(
      code(() =>
        assertEntryPoint(route, { ...good, entryPointCodeHash: v07.codeHash! }),
      ),
    ).toBe('CODE_HASH_MISMATCH');
    expect(
      code(() =>
        assertEntryPoint(route, { ...good, paymasterToken: recipient }),
      ),
    ).toBe('WRONG_PAYMASTER');
  });

  it('permit and paymasterData follow Circle’s layout and cap exposure', () => {
    const route = paymasterFor('eth-sepolia', '0.8');
    const typed = paymasterPermitTypedData({
      route,
      owner: sender,
      value: 2_000_000n,
      nonce: 0n,
      tokenName: 'USDC',
      tokenVersion: '2',
      maxPermit: 2_000_000n,
    });
    expect(typed.message).toMatchObject({
      spender: route.paymaster.address,
      deadline: maxUint256,
    });
    expect(typed.domain).toMatchObject({
      chainId: 11155111,
      verifyingContract: route.usdc.address,
    });
    expect(
      code(() =>
        paymasterPermitTypedData({
          route,
          owner: sender,
          value: 3_000_000n,
          nonce: 0n,
          tokenName: 'USDC',
          tokenVersion: '2',
          maxPermit: 2_000_000n,
        }),
      ),
    ).toBe('PERMIT_TOO_LARGE');
    const sig = `0x${'11'.repeat(65)}` as Hex;
    const data = encodePaymasterData({
      route,
      permitAmount: 2_000_000n,
      permitSignature: sig,
    });
    expect(slice(data, 0, 1)).toBe('0x00');
    expect(slice(data, 1, 21).toLowerCase()).toBe(
      route.usdc.address.toLowerCase(),
    );
    expect(BigInt(slice(data, 21, 53))).toBe(2_000_000n);
    expect(slice(data, 53)).toBe(sig);
  });

  it('P16-04 the paymaster’s USDC fee is accounted separately from the transfer (live op values)', () => {
    const route = paymasterFor('eth-sepolia', '0.8');
    const usdc = route.usdc.address;
    const pm = route.paymaster.address;
    const transfer = parseAbi([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
    ]);
    const log = (address: Address, topics: Hex[], data: Hex): Log =>
      ({
        address,
        topics: topics as [Hex, ...Hex[]],
        data,
        blockNumber: 1n,
        blockHash: `0x${'0'.repeat(64)}`,
        logIndex: 0,
        transactionHash: `0x${'0'.repeat(64)}`,
        transactionIndex: 0,
        removed: false,
      }) as Log;
    const xfer = (from: Address, to: Address, value: bigint) =>
      log(
        usdc,
        encodeEventTopics({
          abi: transfer,
          eventName: 'Transfer',
          args: { from, to },
        }) as Hex[],
        encodeAbiParameters([{ type: 'uint256' }], [value]),
      );
    // Values from bounty-evidence/arc/paymaster-userop-proof.json (Sepolia, 2026-10-16).
    const logs = [
      xfer(sender, pm, 1_159_148n), // prefund under the permit
      xfer(sender, recipient, 10_000n), // the payment
      xfer(pm, sender, 248_399n), // refund in postOp
      log(
        pm,
        encodeEventTopics({
          abi: USER_OPERATION_SPONSORED_ABI,
          eventName: 'UserOperationSponsored',
          args: { token: usdc, sender },
        }) as Hex[],
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [userOpHash, 3_000_000_000n, 910_749n, 0n],
        ),
      ),
      log(
        route.entryPoint.address,
        encodeEventTopics({
          abi: USER_OPERATION_EVENT_ABI,
          eventName: 'UserOperationEvent',
          args: { userOpHash, sender, paymaster: pm },
        }) as Hex[],
        encodeAbiParameters(
          [
            { type: 'uint256' },
            { type: 'bool' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          // nonce, success, actualGasCost (live); actualGasUsed is illustrative (unused)
          [0n, true, 291_029_657_679_710n, 400_000n],
        ),
      ),
    ];
    const a = accountUserOp({ route, logs, sender, recipient, userOpHash });
    expect(a).toMatchObject({
      success: true,
      transferAmount: 10_000n,
      paymasterFee: 910_749n,
      paymasterPulled: 1_159_148n,
      paymasterRefunded: 248_399n,
      actualGasCostWei: 291_029_657_679_710n,
      sponsored: {
        actualTokenNeeded: 910_749n,
        feeTokenAmount: 0n,
        nativeTokenPrice: 3_000_000_000n,
      },
    });
    expect(a.transferAmount + a.paymasterFee).toBe(920_749n);
    // An event that disagrees with the transfers, or a missing EntryPoint event, fails.
    const lying = [
      ...logs.slice(0, 3),
      log(
        pm,
        logs[3]!.topics as Hex[],
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [userOpHash, 3_000_000_000n, 1n, 0n],
        ),
      ),
      logs[4]!,
    ];
    expect(
      code(() =>
        accountUserOp({ route, logs: lying, sender, recipient, userOpHash }),
      ),
    ).toBe('ACCOUNTING');
    expect(
      code(() =>
        accountUserOp({
          route,
          logs: logs.slice(0, 4),
          sender,
          recipient,
          userOpHash,
        }),
      ),
    ).toBe('ACCOUNTING');
  });

  it('P16-05 Gas Station: SCA-only eligibility, daily cap with UTC reset, grant expiry, live status blocked', () => {
    const now = Date.parse('2026-10-16T12:00:00Z');
    const policy: GasStationPolicy = {
      chain: 'arc-testnet',
      active: true,
      dailyLimitWei: 50n * 10n ** 18n,
      grantExpiresAt: now + 3_600_000,
      blockedAddresses: [],
    };
    const usage = { dayStartUtc: utcDayStart(now), spentWei: 49n * 10n ** 18n };
    const base = {
      wallet: sender,
      walletKind: 'SCA' as const,
      circleWallet: true,
      estimatedFeeWei: 10n ** 17n,
      policy,
      usage,
      now,
    };
    expect(decideSponsorship(base)).toMatchObject({
      sponsored: true,
      remainingTodayWei: 9n * 10n ** 17n,
    });
    expect(decideSponsorship({ ...base, walletKind: 'EOA' })).toMatchObject({
      sponsored: false,
      reason: 'NOT_SMART_ACCOUNT',
      fallback: 'USER_PAYS_GAS',
    });
    expect(decideSponsorship({ ...base, walletKind: 'EIP7702' })).toMatchObject(
      { reason: 'NOT_SMART_ACCOUNT' },
    );
    expect(decideSponsorship({ ...base, circleWallet: false })).toMatchObject({
      reason: 'NOT_CIRCLE_WALLET',
    });
    expect(
      decideSponsorship({ ...base, estimatedFeeWei: 2n * 10n ** 18n }),
    ).toMatchObject({ reason: 'DAILY_LIMIT' });
    // Next UTC day: the cap resets.
    expect(
      decideSponsorship({
        ...base,
        estimatedFeeWei: 2n * 10n ** 18n,
        now: Date.parse('2026-10-17T00:00:01Z'),
        policy: { ...policy, grantExpiresAt: null },
      }),
    ).toMatchObject({ sponsored: true });
    expect(decideSponsorship({ ...base, now: now + 3_600_000 })).toMatchObject({
      reason: 'GRANT_EXPIRED',
    });
    expect(
      decideSponsorship({ ...base, policy: { ...policy, active: false } }),
    ).toMatchObject({ reason: 'POLICY_INACTIVE' });
    expect(
      decideSponsorship({
        ...base,
        policy: { ...policy, chain: 'eth-sepolia' },
      }),
    ).toMatchObject({ reason: 'UNSUPPORTED_CHAIN' });
    // A policy asking for more than Circle's testnet default is clamped.
    expect(
      decideSponsorship({
        ...base,
        usage: { ...usage, spentWei: 0n },
        estimatedFeeWei: 51n * 10n ** 18n,
        policy: { ...policy, dailyLimitWei: 10n ** 21n },
      }),
    ).toMatchObject({ reason: 'DAILY_LIMIT' });
    expect(GAS_STATION_LIVE_STATUS.status).toBe('BLOCKED');
  });

  it('P16-06 an ETH-less source wallet gets a user-visible gas requirement with real options', () => {
    const r = sourceGasRequirement({
      chain: 'eth-sepolia',
      wallet: sender,
      walletKind: 'EOA',
      nativeBalance: 0n,
      estimatedGasWei: 240_000n * 1_000_000_000n,
      action: 'send USDC to Arc via CCTP',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.userMessage).toBe(
        `Your Ethereum Sepolia wallet ${sender} has 0 ETH but needs about 0.00024 ETH for network fees to send USDC to Arc via CCTP. Nothing was sent.`,
      );
      expect(r.options).toEqual([
        `Add about 0.00024 ETH to ${sender} on Ethereum Sepolia`,
        'Use a smart account (EIP-7702 or ERC-4337) with Circle Paymaster v0.8 on Ethereum Sepolia to pay the fee in USDC',
        'Pay from a wallet that already holds USDC on Arc (Arc fees are paid in USDC)',
      ]);
    }
    expect(
      sourceGasRequirement({
        chain: 'eth-sepolia',
        wallet: sender,
        walletKind: 'EOA',
        nativeBalance: 10n ** 18n,
        estimatedGasWei: 1n,
        action: 'x',
      }),
    ).toEqual({ ok: true, chain: 'eth-sepolia', mode: 'NATIVE_GAS' });
    const arc = sourceGasRequirement({
      chain: 'arc-testnet',
      wallet: sender,
      walletKind: 'EOA',
      nativeBalance: 0n,
      estimatedGasWei: 10n ** 15n,
      action: 'pay an invoice',
    });
    expect(arc.ok).toBe(false);
    if (!arc.ok)
      expect(arc.userMessage).toMatch(/On Arc, fees are paid in USDC/);
  });
});
