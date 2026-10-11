import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, http, keccak256, stringToHex } from 'viem';
import { monadMainnetProfile, monadTestnetProfile } from '@synq/chain-registry';
import type { ProfileName } from '@synq/domain';
import {
  KuruCapabilities,
  KuruClobAdapter,
  KuruError,
  KuruFlowAdapter,
  KuruFlowClient,
  KuruSkillAdapter,
  kuruDeployment,
  simulateSwap,
  simulateWithAssetChanges,
  type Address,
  type HttpFetch,
} from '@synq/plugin-kuru';

/**
 * Read-only Kuru evidence: live Flow quote and prepared AUSD->WMON swap, skill-semantics USDC->WMON prepare, CLOB
 * reads, and eth_simulateV1 simulations with state overrides. Nothing is signed or broadcast.
 *
 *   node --import tsx scripts/kuru-evidence.ts [outDir]
 */
const outDir = process.argv[2] ?? 'bounty-evidence/kuru';
mkdirSync(outDir, { recursive: true });
export const GROUP_LIKE_ACCOUNT =
  `0x${keccak256(stringToHex('synq:kuru-canary:group-like-account')).slice(-40)}` as Address;

const rpc = (profile: ProfileName) =>
  profile === 'proof/monad-mainnet'
    ? (process.env[monadMainnetProfile.rpcEnvironment] ??
      monadMainnetProfile.defaultRpcUrl)
    : (process.env[monadTestnetProfile.rpcEnvironment] ??
      monadTestnetProfile.defaultRpcUrl);
const clients = {
  'proof/monad-mainnet': createPublicClient({
    transport: http(rpc('proof/monad-mainnet')),
  }),
  'sandbox/monad-testnet': createPublicClient({
    transport: http(rpc('sandbox/monad-testnet')),
  }),
} as const;
const clientFor = (profile: ProfileName) => {
  if (profile === 'local/anvil') throw new Error('no local client');
  return clients[profile];
};
const rawQuotes: { request: unknown; status: number; response: unknown }[] = [];
const fetchImpl: HttpFetch = async (url, init) => {
  const response = await fetch(url, init);
  if (!url.endsWith('/quote')) return response;
  const body: unknown = await response.json().catch(() => null);
  rawQuotes.push({
    request: JSON.parse(init.body ?? 'null'),
    status: response.status,
    response: body,
  });
  return { ok: response.ok, status: response.status, json: async () => body };
};
const flowClient = new KuruFlowClient({ fetch: fetchImpl, clock: Date });
const flow = new KuruFlowAdapter(flowClient);
const clob = new KuruClobAdapter(clientFor, fetchImpl);
const skill = new KuruSkillAdapter(flow, clients['proof/monad-mainnet']);
const json = (value: unknown) =>
  JSON.stringify(
    value,
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    2,
  );
const write = (name: string, mode: string, body: unknown) => {
  writeFileSync(
    `${outDir}/${name}`,
    `${json({ executionMode: mode, capturedAt: new Date().toISOString(), ...(body as object) })}\n`,
  );
  console.log(`wrote ${outDir}/${name}`);
};
const failure = (error: unknown) =>
  error instanceof KuruError
    ? { code: error.code, detail: error.detail ?? null }
    : { code: 'ERROR', detail: String(error).slice(0, 300) };

const mainnet = kuruDeployment('proof/monad-mainnet');
const AUSD = mainnet.tokens.AUSD!;
const WMON = mainnet.tokens.WMON!;
const USDC = mainnet.tokens.USDC!;

type Prepared = Awaited<ReturnType<typeof flow.prepare>>;
async function simulatePrepared(prepared: Prepared) {
  return simulateSwap(clients['proof/monad-mainnet'], {
    account: prepared.account,
    tokenIn: prepared.tokenIn,
    tokenOut: prepared.tokenOut,
    amountIn: prepared.amountIn,
    approval: prepared.approval,
    swap: prepared.swap,
  });
}
/** Up to three fresh quotes: a quote whose route reverts in simulation is recorded and replaced, never executed. */
async function quoteUntilSimulated(make: () => Promise<Prepared>) {
  const attempts: unknown[] = [];
  for (let i = 0; i < 3; i++) {
    const prepared = await make();
    const simulation = await simulatePrepared(prepared);
    const passed =
      simulation.succeeded &&
      BigInt(simulation.outputAmount) >= prepared.minOutput;
    attempts.push({
      attempt: i + 1,
      quoteId: prepared.quoteId,
      minOutput: prepared.minOutput,
      quotedOutput: prepared.quotedOutput,
      routeBytes: (prepared.decoded.route.length - 2) / 2,
      simulation,
      passed,
    });
    if (passed) return { prepared, simulation, attempts };
  }
  return { prepared: null, simulation: null, attempts };
}

