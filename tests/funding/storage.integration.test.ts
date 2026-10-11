import pg from 'pg';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { officialAssets } from '@synq/chain-registry';
import {
  PostgresFundingSessionStore,
  PostgresSendStore,
  FundingRequestSchema,
  DirectMonadAusdAdapter,
  authorizeSession,
  recordSourceSubmission,
  observeDestination,
  markIndexed,
  creditSession,
  openSession,
  contentHash,
  tokenRefOf,
  advanceSend,
  newSendRecord,
  type SendPreview,
  type DestinationReceipt,
} from '@synq/funding';
import { MEMBER, SAFE, TESTNET, NOW, request } from './helpers.js';
const url =
  process.env.SYNQ_P08_STORE_TEST_DATABASE_URL ??
  'postgresql://postgres:synq_local@127.0.0.1:55432/synq_p08_store_test';
const pool = new pg.Pool({ connectionString: url, max: 8 });
const hash = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as const;
const asset = officialAssets.testnetAUSD;
function preview(): SendPreview {
  const previewId = hash(101);
  const body = {
    schemaVersion: 1 as const,
    previewId,
    groupId: hash(102),
    account: SAFE,
    mandateId: 'send',
    mandateVersion: 1,
    recipient: {
      recipientId: 'member:a',
      kind: 'MEMBER' as const,
      label: 'a',
      address: MEMBER,
      memberId: 'a',
      principalId: 'a',
      sendable: true,
    },
    asset,
    amount: '1000000',
    amountDecimal: '1',
    chainId: TESTNET,
    profile: 'sandbox/monad-testnet',
    createdAt: NOW,
    expiresAt: NOW + 300,
    policy: {
      tier: 'QUORUM' as const,
      kernelTier: 'CONSENSUS' as const,
      policyApprovals: 2,
      accountThreshold: 2,
      requiredApprovals: 2,
    },
    treasury: { free: '3000000', freeAfter: '2000000' },
    guard: {
      status: 'PASS' as const,
      chainId: TESTNET,
      token: asset.address,
      account: SAFE,
      recipient: MEMBER,
      amount: '1000000',
      blockNumber: '1',
      checks: [],
      reasons: [],
    },
  };
  return { ...body, digest: contentHash(body) };
}
beforeAll(async () => {
  const name = new URL(url).pathname.slice(1);
  if (!/^synq_p08[a-z]?_[a-z0-9_]+$/.test(name))
    throw new Error('isolated P08 database required');
  const admin = new pg.Client({
    connectionString: url.replace(/\/[^/]+$/, '/postgres'),
  });
  await admin.connect();
  if (
    !(await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [name]))
      .rows.length
  )
    await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await new PostgresSendStore(pool).migrate();
  await new PostgresFundingSessionStore(pool).migrate();
  await pool.query(
    'TRUNCATE synq_sends,synq_send_previews,synq_funding_sessions',
  );
});
afterAll(() => pool.end());

