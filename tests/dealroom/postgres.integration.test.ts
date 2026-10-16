import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { Ledger, PostgresLedgerStore, migrateFinance } from '@synq/ledger';
import { keccak256, toHex } from 'viem';
import {
  DEALROOM_MIGRATIONS,
  DealRoomError,
  DealRoomService,
  PostgresDealRoomStore,
  acceptsFor,
  migrateDealRoom,
  type Terms,
} from '@synq/dealroom';
import { admitEscrowGrant } from '@synq/kernel/arc-escrow';
import {
  ESCROW,
  GRANT_CONFIG,
  acceptSig,
  arbiter,
  attestation,
  client,
  commitEvidence,
  declineSig,
  drafted,
  fence,
  freelancer,
  fundedRecord,
  kernel,
  mandate,
  room,
  signedBoth,
  T0,
} from './harness.js';

/**
 * Deal Room on Postgres (own `synq_dealroom_migrations`, database
 * `synq_m2_dealroom`): the P13 invariants hold through the durable store,
 * history is append-only, and concurrent or replayed writes cannot double
 * apply.
 */

const URL =
  process.env.SYNQ_DEALROOM_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_m2_dealroom';
let pool: pg.Pool;

async function ensureDatabase(url: string) {
  const name = new globalThis.URL(url).pathname.slice(1);
  if (!/^synq_m2_dealroom[a-z0-9_]*$/.test(name))
    throw new Error('Deal Room test database must be named synq_m2_dealroom*');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  try {
    const exists = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname=$1',
      [name],
    );
    if (!exists.rows.length) await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  return new pg.Pool({ connectionString: url, max: 6 });
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DealRoomError).code ?? (e as Error).message;
  }
  return 'NO_ERROR';
};
const pgRoom = () => {
  const r = room(new PostgresDealRoomStore(pool));
  const ledger = new Ledger(new PostgresLedgerStore(pool));
  const service = new DealRoomService(r.store, {
    ...r.service.config,
    books: { ledger, workspaceId: 'wsp_dealroom_test' },
  });
  return { ...r, service, ledger };
};

beforeAll(async () => {
  pool = await ensureDatabase(URL);
  await migrateFinance(pool);
  await migrateDealRoom(pool, 0);
  await pool.query('DROP TABLE IF EXISTS synq_dealroom_migrations');
  expect(await migrateDealRoom(pool)).toBe(DEALROOM_MIGRATIONS.at(-1)!.version);
});
afterAll(async () => {
  await migrateDealRoom(pool, 0);
  await pool.query('DROP TABLE IF EXISTS synq_dealroom_migrations');
  await pool.end();
});

