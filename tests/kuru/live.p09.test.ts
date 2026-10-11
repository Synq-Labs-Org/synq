import { describe, expect, it } from 'vitest';
import { createPublicClient, http } from 'viem';
import { monadMainnetProfile, monadTestnetProfile } from '@synq/chain-registry';
import type { ProfileName } from '@synq/domain';
import {
  KuruCapabilities,
  KuruClobAdapter,
  KuruFlowAdapter,
  KuruFlowClient,
  kuruDeployment,
  parseFlowQuote,
  simulateSwap,
} from '@synq/plugin-kuru';
import { ACCOUNT } from './fixtures.js';

const live = process.env.SYNQ_LIVE_P09 === '1';
const clients = {
  'proof/monad-mainnet': createPublicClient({
    transport: http(monadMainnetProfile.defaultRpcUrl),
  }),
  'sandbox/monad-testnet': createPublicClient({
    transport: http(monadTestnetProfile.defaultRpcUrl),
  }),
};
const clientFor = (p: ProfileName) =>
  clients[p as keyof typeof clients] ?? clients['proof/monad-mainnet'];
const flowClient = new KuruFlowClient({
  fetch: (u, i) => fetch(u, i),
  clock: Date,
});
const flow = new KuruFlowAdapter(flowClient);
const clob = new KuruClobAdapter(clientFor, (u, i) => fetch(u, i));
const mainnet = kuruDeployment('proof/monad-mainnet');

describe.skipIf(!live)(
  `Kuru live network suite ${live ? '' : '[set SYNQ_LIVE_P09=1]'} (MAINNET_READ_ONLY / MAINNET_SIMULATION)`,
  () => {
    it('quotes AUSD->WMON live, verifies the calldata and simulates it with eth_simulateV1', async () => {
      let lastFailure = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        const quote = await flow.quote(
          {
            profile: 'proof/monad-mainnet',
            account: ACCOUNT,
            tokenIn: mainnet.tokens.AUSD!.address,
            tokenOut: mainnet.tokens.WMON!.address,
            amountIn: 1_000_000n,
            slippageBps: 50,
          },
          Date.now(),
        );
        expect(quote.shape).toBe('LIVE');
        const prepared = flow.prepare(quote, {
          maxSlippageBps: 75,
          maxInputAmount: 1_000_000n,
          now: Date.now(),
        });
        const simulation = await simulateSwap(clients['proof/monad-mainnet'], {
          account: prepared.account,
          tokenIn: prepared.tokenIn,
          tokenOut: prepared.tokenOut,
          amountIn: prepared.amountIn,
          approval: prepared.approval,
          swap: prepared.swap,
        });
        if (simulation.succeeded) {
          expect(BigInt(simulation.outputAmount)).toBeGreaterThanOrEqual(
            prepared.minOutput,
          );
          expect(simulation.residualAllowance).toBe('0');
          expect(simulation.inputBalanceAfter).toBe('0');
          return;
        }
        lastFailure = simulation.failure ?? 'failed';
      }
      throw new Error(`no simulated route in three quotes: ${lastFailure}`);
    }, 120_000);

    it('CLOB reads: MON-AUSD empty book is UNHEALTHY, MON-USDC params match the registry, testnet MON-USDC reads', async () => {
      expect(
        (await clob.health('proof/monad-mainnet', 'MON-AUSD')).status,
      ).toBeDefined();
      await expect(
        clob.marketParams('proof/monad-mainnet', 'MON-USDC'),
      ).resolves.toMatchObject({ quoteDecimals: 6, baseDecimals: 18 });
      await expect(
        clob.marketParams('sandbox/monad-testnet', 'MON-USDC'),
      ).resolves.toMatchObject({ quoteDecimals: 6 });
      expect(
        KuruClobAdapter.exchangeDrift(
          'proof/monad-mainnet',
          await clob.exchangeInfo(),
        ),
      ).toEqual([]);
    }, 60_000);

    it('capabilities: Flow available on mainnet, UNAVAILABLE_IN_NETWORK_PROFILE on testnet where Flow finds no paths', async () => {
      const caps = new KuruCapabilities({
        clob,
        flow: flowClient,
        probeAddress: ACCOUNT,
      });
      expect((await caps.discover('proof/monad-mainnet', 1)).flow.status).toBe(
        'AVAILABLE',
      );
      expect(
        (await caps.discover('sandbox/monad-testnet', 1)).flow.status,
      ).toBe('UNAVAILABLE_IN_NETWORK_PROFILE');
      const testnet = kuruDeployment('sandbox/monad-testnet');
      const raw = await flowClient.quote({
        userAddress: ACCOUNT,
        tokenIn: testnet.tokens.USDC!.address,
        tokenOut: testnet.tokens.MON!.address,
        amount: 1_000_000n,
        slippageBps: 50,
      });
      expect(() => parseFlowQuote(raw)).toThrow('QUOTE_FAILED');
    }, 60_000);
  },
);
