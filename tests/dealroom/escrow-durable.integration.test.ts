import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { encodeFunctionData, erc20Abi } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { connectChain } from '@synq/execution-worker/arc';
import {
  sendEscrowCall,
  type EscrowBroadcast,
} from '@synq/execution-worker/escrow';
import { PostgresEscrowJournal } from '@synq/execution-worker/pg-escrow';
import { PostgresGrantFence } from '@synq/execution-worker/pg-outbox';
import { migrateExecution } from '@synq/execution-worker/pg-schema';
import { durablePool, runId, testDatabaseUrl } from '../durable/pg.js';
import { countingSigner, fakeArc, USDC } from '../durable/fake-arc.js';
import { signedBoth, mandate, kernel, client, ESCROW, T0 } from './harness.js';

let pool: pg.Pool;
beforeAll(async () => {
  pool = await durablePool(
    testDatabaseUrl(
      'SYNQ_ESCROW_TEST_DATABASE_URL',
      'synq_m2_escrow_continuation_test',
    ),
  );
  await migrateExecution(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('durable escrow executor journal (LOCAL_FIXTURE chain)', () => {
  it('grant consumption and resumable operation admission are atomic and survive restart', async () => {
    const r = await signedBoth();
    const m = await mandate({
      owner: client,
      id: runId(),
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30000n,
      budget: 30000n,
    });
    const auth = await r.service.authorizeFunding(
      r.view.deal.dealId,
      kernel(m),
    );
    if (auth.decision.outcome !== 'ALLOW') throw new Error('no grant');
    const g = auth.decision.grant;
    expect(
      await Promise.all(
        Array.from({ length: 4 }, () =>
          new PostgresEscrowJournal(pool).admit(g, T0),
        ),
      ),
    ).toEqual([true, true, true, true]);
    expect(await new PostgresGrantFence(pool).consumed(g.grantId)).toBe(T0);
    expect(
      await new PostgresEscrowJournal(pool).admit(
        { ...g, grantId: `other_${runId()}` },
        T0,
      ),
    ).toBe(false);
    await new PostgresGrantFence(pool).revoke(g.nonce);
    expect(await new PostgresEscrowJournal(pool).admit(g, T0)).toBe(false);
    expect(await new PostgresGrantFence(pool).consume(g.nonce)).toBe(false);
    await expect(
      new PostgresEscrowJournal(pool).storeSigned(`${g.grantId}:OPEN`, {
        chainId: USDC.chainId,
        from: client.address,
        to: ESCROW,
        nonce: 999,
        raw: '0x01',
        hash: `0x${'11'.repeat(32)}`,
      }),
    ).rejects.toThrow(/revoked/);
    await expect(
      pool.query('DELETE FROM synq_escrow_admissions WHERE grant_id=$1', [
        g.grantId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('crash after signed bytes persist: a new journal recovers one signature and one payment', async () => {
    const acct = privateKeyToAccount(generatePrivateKey());
    const fake = fakeArc();
    fake.setPayer(acct.address);
    const chain = await connectChain('arc-testnet', undefined, fake.client);
    const signer = countingSigner(acct);
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [ESCROW, 1n],
    });
    class Interrupted extends PostgresEscrowJournal {
      override async record(_entry: EscrowBroadcast): Promise<void> {
        throw new Error('crash after durable signed bytes');
      }
    }
    const grantId = `fixture_${runId()}`;
    await expect(
      sendEscrowCall(chain, signer, 'fixture escrow step', USDC.address, data, {
        journal: new Interrupted(pool),
        grantId,
        step: 'OPEN',
      }),
    ).rejects.toThrow('crash');
    expect(fake.sent).toHaveLength(0);
    const journal = new PostgresEscrowJournal(pool);
    const stored = await journal.signed(`${grantId}:OPEN`);
    expect(stored).not.toBeNull();
    // Even if writing the broadcast marker failed, a signed OPEN is an
    // ambiguous outcome; a second funding attempt must not be authorized.
    expect(await journal.forGrant(grantId)).toHaveLength(1);
    const result = await sendEscrowCall(
      chain,
      signer,
      'fixture escrow step',
      USDC.address,
      data,
      { journal, grantId, step: 'OPEN' },
    );
    expect(result.tx.hash).toBe(stored!.hash);
    expect(signer.count).toBe(1);
    expect(fake.mined.size).toBe(1);
    await sendEscrowCall(
      chain,
      signer,
      'fixture escrow step',
      USDC.address,
      data,
      { journal: new PostgresEscrowJournal(pool), grantId, step: 'OPEN' },
    );
    expect(signer.count).toBe(1);
    expect(fake.mined.size).toBe(1);
    expect(await journal.forGrant(grantId)).toHaveLength(1);
    await expect(
      pool.query(
        'UPDATE synq_escrow_signed_calls SET hash=$2 WHERE call_key=$1',
        [`${grantId}:OPEN`, `0x${'aa'.repeat(32)}`],
      ),
    ).rejects.toThrow(/append-only/);
  });
});
