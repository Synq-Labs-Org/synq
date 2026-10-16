import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import { signTelegramLoginForTest, verifyTelegramLogin } from '@synq/channels';
import {
  ChannelLinkService,
  PostgresChannelLinkStore,
  channelLinkTypedData,
  migrateIdentityLinks,
} from '@synq/identity/server';
import {
  DurableDelegationRegistry,
  PostgresCouncilStore,
  PostgresDelegationLogStore,
  approveCouncilAction,
  councilActionTypedData,
  currentTerm,
  decisionStatus,
  delegationId,
  delegationTypedData,
  establishCouncil,
  executeDecision,
  migrateGovernance,
  policyHash,
  revocationTypedData,
  rotateTerm,
  termHash,
  withdrawalActionHash,
  type CouncilAction,
  type CouncilTerm,
  type Delegation,
  type GovernancePolicy,
} from '@synq/governance';
import { durablePool, runId } from './pg.js';

const accountFor = (label: string) =>
  privateKeyToAccount(keccak256(toHex(`synq-m2-gov:${label}`)));
const USDC = token('arc-testnet', 'USDC');
const CHAIN = USDC.chainId;
const NOW = 1_790_000_000;
const DAY = 86_400;
let pool: pg.Pool;

const policyFor = (workspaceId: string): GovernancePolicy => ({
  policyId: 'pol_m2',
  version: 1,
  workspaceId,
  chainId: CHAIN,
  quorumBps: 5_000,
  approvalBps: 6_000,
  minYesOfEligibleBps: 3_000,
  votingPeriodSeconds: 7 * DAY,
  challengeWindowSeconds: 2 * DAY,
  maxDelegationDepth: 3,
  concentrationFlagBps: 1_000,
  councilSize: 7,
  councilThreshold: 5,
  termSeconds: 365 * DAY,
  termsHash: keccak256(toHex('terms')),
});
const seats = Array.from({ length: 7 }, (_, i) => accountFor(`seat-${i}`));
const termFor = (
  councilId: string,
  workspaceId: string,
  termId = 1,
  startsAt = NOW - DAY,
  holders: PrivateKeyAccount[] = seats,
): CouncilTerm => ({
  councilId,
  workspaceId,
  chainId: CHAIN,
  termId,
  seats: holders.map((a, i) => ({ seatId: `seat-${i}`, holder: a.address })),
  threshold: 5,
  startsAt,
  endsAt: startsAt + 300 * DAY,
});
const actionFor = (
  t: CouncilTerm,
  p: GovernancePolicy,
  kind: CouncilAction['kind'],
  actionHash: Hex,
  label: string,
): CouncilAction => ({
  councilId: t.councilId,
  workspaceId: t.workspaceId,
  chainId: CHAIN,
  termId: t.termId,
  termHash: termHash(t),
  policyHash: policyHash(p),
  kind,
  actionHash,
  nonce: keccak256(toHex(`nonce:${label}`)),
  proposedAt: NOW - 60,
  expiresAt: NOW + 30 * DAY,
});
const sign = (who: PrivateKeyAccount[], a: CouncilAction) =>
  Promise.all(who.map((s) => s.signTypedData(councilActionTypedData(a))));
const payout = (n: bigint) =>
  withdrawalActionHash({
    chainId: CHAIN,
    token: USDC.address,
    payer: `0x${'a1'.repeat(20)}` as Address,
    recipient: `0x${'5a'.repeat(20)}` as Address,
    amount: n,
  });

