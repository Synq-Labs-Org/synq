import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { randomBytes } from 'node:crypto';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { keccak256, toHex, type Address } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  DurableDelegationRegistry,
  MemoryDelegationHeadAnchor,
  PostgresDelegationLogStore,
  delegationLogHash,
  delegationTypedData,
  migrateGovernance,
  revocationTypedData,
  type Delegation,
  type DelegationLogEntry,
  type GovernancePolicy,
} from '@synq/governance';
import { durablePool, runId } from './pg.js';

const accountFor = (label: string) =>
  privateKeyToAccount(keccak256(toHex(`synq-m2-deleg:${label}`)));
const CHAIN = token('arc-testnet', 'USDC').chainId;
const NOW = 1_790_000_000;
const DAY = 86_400;
const macKey = randomBytes(32);
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

beforeAll(async () => {
  pool = await durablePool();
  await migrateGovernance(pool);
});
afterAll(async () => {
  await pool.end();
});

/** alice→bob registered then revoked, then dave→bob registered. */
async function scenario(anchor?: MemoryDelegationHeadAnchor) {
  const id = runId();
  const policy = policyFor(`wsp_${id}`);
  const alice = accountFor(`alice-${id}`);
  const bob = accountFor(`bob-${id}`);
  const dave = accountFor(`dave-${id}`);
  const opts = { macKey, ...(anchor ? { anchor } : {}) };
  const reg = new DurableDelegationRegistry(
    policy,
    new PostgresDelegationLogStore(pool),
    opts,
  );
  const mk = (from: PrivateKeyAccount, to: Address, n: string): Delegation => ({
    workspaceId: policy.workspaceId,
    chainId: CHAIN,
    delegator: from.address,
    delegate: to,
    issuedAt: NOW - 10,
    expiresAt: NOW + 30 * DAY,
    nonce: keccak256(toHex(n)),
  });
  const d = mk(alice, bob.address, `a-${id}`);
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
  const d3 = mk(dave, bob.address, `d-${id}`);
  await reg.register(
    d3,
    await dave.signTypedData(delegationTypedData(d3)),
    NOW + 6,
  );
  return { policy, opts, aliceId: r.id };
}

/** A DB writer rewrites the log: run `edit` with the append-only trigger off. */
async function rewrite(edit: (c: pg.PoolClient) => Promise<void>) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'ALTER TABLE synq_delegation_log DISABLE TRIGGER synq_delegation_log_keep',
    );
    await edit(c);
    await c.query(
      'ALTER TABLE synq_delegation_log ENABLE TRIGGER synq_delegation_log_keep',
    );
    await c.query('COMMIT');
  } finally {
    c.release();
  }
}

describe(
  'critic C-04: delegation-log tamper detection',
  { timeout: 60_000 },
  () => {
    it('a revocation removed from the middle and the log re-chained by a DB writer (without the MAC key) is detected', async () => {
      const { policy, opts } = await scenario();
      const ws = policy.workspaceId;
      const rows = await pool.query(
        'SELECT entry FROM synq_delegation_log WHERE workspace_id=$1 ORDER BY seq',
        [ws],
      );
      const entries = rows.rows.map((r) => r.entry as DelegationLogEntry);
      const third = entries[2]!;
      // The attacker re-chains seq 3 as seq 2, hashing with any key they have.
      const attackerKey = randomBytes(32);
      const body = { ...third, seq: 2, prevHash: entries[0]!.hash };
      delete (body as { hash?: unknown }).hash;
      const forged = {
        ...body,
        hash: delegationLogHash(ws, CHAIN, body, attackerKey),
      };
      await rewrite(async (c) => {
        await c.query(
          'DELETE FROM synq_delegation_log WHERE workspace_id=$1 AND seq >= 2',
          [ws],
        );
        await c.query(
          `INSERT INTO synq_delegation_log (workspace_id, chain_id, seq, kind, delegation_id, entry, prev_hash, hash)
         VALUES ($1,$2,2,$3,$4,$5,$6,$7)`,
          [
            ws,
            CHAIN,
            forged.kind,
            forged.delegationId,
            JSON.stringify(forged),
            forged.prevHash,
            forged.hash,
          ],
        );
        await c.query(
          'UPDATE synq_delegation_heads SET seq=2, hash=$2 WHERE workspace_id=$1',
          [ws, forged.hash],
        );
      });
      await expect(
        new DurableDelegationRegistry(
          policy,
          new PostgresDelegationLogStore(pool),
          opts,
        ).list(),
      ).rejects.toMatchObject({ code: 'STORE_TAMPERED' });
    });

    it('truncating the newest entries and rewinding the head is detected against the anchored head', async () => {
      const anchor = new MemoryDelegationHeadAnchor();
      const { policy, opts } = await scenario(anchor);
      const ws = policy.workspaceId;
      await rewrite(async (c) => {
        const keep = await c.query(
          'SELECT hash FROM synq_delegation_log WHERE workspace_id=$1 AND seq=1',
          [ws],
        );
        await c.query(
          'DELETE FROM synq_delegation_log WHERE workspace_id=$1 AND seq >= 2',
          [ws],
        );
        await c.query(
          'UPDATE synq_delegation_heads SET seq=1, hash=$2 WHERE workspace_id=$1',
          [ws, keep.rows[0]!.hash],
        );
      });
      await expect(
        new DurableDelegationRegistry(
          policy,
          new PostgresDelegationLogStore(pool),
          opts,
        ).list(),
      ).rejects.toMatchObject({ code: 'STORE_TAMPERED' });
    });

    it('known limit: without an anchor, a fresh process cannot see a truncated tail (stated in the finding)', async () => {
      const { policy, opts, aliceId } = await scenario();
      const ws = policy.workspaceId;
      await rewrite(async (c) => {
        const keep = await c.query(
          'SELECT hash FROM synq_delegation_log WHERE workspace_id=$1 AND seq=1',
          [ws],
        );
        await c.query(
          'DELETE FROM synq_delegation_log WHERE workspace_id=$1 AND seq >= 2',
          [ws],
        );
        await c.query(
          'UPDATE synq_delegation_heads SET seq=1, hash=$2 WHERE workspace_id=$1',
          [ws, keep.rows[0]!.hash],
        );
      });
      const records = await new DurableDelegationRegistry(
        policy,
        new PostgresDelegationLogStore(pool),
        opts,
      ).list();
      expect(records.find((r) => r.id === aliceId)!.revokedAt).toBeNull();
    });

    it('a registry without a MAC key of at least 32 bytes is refused', () => {
      expect(
        () =>
          new DurableDelegationRegistry(
            policyFor('wsp_x'),
            new PostgresDelegationLogStore(pool),
            {
              macKey: new Uint8Array(8),
            },
          ),
      ).toThrow(/32 bytes/);
    });
  },
);
