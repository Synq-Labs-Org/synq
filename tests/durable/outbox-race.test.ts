import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { money } from '@synq/domain';
import { connectChain } from '@synq/execution-worker/arc';
import { MemoryOutboxStore, payOnce } from '@synq/execution-worker/arc-outbox';
import { USDC, countingSigner, fakeArc } from './fake-arc.js';

describe('payout outbox broadcast race', () => {
  it('the signer still succeeds when a concurrent recovery broadcast its recorded bytes first', async () => {
    const payer = privateKeyToAccount(generatePrivateKey());
    const payee = privateKeyToAccount(generatePrivateKey()).address;
    const arc = fakeArc();
    arc.setPayer(payer.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const store = new MemoryOutboxStore();
    const signer = countingSigner(payer);
    let t = 1;
    const now = () => t++;
    const transfer = {
      from: payer.address,
      to: payee,
      amount: money(USDC, 250_000n),
    };
    let loser: Awaited<ReturnType<typeof payOnce>> | undefined;
    const winner = await payOnce({
      store,
      key: 'race',
      chain,
      signer,
      transfer,
      now,
      // Another worker sees the durable record and re-sends the same bytes
      // before this one broadcasts.
      afterRecord: async () => {
        loser = await payOnce({
          store,
          key: 'race',
          chain,
          signer,
          transfer,
          now,
        });
      },
    });
    expect(winner.signedNow).toBe(true);
    expect(winner.record.state).toBe('CONFIRMED');
    expect(loser?.signedNow).toBe(false);
    expect(loser?.record.hash).toBe(winner.record.hash);
    expect(arc.mined.size).toBe(1);
    expect(signer.count).toBe(1);
  });
});