describe('Deal Room Postgres store', () => {
  it('CR-04: ledger postings roll back when the funded deal transition fails', async () => {
    const r = await signedBoth(pgRoom());
    const id = r.view.deal.dealId;
    const v = r.view.current;
    const m = await mandate({
      owner: client,
      id: `mnd_atomic_${id}`,
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: v.terms.total,
      budget: v.terms.total,
    });
    await r.service.authorizeFunding(id, kernel(m));
    await pool.query(
      `CREATE OR REPLACE FUNCTION synq_test_reject_funded() RETURNS trigger AS $$ BEGIN IF NEW.status='FUNDED' THEN RAISE EXCEPTION 'injected commit failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER synq_test_reject_funded BEFORE UPDATE ON synq_dealroom_deals FOR EACH ROW EXECUTE FUNCTION synq_test_reject_funded()`,
    );
    const rec = fundedRecord(v, 99n);
    try {
      await expect(
        r.service.recordFunded({ dealId: id, ...rec }),
      ).rejects.toThrow('injected commit failure');
      expect((await r.service.view(id)).deal.status).toBe('FUNDING');
      const entries = await pool.query(
        `SELECT data FROM synq_ledger_entries WHERE data->'evidence'->>'txHash'=$1`,
        [rec.execution.txs[0]!.hash],
      );
      expect(entries.rows).toEqual([]);
    } finally {
      await pool.query(
        'DROP TRIGGER synq_test_reject_funded ON synq_dealroom_deals',
      );
      await pool.query('DROP FUNCTION synq_test_reject_funded()');
    }
    expect(
      (await r.service.recordFunded({ dealId: id, ...rec })).deal.status,
    ).toBe('FUNDED');
  });

  it('migrations are versioned in their own table and reversible', async () => {
    const r = await pool.query(
      'SELECT version FROM synq_dealroom_migrations ORDER BY version',
    );
    expect(r.rows.map((x) => x.version)).toEqual(
      DEALROOM_MIGRATIONS.map((m) => m.version),
    );
    expect(await migrateDealRoom(pool, 0)).toBe(0);
    const gone = await pool.query(
      "SELECT to_regclass('synq_dealroom_deals') AS t",
    );
    expect(gone.rows[0]!.t).toBeNull();
    expect(await migrateDealRoom(pool)).toBe(1);
    // Idempotent: running again changes nothing.
    expect(await migrateDealRoom(pool)).toBe(1);
  });

  it('P13-01 / P13-03: versions are immutable and an edit needs both approvals again', async () => {
    const r = pgRoom();
    const { view } = await signedBoth(r);
    const id = view.deal.dealId;
    expect(view.deal.status).toBe('ACCEPTED');
    // Drafted citations are only from the authorized context (800 was never stored).
    expect(JSON.stringify(view.current.provenance)).not.toContain('"800"');
    await expect(
      pool.query(
        "UPDATE synq_dealroom_versions SET proposed_by='CLIENT' WHERE deal_id=$1",
        [id],
      ),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM synq_dealroom_signatures WHERE deal_id=$1', [id]),
    ).rejects.toThrow(/append-only/);
    await expect(
      pool.query('DELETE FROM synq_dealroom_transitions WHERE deal_id=$1', [
        id,
      ]),
    ).rejects.toThrow(/append-only/);
    const terms: Terms = {
      ...view.current.terms,
      milestones: view.current.terms.milestones.map((m) =>
        m.index === 0 ? { ...m, deadline: m.deadline + 86_400 } : m,
      ),
    };
    const prep = await r.service.prepareCounteroffer({
      dealId: id,
      baseVersion: 1,
      by: 'CLIENT',
      terms,
    });
    const after = await r.service.counteroffer({
      dealId: id,
      baseVersion: 1,
      by: 'CLIENT',
      terms,
      signature: await client.signTypedData(prep.typedData),
    });
    expect(after.deal.status).toBe('NEGOTIATING');
    expect(acceptsFor(after.signatures, after.current).FREELANCER).toBeNull();
    expect(await code(r.service.fundingCall(id))).toBe('NOT_FULLY_SIGNED');
    const versions = await pool.query(
      'SELECT version, terms_hash FROM synq_dealroom_versions WHERE deal_id=$1 ORDER BY version',
      [id],
    );
    expect(versions.rows).toHaveLength(2);
    expect(versions.rows[0]!.terms_hash).not.toBe(versions.rows[1]!.terms_hash);
    // A stale counteroffer on v1 is refused.
    expect(
      await code(
        r.service.prepareCounteroffer({
          dealId: id,
          baseVersion: 1,
          by: 'FREELANCER',
          terms,
        }),
      ),
    ).toBe('STALE_VERSION');
  });

  it('P13-02: a stored rejection blocks the funding mandate across restarts', async () => {
    const r = pgRoom();
    const { view } = await drafted(r);
    const id = view.deal.dealId;
    await r.service.sign({
      dealId: id,
      version: 1,
      role: 'CLIENT',
      signature: await acceptSig(r.service, view.current, 'CLIENT'),
    });
    await r.service.decline({
      dealId: id,
      version: 1,
      role: 'FREELANCER',
      decision: 'REJECT',
      reason: 'no',
      signature: await declineSig(view.current, 'FREELANCER', 'REJECT', 'no'),
    });
    // A fresh service over the same database sees the rejection.
    const again = pgRoom();
    const m = await mandate({
      owner: client,
      id: 'mnd_pg',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30_000n,
      budget: 30_000n,
    });
    expect(await code(again.service.authorizeFunding(id, kernel(m)))).toBe(
      'COUNTERPARTY_REJECTED',
    );
  });

  it('concurrent signatures serialize; replays are no-ops', async () => {
    const r = pgRoom();
    const { view } = await drafted(r);
    const id = view.deal.dealId;
    const [cs, fs] = await Promise.all([
      acceptSig(r.service, view.current, 'CLIENT'),
      acceptSig(r.service, view.current, 'FREELANCER'),
    ]);
    const results = await Promise.allSettled([
      r.service.sign({ dealId: id, version: 1, role: 'CLIENT', signature: cs }),
      r.service.sign({
        dealId: id,
        version: 1,
        role: 'FREELANCER',
        signature: fs,
      }),
    ]);
    // One may lose the optimistic lock; retrying the loser completes the pair.
    for (const [i, res] of results.entries())
      if (res.status === 'rejected') {
        expect((res.reason as DealRoomError).code).toBe('CONFLICT');
        await r.service.sign({
          dealId: id,
          version: 1,
          role: i === 0 ? 'CLIENT' : 'FREELANCER',
          signature: i === 0 ? cs : fs,
        });
      }
    const v = await r.service.view(id);
    expect(v.deal.status).toBe('ACCEPTED');
    const rows = await pool.query(
      'SELECT count(*)::int AS n FROM synq_dealroom_signatures WHERE deal_id=$1',
      [id],
    );
    expect(rows.rows[0]!.n).toBe(2);
    await r.service.sign({
      dealId: id,
      version: 1,
      role: 'CLIENT',
      signature: cs,
    });
    const after = await pool.query(
      'SELECT count(*)::int AS n FROM synq_dealroom_transitions WHERE deal_id=$1',
      [id],
    );
    expect(after.rows[0]!.n).toBe(3);
  });

  it('P13-04..07 through Postgres: funded, released once, dispute holds, refund to the funder', async () => {
    const r = pgRoom();
    const { view } = await signedBoth(r);
    const id = view.deal.dealId;
    const fm = await mandate({
      owner: client,
      id: 'mnd_f',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30_000n,
      budget: 30_000n,
    });
    const fa = await r.service.authorizeFunding(id, kernel(fm));
    expect(fa.decision.outcome).toBe('ALLOW');
    const rec = fundedRecord(view.current, 41n);
    expect(
      await code(
        r.service.recordFunded({
          dealId: id,
          execution: rec.execution,
          chain: {
            ...rec.chain,
            milestones: [
              { amount: 10_000n, status: 'Funded' },
              { amount: 19_000n, status: 'Funded' },
            ],
          },
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    await r.service.recordFunded({ dealId: id, ...rec });
    const row = await pool.query(
      'SELECT status, escrow_deal_id FROM synq_dealroom_deals WHERE deal_id=$1',
      [id],
    );
    expect(row.rows[0]).toEqual({ status: 'FUNDED', escrow_deal_id: '41' });
    // Milestone 0: delivered + accepted -> released once.
    let v = (await r.service.view(id)).current;
    await r.service.attest(
      await attestation({
        v,
        milestone: 0,
        kind: 'DELIVERED',
        role: 'FREELANCER',
        evidence: commitEvidence(),
      }),
    );
    const accept = await attestation({
      v,
      milestone: 0,
      kind: 'ACCEPT_RELEASE',
      role: 'CLIENT',
      evidence: commitEvidence(),
    });
    await r.service.attest(accept);
    const rm = await mandate({
      owner: client,
      id: 'mnd_r',
      payer: ESCROW,
      recipients: [freelancer.address],
      purposes: ['ESCROW_RELEASE'],
      cap: 20_000n,
      budget: 30_000n,
    });
    const ra = await r.service.authorizeRelease(id, 0, kernel(rm));
    if (ra.decision.outcome !== 'ALLOW') throw new Error('release denied');
    await admitEscrowGrant({
      grantKey: GRANT_CONFIG.grantKey,
      grant: ra.decision.grant,
      call: ra.call,
      now: T0,
      mandateRevoked: false,
      fence: fence(),
    });
    const h = keccak256(toHex(`${id}:release`));
    const exec = {
      op: 'RELEASE' as const,
      milestone: 0,
      escrowDealId: 41n,
      txs: [
        {
          label: 'release+withdraw',
          hash: h,
          from: client.address,
          feeWei: 2n,
        },
      ],
      transfers: [
        {
          from: ESCROW,
          to: freelancer.address,
          value: 10_000n,
          logIndex: 3,
          hash: h,
        },
      ],
    };
    await Promise.all([
      r.service
        .recordReleased({ dealId: id, milestone: 0, execution: exec })
        .catch((e: DealRoomError) => e.code),
      r.service
        .recordReleased({ dealId: id, milestone: 0, execution: exec })
        .catch((e: DealRoomError) => e.code),
    ]);
    await r.service
      .recordReleased({ dealId: id, milestone: 0, execution: exec })
      .catch(() => null);
    const rel = await pool.query(
      "SELECT count(*)::int AS n FROM synq_dealroom_transitions WHERE deal_id=$1 AND kind='RELEASED'",
      [id],
    );
    expect(rel.rows[0]!.n).toBe(1);
    expect(await code(r.service.releaseCall(id, 0))).toBe('WRONG_STATE');
    // A replayed attestation nonce is refused by the database too (on another deal).
    const other = await signedBoth(pgRoom());
    await other.service.authorizeFunding(other.view.deal.dealId, kernel(fm));
    await other.service.recordFunded({
      dealId: other.view.deal.dealId,
      ...fundedRecord(other.view.current, 42n),
    });
    const ov = (await other.service.view(other.view.deal.dealId)).current;
    const reused = await attestation({
      v: ov,
      milestone: 0,
      kind: 'DELIVERED',
      role: 'FREELANCER',
      evidence: commitEvidence(),
      nonce: accept.nonce,
    });
    expect(await code(other.service.attest(reused))).toBe('REPLAYED');
    // Milestone 1: disputed -> payer release refused; arbiter refund goes to the funder.
    v = (await r.service.view(id)).current;
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'DISPUTE',
        role: 'CLIENT',
        evidence: null,
      }),
    );
    expect(await code(r.service.releaseCall(id, 1))).toBe('MILESTONE_DISPUTED');
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'ARBITER_REFUND',
        role: 'ARBITER',
        evidence: null,
      }),
    );
    const { call } = await r.service.refundCall(id, 1);
    expect(call.funder).toBe(client.address);
    expect(call.sender).toBe(arbiter.address);
    const h2 = keccak256(toHex(`${id}:refund`));
    const done = await r.service.recordRefunded({
      dealId: id,
      milestone: 1,
      execution: {
        op: 'REFUND' as const,
        milestone: 1,
        escrowDealId: 41n,
        txs: [{ label: 'refund', hash: h2, from: arbiter.address, feeWei: 2n }],
        transfers: [
          {
            from: ESCROW,
            to: client.address,
            value: 20_000n,
            logIndex: 0,
            hash: h2,
          },
        ],
      },
    });
    expect(done.deal.status).toBe('SETTLED');
    expect(done.deal.milestones.map((m) => m.status)).toEqual([
      'SETTLED',
      'REFUNDED',
    ]);
    const kinds = (await r.service.view(id)).transitions.map((t) => t.kind);
    expect(kinds).toEqual([
      'DRAFTED',
      'SIGNED',
      'SIGNED',
      'FUNDING_GRANTED',
      'FUNDED',
      'ATTESTED_DELIVERED',
      'ATTESTED_ACCEPT_RELEASE',
      'RELEASE_GRANTED',
      'RELEASED',
      'ATTESTED_DISPUTE',
      'ATTESTED_ARBITER_REFUND',
      'REFUNDED',
    ]);
  });
});
