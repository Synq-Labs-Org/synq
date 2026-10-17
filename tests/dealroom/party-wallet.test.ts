import { describe, expect, it } from 'vitest';
import { keccak256, toHex, type Hex, type PublicClient } from 'viem';
import { chainProfile, contract } from '@synq/chain-registry/arc';
import {
  MemoryEscrowBroadcastJournal,
  escrowCalldata,
  sendEscrowCall,
} from '@synq/execution-worker/escrow';
import type { ArcChain } from '@synq/execution-worker/arc';
import { client, mallory } from './harness.js';

const ESCROW = contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address;
const data = escrowCalldata.milestone('release', 7n, 0);

function chainWith(tx: {
  from: Hex;
  to: Hex;
  input: Hex;
  value?: bigint;
  status?: 'success' | 'reverted';
}) {
  const hash = keccak256(toHex(JSON.stringify(tx, (_k, v) => String(v))));
  const c = {
    getTransaction: async (q: { hash: Hex }) => {
      if (q.hash !== hash) throw new Error('not found');
      return {
        hash,
        from: tx.from,
        to: tx.to,
        input: tx.input,
        value: tx.value ?? 0n,
        chainId: chainProfile('arc-testnet').chainId,
      };
    },
    waitForTransactionReceipt: async () => ({
      status: tx.status ?? 'success',
      transactionHash: hash,
      blockNumber: 10n,
      gasUsed: 50000n,
      effectiveGasPrice: 20_000_000_000n,
      logs: [],
    }),
  };
  return {
    hash,
    chain: {
      profile: chainProfile('arc-testnet'),
      client: c as unknown as PublicClient,
    } satisfies ArcChain,
  };
}
const party = {
  address: client.address,
  signTransaction: async (): Promise<Hex> => {
    throw new Error('the party wallet signs');
  },
};
const send = (chain: ArcChain, hash: Hex) =>
  sendEscrowCall(chain, party, 'release', ESCROW, data, {
    journal: new MemoryEscrowBroadcastJournal(),
    grantId: 'grt_test',
    step: 'RELEASE',
    submitted: hash,
  });

describe('G7 party-wallet escrow transactions are proven, never signed by Synq', () => {
  it('accepts the exact prepared call from the party and records it before trusting it', async () => {
    const f = chainWith({ from: client.address, to: ESCROW, input: data });
    const journal = new MemoryEscrowBroadcastJournal();
    const out = await sendEscrowCall(f.chain, party, 'release', ESCROW, data, {
      journal,
      grantId: 'grt_test',
      step: 'RELEASE',
      submitted: f.hash,
    });
    expect(out.tx.hash).toBe(f.hash);
    expect(journal.forGrant('grt_test')).toMatchObject([
      { step: 'RELEASE', hash: f.hash, from: client.address },
    ]);
  });
  it('refuses another sender, other calldata, attached value, another target or a revert', async () => {
    const cases = [
      { from: mallory.address, to: ESCROW, input: data },
      {
        from: client.address,
        to: ESCROW,
        input: escrowCalldata.milestone('release', 7n, 1),
      },
      { from: client.address, to: ESCROW, input: data, value: 1n },
      { from: client.address, to: mallory.address, input: data },
      {
        from: client.address,
        to: ESCROW,
        input: data,
        status: 'reverted' as const,
      },
    ];
    for (const c of cases) {
      const f = chainWith(c);
      await expect(send(f.chain, f.hash)).rejects.toMatchObject({
        code: 'TX_MISMATCH',
      });
    }
  });
  it('refuses an unknown hash', async () => {
    const f = chainWith({ from: client.address, to: ESCROW, input: data });
    await expect(
      send(f.chain, `0x${'00'.repeat(32)}` as Hex),
    ).rejects.toMatchObject({ code: 'TX_MISMATCH' });
  });
});