async function flowEvidence() {
  const result = await quoteUntilSimulated(async () => {
    const quote = await flow.quote(
      {
        profile: 'proof/monad-mainnet',
        account: GROUP_LIKE_ACCOUNT,
        tokenIn: AUSD.address,
        tokenOut: WMON.address,
        amountIn: 1_000_000n,
        slippageBps: 50,
      },
      Date.now(),
    );
    const prepared = flow.prepare(quote, {
      maxSlippageBps: 75,
      maxInputAmount: 1_000_000n,
      now: Date.now(),
    });
    write('flow-quote-ausd-wmon.json', 'MAINNET_READ_ONLY', {
      description:
        'Live Kuru Flow quote AUSD->WMON for 1 AUSD from a group-like account with no funds; calldata decoded and verified (target = registry KuruFlowEntrypoint, exact approval, minOut >= 75 bps policy floor)',
      groupLikeAccount: GROUP_LIKE_ACCOUNT,
      quote,
      prepared,
    });
    return prepared;
  });
  write('flow-simulation-ausd-wmon.json', 'MAINNET_SIMULATION', {
    description:
      'eth_simulateV1 of [approve(exact), swap] from the group-like account with its AUSD balance overridden to exactly the trade amount (storage slot found by prestate trace; AUSD packs a frozen flag in the low byte)',
    attempts: result.attempts,
    final: result.prepared
      ? {
          quoteId: result.prepared.quoteId,
          calldataHash: result.prepared.calldataHash,
          minOutput: result.prepared.minOutput,
          outputAmount: result.simulation!.outputAmount,
          residualAllowance: result.simulation!.residualAllowance,
          inputSpent: (
            BigInt(result.simulation!.inputBalanceBefore) -
            BigInt(result.simulation!.inputBalanceAfter)
          ).toString(),
        }
      : null,
  });
  if (!result.prepared)
    throw new Error(
      'no AUSD->WMON quote simulated successfully in three attempts',
    );
}

async function skillEvidence() {
  let refusal: unknown = null;
  try {
    KuruSkillAdapter.assertSkillPair(
      'proof/monad-mainnet',
      AUSD.address,
      WMON.address,
    );
  } catch (error) {
    refusal = failure(error);
  }
  let skillPlan: unknown = null;
  const result = await quoteUntilSimulated(async () => {
    const prepared = await skill.prepare(
      {
        side: 'buy',
        token: 'WMON',
        amountIn: 1_000_000n,
        from: GROUP_LIKE_ACCOUNT,
        slippageBps: 50,
        now: Date.now(),
      },
      { maxSlippageBps: 75, maxInputAmount: 1_000_000n },
    );
    skillPlan = prepared;
    return prepared;
  });
  write('skill-prepare-usdc-wmon.json', 'MAINNET_SIMULATION', {
    description:
      'Kuru trading-skill semantics (BUY WMON with 1 USDC, Kuru-Labs/kuru-trading-skills@6075030b): unsigned approve (exact, only when allowance is short) + swap, simulated with eth_simulateV1; AUSD->WMON is refused as a non-skill pair',
    lastPlan: skillPlan,
    attempts: result.attempts,
    ausdToWmonSkillRefusal: refusal,
  });
  if (!result.prepared)
    throw new Error(
      'no USDC->WMON quote simulated successfully in three attempts',
    );
}

