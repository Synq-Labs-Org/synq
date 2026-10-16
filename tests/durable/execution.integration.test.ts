import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { Address } from 'viem';
import { money } from '@synq/domain';
import {
  AuthorityError,
  admitGrant,
  decide,
  mandateTypedData,
  type AuthorityConfig,
  type ExecutionGrant,
  type PaymentMandate,
} from '@synq/kernel/arc';
import { connectChain } from '@synq/execution-worker/arc';
import {
  grantOutboxKey,
  payGrantOnce,
  payOnce,
  type OutboxRecord,
} from '@synq/execution-worker/arc-outbox';
import {
  PostgresGrantFence,
  PostgresOutboxStore,
} from '@synq/execution-worker/pg-outbox';
import {
  EXECUTION_MIGRATIONS,
  migrateExecution,
} from '@synq/execution-worker/pg-schema';
import { durablePool, runId } from './pg.js';
import { USDC, countingSigner, fakeArc } from './fake-arc.js';

const owner = privateKeyToAccount(`0x${'11'.repeat(32)}`);
// Each test pays from a fresh sender: (chain, sender, nonce) is unique forever.
let payerKey = privateKeyToAccount(generatePrivateKey());
const payee = '0x00000000000000000000000000000000000beef1' as Address;
let pool: pg.Pool;
let t = 1_800_000_000;
const now = () => t++;
const config: AuthorityConfig = {
  grantKey: new Uint8Array(32).fill(9),
  operator: 'arc-executor-durable',
  grantTtlSeconds: 600,
  riskRequiredAbove: 50_000_000n,
};

async function grantFor(
  id: string,
  amount = 250_000n,
): Promise<ExecutionGrant> {
  const mandate: PaymentMandate = {
    mandateId: `mnd_${id}`,
    version: 1,
    workspaceId: 'wsp_durable',
    owner: owner.address,
    chainId: USDC.chainId,
    token: USDC.address,
    payer: payerKey.address,
    recipients: [payee],
    purposes: ['CONTRACTOR_PAYOUT'],
    perActionCap: 1_000_000n,
    periodBudget: 5_000_000n,
    periodSeconds: 86_400,
    validFrom: t - 100,
    validUntil: t + 86_400,
  };
  const d = await decide({
    config,
    mandate,
    mandateSignature: await owner.signTypedData(mandateTypedData(mandate)),
    state: { revoked: false, spends: [] },
    intent: {
      intentId: `int_${id}`,
      mandateId: mandate.mandateId,
      mandateVersion: 1,
      chainId: USDC.chainId,
      token: USDC.address,
      payer: payerKey.address,
      recipient: payee,
      amount,
      purpose: 'CONTRACTOR_PAYOUT',
      obligationRef: `obl_${id}`,
      evidenceHash: `0x${'e1'.repeat(32)}`,
      proposedBy: 'agent:payments',
    },
    risk: { flags: [], available: true },
    simulationOk: true,
    now: t,
  });
  if (d.outcome !== 'ALLOW') throw new Error(d.reasons.join('; '));
  return d.grant;
}

beforeAll(async () => {
  pool = await durablePool();
  await migrateExecution(pool);
});
afterAll(async () => {
  await pool.end();
});

const transfer = (amount = 250_000n) => ({
  from: payerKey.address,
  to: payee,
  amount: money(USDC, amount),
});

