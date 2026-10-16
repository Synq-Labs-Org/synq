/**
 * Arc testnet USDC -> EURC through Circle App Kit Swap, with the owner's plan
 * enforced on every transaction the kit asks to sign.
 *
 *   node --import tsx scripts/arc-swap-proof.ts [--amount 0.02] [--slippage 100]
 *
 * Signer = testnet.key (owner EOA). Output: bounty-evidence/arc/arc-swap-proof.json
 * If the quote has no liquidity the script stops before signing anything.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { SwapKit } from '@circle-fin/swap-kit';
import { createViemAdapterFromProvider } from '@circle-fin/adapter-viem-v2';
import { money, moneyFromDecimal, moneyToDecimal } from '@synq/domain';
import { token } from '@synq/chain-registry/arc';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import {
  ADAPTER_EXECUTE_ABI,
  KitTxGuard,
  KitTxGuardError,
  decodeAdapterExecute,
  kitDecimalToUnits,
  type KitStep,
  unitsToKitDecimal,
} from '@synq/plugin-circle-app-kit';
import {
  approveSwap,
  normalizeSwapEstimate,
  reconcileSwap,
  swapPlan,
  swapPolicy,
} from '@synq/plugin-arc-swap';
import { guardedArcWallet } from './lib/app-kit-wallet.js';

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

const owner = privateKeyToAccount(key('testnet.key'));
const arc = await connectChain('arc-testnet');
const usdc = token('arc-testnet', 'USDC');
const eurc = token('arc-testnet', 'EURC');
const amountIn = moneyFromDecimal(usdc, arg('amount', '0.02'));
const slippageBps = Number(arg('slippage', '100'));
const policy = swapPolicy({
  chain: 'arc-testnet',
  pairs: [['USDC', 'EURC']],
  maxSlippageBps: 100,
  maxAmountIn: moneyFromDecimal(usdc, '0.02'),
});
const out: Record<string, unknown> = {
  label: 'LIVE_ARC_TESTNET',
  kit: '@circle-fin/swap-kit@1.7.1 + @circle-fin/adapter-viem-v2@1.19.0',
  owner: owner.address,
  policy: j(policy),
  startedAt: new Date().toISOString(),
};
const evidenceDir = join(
  process.cwd(),
  '..',
  'synq-v13',
  'bounty-evidence',
  'arc',
);
const save = () => {
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(
    join(evidenceDir, 'arc-swap-proof.json'),
    JSON.stringify(j(out), null, 2),
  );
};

await verifyContract(arc, 'CIRCLE_APP_KIT_ADAPTER');
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
const kit = new SwapKit();
const params = {
  from: { adapter, chain: 'Arc_Testnet' as const },
  tokenIn: 'USDC' as const,
  tokenOut: 'EURC' as const,
  amountIn: unitsToKitDecimal(amountIn.baseUnits, usdc.decimals),
  config: { slippageBps, allowanceStrategy: 'approve' as const },
};

if (process.argv.includes('--tamper-only')) {
  // Re-run the P15-06 checks against an already-mined execute transaction.
  const prior = JSON.parse(
    readFileSync(join(evidenceDir, 'arc-swap-proof.json'), 'utf8'),
  );
  const hash = prior.sent.at(-1) as Hex;
  const tx = await arc.client.getTransaction({ hash });
  const block = await arc.client.getBlock({ blockNumber: tx.blockNumber });
  const usdcFee = kitDecimalToUnits(
    prior.estimate.fees.find((f: { type: string }) => f.type === 'provider')
      ?.amount ?? '0',
    usdc.decimals,
  );
  const step: KitStep = {
    kind: 'EXECUTE',
    adapter: tx.to!,
    beneficiary: owner.address,
    tokenIn: usdc.address,
    maxAmountIn: moneyFromDecimal(usdc, prior.approved.amountIn).baseUnits,
    tokenOut: eurc.address,
    minOut: moneyFromDecimal(eurc, prior.approved.minOut).baseUnits,
    maxFeeIn: usdcFee,
    allowedTokens: [usdc.address, eurc.address],
    nowSec: block.timestamp - 30n,
    maxDeadlineAheadSec: 3_600n,
  };
  prior.tamperChecks = tamperChecks({ to: tx.to!, input: tx.input }, step);
  prior.tamperChecksAt = new Date().toISOString();
  writeFileSync(
    join(evidenceDir, 'arc-swap-proof.json'),
    JSON.stringify(prior, null, 2),
  );
  console.log(prior.tamperChecks);
  process.exit(0);
}

// 1. Quote + liquidity + policy, before any signature.
const observedAt = Date.now();
let estimate: unknown;
try {
  estimate = await kit.estimate(params);
} catch (error) {
  out.result = 'NO_QUOTE_FAIL_CLOSED';
  out.error = String((error as Error).message).slice(0, 400);
  save();
  console.log('no quote; nothing signed');
  process.exit(2);
}
out.estimate = estimate;
const quote = normalizeSwapEstimate(estimate, {
  observedAt,
  wallet: owner.address,
});
const approved = approveSwap(quote, policy, Date.now());
out.approved = {
  amountIn: moneyToDecimal(quote.amountIn),
  estimatedOut: moneyToDecimal(quote.estimatedOut),
  stopLimit: moneyToDecimal(quote.stopLimit),
  minOut: moneyToDecimal(approved.minOut),
  impliedSlippageBps: approved.impliedSlippageBps,
};
const steps = swapPlan({
  owner: owner.address,
  approved,
  nowSec: BigInt(Math.floor(Date.now() / 1000)),
});

// 2. Balances before.
const bal = async () => ({
  native: await arc.client.getBalance({ address: owner.address }),
  eurc: await arc.client.readContract({
    address: eurc.address,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [owner.address],
  }),
});
const before = await bal();
out.before = before;

// 3. Swap through the guard.
guard = new KitTxGuard(owner.address, steps);
let swapResult: unknown;
try {
  swapResult = await kit.swap(params);
} catch (error) {
  out.result = 'SWAP_FAILED';
  out.error = String((error as Error).message).slice(0, 600);
  out.guardRecords = guard.records;
  out.sent = wallet.sent;
  out.refused = wallet.refused.map((r) => ({
    ...r,
    decoded: r.data ? safeDecode(r.data) : null,
  }));
  save();
  throw error;
}
guard.assertComplete();
out.swapResult = swapResult;
out.guardRecords = guard.records;
out.sent = wallet.sent;

// 4. Receipts, fees and reconciliation (gas is paid from the same USDC).
let feesWei = 0n;
let eurcIn = 0n;
const receipts = [];
let executeTx: { to: Address; input: Hex } | null = null;
for (const h of wallet.sent) {
  const r = await arc.client.waitForTransactionReceipt({ hash: h });
  if (r.status !== 'success') throw new Error(`${h} reverted`);
  feesWei += r.gasUsed * r.effectiveGasPrice;
  for (const l of parseEventLogs({ abi: erc20Abi, logs: r.logs, strict: true }))
    if (
      l.eventName === 'Transfer' &&
      l.address.toLowerCase() === eurc.address.toLowerCase() &&
      l.args.to.toLowerCase() === owner.address.toLowerCase()
    )
      eurcIn += l.args.value;
  receipts.push({
    hash: h,
    block: r.blockNumber,
    gasUsed: r.gasUsed,
    effectiveGasPrice: r.effectiveGasPrice,
    explorer: `${arc.profile.explorer}/tx/${h}`,
  });
  const tx = await arc.client.getTransaction({ hash: h });
  if (tx.input.startsWith('0x') && tx.to && tx.input.length > 10) {
    try {
      decodeAdapterExecute(tx.input);
      executeTx = { to: tx.to, input: tx.input };
    } catch {
      /* the allowance tx */
    }
  }
}
const after = await bal();
const spentWei = before.native - after.native - feesWei;
if (spentWei % 10n ** 12n !== 0n) throw new Error('non-integer USDC spend');
const rec = reconcileSwap({
  approved,
  spentIn: spentWei / 10n ** 12n,
  receivedOut: after.eurc - before.eurc,
});
out.after = after;
out.receipts = receipts;
out.reconciliation = {
  ...rec,
  feesWei,
  eurcFromLogs: eurcIn,
  logsMatchBalance: eurcIn === after.eurc - before.eurc,
  receivedOut: moneyToDecimal(money(eurc, rec.receivedOut)),
};
if (!rec.ok || eurcIn !== after.eurc - before.eurc)
  throw new Error('swap did not reconcile');

