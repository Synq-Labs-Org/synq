import { describe, expect, it } from 'vitest';
import type { SendRecord } from '@synq/funding';
import {
  brainChannelPort,
  productionChannelPorts,
} from '../../apps/api/src/channel-runtime.js';
import type { SendGroupContext } from '../../apps/api/src/send-routes.js';

const G = `0x${'a1'.repeat(32)}`;
const H = (b: string) => `0x${b.repeat(32)}`;
const ALICE = `0x${'a'.repeat(40)}`;
const BOB = `0x${'b'.repeat(40)}`;
const context = {
  groupId: G,
  mandate: {
    mandateId: 'synq_send',
    version: 1,
    status: 'ACTIVE',
    perActionCap: '2000000',
    cumulativeBudget: '10000000',
    inputAsset: { symbol: 'AUSD', decimals: 6, address: `0x${'c'.repeat(40)}` },
    recipients: [{ address: BOB, purpose: 'MEMBER_WITHDRAWAL' }],
  },
  members: [
    {
      memberId: 'member_0',
      principalId: 'p_alice',
      signer: ALICE,
      label: 'alice',
    },
    { memberId: 'member_1', principalId: 'p_bob', signer: BOB, label: 'bob' },
  ],
  contacts: [],
} as unknown as SendGroupContext;
const send = (over: Partial<SendRecord>): SendRecord =>
  ({
    sendId: H('01'),
    state: 'PENDING_APPROVAL',
    preview: {
      amountDecimal: '1',
      asset: { symbol: 'AUSD' },
      recipient: { label: 'bob' },
    },
    intentHash: H('11'),
    draftDigest: H('22'),
    receipt: null,
    ...over,
  }) as SendRecord;

function ports(sends: SendRecord[], counted = 1) {
  return productionChannelPorts({
    send: {
      groups: { context: async (g) => (g === G ? context : null) },
      treasury: { view: async () => null },
    },
    sends: { list: async () => sends },
    approvals: {
      drafts: async () => [
        { draftDigest: H('22'), intentHash: H('11'), status: 'PENDING' },
      ],
      quorum: async () => ({
        required: 2,
        counted: Array(counted).fill({}),
        satisfied: counted >= 2,
        draftStatus: 'PENDING',
      }),
    },
    executed: {
      executed: async () => [{ intentHash: H('44'), transactionHash: H('55') }],
    },
    executionMode: 'REAL_TESTNET',
  });
}

describe('production channel ports', () => {
  it('counts only identity-ledger verified approvals and labels the Send', async () => {
    expect(await ports([send({})]).approvals(G)).toEqual([
      {
        intentHash: H('11'),
        draftDigest: H('22'),
        label: 'Send 1 AUSD to bob',
        kind: 'SEND',
        amount: { amount: '1', symbol: 'AUSD' },
        recipient: { label: 'bob', address: null },
        counted: 1,
        required: 2,
        status: 'PENDING',
      },
    ]);
    expect((await ports([send({})], 2).approvals(G))[0]!.status).toBe(
      'SATISFIED',
    );
    expect(
      (await ports([send({ state: 'REJECTED' })]).approvals(G))[0]!.status,
    ).toBe('INVALIDATED');
  });

  it('reports receipts from confirmed Sends and indexed grant executions', async () => {
    const receipt = { transactionHash: H('33') } as SendRecord['receipt'];
    const r = await ports([send({ state: 'INDEXED', receipt })]).receipts(G);
    expect(r.map((x) => [x.state, x.transactionHash, x.executionMode])).toEqual(
      [
        ['RECONCILED', H('33'), 'REAL_TESTNET'],
        ['RECONCILED', H('55'), 'REAL_TESTNET'],
      ],
    );
    expect(
      await ports([send({ state: 'SUBMITTED', receipt })]).receipts(G),
    ).toHaveLength(1);
  });

  it('resolves members and only sendable recipients', async () => {
    const p = ports([]);
    expect(await p.activeMember(G, 'p_bob')).toEqual({ memberId: 'member_1' });
    expect(await p.activeMember(G, 'p_mallory')).toBeNull();
    expect(await p.sendRecipient!(G, 'BOB')).toEqual({
      recipientId: 'member:member_1',
      label: 'bob',
    });
    expect(await p.sendRecipient!(G, 'alice')).toBeNull();
    expect((await p.mandates(G))[0]).toMatchObject({
      perActionCap: '2.000000',
      symbol: 'AUSD',
    });
  });

  it('maps Brain decisions to approval links by draft digest', async () => {
    const brain = brainChannelPort({
      run: async () => ({
        status: 'COMPLETED',
        items: [
          {
            kind: 'ACTION',
            status: 'SUBMITTED',
            decision: {
              kind: 'ACTION',
              status: 'PENDING_APPROVAL',
              code: 'QUORUM',
              draftDigest: H('22'),
            },
          },
        ],
        findings: [],
      }),
      drafts: async () => [
        { draftDigest: H('22'), intentHash: H('11'), status: 'PENDING' },
      ],
    });
    const reply = await brain({
      groupId: G,
      memberId: 'member_0',
      principalId: 'p_alice',
      text: 'x',
      runId: 'r',
      intent: 'PROPOSE',
    });
    expect(reply.proposals).toEqual([
      {
        kind: 'ACTION',
        status: 'PENDING_APPROVAL',
        code: 'QUORUM',
        intentHash: H('11'),
        reviewPath: null,
      },
    ]);
  });

  it('turns a Kernel-checked Brain mandate proposal into a mandate review link', async () => {
    const proposed: unknown[] = [];
    const brain = brainChannelPort({
      run: async () => ({
        status: 'COMPLETED',
        items: [
          {
            kind: 'MANDATE',
            status: 'ESCALATED',
            normalized: {
              kind: 'MANDATE',
              change: 'NEW',
              mandate: { mandateId: 'm' },
            },
            decision: {
              kind: 'MANDATE',
              status: 'REQUIRES_HUMAN_APPROVAL',
              code: 'NEW_MANDATE',
              draftDigest: null,
            },
          },
          {
            kind: 'MANDATE',
            status: 'REJECTED',
            normalized: {
              kind: 'MANDATE',
              change: 'NEW',
              mandate: { mandateId: 'x' },
            },
            decision: {
              kind: 'MANDATE',
              status: 'REJECTED',
              code: 'INVALID_MANDATE',
              draftDigest: null,
            },
          },
        ],
        findings: [],
      }),
      drafts: async () => [],
      proposeMandate: async (input) => {
        proposed.push(input);
        return H('77');
      },
    });
    const reply = await brain({
      groupId: G,
      memberId: 'member_0',
      principalId: 'p_alice',
      text: 'x',
      runId: 'r',
      intent: 'PROPOSE',
    });
    expect(proposed).toEqual([
      {
        groupId: G,
        memberId: 'member_0',
        mandate: { mandateId: 'm' },
        change: 'NEW',
      },
    ]);
    expect(reply.proposals.map((p) => p.reviewPath)).toEqual([
      `/mandates/${H('77')}`,
      null,
    ]);
  });
});
