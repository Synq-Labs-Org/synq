import { readFileSync } from 'node:fs';
import { keccak256, stringToHex } from 'viem';
import {
  KuruFlowAdapter,
  KuruFlowClient,
  kuruDeployment,
  type Address,
  type HttpFetch,
} from '@synq/plugin-kuru';

type RawQuote = {
  request: { tokenIn: string; tokenOut: string };
  status: number;
  response: unknown;
};
/** Raw /api/quote bodies recorded live on Monad mainnet (bounty-evidence/kuru/flow-raw-quote-responses.json). */
export const recorded = JSON.parse(
  readFileSync('bounty-evidence/kuru/flow-raw-quote-responses.json', 'utf8'),
) as { quotes: RawQuote[] };
export const mainnet = kuruDeployment('proof/monad-mainnet');
export const AUSD = mainnet.tokens.AUSD!;
export const WMON = mainnet.tokens.WMON!;
export const USDC = mainnet.tokens.USDC!;
export const ACCOUNT =
  `0x${keccak256(stringToHex('test-group')).slice(-40)}` as Address;
export const T0 = 1_791_640_000_000;

export function rawQuote(tokenIn: Address, tokenOut: Address): unknown {
  const found = recorded.quotes.find(
    (q) =>
      q.request.tokenIn.toLowerCase() === tokenIn &&
      q.request.tokenOut.toLowerCase() === tokenOut,
  );
  if (!found) throw new Error(`no recorded quote ${tokenIn}->${tokenOut}`);
  return structuredClone(found.response);
}

export class FakeClock {
  constructor(public t = T0) {}
  now() {
    return this.t;
  }
}

export function fakeFlow(
  respond: (
    path: string,
    body: Record<string, unknown>,
  ) => {
    status?: number;
    body: unknown;
  },
) {
  const clock = new FakeClock();
  const calls: { path: string; at: number; body: Record<string, unknown> }[] =
    [];
  const fetch: HttpFetch = async (url, init) => {
    const path = url.replace(/^https:\/\/ws\.kuru\.io\/api/, '');
    const body = JSON.parse(init.body ?? '{}') as Record<string, unknown>;
    calls.push({ path, at: clock.t, body });
    const r = respond(path, body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => r.body };
  };
  const sleep = async (ms: number) => {
    clock.t += ms;
  };
  const client = new KuruFlowClient({ fetch, clock, sleep });
  return { client, clock, calls, adapter: new KuruFlowAdapter(client) };
}

export function recordedFlow(
  override?: (tokenIn: string, tokenOut: string) => unknown,
) {
  return fakeFlow((path, body) => {
    if (path === '/generate-token')
      return {
        body: {
          token: 'test-token-not-a-secret-value',
          expires_at: Math.floor(T0 / 1000) + 86_400,
          rate_limit: { rps: 1, burst: 1 },
        },
      };
    const tokenIn = String(body.tokenIn).toLowerCase() as Address;
    const tokenOut = String(body.tokenOut).toLowerCase() as Address;
    return {
      body: override?.(tokenIn, tokenOut) ?? rawQuote(tokenIn, tokenOut),
    };
  });
}
