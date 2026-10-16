import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { connectChain } from '@synq/execution-worker/arc';
import {
  MemoryOutboxStore,
  type OutboxRecord,
} from '@synq/execution-worker/arc-outbox';
import { vaultPayOnce } from '@synq/execution-worker/vault-outbox';
import { MemoryFundStore } from '@synq/treasury';
import {
  DEV,
  USDC,
  countingSigner as vaultSigner,
  fakeVaultChain,
  usd,
} from '../allocations/harness.js';
import { durableMemoryJournal } from './crash-fixtures.js';
import { groupFundRefundCrash, signedStepsCrash } from './crash-scenarios.js';

/**
 * P23-02 crash recovery for the mutable workflows that had no crash test of
 * their own (LOCAL_FIXTURE chains, memory stores standing in for the durable
 * ones; the Postgres twins are in crash-recovery.integration.test.ts). The
 * workflows that already had one are listed in the P23 report.
 */
const REF = `0x${'cd'.repeat(32)}` as Hex;
const now = () => 1_800_000_000;

describe('P23-02 vault pay-once crash recovery', () => {
  it('P23-02 vault pay-once: crash after the durable record and before broadcast resumes with the same bytes, one signature, one payment', async () => {
    const fake = fakeVaultChain();
    const chain = await connectChain('arc-testnet', undefined, fake.client);
    const store = new MemoryOutboxStore();
    const signer = vaultSigner();
    let authorized = 0;
    const pay = (afterRecord?: (r: OutboxRecord) => void) =>
      vaultPayOnce({
        store,
        key: 'p23-vault-1',
        chain,
        signer,
        asset: USDC,
        call: { recipient: DEV, amount: usd('3'), ref: REF },
        authorize: async () => {
          authorized++;
        },
        now,
        ...(afterRecord ? { afterRecord } : {}),
      });
    await expect(
      pay(() => {
        throw new Error('process killed before broadcast');
      }),
    ).rejects.toThrow(/killed/);
    expect(fake.broadcasts).toEqual([]);
    const recorded = (await store.get('p23-vault-1'))!;
    expect(recorded.state).toBe('SIGNED');
    // Restart: the recovery path re-sends the recorded bytes, never re-signs.
    const r = await pay();
    expect(r.signedNow).toBe(false);
    expect(r.record.hash).toBe(recorded.hash);
    expect(r.record.state).toBe('CONFIRMED');
    expect(signer.total).toBe(1);
    expect(authorized).toBe(1);
    expect(fake.paid).toEqual([{ recipient: DEV, amount: usd('3'), ref: REF }]);
    expect(new Set(fake.broadcasts)).toEqual(new Set([recorded.hash]));
  });

  it('P23-02 vault pay-once: worker dies waiting for the receipt after broadcast; recovery confirms from the chain without a new transaction', async () => {
    const fake = fakeVaultChain();
    const chain = await connectChain('arc-testnet', undefined, fake.client);
    const store = new MemoryOutboxStore();
    const signer = vaultSigner();
    const pay = () =>
      vaultPayOnce({
        store,
        key: 'p23-vault-2',
        chain,
        signer,
        asset: USDC,
        call: { recipient: DEV, amount: usd('2'), ref: REF },
        authorize: async () => undefined,
        now,
      });
    fake.fail.wait = 1;
    await expect(pay()).rejects.toThrow(/worker died/);
    expect((await store.get('p23-vault-2'))!.state).toBe('SIGNED');
    expect(fake.paid).toHaveLength(1);
    const r = await pay();
    expect(r.record.state).toBe('CONFIRMED');
    expect(r.evidence?.amount.baseUnits).toBe(usd('2'));
    expect(signer.total).toBe(1);
    expect(fake.paid).toHaveLength(1);
    expect(new Set(fake.broadcasts).size).toBe(1);
  });
});

describe('P23-02 group fund refund crash recovery', () => {
  it('P23-02 group fund refund: crash after execution start; a restarted service never re-admits, never double-refunds, credits one transfer', async () => {
    const store = new MemoryFundStore();
    await groupFundRefundCrash(() => store, 'p23_refund_mem');
  });
});

describe('P23-02 escrow and agent-job signed-step crash recovery', () => {
  for (const steps of [
    ['APPROVE', 'OPEN'],
    ['RELEASE'],
    ['REFUND'],
    ['JOB_APPROVE', 'JOB_FUND'],
    ['JOB_COMPLETE'],
  ] as const)
    it(`P23-02 ${steps.join('->')}: crash after signed bytes and after broadcast; every step signed and included exactly once`, async () => {
      const j = durableMemoryJournal();
      await signedStepsCrash({
        steps,
        grantId: `grt_p23_${steps.join('_').toLowerCase()}`,
        journal: j.restart,
        crashing: j.crashing,
      });
    });
});