beforeAll(async () => {
  pool = await durablePool();
  await migrateGovernance(pool);
  await migrateIdentityLinks(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('governance state on Postgres', { timeout: 60_000 }, () => {
  it('council: an approved decision recorded before a crash executes exactly once after restart, under concurrency', async () => {
    const id = runId();
    const policy = policyFor(`wsp_${id}`);
    const term = termFor(`cnc_${id}`, policy.workspaceId);
    const store = new PostgresCouncilStore(pool);
    await establishCouncil({ store, term, policy });
    await expect(
      establishCouncil({ store: new PostgresCouncilStore(pool), term, policy }),
    ).rejects.toMatchObject({ code: 'BAD_COUNCIL' });
    const a = actionFor(term, policy, 'WITHDRAWAL', payout(5n), `pay-${id}`);
    const d = await approveCouncilAction({
      store,
      term,
      policy,
      action: a,
      signatures: await sign(seats.slice(0, 5), a),
      now: NOW,
    });
    // Crash here. Fresh instances (processes) race to execute after the window.
    const at = NOW + 3 * DAY;
    expect(
      await decisionStatus({
        store: new PostgresCouncilStore(pool),
        digest: d.digest,
        policy,
        now: at,
      }),
    ).toBe('EXECUTABLE');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        executeDecision({
          store: new PostgresCouncilStore(pool),
          decision: { digest: d.digest },
          policy,
          now: at,
          kind: 'WITHDRAWAL',
          actionHash: a.actionHash,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const r of results)
      if (r.status === 'rejected')
        expect((r.reason as { code: string }).code).toMatch(/ALREADY_EXECUTED/);
    expect(
      await decisionStatus({
        store: new PostgresCouncilStore(pool),
        digest: d.digest,
        policy,
        now: at,
      }),
    ).toBe('EXECUTED');
    // A second decision reusing the nonce (different effect) cannot execute.
    const reuse = { ...a, actionHash: payout(6n) };
    const d2 = await approveCouncilAction({
      store,
      term,
      policy,
      action: reuse,
      signatures: await sign(seats.slice(0, 5), reuse),
      now: NOW,
    });
    await expect(
      executeDecision({
        store,
        decision: { digest: d2.digest },
        policy,
        now: at,
        kind: 'WITHDRAWAL',
        actionHash: reuse.actionHash,
      }),
    ).rejects.toMatchObject({ code: 'ALREADY_EXECUTED' });
    await expect(
      pool.query('DELETE FROM synq_council_executions WHERE digest=$1', [
        d.digest.toLowerCase(),
      ]),
    ).rejects.toThrow(/append-only/);
  });

  it('council: the term log advances by compare-and-set; two concurrent rotations cannot fork it', async () => {
    const id = runId();
    const policy = policyFor(`wsp_${id}`);
    const term = termFor(`cnc_${id}`, policy.workspaceId);
    const store = new PostgresCouncilStore(pool);
    await establishCouncil({ store, term, policy });
    const next = termFor(term.councilId, policy.workspaceId, 2, NOW + 3 * DAY, [
      ...seats.slice(1),
      accountFor('new-seat'),
    ]);
    const a = actionFor(
      term,
      policy,
      'ROTATE_TERM',
      termHash(next),
      `rot-${id}`,
    );
    const d = await approveCouncilAction({
      store,
      term,
      policy,
      action: a,
      signatures: await sign(seats.slice(0, 5), a),
      now: NOW,
    });
    // CAS directly: two writers from term 1, one wins.
    const nextRecord = {
      term: next,
      hash: termHash(next),
      effectiveEnd: next.endsAt,
    };
    const [x, y] = await Promise.all([
      new PostgresCouncilStore(pool).advanceTerm(
        term.councilId,
        1,
        next.startsAt,
        nextRecord,
      ),
      new PostgresCouncilStore(pool).advanceTerm(
        term.councilId,
        1,
        next.startsAt,
        { ...nextRecord, term: { ...next, termId: 3 } },
      ),
    ]);
    expect([x, y].filter(Boolean)).toHaveLength(1);
    const log = await new PostgresCouncilStore(pool).terms(term.councilId);
    expect(log).toHaveLength(2);
    expect(log[0]!.effectiveEnd).toBe(next.startsAt);
    // The decision is now consumed only if rotateTerm runs; the log already moved, so it refuses.
    await expect(
      rotateTerm({
        store: new PostgresCouncilStore(pool),
        next,
        policy,
        decision: d,
        now: NOW + 2 * DAY + 1,
      }),
    ).rejects.toMatchObject({ code: 'BAD_COUNCIL' });
    expect(
      (
        await currentTerm(
          new PostgresCouncilStore(pool),
          term.councilId,
          NOW + 4 * DAY,
        )
      )?.term.termId,
    ).toBe(log[1]!.term.termId);
  });

  it('delegations: registrations and revocations survive restart; concurrent conflicting registrations admit one', async () => {
    const id = runId();
    const policy = policyFor(`wsp_${id}`);
    const alice = accountFor(`alice-${id}`);
    const bob = accountFor(`bob-${id}`);
    const carol = accountFor(`carol-${id}`);
    const del = (
      from: PrivateKeyAccount,
      to: Address,
      n: string,
    ): Delegation => ({
      workspaceId: policy.workspaceId,
      chainId: CHAIN,
      delegator: from.address,
      delegate: to,
      issuedAt: NOW - 10,
      expiresAt: NOW + 30 * DAY,
      nonce: keccak256(toHex(n)),
    });
    const d1 = del(alice, bob.address, `a-b-${id}`);
    const d2 = del(alice, carol.address, `a-c-${id}`);
    const sig = (who: PrivateKeyAccount, d: Delegation) =>
      who.signTypedData(delegationTypedData(d));
    const [s1, s2] = await Promise.all([sig(alice, d1), sig(alice, d2)]);
    const results = await Promise.allSettled([
      new DurableDelegationRegistry(
        policy,
        new PostgresDelegationLogStore(pool),
      ).register(d1, s1, NOW),
      new DurableDelegationRegistry(
        policy,
        new PostgresDelegationLogStore(pool),
      ).register(d2, s2, NOW),
    ]);
    // Alice may hold one active delegation: exactly one registration lands.
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const winner = (
      results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<{
        id: Hex;
        delegation: Delegation;
      }>
    ).value;
    const live = await new DurableDelegationRegistry(
      policy,
      new PostgresDelegationLogStore(pool),
    ).list();
    expect(live.map((r) => r.id)).toEqual([winner.id]);
    // Revoke, "crash", restart: the revocation is still in force.
    const revocation = {
      workspaceId: policy.workspaceId,
      chainId: CHAIN,
      delegationId: winner.id,
      delegator: alice.address,
      requestedAt: NOW + 100,
    };
    await new DurableDelegationRegistry(
      policy,
      new PostgresDelegationLogStore(pool),
    ).revoke(
      revocation,
      await alice.signTypedData(revocationTypedData(revocation)),
      NOW + 100,
    );
    const after = await new DurableDelegationRegistry(
      policy,
      new PostgresDelegationLogStore(pool),
    ).list();
    expect(after[0]!.revokedAt).toBe(NOW + 100);
    expect(delegationId(winner.delegation)).toBe(winner.id);
  });

  it('delegations: a dropped revocation is detected on load, not silently revived', async () => {
    const id = runId();
    const policy = policyFor(`wsp_${id}`);
    const alice = accountFor(`alice-${id}`);
    const bob = accountFor(`bob-${id}`);
    const dave = accountFor(`dave-${id}`);
    const reg = new DurableDelegationRegistry(
      policy,
      new PostgresDelegationLogStore(pool),
    );
    const mk = (
      from: PrivateKeyAccount,
      to: Address,
      n: string,
    ): Delegation => ({
      workspaceId: policy.workspaceId,
      chainId: CHAIN,
      delegator: from.address,
      delegate: to,
      issuedAt: NOW - 10,
      expiresAt: NOW + 30 * DAY,
      nonce: keccak256(toHex(n)),
    });
    const d = mk(alice, bob.address, `drop-${id}`);
    const r = await reg.register(
      d,
      await alice.signTypedData(delegationTypedData(d)),
      NOW,
    );
    const rev = {
      workspaceId: policy.workspaceId,
      chainId: CHAIN,
      delegationId: r.id,
      delegator: alice.address,
      requestedAt: NOW + 5,
    };
    await reg.revoke(
      rev,
      await alice.signTypedData(revocationTypedData(rev)),
      NOW + 5,
    );
    const d3 = mk(dave, bob.address, `later-${id}`);
    await reg.register(
      d3,
      await dave.signTypedData(delegationTypedData(d3)),
      NOW + 6,
    );
    // A database-level attacker removes the revocation (bypassing the append-only trigger).
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(
        'ALTER TABLE synq_delegation_log DISABLE TRIGGER synq_delegation_log_keep',
      );
      await c.query(
        `DELETE FROM synq_delegation_log WHERE workspace_id=$1 AND kind='REVOKE'`,
        [policy.workspaceId],
      );
      await c.query(
        'ALTER TABLE synq_delegation_log ENABLE TRIGGER synq_delegation_log_keep',
      );
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    await expect(
      new DurableDelegationRegistry(
        policy,
        new PostgresDelegationLogStore(pool),
      ).list(),
    ).rejects.toMatchObject({ code: 'STORE_TAMPERED' });
    await expect(reg.list()).rejects.toMatchObject({ code: 'STORE_TAMPERED' });
  });
});

describe('channel links on Postgres', { timeout: 60_000 }, () => {
  const BOT = 'm2-durable-test-bot-token';
  function service(
    store: PostgresChannelLinkStore,
    clock: () => number,
    outbox: Map<string, string>,
  ) {
    return new ChannelLinkService(store, {
      now: clock,
      challengeTtlSeconds: 300,
      deliverCode: async ({ channelUserId, code }) => {
        outbox.set(channelUserId, code);
      },
      verifiers: {
        telegram: (proof, now) => {
          const uid = verifyTelegramLogin(proof, BOT, now);
          return uid ? { channelUserId: uid } : null;
        },
      },
    });
  }

  it('a proof and a challenge are used once across restarts; concurrent links for one wallet admit one', async () => {
    const ws = `wsp_${runId()}`;
    const clock = () => NOW;
    const outbox = new Map<string, string>();
    const alice = accountFor(`link-alice-${ws}`);
    const userA = String(100_000 + Math.floor(Math.random() * 1e6));
    const userB = String(2_000_000 + Math.floor(Math.random() * 1e6));
    const proofA = signTelegramLoginForTest(
      { id: Number(userA), auth_date: NOW },
      BOT,
    );
    const proofB = signTelegramLoginForTest(
      { id: Number(userB), auth_date: NOW },
      BOT,
    );
    const s1 = service(new PostgresChannelLinkStore(pool), clock, outbox);
    const chA = await s1.requestLink({
      workspaceId: ws,
      channel: 'telegram',
      channelProof: proofA,
      wallet: alice.address,
    });
    // Restart: the same login payload is refused by a fresh process.
    const s2 = service(new PostgresChannelLinkStore(pool), clock, outbox);
    await expect(
      s2.requestLink({
        workspaceId: ws,
        channel: 'telegram',
        channelProof: proofA,
        wallet: alice.address,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    const chB = await s2.requestLink({
      workspaceId: ws,
      channel: 'telegram',
      channelProof: proofB,
      wallet: alice.address,
    });
    const sigA = await alice.signTypedData(channelLinkTypedData(chA));
    const sigB = await alice.signTypedData(channelLinkTypedData(chB));
    const results = await Promise.allSettled([
      service(new PostgresChannelLinkStore(pool), clock, outbox).completeLink({
        challengeId: chA.challengeId,
        channelCode: outbox.get(userA)!,
        signature: sigA,
      }),
      service(new PostgresChannelLinkStore(pool), clock, outbox).completeLink({
        challengeId: chB.challengeId,
        channelCode: outbox.get(userB)!,
        signature: sigB,
      }),
      service(new PostgresChannelLinkStore(pool), clock, outbox).completeLink({
        challengeId: chA.challengeId,
        channelCode: outbox.get(userA)!,
        signature: sigA,
      }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const links = await new PostgresChannelLinkStore(pool).listLinks(ws);
    expect(links.filter((l) => l.unlinkedAt === null)).toHaveLength(1);
    // Replaying a completed challenge after restart is refused.
    await expect(
      service(new PostgresChannelLinkStore(pool), clock, outbox).completeLink({
        challengeId: chA.challengeId,
        channelCode: outbox.get(userA)!,
        signature: sigA,
      }),
    ).rejects.toMatchObject({ code: 'CHALLENGE_CONSUMED' });
  });
});