describe('durable Send and funding stores (SIMULATION)', () => {
  it('restart retains preview/record and only one concurrent process claims confirmation', async () => {
    const a = new PostgresSendStore(pool);
    const b = new PostgresSendStore(pool);
    const p = preview();
    await a.savePreview(p);
    const record = newSendRecord(p, NOW * 1000);
    const creates = await Promise.all(
      Array.from({ length: 8 }, () => b.createOnce(record)),
    );
    expect(creates.filter((c) => c.created)).toHaveLength(1);
    const claims = await Promise.all([
      a.claimConfirmation(record.sendId, NOW * 1000),
      b.claimConfirmation(record.sendId, NOW * 1000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const restarted = new PostgresSendStore(pool);
    expect(await restarted.preview(p.previewId)).toEqual(p);
    expect((await restarted.get(record.sendId))?.state).toBe('CONFIRMING');
    const claimed = claims.find((c) => c !== null)!;
    await a.save(
      advanceSend(claimed, 'PENDING_APPROVAL', NOW * 1000, 'draft', {
        intentHash: hash(300),
      }),
    );
    await expect(b.save(record)).rejects.toThrow('IDEMPOTENCY_CONFLICT');
    expect((await restarted.byIntentHash(hash(300)))?.state).toBe(
      'PENDING_APPROVAL',
    );
  });
  it('more same and distinct lock requests than pool slots leave query capacity available', async () => {
    const a = new PostgresSendStore(pool);
    const b = new PostgresSendStore(pool);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? a : b).withConfirmationLock(
          i < 12 ? 'shared' : `send-${i}`,
          async () => {
            active++;
            maximum = Math.max(maximum, active);
            const row = await pool.query('SELECT 1 AS alive');
            expect(row.rows[0].alive).toBe(1);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
          },
        ),
      ),
    );
    expect(maximum).toBe(1);
    expect(
      () => new PostgresSendStore({ ...pool, options: { max: 1 } } as never),
    ).toThrow('capacity');
  });
  it('one chain event cannot credit two sessions, including concurrent processes and restart', async () => {
    const store = new PostgresFundingSessionStore(pool);
    const req = FundingRequestSchema.parse(
      request({
        destinationChainId: TESTNET,
        sourceToken: tokenRefOf(asset),
        amount: '1000000',
      }),
    );
    const adapter = new DirectMonadAusdAdapter();
    const receipt: DestinationReceipt = {
      chainId: TESTNET,
      token: asset.address.toLowerCase() as `0x${string}`,
      from: MEMBER,
      to: SAFE,
      amount: '1000000',
      transactionHash: hash(400),
      logIndex: 0,
      blockNumber: 99,
    };
    const sessions = await Promise.all(
      [1, 2].map(async (n) => {
        const q = await adapter.quote({ ...req, requestId: `req-${n}-unique` });
        const s = await store.open(
          openSession({ groupId: req.groupId, quote: q, now: NOW }),
        );
        const auth = authorizeSession(s, NOW + 1);
        await store.save(auth);
        const src = recordSourceSubmission(auth, receipt, NOW + 2);
        await store.save(src);
        const seen = observeDestination(src, receipt, NOW + 3);
        await store.save(seen);
        const idx = markIndexed(
          seen,
          { indexedThroughBlock: 100, eventPresent: true },
          NOW + 4,
        );
        await store.save(idx);
        return creditSession(idx, NOW + 5);
      }),
    );
    const saves = await Promise.allSettled(
      sessions.map((s) => new PostgresFundingSessionStore(pool).save(s)),
    );
    expect(saves.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(saves.filter((s) => s.status === 'rejected')).toHaveLength(1);
    const restarted = new PostgresFundingSessionStore(pool);
    expect(
      (await restarted.list(req.groupId)).filter((s) => s.state === 'CREDITED'),
    ).toHaveLength(1);
    const winner = sessions[saves.findIndex((s) => s.status === 'fulfilled')]!;
    await restarted.save(winner);
    expect((await restarted.get(winner.sessionId))?.creditedAmount).toBe(
      '1000000',
    );
    expect(() =>
      observeDestination(winner, { ...receipt, from: SAFE }, NOW + 6),
    ).toThrow('DESTINATION_MISMATCH');
    expect(() =>
      recordSourceSubmission(
        authorizeSession(
          openSession({ groupId: 'g', quote: winner.quote, now: NOW }),
          NOW + 1,
        ),
        { ...receipt, to: MEMBER },
        NOW + 2,
      ),
    ).toThrow('DESTINATION_MISMATCH');
  });
  it('malformed stored JSON fails closed', async () => {
    const record = newSendRecord(preview(), NOW * 1000);
    await pool.query(
      "UPDATE synq_sends SET data=jsonb_set(data,'{preview,amount}','\"-1\"') WHERE send_id=$1",
      [record.sendId],
    );
    await expect(
      new PostgresSendStore(pool).get(record.sendId),
    ).rejects.toThrow();
  });
});
