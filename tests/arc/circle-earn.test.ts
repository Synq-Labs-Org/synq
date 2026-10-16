import { describe, expect, it } from 'vitest';
import {
  decodeFunctionData,
  encodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import { money, moneyFromDecimal } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import {
  ADAPTER_EXECUTE_ABI,
  KitTxGuard,
  KitTxGuardError,
  decodeAdapterExecute,
} from '@synq/plugin-circle-app-kit';
import {
  EarnError,
  allocationYieldReserves,
  type YieldAllocationSnapshot,
  VaultShareLedger,
  apyFreshness,
  assertVaultOnChain,
  assertWithdrawable,
  decideYieldDeposit,
  describeApy,
  earnDepositPlan,
  earnWithdrawPlan,
  normalizeDepositQuote,
  normalizeVault,
  reconcileRoundTrip,
  type YieldReservePort,
} from '@synq/plugin-circle-earn';
import fixtures from './fixtures/app-kit-executes.json' with { type: 'json' };

const usdc = token('arc-testnet', 'USDC');
const vaultPin = contract('arc-testnet', 'CIRCLE_EARN_VAULT_USDC');
const t0 = Date.parse('2026-10-16T05:57:03Z');
// Shape returned by EarnKit.exploreVaults({ chain: 'Arc_Testnet' }) on 2026-10-16.
const kitVault = {
  vaultAddress: vaultPin.address.toLowerCase(),
  chain: 'Arc_Testnet',
  name: 'EarnKit USDC Vault (Arc Testnet)',
  protocol: 'MORPHO',
  asset: 'USDC',
  assetAddress: usdc.address,
  currentApy: 0.042,
  nativeApy: 0,
  vaultFee: 0,
  status: 'active',
  circleGuarded: false,
  asOf: '2026-10-16T05:55:09Z',
  apyProfile: {
    current: 0.042,
    source: 'morpho:avgNetApy',
    asOf: '2026-10-16T05:55:09Z',
  },
  riskSignals: { circleSentinel: false, warnings: [], earnKitWarnings: [] },
  totalDeposits: '0.0',
  liquidity: '1000000.0',
};
const open: YieldReservePort = {
  canDeployToYield: async () => ({ allowed: true }),
};
const policy = {
  minApyBps: 1,
  maxDeposit: moneyFromDecimal(usdc, '0.05'),
  allowTestVaults: true,
};
const amount = moneyFromDecimal(usdc, '0.05');

describe('Circle Earn on Arc (P15)', () => {
  it('discovers only registry vaults whose underlying is Arc USDC, on chain too', () => {
    const v = normalizeVault(kitVault, { observedAt: t0 });
    expect(v).toMatchObject({
      kind: 'CIRCLE_EARN_VAULT_USDC',
      chainId: 5042002,
      active: true,
      testVault: true,
      apy: { apyBps: 420, guaranteed: false, source: 'morpho:avgNetApy' },
    });
    expect(describeApy(v.apy)).toMatch(/variable APY .* not guaranteed/);
    expect(() =>
      normalizeVault(
        { ...kitVault, assetAddress: token('arc-testnet', 'EURC').address },
        { observedAt: t0 },
      ),
    ).toThrow(/not Arc USDC/);
    expect(() =>
      normalizeVault(
        { ...kitVault, vaultAddress: `0x${'7'.repeat(40)}` },
        { observedAt: t0 },
      ),
    ).toThrow(/registry-pinned/);
    expect(() =>
      normalizeVault(
        { ...kitVault, chain: 'Base_Sepolia' },
        { observedAt: t0 },
      ),
    ).toThrow(EarnError);
    // Provider metadata is not enough: the vault's own asset() and bytecode must match.
    expect(
      assertVaultOnChain(v, {
        asset: usdc.address,
        shareDecimals: 18,
        codeHash: vaultPin.codeHash!,
      }),
    ).toBe(true);
    expect(() =>
      assertVaultOnChain(v, {
        asset: token('arc-testnet', 'EURC').address,
        shareDecimals: 18,
        codeHash: vaultPin.codeHash!,
      }),
    ).toThrow(/asset\(\)/);
    expect(() =>
      assertVaultOnChain(v, {
        asset: usdc.address,
        shareDecimals: 18,
        codeHash: `0x${'0'.repeat(64)}`,
      }),
    ).toThrow(EarnError);
  });

  it('P15-04 a stale, future or undated APY quote cannot justify a deposit', async () => {
    const v = normalizeVault(kitVault, { observedAt: t0 });
    const fresh = await decideYieldDeposit({
      vault: v,
      amount,
      now: t0 + 60_000,
      policy,
      reserves: open,
    });
    expect(fresh.decision).toBe('DEPOSIT');
    if (fresh.decision === 'DEPOSIT')
      expect(fresh.justification).toMatch(/not guaranteed/);
    const stale = await decideYieldDeposit({
      vault: v,
      amount,
      now: t0 + 6 * 60_000,
      policy,
      reserves: open,
    });
    expect(stale).toMatchObject({ decision: 'REJECT', reason: 'STALE_APY' });
    const providerStale = normalizeVault(
      {
        ...kitVault,
        asOf: '2026-10-14T00:00:00Z',
        apyProfile: { ...kitVault.apyProfile, asOf: '2026-10-14T00:00:00Z' },
      },
      { observedAt: t0 },
    );
    expect(apyFreshness(providerStale.apy, t0 + 1_000)).toEqual({
      fresh: false,
      reason: 'STALE_APY',
    });
    expect(apyFreshness({ ...v.apy, observedAt: t0 + 10_000 }, t0)).toEqual({
      fresh: false,
      reason: 'FUTURE_APY',
    });
    expect(apyFreshness({ ...v.apy, providerAsOf: null }, t0 + 1_000)).toEqual({
      fresh: false,
      reason: 'NO_PROVIDER_TIME',
    });
    // Even a fresh quote never reads as a guarantee; low APY and risk flags reject.
    expect(
      await decideYieldDeposit({
        vault: v,
        amount,
        now: t0,
        policy: { ...policy, minApyBps: 500 },
        reserves: open,
      }),
    ).toMatchObject({ reason: 'BELOW_MIN_APY' });
    expect(
      await decideYieldDeposit({
        vault: normalizeVault(
          { ...kitVault, riskSignals: { warnings: ['oracle paused'] } },
          { observedAt: t0 },
        ),
        amount,
        now: t0,
        policy,
        reserves: open,
      }),
    ).toMatchObject({ reason: 'RISK_WARNINGS' });
    expect(
      await decideYieldDeposit({
        vault: v,
        amount,
        now: t0,
        policy: { ...policy, allowTestVaults: false },
        reserves: open,
      }),
    ).toMatchObject({ reason: 'TEST_VAULT_NOT_ALLOWED' });
    expect(
      await decideYieldDeposit({
        vault: v,
        amount: moneyFromDecimal(usdc, '0.06'),
        now: t0,
        policy,
        reserves: open,
      }),
    ).toMatchObject({ reason: 'AMOUNT_ABOVE_CAP' });
  });

  it('P15-07 due payroll/rent reserves block the deposit, and an unknown answer blocks too', async () => {
    const v = normalizeVault(kitVault, { observedAt: t0 });
    let asked = 0;
    const payrollDue: YieldReservePort = {
      canDeployToYield: async ({ amount: a }) => {
        asked++;
        expect(a).toEqual(amount);
        return {
          allowed: false,
          reason: 'payroll due 2026-10-17 not reserved',
          dueReserve: moneyFromDecimal(usdc, '4200'),
        };
      },
    };
    expect(
      await decideYieldDeposit({
        vault: v,
        amount,
        now: t0,
        policy,
        reserves: payrollDue,
      }),
    ).toEqual({
      decision: 'REJECT',
      reason: 'RESERVES_DUE',
      detail: 'payroll due 2026-10-17 not reserved',
    });
    expect(asked).toBe(1);
    const broken: YieldReservePort = {
      canDeployToYield: async () => {
        throw new Error('allocations store offline');
      },
    };
    expect(
      await decideYieldDeposit({
        vault: v,
        amount,
        now: t0,
        policy,
        reserves: broken,
      }),
    ).toMatchObject({
      decision: 'REJECT',
      reason: 'RESERVES_UNKNOWN',
    });
  });

  it('P15-03 share accounting conserves value: the live round trip reconciles to the wei', () => {
    // Values from bounty-evidence/arc/arc-earn-proof.json (live Arc testnet).
    const before = 24_481_013_935_385_321_400n;
    const fees = [
      964_600_000_000_000n,
      9_989_150_000_000_000n,
      1_149_300_000_000_000n,
      9_280_350_000_000_000n,
    ];
    const minted = 49_947_137_794_808_732n;
    const deposited = money(usdc, 50_000n);
    const withdrawn = money(usdc, 49_999n);
    const after = 24_459_629_535_385_321_400n; // balance read after the withdrawal
    const r = reconcileRoundTrip({
      nativeBeforeWei: before,
      nativeAfterWei: after,
      feesWei: fees,
      deposited,
      withdrawn,
      sharesBefore: 0n,
      sharesAfter: 0n,
      sharesMinted: minted,
      sharesBurned: minted,
    });
    expect(r).toMatchObject({
      ok: true,
      walletDeltaWei: 0n,
      shareDelta: 0n,
      netYieldUnits: -1n,
    });
    // One wei unaccounted for, or one share missing, fails.
    expect(
      reconcileRoundTrip({
        nativeBeforeWei: before,
        nativeAfterWei: after + 1n,
        feesWei: fees,
        deposited,
        withdrawn,
        sharesBefore: 0n,
        sharesAfter: 0n,
        sharesMinted: minted,
        sharesBurned: minted,
      }).ok,
    ).toBe(false);
    expect(
      reconcileRoundTrip({
        nativeBeforeWei: before,
        nativeAfterWei: after,
        feesWei: fees,
        deposited,
        withdrawn,
        sharesBefore: 0n,
        sharesAfter: 1n,
        sharesMinted: minted,
        sharesBurned: minted,
      }).ok,
    ).toBe(false);

    const vault = vaultPin.address;
    const ledger = new VaultShareLedger(
      vault,
      `0x${'1'.repeat(40)}` as Address,
    );
    ledger.deposit(50_000n, minted, fixtures.earnDepositExecute.txHash as Hex);
    ledger.reconcile(minted);
    expect(() => ledger.reconcile(minted - 1n)).toThrow(EarnError);
    expect(() =>
      ledger.withdraw(
        49_999n,
        minted + 1n,
        fixtures.earnWithdrawExecute.txHash as Hex,
      ),
    ).toThrow(/exceeds held/);
    expect(() =>
      ledger.deposit(1n, 1n, fixtures.earnDepositExecute.txHash as Hex),
    ).toThrow(/duplicate/);
    ledger.withdraw(
      49_999n,
      minted,
      fixtures.earnWithdrawExecute.txHash as Hex,
    );
    expect(ledger.realised()).toBe(-1n);
  });

  it('withdrawals are bounded by provider maxWithdrawable and on-chain position value', () => {
    expect(
      assertWithdrawable({
        requested: 49_999n,
        positionValue: 49_999n,
        providerMaxWithdrawable: 49_999n,
      }),
    ).toBe(49_999n);
    expect(() =>
      assertWithdrawable({
        requested: 50_000n,
        positionValue: 49_999n,
        providerMaxWithdrawable: 60_000n,
      }),
    ).toThrow(/withdrawable 49999/);
    expect(() =>
      assertWithdrawable({
        requested: 10n,
        positionValue: 49_999n,
        providerMaxWithdrawable: 0n,
      }),
    ).toThrow(EarnError);
  });

  it('the live deposit and withdrawal calldata pass their plans; a redirected share mint is refused', () => {
    const v = normalizeVault(kitVault, { observedAt: t0 });
    const dep = decodeAdapterExecute(fixtures.earnDepositExecute.input as Hex);
    const owner = dep.tokens[0]!.beneficiary;
    const depositGuard = () =>
      new KitTxGuard(
        owner,
        earnDepositPlan({
          owner,
          vault: v,
          assetsIn: 50_000n,
          minShares:
            (normalizeDepositQuote(
              {
                vaultAddress: vaultPin.address,
                deposit: { symbol: 'USDC', amount: '0.05' },
                expectedShares: { amount: '0.0499471559090482' },
                fees: [],
              },
              { shareDecimals: 18, observedAt: t0 },
            ).expectedShares *
              99n) /
            100n,
          maxFee: 0n,
          nowSec: BigInt(fixtures.earnDepositExecute.blockTimestamp - 60),
        }).filter((s) => s.kind === 'EXECUTE'),
      );
    const adapter = contract('arc-testnet', 'CIRCLE_APP_KIT_ADAPTER').address;
    expect(() =>
      depositGuard().check({
        from: owner,
        to: adapter,
        data: fixtures.earnDepositExecute.input as Hex,
      }),
    ).not.toThrow();
    const [p, inputs, sig] = decodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      data: fixtures.earnDepositExecute.input as Hex,
    }).args;
    const redirected = encodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      functionName: 'execute',
      args: [
        {
          ...p,
          tokens: p.tokens.map((t) => ({
            ...t,
            beneficiary: `0x${'7'.repeat(40)}` as Address,
          })),
        },
        inputs,
        sig,
      ],
    });
    try {
      depositGuard().check({ from: owner, to: adapter, data: redirected });
      throw new Error('accepted');
    } catch (e) {
      expect((e as KitTxGuardError).code).toBe('RECIPIENT_MISMATCH');
    }
    const wd = decodeAdapterExecute(fixtures.earnWithdrawExecute.input as Hex);
    const shares = wd.tokenInputs[0]!.amount;
    const withdrawGuard = new KitTxGuard(
      owner,
      earnWithdrawPlan({
        owner,
        vault: v,
        maxShares: shares,
        minAssets: (49_999n * 99n) / 100n,
        maxFee: 0n,
        nowSec: BigInt(fixtures.earnWithdrawExecute.blockTimestamp - 60),
      }).filter((s) => s.kind === 'EXECUTE'),
    );
    expect(() =>
      withdrawGuard.check({
        from: owner,
        to: adapter,
        data: fixtures.earnWithdrawExecute.input as Hex,
      }),
    ).not.toThrow();
  });
});

