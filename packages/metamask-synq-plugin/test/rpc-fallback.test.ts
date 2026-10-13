import { createPublicClient, custom, HttpRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { contribute } from '../src/core/contribute.js';
import { SynqPluginError, synqError } from '../src/core/errors.js';
import { MemoryJournal } from '../src/core/journal.js';
import { NETWORK } from '../src/core/network.js';
import {
  ChainReads,
  RpcFallback,
  gatewayRejectsChain,
  rpcUrlFromEnv,
} from '../src/core/rpc.js';
import { MemorySessionStore } from '../src/core/session.js';
import type { HostContext } from '../src/plugin-host.js';
import { makeDeps } from './deps.js';
import { FakeSynqApi } from './fake-api.js';
import { FakeChain, GROUP_ID, MEMBER, SAFE, fakeHostContext } from './fakes.js';

const NOW = 1_790_000_000_000;
const KEYED = 'https://rpc.example.test/v1/secret-api-key-123';

const invalidChain = () =>
  new HttpRequestError({
    url: 'https://gateway.example.test/v3/project',
    status: 400,
    body: { method: 'eth_chainId' },
    details: '{"error":"Invalid chainId"}',
  });

/** An Agent Wallet gateway that does not serve Monad testnet, counting calls. */
function rejectingGateway(error: () => Error = invalidChain) {
  const calls: string[] = [];
  const client = createPublicClient({
    transport: custom(
      {
        request: async ({ method }: { method: string }) => {
          calls.push(method);
          throw error();
        },
      },
      { retryCount: 0 },
    ),
    pollingInterval: 5,
    cacheTime: 0,
  });
  return { calls, client };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (error) {
    const synq = synqError(error);
    if (synq) return synq.code;
    throw error;
  }
  return 'NO_ERROR';
};

function setup(opts: { fallbackChainId?: number; gatewayError?: () => Error }) {
  const chain = new FakeChain();
  const api = new FakeSynqApi(chain, () => NOW);
  const { ctx: base, log } = fakeHostContext(chain);
  const gateway = rejectingGateway(opts.gatewayError);
  const waits: (boolean | undefined)[] = [];
  const ctx: HostContext = {
    ...base,
    publicClient: () =>
      gateway.client as unknown as ReturnType<HostContext['publicClient']>,
    walletExecutor: async (io, source) => {
      const execute = await base.walletExecutor(io, source);
      return (request, o) => {
        if (request.kind === 'transaction') waits.push(o?.waitForReceipt);
        return execute(request, o);
      };
    },
  };
  const remote = new FakeChain();
  remote.chainId = opts.fallbackChainId ?? NETWORK.chainId;
  // The fallback serves the same ledger; only its eth_chainId may differ.
  const fallbackTransport = custom({
    request: async (a: { method: string; params?: unknown }) =>
      a.method === 'eth_chainId'
        ? remote.request(a)
        : chain.request(a as Parameters<FakeChain['request']>[0]),
  });
  const deps = makeDeps(
    ctx,
    api.fetch,
    'synq:contribute',
    new MemorySessionStore(),
    () => NOW,
    new RpcFallback(fallbackTransport),
  );
  const run = () =>
    contribute(
      deps,
      { groupId: GROUP_ID, amount: '1.5' },
      {
        journal: new MemoryJournal(),
        reconcileAttempts: 3,
        reconcileDelayMs: 0,
        sleep: async () => {},
      },
    );
  return { chain, gateway, log, waits, run };
}

const transactions = (log: ReturnType<typeof setup>['log']) =>
  log.flatMap((l) => l.requests).filter((r) => r.kind === 'transaction').length;

describe('SYNQ_MM_RPC_URL public-RPC fallback', () => {
  it('accepts only an https URL without embedded credentials, and never echoes it', () => {
    expect(rpcUrlFromEnv({})).toBeNull();
    expect(rpcUrlFromEnv({ SYNQ_MM_RPC_URL: '  ' })).toBeNull();
    expect(rpcUrlFromEnv({ SYNQ_MM_RPC_URL: KEYED })).toBe(KEYED);
    for (const bad of [
      'http://rpc.example.test/v1/secret-api-key-123',
      'ws://rpc.example.test/secret-api-key-123',
      'not a url secret-api-key-123',
      'https://user:secret-api-key-123@rpc.example.test',
    ]) {
      let message = '';
      try {
        rpcUrlFromEnv({ SYNQ_MM_RPC_URL: bad });
      } catch (error) {
        expect(error).toBeInstanceOf(SynqPluginError);
        expect((error as SynqPluginError).code).toBe('CONFIG_INVALID');
        message = (error as Error).message;
      }
      expect(message).not.toBe('');
      expect(message).not.toContain('secret-api-key-123');
    }
  });

  it('recognises the gateway chain rejection and nothing else', () => {
    expect(gatewayRejectsChain(invalidChain())).toBe(true);
    expect(
      gatewayRejectsChain(new Error('wrapped', { cause: invalidChain() })),
    ).toBe(true);
    expect(gatewayRejectsChain(new Error('fetch failed'))).toBe(false);
    expect(
      gatewayRejectsChain(
        new HttpRequestError({
          url: 'https://gateway.example.test',
          status: 500,
          details: 'internal error',
        }),
      ),
    ).toBe(false);
  });

  it('contributes on Monad testnet when the gateway rejects the chain: reads and receipt via the verified RPC, signing in the wallet', async () => {
    const t = setup({});
    const r = await t.run();
    expect(r.mode).toBe('REAL_TESTNET');
    expect(t.chain.balance(SAFE)).toBe(1_500_000n);
    expect(t.chain.balance(MEMBER)).toBe(8_500_000n);
    // The gateway was tried once, then the chain moved to the fallback.
    expect(t.gateway.calls).toEqual(['eth_chainId']);
    // The wallet still signed and submitted, without polling the rejecting gateway.
    expect(transactions(t.log)).toBe(1);
    expect(t.waits).toEqual([false]);
  });

  it('refuses a fallback RPC that reports another chain, before any wallet call', async () => {
    const t = setup({ fallbackChainId: 1 });
    expect(await code(t.run())).toBe('WRONG_CHAIN');
    expect(transactions(t.log)).toBe(0);
  });

  it('does not fall back on unrelated gateway failures', async () => {
    const t = setup({ gatewayError: () => new Error('fetch failed') });
    await expect(t.run()).rejects.toThrow();
    expect(transactions(t.log)).toBe(0);
  });

  it('never serves a mainnet chain from the fallback', async () => {
    expect(() => new RpcFallback(KEYED, 1)).toThrow(SynqPluginError);
    const chain = new FakeChain();
    const fallback = new RpcFallback(
      custom({
        request: (a: { method: string; params?: unknown }) =>
          chain.request(a as Parameters<FakeChain['request']>[0]),
      }),
    );
    const gateway = rejectingGateway();
    const reads = new ChainReads(() => gateway.client as never, fallback);
    // Chain 1 goes to the gateway only; its rejection surfaces unchanged.
    await expect(reads.publicClient(1).getChainId()).rejects.toThrow();
    expect(reads.usingFallback(1)).toBe(false);
    expect(await reads.publicClient(NETWORK.chainId).getChainId()).toBe(
      NETWORK.chainId,
    );
    expect(reads.usingFallback(NETWORK.chainId)).toBe(true);
  });
});