async function clobEvidence() {
  const exchange = await clob.exchangeInfo();
  const markets: Record<string, unknown> = {};
  for (const profile of [
    'proof/monad-mainnet',
    'sandbox/monad-testnet',
  ] as const)
    for (const market of kuruDeployment(profile).markets) {
      const key = `${profile}:${market.pair}`;
      try {
        const params = await clob.marketParams(profile, market.pair);
        const health = await clob.health(profile, market.pair);
        const book = await clob.l2Book(profile, market.pair);
        markets[key] = {
          market: market.address,
          params,
          health,
          l2Book: {
            blockNumber: book.blockNumber,
            bids: book.bids.slice(0, 5),
            asks: book.asks.slice(0, 5),
            bidLevels: book.bids.length,
            askLevels: book.asks.length,
          },
        };
      } catch (error) {
        markets[key] = { market: market.address, error: failure(error) };
      }
    }
  let monAusdBuy: unknown;
  try {
    await clob.prepareMarketBuy({
      profile: 'proof/monad-mainnet',
      pair: 'MON-AUSD',
      quoteAmount: 1_000_000n,
      minBaseOut: 1n,
    });
    monAusdBuy = { prepared: true };
  } catch (error) {
    monAusdBuy = failure(error);
  }
  const book = await clob.l2Book('proof/monad-mainnet', 'MON-USDC');
  const params = await clob.marketParams('proof/monad-mainnet', 'MON-USDC');
  const bestAsk = book.asks[0];
  const estimate = bestAsk
    ? (1_000_000n *
        params.pricePrecision *
        10n ** BigInt(params.baseDecimals)) /
      (bestAsk.price * 10n ** BigInt(params.quoteDecimals))
    : 0n;
  const minBaseOut = (estimate * 9_000n) / 10_000n;
  const buy = await clob.prepareMarketBuy({
    profile: 'proof/monad-mainnet',
    pair: 'MON-USDC',
    quoteAmount: 1_000_000n,
    minBaseOut,
  });
  const client = clients['proof/monad-mainnet'];
  const simulation = await simulateWithAssetChanges(client, {
    account: GROUP_LIKE_ACCOUNT,
    fundToken: USDC.address,
    fundAmount: 1_000_000n,
    calls: [
      ...(buy.approval
        ? [
            {
              label: 'approve',
              to: buy.approval.token,
              data: buy.approval.calldata,
            },
          ]
        : []),
      {
        label: 'placeAndExecuteMarketBuy',
        to: buy.call.target,
        data: buy.call.calldata,
        value: buy.call.value,
      },
    ],
  });
  write('clob-reads.json', 'MAINNET_READ_ONLY', {
    description:
      'Kuru exchangeInfo, on-chain getMarketParams/bestBidAsk/getL2Book for MON-AUSD and MON-USDC (mainnet) and MON-USDC (testnet)',
    exchangeInfo: exchange,
    registryDrift: {
      mainnet: KuruClobAdapter.exchangeDrift('proof/monad-mainnet', exchange),
    },
    markets,
    monAusdMarketBuy: monAusdBuy,
  });
  write('clob-simulation-mon-usdc-buy.json', 'MAINNET_SIMULATION', {
    description:
      'placeAndExecuteMarketBuy on MON-USDC for exactly 1 USDC (FOK), minOut 90% of the best-ask estimate; eth_simulateV1 with a USDC balance override. asset changes show the exact USDC spend and the native MON received.',
    prepared: buy,
    estimateFromBestAsk: estimate,
    simulation,
  });
}

async function testnetFlowEvidence() {
  const testnet = kuruDeployment('sandbox/monad-testnet');
  let raw: unknown;
  try {
    raw = await flowClient.quote({
      userAddress: GROUP_LIKE_ACCOUNT,
      tokenIn: testnet.tokens.USDC!.address,
      tokenOut: testnet.tokens.MON!.address,
      amount: 1_000_000n,
      slippageBps: 50,
    });
  } catch (error) {
    raw = failure(error);
  }
  write('flow-testnet-probe.json', 'MAINNET_READ_ONLY', {
    description:
      'Kuru Flow API asked for a testnet USDC->MON quote; Flow has no testnet entrypoint in the registry and the capability report says UNAVAILABLE_IN_NETWORK_PROFILE',
    response: raw,
  });
}

async function capabilityEvidence() {
  const capabilities = new KuruCapabilities({
    clob,
    flow: flowClient,
    probeAddress: GROUP_LIKE_ACCOUNT,
  });
  write('capabilities.json', 'MAINNET_READ_ONLY', {
    mainnet: await capabilities.discover(
      'proof/monad-mainnet',
      Math.floor(Date.now() / 1000),
    ),
    testnet: await capabilities.discover(
      'sandbox/monad-testnet',
      Math.floor(Date.now() / 1000),
    ),
  });
}

async function stablePairEvidence() {
  const quote = await flow.quote(
    {
      profile: 'proof/monad-mainnet',
      account: GROUP_LIKE_ACCOUNT,
      tokenIn: AUSD.address,
      tokenOut: USDC.address,
      amountIn: 1_000_000n,
      slippageBps: 50,
    },
    Date.now(),
  );
  const prepared = flow.prepare(quote, {
    maxSlippageBps: 75,
    maxInputAmount: 1_000_000n,
    now: Date.now(),
  });
  write('flow-quote-ausd-usdc.json', 'MAINNET_READ_ONLY', {
    description:
      'Live Kuru Flow quote AUSD->USDC (the AUSD/USDC venue reference used by the CRE workflow); prepared and verified',
    quote,
    prepared,
  });
}

const steps: [string, () => Promise<unknown>][] = [
  ['flow', flowEvidence],
  ['stable', stablePairEvidence],
  ['skill', skillEvidence],
  ['clob', clobEvidence],
  ['testnet', testnetFlowEvidence],
  ['capabilities', capabilityEvidence],
];
const only = process.env.KURU_EVIDENCE_STEPS?.split(',');
for (const [name, step] of steps) {
  if (only && !only.includes(name)) continue;
  try {
    await step();
  } catch (error) {
    console.error(`${name} failed`, failure(error));
    process.exitCode = 1;
  }
}
if (rawQuotes.length)
  write('flow-raw-quote-responses.json', 'MAINNET_READ_ONLY', {
    description:
      'Raw Kuru Flow /api/quote request and response bodies exactly as received (JWTs are not recorded); used as parser fixtures',
    quotes: rawQuotes,
  });