describe('durable execution state on Postgres', { timeout: 60_000 }, () => {
  beforeEach(() => {
    payerKey = privateKeyToAccount(generatePrivateKey());
  });
  it('migrates idempotently under concurrent starts and records its own version table', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => migrateExecution(pool)),
    );
    expect(results).toEqual(
      results.map(() => EXECUTION_MIGRATIONS.at(-1)!.version),
    );
    const v = await pool.query(
      'SELECT count(*)::int AS n FROM synq_execution_migrations',
    );
    expect(v.rows[0]!.n).toBe(EXECUTION_MIGRATIONS.length);
  });

  it('outbox: crash after the signed bytes are recorded, restart with a new store, recover without re-signing or paying twice', async () => {
    const arc = fakeArc();
    arc.setPayer(payerKey.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const s = countingSigner(payerKey);
    const key = `payout:${runId()}`;
    const first = new PostgresOutboxStore(pool);
    await expect(
      payOnce({
        store: first,
        key,
        chain,
        signer: s,
        transfer: transfer(),
        now,
        afterRecord: () => {
          throw new Error('process killed after the durable record');
        },
      }),
    ).rejects.toThrow(/killed/);
    expect(arc.sent).toHaveLength(0);
    expect((await first.get(key))!.state).toBe('SIGNED');
    // Restart: a fresh store instance (fresh process) on the same database.
    const restarted = new PostgresOutboxStore(pool);
    const pending = await restarted.unsettled(1000);
    expect(pending.map((r) => r.key)).toContain(key);
    const r = await payOnce({
      store: restarted,
      key,
      chain,
      signer: s,
      transfer: transfer(),
      now,
    });
    expect(r.signedNow).toBe(false);
    expect(r.record.state).toBe('CONFIRMED');
    expect(s.count).toBe(1);
    expect(arc.mined.size).toBe(1);
    // The resend was the identical recorded bytes.
    expect(arc.sent).toEqual([(await restarted.get(key))!.raw]);
    const again = await payOnce({
      store: new PostgresOutboxStore(pool),
      key,
      chain,
      signer: s,
      transfer: transfer(),
      now,
    });
    expect(again.record.state).toBe('CONFIRMED');
    expect(s.count).toBe(1);
    expect(arc.mined.size).toBe(1);
  });

  it('outbox: a consumed nonce after a crash ends in NEEDS_REVIEW, and the record can never be re-signed or regressed', async () => {
    const arc = fakeArc();
    arc.setPayer(payerKey.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const s = countingSigner(payerKey);
    const key = `payout:${runId()}`;
    const store = new PostgresOutboxStore(pool);
    await expect(
      payOnce({
        store,
        key,
        chain,
        signer: s,
        transfer: transfer(),
        now,
        afterRecord: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow();
    arc.bumpNonce(); // something else used the nonce
    const r = await payOnce({
      store: new PostgresOutboxStore(pool),
      key,
      chain,
      signer: s,
      transfer: transfer(),
      now,
    });
    expect(r.record.state).toBe('NEEDS_REVIEW');
    expect(arc.sent).toHaveLength(0);
    expect(s.count).toBe(1);
    const rec = (await store.get(key))!;
    // The database refuses to change signed bytes or leave a terminal state.
    await expect(
      store.update({ ...rec, state: 'SIGNED' } as OutboxRecord),
    ).rejects.toThrow(/terminal/);
    await expect(
      pool.query('UPDATE synq_arc_payout_outbox SET raw=$2 WHERE key=$1', [
        key,
        '0x00',
      ]),
    ).rejects.toThrow(/immutable/);
    await expect(
      pool.query('DELETE FROM synq_arc_payout_outbox WHERE key=$1', [key]),
    ).rejects.toThrow(/append-only/);
  });

  it('outbox: concurrent attempts for one key sign at most one transaction that is ever broadcast', async () => {
    const arc = fakeArc();
    arc.setPayer(payerKey.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const s = countingSigner(payerKey);
    const key = `payout:${runId()}`;
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        payOnce({
          store: new PostgresOutboxStore(pool),
          key,
          chain,
          signer: s,
          transfer: transfer(),
          now,
        }),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    expect(ok.length).toBeGreaterThan(0);
    expect(arc.mined.size).toBe(1);
    expect(
      new Set(
        ok.map(
          (r) =>
            (r as PromiseFulfilledResult<{ record: OutboxRecord }>).value.record
              .hash,
        ),
      ).size,
    ).toBe(1);
    expect(
      ok.filter(
        (r) =>
          (r as PromiseFulfilledResult<{ signedNow: boolean }>).value.signedNow,
      ),
    ).toHaveLength(1);
  });

  it('grant fence: a grant is consumed once across processes (unique grant id and nonce), and survives restart', async () => {
    const g = await grantFor(runId());
    const fences = Array.from(
      { length: 8 },
      () => new PostgresGrantFence(pool),
    );
    const results = await Promise.allSettled(
      fences.map((fence) =>
        admitGrant({
          grantKey: config.grantKey,
          grant: g,
          call: {
            chainId: USDC.chainId,
            token: USDC.address,
            payer: payerKey.address,
            recipient: payee,
            amount: 250_000n,
          },
          now: t,
          mandateRevoked: false,
          fence,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results.filter((x) => x.status === 'rejected'))
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        AuthorityError,
      );
    const restarted = new PostgresGrantFence(pool);
    expect(await restarted.consumed(g.grantId)).not.toBeNull();
    expect(await restarted.consume(g.nonce)).toBe(false);
    await expect(
      pool.query('DELETE FROM synq_consumed_grants WHERE grant_id=$1', [
        g.grantId,
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('granted payout: crash after the grant and signed bytes are recorded together, restart, one payment, grant never re-admitted', async () => {
    const arc = fakeArc();
    arc.setPayer(payerKey.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const s = countingSigner(payerKey);
    const g = await grantFor(runId());
    const base = {
      grant: g,
      grantKey: config.grantKey,
      mandateRevoked: false,
      chain,
      signer: s,
      transfer: transfer(),
      now,
    };
    await expect(
      payGrantOnce({
        ...base,
        store: new PostgresOutboxStore(pool),
        fence: new PostgresGrantFence(pool),
        afterRecord: () => {
          throw new Error('killed');
        },
      }),
    ).rejects.toThrow(/killed/);
    const fence = new PostgresGrantFence(pool);
    expect(await fence.consumed(g.grantId)).not.toBeNull();
    const store = new PostgresOutboxStore(pool);
    expect((await store.get(grantOutboxKey(g.grantId)))!.state).toBe('SIGNED');
    const r = await payGrantOnce({ ...base, store, fence });
    expect(r.record.state).toBe('CONFIRMED');
    expect(r.signedNow).toBe(false);
    expect(s.count).toBe(1);
    expect(arc.mined.size).toBe(1);
    // The same grant presented to a plain admission path is refused: consumed.
    await expect(
      admitGrant({
        grantKey: config.grantKey,
        grant: g,
        call: {
          chainId: USDC.chainId,
          token: USDC.address,
          payer: payerKey.address,
          recipient: payee,
          amount: 250_000n,
        },
        now: t,
        mandateRevoked: false,
        fence,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_REPLAYED' });
  });

  it('granted payout: two executors racing one grant broadcast one transaction; a grant consumed elsewhere is refused before broadcast', async () => {
    const arc = fakeArc();
    arc.setPayer(payerKey.address);
    const chain = await connectChain('arc-testnet', undefined, arc.client);
    const s = countingSigner(payerKey);
    const g = await grantFor(runId());
    const results = await Promise.allSettled(
      [1, 2, 3, 4].map(() =>
        payGrantOnce({
          store: new PostgresOutboxStore(pool),
          fence: new PostgresGrantFence(pool),
          grant: g,
          grantKey: config.grantKey,
          mandateRevoked: false,
          chain,
          signer: s,
          transfer: transfer(),
          now,
        }),
      ),
    );
    expect(arc.mined.size).toBe(1);
    expect(
      results.filter((r) => r.status === 'fulfilled' && r.value.signedNow),
    ).toHaveLength(1);
    // A different grant whose nonce was burned by the plain fence is refused.
    const g2 = await grantFor(runId());
    expect(await new PostgresGrantFence(pool).consume(g2.nonce)).toBe(true);
    await expect(
      payGrantOnce({
        store: new PostgresOutboxStore(pool),
        fence: new PostgresGrantFence(pool),
        grant: g2,
        grantKey: config.grantKey,
        mandateRevoked: false,
        chain,
        signer: s,
        transfer: transfer(),
        now,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_REPLAYED' });
    expect(arc.mined.size).toBe(1);
    expect(
      await new PostgresOutboxStore(pool).get(grantOutboxKey(g2.grantId)),
    ).toBeNull();
  });
});
