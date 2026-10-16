import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  parseAbi,
  zeroAddress,
  type Hex,
  type Address,
  type Log,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { CHAINS, contract, token } from '@synq/chain-registry/arc';
import {
  ADAPTER_EXECUTE_ABI,
  KitTxGuard,
  decodeAdapterExecute,
} from '@synq/plugin-circle-app-kit';
import {
  swapPolicy,
  approveSwap,
  normalizeSwapEstimate,
  swapPlan,
} from '@synq/plugin-arc-swap';
import { normalizeVault, earnDepositPlan } from '@synq/plugin-circle-earn';
import { planUsycSubscription, type UsycEntitlement } from '@synq/plugin-usyc';
import { createArcDcaSchedule, amendDcaSchedule } from '@synq/strategies';
import { decideSponsorship } from '@synq/plugin-circle-gas';
import {
  accountUserOp,
  paymasterFor,
  USER_OPERATION_EVENT_ABI,
  USER_OPERATION_SPONSORED_ABI,
} from '@synq/plugin-circle-paymaster';
import { guardedArcWallet } from '../../scripts/lib/app-kit-wallet.js';
import fixtures from './fixtures/app-kit-executes.json' with { type: 'json' };
const usdc = token('arc-testnet', 'USDC'),
  eurc = token('arc-testnet', 'EURC');
const adapter = contract('arc-testnet', 'CIRCLE_APP_KIT_ADAPTER').address;
const raw = fixtures.swapExecute.input as Hex;
const owner = decodeAdapterExecute(raw).tokens[0]!.beneficiary;
const evil = `0x${'7'.repeat(40)}` as Address;
const now = Date.parse('2026-10-16T05:00:00Z');
const estimate = {
  tokenIn: 'USDC',
  tokenOut: 'EURC',
  amountIn: '0.02',
  chain: 'Arc_Testnet',
  fromAddress: owner,
  toAddress: owner,
  stopLimit: { amount: '0.022549', token: 'EURC' },
  estimatedOutput: { amount: '0.022777', token: 'EURC' },
  fees: [{ token: 'USDC', amount: '0.000004', type: 'provider' }],
};
function plan() {
  return swapPlan({
    owner,
    approved: approveSwap(
      normalizeSwapEstimate(estimate, { observedAt: now, wallet: owner }),
      swapPolicy({
        chain: 'arc-testnet',
        pairs: [['USDC', 'EURC']],
        maxSlippageBps: 100,
        maxAmountIn: moneyFromDecimal(usdc, '0.02'),
      }),
      now,
    ),
    nowSec: BigInt(fixtures.swapExecute.blockTimestamp - 30),
  });
}
type Params = ReturnType<typeof decodeAdapterExecute>;
type ExecuteParams = ReturnType<
  typeof decodeFunctionData<typeof ADAPTER_EXECUTE_ABI>
