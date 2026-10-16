/**
 * Circle App Kit Earn on Arc testnet: vault discovery, the yield decision
 * gate, one tiny deposit and its full withdrawal, reconciled to the wei.
 *
 *   node --import tsx scripts/arc-earn-proof.ts [--amount 0.05] [--discover-only]
 *
 * Signer = testnet.key (owner EOA); the kit only sees a guarded wallet.
 * Output: bounty-evidence/arc/arc-earn-proof.json
 *
 * The cash-floor port here is a script-local stand-in (keep `--reserve` USDC
 * free after the deposit); production wires `@synq/allocations`.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  erc20Abi,
  keccak256,
  maxUint256,
  parseAbi,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { EarnKit } from '@circle-fin/earn-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import {
  money,
  moneyFromDecimal,
  moneyToDecimal,
  type Money,
} from '@synq/domain';
import { arcNativeToUsdc, token } from '@synq/chain-registry/arc';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import {
  KitTxGuard,
  KitTxGuardError,
  appKitAdapter,
  unitsToKitDecimal,
} from '@synq/plugin-circle-app-kit';
import {
  VaultShareLedger,
  assertVaultOnChain,
  assertWithdrawable,
  decideYieldDeposit,
  describeApy,
  earnDepositPlan,
  earnWithdrawPlan,
  normalizeDepositQuote,
  normalizeVault,
  reconcileRoundTrip,
  type EarnVault,
  type YieldReservePort,
} from '@synq/plugin-circle-earn';
import { guardedArcWallet, revokeAllowance } from './lib/app-kit-wallet.js';

const key = (f: string) => {
  const k = readFileSync(`${process.env.HOME}/.synq/${f}`, 'utf8').trim();
  return (k.startsWith('0x') ? k : `0x${k}`) as Hex;
};
const arg = (n: string, d: string) =>
  process.argv.includes(`--${n}`)
    ? process.argv[process.argv.indexOf(`--${n}`) + 1]!
    : d;
const j = (x: unknown) =>
  JSON.parse(
    JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? v.toString() : v)),
  );

const VAULT_ABI = parseAbi([
  'function asset() view returns (address)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function convertToAssets(uint256) view returns (uint256)',
  'function maxWithdraw(address) view returns (uint256)',
  'function maxRedeem(address) view returns (uint256)',
  'function previewRedeem(uint256) view returns (uint256)',
  'function totalAssets() view returns (uint256)',
]);

const owner = privateKeyToAccount(key('testnet.key'));
const arc = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const amount = moneyFromDecimal(usdc, arg('amount', '0.05'));
if (amount.baseUnits > 50_000n)
  throw new Error('live Earn proof is capped at 0.05 USDC');
const reserveFloor = moneyFromDecimal(usdc, arg('reserve', '5'));
const evidenceDir = join(
  process.cwd(),
  '..',
  'synq-v13',
  'bounty-evidence',
  'arc',
);
const out: Record<string, unknown> = {
  label: 'LIVE_ARC_TESTNET',
  kit: '@circle-fin/earn-kit@1.8.1 + @circle-fin/adapter-viem-v2@1.19.0',
  owner: owner.address,
  startedAt: new Date().toISOString(),
  note: 'Circle Earn vaults on Arc testnet are Circle test vaults; APY is illustrative and variable, never guaranteed.',
};
const save = () => {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, 'arc-earn-proof.json'),
    JSON.stringify(j(out), null, 2),
  );
};

// 1. Discovery: every vault the kit lists, normalised and cross-checked on chain.
const kit = new EarnKit();
const observedAt = Date.now();
const listed = await kit.exploreVaults({ chain: 'Arc_Testnet', page: 1 });
const vaults: EarnVault[] = [];
out.discovery = [] as unknown[];
for (const raw of listed.vaults) {
  try {
    const v = normalizeVault(raw, { observedAt });
    const [asset, decimals, code, totalAssets] = await Promise.all([
      arc.client.readContract({
        address: v.address,
        abi: VAULT_ABI,
        functionName: 'asset',
      }),
      arc.client.readContract({
        address: v.address,
        abi: VAULT_ABI,
        functionName: 'decimals',
      }),
      arc.client.getCode({ address: v.address }),
      arc.client.readContract({
        address: v.address,
        abi: VAULT_ABI,
        functionName: 'totalAssets',
      }),
    ]);
    assertVaultOnChain(v, {
      asset,
      shareDecimals: decimals,
      codeHash: keccak256(code!),
    });
    vaults.push(v);
    (out.discovery as unknown[]).push({
      ...j(v),
      apyText: describeApy(v.apy),
      onchain: {
        asset,
        shareDecimals: decimals,
        totalAssets: moneyToDecimal(money(usdc, totalAssets)),
      },
    });
  } catch (error) {
    (out.discovery as unknown[]).push({
      raw,
      rejected: String((error as Error).message),
    });
  }
}
if (process.argv.includes('--discover-only')) {
  save();
  console.log(JSON.stringify(out.discovery, null, 2));
  process.exit(0);
}
const vault = vaults.find((v) => v.kind === 'CIRCLE_EARN_VAULT_USDC');
if (!vault) throw new Error('registry vault not listed by the kit');
await verifyContract(arc, 'CIRCLE_APP_KIT_ADAPTER');
await verifyContract(arc, 'CIRCLE_EARN_VAULT_USDC');
const shareDecimals = Number(
  await arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'decimals',
  }),
);

// 2. Decision gate. The live port keeps `reserve` USDC free after the deposit.
const liveReserves: YieldReservePort = {
  async canDeployToYield({ amount: a }) {
    const wei = await arc.client.getBalance({ address: owner.address });
    const free = arcNativeToUsdc('arc-testnet', wei).usdc.baseUnits;
    return free - a.baseUnits >= reserveFloor.baseUnits
      ? { allowed: true }
      : {
          allowed: false,
          reason: `would leave less than ${moneyToDecimal(reserveFloor)} USDC free`,
        };
  },
};
const policy = {
  minApyBps: 1,
  maxDeposit: moneyFromDecimal(usdc, '0.05'),
  allowTestVaults: true,
};
const payrollDue: YieldReservePort = {
  async canDeployToYield() {
    return {
      allowed: false,
      reason:
        'payroll 2026-10-17 and rent 2026-10-20 are due and not yet reserved',
      dueReserve: moneyFromDecimal(usdc, '4200'),
    };
  },
};
out.decisionChecks = {
  staleApy: await decideYieldDeposit({
    vault: {
      ...vault,
      apy: { ...vault.apy, observedAt: vault.apy.observedAt - 3_600_000 },
    },
    amount,
    now: Date.now(),
    policy,
    reserves: liveReserves,
  }),
  payrollDue_LOCAL_FIXTURE_PORT: await decideYieldDeposit({
    vault,
    amount,
    now: Date.now(),
    policy,
    reserves: payrollDue,
  }),
};
const decision = await decideYieldDeposit({
  vault,
  amount,
  now: Date.now(),
  policy,
  reserves: liveReserves,
});
out.decision = decision;
if (decision.decision !== 'DEPOSIT') {
  save();
  throw new Error(`decision rejected: ${decision.reason}`);
}

// 3. Guarded wallet + quotes.
let guard: KitTxGuard | null = null;
const wallet = guardedArcWallet({
  profile: arc.profile,
  client: arc.client,
  signer: owner,
  rpcUrl: arc.profile.rpcUrls[0]!,
  guard: () => {
    if (!guard) throw new KitTxGuardError('UNEXPECTED_STEP', 'no plan armed');
    return guard;
  },
  log: (m) => console.log(m),
});
const adapter = await createViemAdapterFromProvider({
  provider: wallet.provider as never,
});
const from = { adapter, chain: 'Arc_Testnet' as const };
const amountText = unitsToKitDecimal(amount.baseUnits, usdc.decimals);
const rawQuote = await kit.getDepositQuote({
  from,
  vaultAddress: vault.address,
  amount: amountText,
});
const quote = normalizeDepositQuote(rawQuote, {
  shareDecimals,
  observedAt: Date.now(),
});
out.depositQuote = { raw: rawQuote, normalized: quote };
const circleFee = (rawQuote.fees ?? []).reduce(
  (a: bigint, f: { amount?: string }) =>
    a + (f.amount ? moneyFromDecimal(usdc, f.amount).baseUnits : 0n),
  0n,
);

const balances = async () => ({
  nativeWei: await arc.client.getBalance({ address: owner.address }),
  shares: await arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'balanceOf',
    args: [owner.address],
  }),
});
const feesOf = async (hashes: readonly Hex[]) => {
  const fees: bigint[] = [];
  const receipts = [];
  for (const h of hashes) {
    const r = await arc.client.waitForTransactionReceipt({ hash: h });
    if (r.status !== 'success') throw new Error(`${h} reverted`);
    fees.push(r.gasUsed * r.effectiveGasPrice);
    receipts.push({
      hash: h,
      block: r.blockNumber,
      feeWei: r.gasUsed * r.effectiveGasPrice,
      explorer: `${arc.profile.explorer}/tx/${h}`,
    });
  }
  return { fees, receipts };
};

const balancesAt = async (blockNumber: bigint) => ({
  nativeWei: await arc.client.getBalance({
    address: owner.address,
    blockNumber,
  }),
  shares: await arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'balanceOf',
    args: [owner.address],
    blockNumber,
  }),
});
const depositPlan = (nowSec: bigint) =>
  earnDepositPlan({
    owner: owner.address,
    vault,
    assetsIn: amount.baseUnits,
    // The vault mints by its own rate at execution; accept 1% below the quote.
    minShares: (quote.expectedShares * 99n) / 100n,
    maxFee: circleFee,
    nowSec,
  });

// 4. Deposit, or resume from a deposit already mined by an earlier run
//    (`--resume-deposit <allowanceTx>,<executeTx>`): its calldata is re-checked
//    by the same guard and its balances are read at the mined blocks.
const resume = process.argv.includes('--resume-deposit')
  ? (arg('resume-deposit', '').split(',') as Hex[])
  : null;
let before: Awaited<ReturnType<typeof balances>>;
let mid: Awaited<ReturnType<typeof balances>>;
let depositTx: Awaited<ReturnType<typeof feesOf>>;
if (resume) {
  depositTx = await feesOf(resume);
  const first = await arc.client.getTransactionReceipt({ hash: resume[0]! });
  const last = await arc.client.getTransactionReceipt({ hash: resume.at(-1)! });
  const block = await arc.client.getBlock({ blockNumber: first.blockNumber });
  const replay = new KitTxGuard(
    owner.address,
    depositPlan(block.timestamp - 60n),
  );
  for (const h of resume) {
    const tx = await arc.client.getTransaction({ hash: h });
    replay.check({ from: tx.from, to: tx.to, data: tx.input, value: tx.value });
  }
  replay.assertComplete();
  out.depositGuard = replay.records;
  out.depositResumedFrom = resume;
  before = await balancesAt(first.blockNumber - 1n);
  mid = await balancesAt(last.blockNumber);
} else {
  before = await balances();
  guard = new KitTxGuard(
    owner.address,
    depositPlan(BigInt(Math.floor(Date.now() / 1000))),
  );
  const sentBeforeDeposit = wallet.sent.length;
  try {
    out.depositResult = await kit.deposit({
      from,
      vaultAddress: vault.address,
      amount: amountText,
      config: { batchTransactions: false },
    });
  } catch (error) {
    out.result = 'DEPOSIT_FAILED';
    out.error = String((error as Error).message).slice(0, 600);
    out.refused = wallet.refused;
    out.sent = wallet.sent;
    save();
    throw error;
  }
  guard.assertComplete();
  out.depositGuard = guard.records;
  depositTx = await feesOf(wallet.sent.slice(sentBeforeDeposit));
  mid = await balances();
}
out.before = before;
const ledger = new VaultShareLedger(
  vault.address,
  owner.address,
  before.shares,
);
const minted = mid.shares - before.shares;
const depositedWei =
  before.nativeWei - mid.nativeWei - depositTx.fees.reduce((a, b) => a + b, 0n);
if (depositedWei !== amount.baseUnits * 10n ** 12n)
  throw new Error(
    `deposit moved ${depositedWei} wei, expected ${amount.baseUnits * 10n ** 12n}`,
  );
ledger.deposit(amount.baseUnits, minted, depositTx.receipts.at(-1)!.hash);
ledger.reconcile(mid.shares);
save();
const valueOfMinted = await arc.client.readContract({
  address: vault.address,
  abi: VAULT_ABI,
  functionName: 'convertToAssets',
  args: [minted],
});
out.deposit = {
  receipts: depositTx.receipts,
  sharesMinted: minted,
  valueOfMintedUnits: valueOfMinted,
  mid,
};

// 5. Withdraw the whole position. The bound is the smaller of the provider's
//    `maxWithdrawable` and the on-chain value of the held shares. (This test
//    vault's ERC-4626 `maxWithdraw`/`maxRedeem` report 0 even though the kit
//    redeems through the Adapter; recorded, not relied on.)
const [vaultMaxWithdraw, vaultMaxRedeem, positionValue] = await Promise.all([
  arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'maxWithdraw',
    args: [owner.address],
  }),
  arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'maxRedeem',
    args: [owner.address],
  }),
  arc.client.readContract({
    address: vault.address,
    abi: VAULT_ABI,
    functionName: 'previewRedeem',
    args: [mid.shares],
  }),
]);
const probeQuote = await kit.getWithdrawalQuote({
  from,
  vaultAddress: vault.address,
  amount: unitsToKitDecimal(positionValue, usdc.decimals),
});
const providerMax = moneyFromDecimal(
  usdc,
  probeQuote.maxWithdrawable.amount,
).baseUnits;
const withdrawUnits = assertWithdrawable({
  requested: positionValue,
  positionValue,
  providerMaxWithdrawable: providerMax,
});
out.withdrawLimits = {
  vaultMaxWithdraw,
  vaultMaxRedeem,
  positionValue,
  providerMax,
};
const withdrawText = unitsToKitDecimal(withdrawUnits, usdc.decimals);
const rawWq = await kit.getWithdrawalQuote({
  from,
  vaultAddress: vault.address,
  amount: withdrawText,
});
out.withdrawQuote = rawWq;
const wFee = (rawWq.fees ?? []).reduce(
  (a: bigint, f: { amount?: string; symbol?: string }) =>
    a + (f.amount ? moneyFromDecimal(usdc, f.amount).baseUnits : 0n),
  0n,
);
guard = new KitTxGuard(
  owner.address,
  earnWithdrawPlan({
    owner: owner.address,
    vault,
    maxShares: mid.shares,
    minAssets: ((withdrawUnits - wFee) * 99n) / 100n,
    maxFee: wFee,
    nowSec: BigInt(Math.floor(Date.now() / 1000)),
  }),
);
const sentBeforeWithdraw = wallet.sent.length;
try {
  out.withdrawResult = await kit.withdraw({
    from,
    vaultAddress: vault.address,
    amount: withdrawText,
    config: { batchTransactions: false },
  });
} catch (error) {
  out.result = 'WITHDRAW_FAILED';
  out.error = String((error as Error).message).slice(0, 600);
  out.refused = wallet.refused;
  out.sent = wallet.sent;
  save();
  throw error;
}
guard.assertComplete();
out.withdrawGuard = guard.records;
const withdrawTx = await feesOf(wallet.sent.slice(sentBeforeWithdraw));
const after = await balances();
const burned = mid.shares - after.shares;
const withdrawnWei =
  after.nativeWei - mid.nativeWei + withdrawTx.fees.reduce((a, b) => a + b, 0n);
if (withdrawnWei % 10n ** 12n !== 0n)
  throw new Error('non-integer USDC withdrawal');
const withdrawn: Money = money(usdc, withdrawnWei / 10n ** 12n);
ledger.withdraw(withdrawn.baseUnits, burned, withdrawTx.receipts.at(-1)!.hash);
ledger.reconcile(after.shares);
out.withdraw = {
  receipts: withdrawTx.receipts,
  sharesBurned: burned,
  withdrawn: moneyToDecimal(withdrawn),
  after,
};

// 6. Reconcile the round trip to the wei and the share.
const residualShares = after.shares - before.shares;
const residualValue =
  residualShares > 0n
    ? await arc.client.readContract({
        address: vault.address,
        abi: VAULT_ABI,
        functionName: 'convertToAssets',
        args: [residualShares],
      })
    : 0n;
out.reconciliation = {
  ...reconcileRoundTrip({
    nativeBeforeWei: before.nativeWei,
    nativeAfterWei: after.nativeWei,
    feesWei: [...depositTx.fees, ...withdrawTx.fees],
    deposited: amount,
    withdrawn,
    sharesBefore: before.shares,
    sharesAfter: after.shares,
    sharesMinted: minted,
    sharesBurned: burned,
  }),
  residualShares,
  residualValueUnits: residualValue,
  ledger: {
    principalIn: ledger.principalIn,
    principalOut: ledger.principalOut,
    shares: ledger.shares,
  },
};

// 7. Leave no standing allowance to the kit Adapter.
const adapterAddr = appKitAdapter();
const leftover = await arc.client.readContract({
  address: usdc.address,
  abi: erc20Abi,
  functionName: 'allowance',
  args: [owner.address, adapterAddr],
});
out.residualAdapterAllowance = leftover;
if (leftover > 0n && leftover !== maxUint256) {
  out.allowanceRevoke = await revokeAllowance(
    arc,
    owner,
    usdc.address as Address,
    adapterAddr,
  );
}
out.result = 'DEPOSITED_WITHDRAWN_RECONCILED';
out.finishedAt = new Date().toISOString();
save();
console.log(JSON.stringify(j(out.reconciliation), null, 2));
