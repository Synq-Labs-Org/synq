import { writeFileSync } from 'node:fs';
import { createPublicClient, http, parseAbi } from 'viem';
import { chainRegistry, monadMainnetProfile } from '@synq/chain-registry';

const REGISTRY_KEY = 'mainnetChainlinkMonUsd';
const DAYS = Number(process.env.DAYS ?? 120);
const OUT = new URL('./mon-usd-chainlink-mainnet.json', import.meta.url);
const abi = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
  'function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)',
  'function decimals() view returns (uint8)',
  'function description() view returns (string)',
]);
const feed = chainRegistry.contracts[REGISTRY_KEY];
if (!feed || feed.kind !== 'CHAINLINK_PRICE_FEED') throw new Error('feed');
const rpc =
  process.env.SYNQ_MONAD_MAINNET_RPC_URL ?? monadMainnetProfile.defaultRpcUrl;
const client = createPublicClient({
  transport: http(rpc, { retryCount: 4, retryDelay: 400, timeout: 20_000 }),
});
const read = (functionName: 'latestRoundData' | 'decimals' | 'description') =>
  client.readContract({ address: feed.address, abi, functionName });

const latest = (await read('latestRoundData')) as readonly [
  bigint,
  bigint,
  bigint,
  bigint,
  bigint,
];
const phase = latest[0] >> 64n;
const MASK = (1n << 64n) - 1n;
const cache = new Map<bigint, { answer: bigint; updatedAt: number }>();
let calls = 0;
async function round(n: bigint) {
  const hit = cache.get(n);
  if (hit) return hit;
  calls++;
  const r = await client.readContract({
    address: feed!.address,
    abi,
    functionName: 'getRoundData',
    args: [(phase << 64n) | n],
  });
  const value = { answer: r[1], updatedAt: Number(r[3]) };
  cache.set(n, value);
  return value;
}
async function lastAtOrBefore(target: number, lo: bigint, hi: bigint) {
  let a = lo;
  let b = hi;
  while (b - a > 1n) {
    const [ta, tb] = [(await round(a)).updatedAt, (await round(b)).updatedAt];
    let mid =
      tb > ta
        ? a + ((b - a) * BigInt(Math.max(0, target - ta))) / BigInt(tb - ta)
        : (a + b) / 2n;
    if (mid <= a) mid = a + 1n;
    if (mid >= b) mid = b - 1n;
    if (b - a > 64n) {
      const spread = (b - a) / 64n;
      const t = (await round(mid)).updatedAt;
      if (t <= target) {
        a = mid;
        const probe = mid + spread < b ? mid + spread : b - 1n;
        if (probe > a && (await round(probe)).updatedAt > target) b = probe;
        else if (probe > a) a = probe;
      } else {
        b = mid;
        const probe = mid - spread > a ? mid - spread : a + 1n;
        if (probe < b && (await round(probe)).updatedAt <= target) a = probe;
        else if (probe < b) b = probe;
      }
    } else if ((await round(mid)).updatedAt <= target) a = mid;
    else b = mid;
  }
  return (await round(b)).updatedAt <= target ? b : a;
}

const latestAgg = latest[0] & MASK;
const first = await round(1n);
const latestTs = Number(latest[3]);
const dayEnd = Math.floor(latestTs / 86_400) * 86_400;
const points: {
  roundId: string;
  answer: string;
  updatedAt: number;
  day: number;
}[] = [];
let hi = latestAgg;
for (let k = 0; k < DAYS; k++) {
  const target = dayEnd - k * 86_400;
  if (target < first.updatedAt) break;
  const r = await lastAtOrBefore(target, 1n, hi);
  const data = await round(r);
  if (
    data.updatedAt > target ||
    (r < latestAgg && (await round(r + 1n)).updatedAt <= target)
  )
    throw new Error(`round search failed for ${target}`);
  points.push({
    roundId: ((phase << 64n) | r).toString(),
    answer: data.answer.toString(),
    updatedAt: data.updatedAt,
    day: target,
  });
  hi = r;
}
points.reverse();
const decimals = Number(await read('decimals'));
const description = String(await read('description'));
writeFileSync(
  OUT,
  JSON.stringify(
    {
      provenance: {
        kind: 'REAL_MAINNET_READ_ONLY',
        source: 'Chainlink price feed proxy getRoundData on Monad mainnet',
        registryKey: REGISTRY_KEY,
        chainId: feed.chainId,
        description,
        decimals,
        phaseId: phase.toString(),
        rpc,
        sampling: 'last round with updatedAt <= each UTC midnight',
        fetchedAt: new Date().toISOString(),
        rpcCalls: calls,
        command: 'node --import tsx tests/strategy/fixtures/fetch-mon-usd.ts',
      },
      points,
    },
    null,
    2,
  ) + '\n',
);
console.log(`wrote ${points.length} daily points using ${calls} round reads`);