>['args'][0];
function mutate(change: (p: ExecuteParams) => ExecuteParams, inputRaw = raw) {
  const [p, ins, sig] = decodeFunctionData({
    abi: ADAPTER_EXECUTE_ABI,
    data: inputRaw,
  }).args;
  return encodeFunctionData({
    abi: ADAPTER_EXECUTE_ABI,
    functionName: 'execute',
    args: [change(p), ins, sig],
  });
}
function check(data: Hex) {
  return new KitTxGuard(
    owner,
    plan().filter((s) => s.kind === 'EXECUTE'),
  ).check({ from: owner, to: adapter, data });
}
afterEach(() => vi.unstubAllGlobals());
describe('Circle adversarial regressions', () => {
  it('CIR-01: extra token-transfer instructions and arbitrary fee targets are refused', () => {
    const theft: Params['instructions'][number] = {
      target: eurc.address,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [evil, 22549n],
      }),
      value: 0n,
      tokenIn: usdc.address,
      amountToApprove: 0n,
      tokenOut: zeroAddress,
      minTokenOut: 0n,
    };
    expect(() =>
      check(
        mutate((p) => ({ ...p, instructions: [...p.instructions, theft] })),
      ),
    ).toThrow();
    expect(() =>
      check(
        mutate((p) => ({
          ...p,
          instructions: [
            ...p.instructions,
            { ...theft, tokenOut: eurc.address },
          ],
        })),
      ),
    ).toThrow();
    expect(() =>
      check(
        mutate((p) => ({
          ...p,
          instructions: p.instructions.map((i, n) =>
            n === 0 ? { ...i, target: evil } : i,
          ),
        })),
      ),
    ).toThrow();
  });
  it('CIR-01: deposit calldata must send shares to the adapter and match the input amount', () => {
    const pin = contract('arc-testnet', 'CIRCLE_EARN_VAULT_USDC');
    const vault = normalizeVault(
      {
        vaultAddress: pin.address,
        chain: 'Arc_Testnet',
        name: 'test',
        protocol: 'morpho',
        asset: 'USDC',
        assetAddress: usdc.address,
        currentApy: 0.05,
        status: 'active',
        asOf: new Date(now).toISOString(),
      },
      { observedAt: now },
    );
    const steps = earnDepositPlan({
      owner,
      vault,
      assetsIn: 50000n,
      minShares: 49697420129502959n,
      maxFee: 0n,
      nowSec: BigInt(fixtures.earnDepositExecute.blockTimestamp - 30),
    }).filter((s) => s.kind === 'EXECUTE');
    const bad = mutate(
      (p) => ({
        ...p,
        instructions: p.instructions.map((i) => ({
          ...i,
          data: encodeFunctionData({
            abi: parseAbi([
              'function deposit(uint256,address) returns (uint256)',
            ]),
            functionName: 'deposit',
            args: [50000n, evil],
          }),
        })),
      }),
      fixtures.earnDepositExecute.input as Hex,
    );
    expect(() =>
      new KitTxGuard(owner, steps).check({
        from: owner,
        to: adapter,
        data: bad,
      }),
    ).toThrow();
  });
  it('CIR-01: undeclared permit payloads are refused before any signature', () => {
    const [p, inputs, sig] = decodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      data: raw,
    }).args;
    const bad = encodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      functionName: 'execute',
      args: [
        p,
        inputs.map((i) => ({
          ...i,
          permitType: 1,
          permitCalldata: '0x1234' as Hex,
        })),
        sig,
      ],
    });
    expect(() => check(bad)).toThrow();
  });
  it('CIR-02: an allowance increase cannot use an unknown existing approval to exceed the cap', () => {
    const data = encodeFunctionData({
      abi: parseAbi([
        'function increaseAllowance(address,uint256) returns (bool)',
      ]),
      functionName: 'increaseAllowance',
      args: [adapter, 20000n],
    });
    expect(() =>
      new KitTxGuard(owner, plan()).check({
        from: owner,
        to: usdc.address,
        data,
      }),
    ).toThrow();
  });
  it('CIR-03: raw broadcasts and unknown wallet methods never reach RPC forwarding', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const wallet = guardedArcWallet({
      profile: CHAINS['arc-testnet'],
      client: {} as Parameters<typeof guardedArcWallet>[0]['client'],
      signer: privateKeyToAccount(`0x${'11'.repeat(32)}`),
      rpcUrl: 'https://rpc.testnet.arc.io',
      guard: () => new KitTxGuard(owner, plan()),
    });
    for (const method of [
      'eth_sendRawTransaction',
      'wallet_sendTransaction',
      'wallet_addEthereumChain',
      'admin_unlockAccount',
    ])
      await expect(
        wallet.provider.request({ method, params: ['0xdead'] }),
      ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('CIR-04: easing the larger-tranche dip trigger requires a signed owner amendment', async () => {
    const initial = createArcDcaSchedule({
      strategyId: 'critic',
      startAt: 1800000000,
      expiresAt: 1900000000,
      frequencySeconds: 86400,
      baseTranche: '10000',
      maxTranche: '15000',
      minTranche: '1000',
      budget: '100000',
      maxDeployment: '100000',
      maxAllocationBps: 5000,
      maxSlippageBps: 100,
    });
    const schedule = await amendDcaSchedule({
      schedule: initial,
      amendment: {
        dip: { multiplierBps: 15000, triggerBelowTrailingBps: 1000 },
      },
      actor: { kind: 'OWNER', id: 'o', approval: 'signed' },
      approvals: { verifyScheduleApproval: async () => true },
    });
    await expect(
      amendDcaSchedule({
        schedule,
        amendment: {
          dip: { multiplierBps: 15000, triggerBelowTrailingBps: 1 },
        },
        actor: { kind: 'AGENT', id: 'a' },
      }),
    ).rejects.toMatchObject({ code: 'CAP_EXPANSION_REQUIRES_OWNER' });
  });
  it('CIR-05: sponsorship rejects negative fees/usage and a backwards usage clock', () => {
    const input = {
      wallet: owner,
      walletKind: 'SCA' as const,
      circleWallet: true,
      estimatedFeeWei: 1n,
      policy: {
        chain: 'arc-testnet' as const,
        active: true,
        dailyLimitWei: 50n * 10n ** 18n,
        grantExpiresAt: null,
        blockedAddresses: [],
      },
      usage: { dayStartUtc: now, spentWei: 49n * 10n ** 18n },
      now: now + 1000,
    };
    for (const over of [
      { estimatedFeeWei: -49n * 10n ** 18n },
      { estimatedFeeWei: 0n },
      { usage: { ...input.usage, spentWei: -1n } },
      { now: now - 86400000 },
    ])
      expect(decideSponsorship({ ...input, ...over }).sponsored).toBe(false);
  });
  it('CIR-06: a self-asserted USYC entitlement does not replace the chain checker', () => {
    const entitlement = {
      status: 'ELIGIBLE',
      wallet: owner,
      action: 'deposit',
      canCall: true,
      checkedAt: now,
      selector: '0x6e553f65',
    } as unknown as UsycEntitlement;
    expect(() =>
      planUsycSubscription({
        entitlement,
        wallet: owner,
        amount: moneyFromDecimal(usdc, '0.01'),
        now,
      }),
    ).toThrow();
  });
  it('CIR-07: missing/mismatched sponsorship or multiple UserOps cannot misattribute the fee', () => {
    const route = paymasterFor('eth-sepolia', '0.8'),
      sender = owner,
      recipient = evil,
      userOpHash = `0x${'ab'.repeat(32)}` as Hex;
    const log = (
      address: Address,
      topics: readonly unknown[],
      data: Hex,
    ): Log => ({
      address,
      topics: [...topics] as [Hex, ...Hex[]],
      data,
      blockNumber: 1n,
      blockHash: `0x${'0'.repeat(64)}`,
      logIndex: 0,
      transactionHash: `0x${'0'.repeat(64)}`,
      transactionIndex: 0,
      removed: false,
    });
    const op = log(
      route.entryPoint.address,
      encodeEventTopics({
        abi: USER_OPERATION_EVENT_ABI,
        eventName: 'UserOperationEvent',
        args: { userOpHash, sender, paymaster: route.paymaster.address },
      }),
      encodeAbiParameters(
        [
          { type: 'uint256' },
          { type: 'bool' },
          { type: 'uint256' },
          { type: 'uint256' },
        ],
        [0n, true, 10n, 10n],
      ),
    );
    const sponsored = (hash: Hex, who: Address) =>
      log(
        route.paymaster.address,
        encodeEventTopics({
          abi: USER_OPERATION_SPONSORED_ABI,
          eventName: 'UserOperationSponsored',
          args: { token: route.usdc.address, sender: who },
        }),
        encodeAbiParameters(
          [
            { type: 'bytes32' },
            { type: 'uint256' },
            { type: 'uint256' },
            { type: 'uint256' },
          ],
          [hash, 1n, 0n, 0n],
        ),
      );
    for (const logs of [
      [op],
      [op, sponsored(`0x${'cd'.repeat(32)}`, sender)],
      [op, sponsored(userOpHash, evil)],
      [op, op, sponsored(userOpHash, sender)],
    ])
      expect(() =>
        accountUserOp({ route, logs, sender, recipient, userOpHash }),
      ).toThrow();
  });
});
