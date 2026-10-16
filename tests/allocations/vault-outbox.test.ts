import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { connectChain } from '@synq/execution-worker/arc';
import { MemoryOutboxStore } from '@synq/execution-worker/arc-outbox';
import {
  isVaultPayRecord,
  recoverVaultPay,
  vaultPayOnce,
} from '@synq/execution-worker/vault-outbox';
import {
  DEV,
  SAVINGS,
  USDC,
  countingSigner,
  fakeVaultChain,
  usd,
} from './harness.js';

const REF = `0x${'ab'.repeat(32)}` as Hex;
const now = () => 1_800_000_000;

async function setup(caps?: { perPaymentCap?: bigint; windowCap?: bigint }) {
  const fake = fakeVaultChain(caps);
  const chain = await connectChain('arc-testnet', undefined, fake.client);
  return {
    fake,
    chain,
    store: new MemoryOutboxStore(),
    signer: countingSigner(),
  };
}

describe('vaultPayOnce', () => {
  it('records signed bytes before broadcast and pays once per key', async () => {
    const { fake, chain, store, signer } = await setup();
    let authorized = 0;
    const pay = () =>
      vaultPayOnce({
        store,
        key: 'k1',
        chain,
        signer,
        asset: USDC,
        call: { recipient: DEV, amount: usd('5'), ref: REF },
        authorize: async () => {
          authorized++;
        },
        now,
        afterRecord: async (r) => {
          expect(fake.broadcasts).not.toContain(r.hash);
        },
      });
    const a = await pay();
    expect(a.signedNow).toBe(true);
    expect(isVaultPayRecord(a.record)).toBe(true);
    expect(a.evidence).toMatchObject({ to: DEV, ref: REF, logIndex: 1 });
    const b = await pay();
    expect(b.signedNow).toBe(false);
    expect(b.record.hash).toBe(a.record.hash);
    expect(signer.total).toBe(1);
    expect(authorized).toBe(1);
    expect(fake.paid).toHaveLength(1);
  });

  it('refuses to reuse a key for a different payment', async () => {
    const { chain, store, signer } = await setup();
    const base = {
      store,
      key: 'k2',
      chain,
      signer,
      asset: USDC,
      authorize: async () => undefined,
      now,
    };
    await vaultPayOnce({
      ...base,
      call: { recipient: DEV, amount: usd('5'), ref: REF },
    });
    await expect(
      vaultPayOnce({
        ...base,
        call: { recipient: SAVINGS, amount: usd('5'), ref: REF },
      }),
    ).rejects.toMatchObject({ code: 'TX_MISMATCH' });
    expect(signer.total).toBe(1);
  });

  it('an over-cap payment reverts in simulation and is never signed or authorized', async () => {
    const { chain, store, signer, fake } = await setup({
      perPaymentCap: usd('1'),
    });
    let authorized = false;
    await expect(
      vaultPayOnce({
        store,
        key: 'k3',
        chain,
        signer,
        asset: USDC,
        call: { recipient: DEV, amount: usd('2'), ref: REF },
        authorize: async () => {
          authorized = true;
        },
        now,
      }),
    ).rejects.toThrow(/CapExceeded\(2000000,1000000\)/);
    expect(authorized).toBe(false);
    expect(signer.total).toBe(0);
    expect(await store.get('k3')).toBeNull();
    expect(fake.broadcasts).toEqual([]);
  });

  it('a recorded payment whose nonce was used by something else goes to review, not re-payment', async () => {
    const { chain, store, signer, fake } = await setup();
    await vaultPayOnce({
      store,
      key: 'k4',
      chain,
      signer,
      asset: USDC,
      call: { recipient: DEV, amount: usd('5'), ref: REF },
      authorize: async () => undefined,
      now,
      afterRecord: () => {
        throw new Error('crash before broadcast');
      },
    }).catch(() => undefined);
    const rec = (await store.get('k4'))!;
    // Another transaction from the operator consumes the recorded nonce.
    const other = await vaultPayOnce({
      store,
      key: 'k5',
      chain,
      signer,
      asset: USDC,
      call: { recipient: SAVINGS, amount: usd('1'), ref: REF },
      authorize: async () => undefined,
      now,
    });
    expect(other.record.prepared.nonce).toBe(rec.prepared.nonce);
    const r = await recoverVaultPay(store, chain, rec, USDC, now);
    expect(r.record.state).toBe('NEEDS_REVIEW');
    expect(fake.paid.map((p) => p.recipient)).toEqual([SAVINGS]);
  });
});