describe('Earn allocations integration (CIR-08)', () => {
  function snapshot(): YieldAllocationSnapshot {
    return {
      asset: usdc,
      cash: {
        position: {
          treasury: decodeAdapterExecute(fixtures.swapExecute.input as Hex)
            .tokens[0]!.beneficiary,
          onChainFinalized: 100000n,
          observedBlock: 1n,
          observedAt: Math.floor(t0 / 1000),
          source: 'LOCAL_FIXTURE books',
          reservations: 0n,
          committedOutgoing: 0n,
          escrowLiabilities: 0n,
          refundLiabilities: 0n,
          invested: 0n,
        },
        heldForTax: 0n,
        payables: [],
        bills: [],
        receivables: [],
      },
      obligationsImported: true,
      builtAt: Math.floor(t0 / 1000),
      maxAgeSeconds: 60,
      operatingFloor: 20000n,
      stressBuffer: 0n,
      lockDays: 30,
      activeDisputes: 0,
      productEligible: true,
    };
  }
  const decide = (reserves: YieldReservePort) =>
    decideYieldDeposit({
      vault: normalizeVault(kitVault, { observedAt: t0 }),
      amount,
      now: t0,
      policy,
      reserves,
    });
  it('loads books again and refuses newly due payroll despite ample spot balance', async () => {
    let books = snapshot();
    const reserves = allocationYieldReserves(async () => books);
    expect((await decide(reserves)).decision).toBe('DEPOSIT');
    books = {
      ...books,
      cash: {
        ...books.cash,
        bills: [
          {
            billId: 'payroll',
            label: 'payroll',
            kind: 'PAYROLL',
            amount: 40000n,
            nextDueOn: '2026-10-17',
            cadenceDays: 30,
          },
        ],
      },
    };
    expect(await decide(reserves)).toMatchObject({
      decision: 'REJECT',
      reason: 'RESERVES_DUE',
    });
  });
  it('refuses unimported, disputed, stale and future context', async () => {
    for (const override of [
      { obligationsImported: false },
      { activeDisputes: 1 },
      { builtAt: Math.floor(t0 / 1000) - 61 },
      { builtAt: Math.floor(t0 / 1000) + 1 },
    ])
      expect(
        (
          await decide(
            allocationYieldReserves(async () => ({
              ...snapshot(),
              ...override,
            })),
          )
        ).decision,
      ).toBe('REJECT');
  });
  it('protects active holds even when their obligation is absent from the feed', async () => {
    const s = snapshot();
    expect(
      await decide(
        allocationYieldReserves(async () => ({
          ...s,
          cash: {
            ...s.cash,
            position: { ...s.cash.position, reservations: 40000n },
          },
        })),
      ),
    ).toMatchObject({ decision: 'REJECT', reason: 'RESERVES_DUE' });
  });
  it('refuses a different chain asset or unreadable books', async () => {
    expect(
      (
        await decide(
          allocationYieldReserves(async () => ({
            ...snapshot(),
            asset: token('eth-sepolia', 'USDC'),
          })),
        )
      ).decision,
    ).toBe('REJECT');
    expect(
      await decide(
        allocationYieldReserves(async () => {
          throw new Error('books unavailable');
        }),
      ),
    ).toMatchObject({ decision: 'REJECT', reason: 'RESERVES_UNKNOWN' });
  });
});