// 5. P15-06 on the real calldata: the same execute with a changed recipient,
//    selector or min output is refused by a fresh guard for the same plan.
if (executeTx)
  out.tamperChecks = tamperChecks(
    executeTx,
    steps.find((s) => s.kind === 'EXECUTE')!,
  );
out.result = 'SWAPPED_AND_RECONCILED';
out.finishedAt = new Date().toISOString();
save();
console.log(JSON.stringify(j(out.reconciliation), null, 2));
console.log(JSON.stringify(out.tamperChecks, null, 2));

function safeDecode(data: Hex) {
  try {
    return j(decodeAdapterExecute(data));
  } catch {
    return null;
  }
}

function tamperChecks(
  exec: { to: Address; input: Hex },
  executeStep: KitStep,
): Record<string, string> {
  const [p0, inputs, sig] = decodeFunctionData({
    abi: ADAPTER_EXECUTE_ABI,
    data: exec.input,
  }).args;
  const reencode = (params: typeof p0) =>
    encodeFunctionData({
      abi: ADAPTER_EXECUTE_ABI,
      functionName: 'execute',
      args: [params, inputs, sig],
    });
  const check = (data: Hex) => {
    const g = new KitTxGuard(owner.address, [executeStep]);
    try {
      g.check({ from: owner.address, to: exec.to, data, value: 0n });
      return 'ACCEPTED';
    } catch (e) {
      return (e as KitTxGuardError).code;
    }
  };
  return {
    original: check(exec.input),
    changedRecipient: check(
      reencode({
        ...p0,
        tokens: p0.tokens.map((t) => ({
          ...t,
          beneficiary: `0x${'7'.repeat(40)}` as Address,
        })),
      }),
    ),
    loweredMinOut: check(
      reencode({
        ...p0,
        instructions: p0.instructions.map((i) =>
          i.minTokenOut > 0n ? { ...i, minTokenOut: i.minTokenOut - 1n } : i,
        ),
      }),
    ),
    raisedFee: check(
      reencode({
        ...p0,
        instructions: p0.instructions.map((i) =>
          i.minTokenOut === 0n
            ? { ...i, amountToApprove: i.amountToApprove + 1_000n }
            : i,
        ),
      }),
    ),
    changedSelector: check(`0xdeadbeef${exec.input.slice(10)}` as Hex),
    changedTarget: (() => {
      const g = new KitTxGuard(owner.address, [executeStep]);
      try {
        g.check({
          from: owner.address,
          to: `0x${'7'.repeat(40)}` as Address,
          data: exec.input,
          value: 0n,
        });
        return 'ACCEPTED';
      } catch (e) {
        return (e as KitTxGuardError).code;
      }
    })(),
  };
}
