import { describe, expect, it } from 'vitest';
import {
  AgoraClient,
  presentAusdBalance,
  supplyOnChain,
} from '@synq/plugin-agora';
import { fakeFetch } from './helpers.js';

const metrics = {
  circulatingSupply: '175312293.646175',
  totalSupply: '205255055.748162',
  partial: false,
  chains: [
    {
      chainId: 'eip155:143',
      network: 'monad',
      circulatingSupply: '92822418.091975',
      totalSupply: '99529478.491219',
    },
  ],
};

describe('Agora adapter interface (B08.6)', () => {
  it('reads public metrics without auth and parses per-chain supply', async () => {
    const f = fakeFetch({ '/v0/metrics': () => metrics });
    const agora = new AgoraClient({ fetch: f.fetch });
    const { metrics: m } = await agora.metrics();
    expect(supplyOnChain(m, 'eip155:143')?.totalSupply).toBe('99529478.491219');
    expect(f.calls[0]?.url).toBe('https://api.agora.finance/v0/metrics');
  });

  it('AUSD-031 authenticated accounts/routes/transactions are PENDING_CREDENTIALS without an issued key; no request is made', async () => {
    const f = fakeFetch({});
    const agora = new AgoraClient({ fetch: f.fetch });
    expect(agora.status().status).toBe('PENDING_CREDENTIALS');
    await expect(agora.accounts()).rejects.toThrow('Agora API key absent');
    await expect(agora.routes()).rejects.toThrow('Agora API key absent');
    await expect(agora.transactions()).rejects.toThrow('Agora API key absent');
    expect(f.calls).toHaveLength(0);
  });

  it('with a key, exchanges it for a session token and pages typed routes', async () => {
    const f = fakeFetch({
      '/v0/auth/token': () => ({ sessionJwt: 'jwt' }),
      '/v0/routes': (url) =>
        url.includes('cursor=c2')
          ? { data: [], nextCursor: null }
          : {
              data: [
                {
                  id: 'r1',
                  createdAt: '2026-10-10T00:00:00Z',
                  from: { currency: 'usd' },
                  to: { currency: 'ausd', accountId: 'a1', chain: 'monad' },
                  instructions: [],
                },
              ],
              nextCursor: 'c2',
            },
    });
    const agora = new AgoraClient({ apiKey: 'k', fetch: f.fetch });
    const routes = await agora.routes({ toChain: 'monad' });
    expect(routes).toHaveLength(1);
    expect(routes[0]?.to.currency).toBe('ausd');
    expect(
      f.calls.filter((c) => c.url.includes('/v0/auth/token')),
    ).toHaveLength(1);
  });

  it('AUSD-030 an AUSD balance is cash-like with no yield or APY; rewards report unavailable', () => {
    expect(presentAusdBalance('12.500000')).toMatchObject({
      classification: 'CASH_LIKE_STABLECOIN',
      yieldBearing: false,
      apy: null,
    });
    expect(new AgoraClient().rewards()).toMatchObject({
      status: 'UNAVAILABLE',
      apy: null,
    });
  });
});
