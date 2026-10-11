import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { monadTestnetProfile, officialAssets } from '@synq/chain-registry';
import { MandateSchema, type Mandate } from '@synq/schemas';
import type { AuthorizationDecision } from '@synq/kernel';
import {
  FundingError,
  MemorySendStore,
  buildSendPreview,
  confirmSendPreview,
  sendDirectory,
  sendPolicy,
  type AusdGuardResult,
  type SendPreview,
  type SendRecord,
} from '@synq/funding';
import { sendConfirmationTypedData } from '@synq/identity/server';
import {
  confirmationOf,
  sendRoutes,
  type SendRouteDeps,
} from '../../apps/api/src/send-routes.js';

const NOW = 1_800_000_000;
const ausd = officialAssets.testnetAUSD;
const hex = (byte: string, n = 20) => `0x${byte.repeat(n)}` as `0x${string}`;
const ACCOUNT = hex('a1');
const CONTACT = hex('c0');
const GROUP = hex('9e', 32);
const members = ['alice', 'bob', 'carol'].map((label, i) => ({
  label,
  memberId: `member_${i}`,
  account: privateKeyToAccount(generatePrivateKey()),
}));
const signer = (i: number) =>
  members[i]!.account.address.toLowerCase() as `0x${string}`;

function mandate(overrides: Partial<Mandate> = {}): Mandate {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: 'synq_send',
    groupId: GROUP,
    version: 1,
    status: 'ACTIVE',
    network: monadTestnetProfile.network,
    account: ACCOUNT,
    chainGroupId: GROUP,
    operators: [hex('0e')],
    bindings: [
      {
        pluginId: 'ausd-transfer',
        action: 'TRANSFER',
        target: ausd.address,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [
      { address: signer(2), purpose: 'MEMBER_WITHDRAWAL' },
      { address: CONTACT, purpose: 'COUNTERPARTY' },
    ],
    inputAsset: ausd,
    outputAssets: [],
    perActionCap: '2000000',
    cumulativeBudget: '10000000',
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 0,
    maxReferenceDeviationBps: 0,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '100000', reviewMax: '500000' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'CONSENSUS',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['MERA_HUMAN'],
    },
    delegationScope: null,
    members: members.map((m, i) => ({
      memberId: m.memberId,
      signer: signer(i),
      active: true,
    })),
    validAfter: NOW - 60,
    validUntil: NOW + 86_400,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 10,
    ...overrides,
  });
}
const directory = (m = mandate()) =>
  sendDirectory({
    members: members.map((x, i) => ({
      memberId: x.memberId,
      principalId: `mera:${signer(i)}`,
      signer: signer(i),
      label: x.label,
    })),
    contacts: [{ label: 'contact', address: CONTACT }],
    mandate: m,
  });
const guardPass = (
  recipient: string,
  amount: bigint,
  status: 'PASS' | 'BLOCKED' = 'PASS',
): AusdGuardResult => ({
  status,
  chainId: ausd.chainId,
  token: ausd.address,
  account: ACCOUNT,
  recipient: recipient as `0x${string}`,
  amount: String(amount),
  blockNumber: '1',
  checks: [],
  reasons: status === 'PASS' ? [] : ['RECIPIENT_FROZEN'],
});
const code = (f: () => unknown) => {
  try {
    f();
    return 'NO_ERROR';
  } catch (e) {
    return e instanceof FundingError ? e.code : String(e);
  }
};
function preview(
  amountDecimal = '1',
  who = directory().find((r) => r.kind === 'MEMBER' && r.sendable)!,
  free = 3_000_000n,
) {
  const amount = BigInt(Math.round(Number(amountDecimal) * 1e6));
  return buildSendPreview({
    groupId: GROUP,
    mandate: mandate(),
    recipient: who,
    amountDecimal,
    freeBalance: free,
    guard: guardPass(who.address, amount),
    now: NOW,
    ttlSeconds: 300,
    nonce: 'n',
  });
}

describe('Synq Send preview and confirmation (B08.4)', () => {
  it('directory lists members and contacts; only mandate recipients are sendable', () => {
    const d = directory();
    expect(d.map((r) => [r.kind, r.sendable])).toEqual([
      ['MEMBER', false],
      ['MEMBER', false],
      ['MEMBER', true],
      ['CONTACT', true],
    ]);
  });

  it('preview binds recipient address, AUSD amount in decimals, chain, expiry, policy tier and guard evidence', () => {
    const p = preview('1');
    expect(p.amount).toBe('1000000');
    expect(p.amountDecimal).toBe('1.000000');
    expect(p.asset).toEqual(ausd);
    expect(p.chainId).toBe(monadTestnetProfile.network.chainId);
    expect(p.expiresAt).toBe(NOW + 300);
    expect(p.policy).toMatchObject({ tier: 'QUORUM', requiredApprovals: 2 });
    expect(p.treasury).toEqual({ free: '3000000', freeAfter: '2000000' });
  });

  it('policy: personal / review / quorum per mandate bands; member withdrawals are quorum', () => {
    const m = mandate();
    expect(sendPolicy(m, 50_000n, CONTACT).tier).toBe('PERSONAL');
    expect(sendPolicy(m, 400_000n, CONTACT)).toMatchObject({
      tier: 'REVIEW',
      policyApprovals: 1,
      requiredApprovals: 2,
    });
    expect(sendPolicy(m, 900_000n, CONTACT).tier).toBe('QUORUM');
    expect(sendPolicy(m, 50_000n, signer(2)).tier).toBe('QUORUM');
  });

  it('AUSD amount exceeds mandate, free balance, guard and allowlist all block the preview', () => {
    expect(code(() => preview('2.5'))).toBe('AMOUNT_EXCEEDS_MANDATE');
    expect(code(() => preview('1', undefined, 500_000n))).toBe(
      'INSUFFICIENT_FREE_BALANCE',
    );
    expect(code(() => preview('1', directory()[0]!))).toBe('RECIPIENT_UNKNOWN');
    expect(code(() => preview('0.0000001'))).toBe('AMOUNT_INVALID');
    const who = directory()[2]!;
    expect(
      code(() =>
        buildSendPreview({
          groupId: GROUP,
          mandate: mandate(),
          recipient: who,
          amountDecimal: '1',
          freeBalance: 3_000_000n,
          guard: guardPass(who.address, 1_000_000n, 'BLOCKED'),
          now: NOW,
          ttlSeconds: 300,
          nonce: 'n',
        }),
      ),
    ).toBe('AUSD_GUARD_BLOCKED');
    expect(
      code(() =>
        buildSendPreview({
          groupId: GROUP,
          mandate: mandate(),
          recipient: who,
          amountDecimal: '1',
          freeBalance: 3_000_000n,
          guard: guardPass(CONTACT, 1_000_000n),
          now: NOW,
          ttlSeconds: 300,
          nonce: 'n',
        }),
      ),
    ).toBe('AUSD_GUARD_BLOCKED');
  });

  it('AUSD-006 recipient mismatch, amount/digest tampering, wrong chain and expiry block confirmation', () => {
    const p = preview('1');
    const ok = {
      previewId: p.previewId,
      digest: p.digest,
      recipientAddress: p.recipient.address,
      amount: p.amount,
      chainId: p.chainId,
    };
    expect(confirmSendPreview(p, ok, NOW + 1)).toBe(p);
    expect(
      code(() =>
        confirmSendPreview(p, { ...ok, recipientAddress: CONTACT }, NOW + 1),
      ),
    ).toBe('RECIPIENT_MISMATCH');
    expect(
      code(() => confirmSendPreview(p, { ...ok, amount: '1000001' }, NOW + 1)),
    ).toBe('PREVIEW_MISMATCH');
    expect(
      code(() => confirmSendPreview(p, { ...ok, chainId: 143 }, NOW + 1)),
    ).toBe('NETWORK_MISMATCH');
    expect(code(() => confirmSendPreview(p, ok, NOW + 300))).toBe(
      'PREVIEW_EXPIRED',
    );
    const tampered: SendPreview = {
      ...p,
      recipient: { ...p.recipient, address: CONTACT },
    };
    expect(
      code(() =>
        confirmSendPreview(
          tampered,
          { ...ok, recipientAddress: CONTACT },
          NOW + 1,
        ),
      ),
    ).toBe('PREVIEW_MISMATCH');
  });
});

it('guard evidence with wrong chain or token cannot create a preview', () => {
  const recipient = directory().find((r) => r.sendable)!;
  for (const patch of [{ chainId: 143 }, { token: CONTACT }])
    expect(() =>
      buildSendPreview({
        groupId: GROUP,
        mandate: mandate(),
        recipient,
        amountDecimal: '1',
        freeBalance: 3000000n,
        guard: { ...guardPass(recipient.address, 1000000n), ...patch },
        now: NOW,
        ttlSeconds: 300,
        nonce: 'bound',
      }),
    ).toThrow('AUSD_GUARD_BLOCKED');
});

describe('Synq Send API routes with fake Kernel/index ports', () => {
  const app = Fastify();
  const store = new MemorySendStore();
  const calls: { approvals: number }[] = [];
  let counted = 0;
  let failNext = false;
  let frozen = false;
  let indexed: { block: number; tx: string | null; amount: string } = {
    block: 0,
    tx: null,
    amount: '1000000',
  };
  const ADMIN = 'x'.repeat(40);
  const draft = { digest: hex('d1', 32), grant: {} };
  const deps: SendRouteDeps = {
    store,
    adminToken: ADMIN,
    now: () => NOW,
    groups: {
      context: async (g) =>
        g === GROUP
          ? {
              groupId: GROUP,
              mandate: mandate(),
              members: members.map((m, i) => ({
                memberId: m.memberId,
                principalId: `mera:${signer(i)}`,
                signer: signer(i),
                label: m.label,
              })),
              contacts: [{ label: 'contact', address: CONTACT }],
            }
          : null,
    },
    members: {
      activeSigner: async (_g, m) => {
        const i = members.findIndex((x) => x.memberId === m);
        return i < 0 ? null : signer(i);
      },
    },
    treasury: {
      view: async () =>
        ({ core: { free: '3000000' } }) as Awaited<
          ReturnType<SendRouteDeps['treasury']['view']>
        >,
    },
    guard: {
      check: async ({ recipient, amount }) =>
        guardPass(recipient, amount, frozen ? 'BLOCKED' : 'PASS'),
    },
    proposer: {
      propose: async ({ nonce }) => {
        if (failNext) {
          failNext = false;
          throw new Error('RPC_DOWN');
        }
        return {
          intent: { intentId: `send_${nonce}` },
          risk: {},
          simulation: {},
          data: '0xa9059cbb',
        };
      },
    },
    kernel: {
      authorize: async (request) => {
        const approvals = (request as { approvals: unknown[] }).approvals
          .length;
        calls.push({ approvals });
        const base = {
          intentId: 'send_1',
          intentHash: hex('ab', 32),
          state: null,
          tier: 'CONSENSUS',
          policy: null,
          transitions: [],
          audit: null,
        };
        return (approvals >= 2
          ? {
              ...base,
              status: 'AUTHORIZED',
              requiredApprovals: 2,
              draft,
              grant: { grantId: hex('9a', 32) },
            }
          : {
              ...base,
              status: 'PENDING_APPROVAL',
              code: 'MISSING_QUORUM',
              issues: [],
              draft,
              requiredApprovals: 2,
              countedApprovals: approvals,
              rejectedApprovals: [],
            }) as unknown as AuthorizationDecision;
      },
    },
    drafts: {
      register: async () => ({}),
      verifiedApprovals: async () => ({
        satisfied: counted >= 2,
        counted: Array.from({ length: counted }, () => ({}) as never),
      }),
    },
    index: {
      executed: async () => ({
        indexedThroughBlock: indexed.block,
        transactionHash: indexed.tx,
        tokenAmount: indexed.amount,
        recipient: signer(2),
      }),
    },
  };
  const req = (
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    admin = method === 'GET' || url === '/v1/send/previews',
  ) =>
    app.inject({
      method,
      url,
      ...(body === undefined ? {} : { payload: body as object }),
      ...(admin ? { headers: { authorization: `Bearer ${ADMIN}` } } : {}),
    });
  beforeAll(async () => {
    await app.register(sendRoutes, deps);
    await app.ready();
  });
  afterAll(() => app.close());

  async function confirmBody(p: SendPreview, memberIndex = 0, as = 0) {
    const signature = await members[as]!.account.signTypedData(
      sendConfirmationTypedData(
        confirmationOf({ preview: p }, members[memberIndex]!.memberId),
      ),
    );
    return {
      previewId: p.previewId,
      digest: p.digest,
      recipientAddress: p.recipient.address,
      amount: p.amount,
      chainId: p.chainId,
      sender: { memberId: members[memberIndex]!.memberId, signature },
    };
  }

  it('AUSD-007 a confirmation whose proposal failed stays PREVIEWED and a retry proposes exactly once', async () => {
    const recipients = (
      await req('GET', `/v1/send/${GROUP}/recipients`)
    ).json();
    const contact = recipients.recipients.find(
      (r: { address: string }) => r.address === CONTACT,
    );
    const p = (
      await req('POST', '/v1/send/previews', {
        groupId: GROUP,
        recipientId: contact.recipientId,
        amount: '0.5',
      })
    ).json() as SendPreview;
    const body = await confirmBody(p);
    failNext = true;
    const before = calls.length;
    expect((await req('POST', '/v1/send', body)).statusCode).toBe(500);
    const retried = (await req('POST', '/v1/send', body)).json() as SendRecord;
    expect(retried.state).toBe('PENDING_APPROVAL');
    const again = (await req('POST', '/v1/send', body)).json() as SendRecord;
    expect(again.sendId).toBe(retried.sendId);
    expect(calls.length - before).toBe(1);
  });

  it('end to end: preview → passkey-signed confirm (idempotent) → quorum insufficient stays pending → authorize → execution → indexer delayed → INDEXED with latency', async () => {
    const recipients = (
      await req('GET', `/v1/send/${GROUP}/recipients`)
    ).json();
    const carol = recipients.recipients.find(
      (r: { address: string }) => r.address === signer(2),
    );
    const over = await req('POST', '/v1/send/previews', {
      groupId: GROUP,
      recipientId: carol.recipientId,
      amount: '3',
    });
    expect(over.statusCode).toBe(422);
    expect(over.json().error).toBe('AMOUNT_EXCEEDS_MANDATE');
    const p = (
      await req('POST', '/v1/send/previews', {
        groupId: GROUP,
        recipientId: carol.recipientId,
        amount: '1',
      })
    ).json() as SendPreview;

    const forged = await req('POST', '/v1/send', await confirmBody(p, 1, 0));
    expect(forged.json().error).toBe('SENDER_SIGNATURE_INVALID');
    const outsider = await req('POST', '/v1/send', {
      ...(await confirmBody(p)),
      sender: { memberId: 'member_9', signature: '0x00' },
    });
    expect(outsider.json().error).toBe('SENDER_NOT_MEMBER');
    const mismatch = await req('POST', '/v1/send', {
      ...(await confirmBody(p)),
      recipientAddress: CONTACT,
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error).toBe('RECIPIENT_MISMATCH');

    const body = await confirmBody(p);
    const proposedBefore = calls.length;
    const first = (await req('POST', '/v1/send', body)).json() as SendRecord;
    const again = (await req('POST', '/v1/send', body)).json() as SendRecord;
    expect(first.state).toBe('PENDING_APPROVAL');
    expect(again.sendId).toBe(first.sendId);
    expect(calls.length - proposedBefore).toBe(1);
    expect(again.state).toBe(first.state);

    expect(
      (await req('POST', `/v1/send/${first.sendId}/authorize`, {})).statusCode,
    ).toBe(401);
    counted = 1;
    const one = (
      await req('POST', `/v1/send/${first.sendId}/authorize`, {}, true)
    ).json();
    expect(one.grant).toBeNull();
    expect(one.record.state).toBe('PENDING_APPROVAL');
    expect(one.record.kernelCode).toBe('MISSING_QUORUM');
    counted = 2;
    frozen = true;
    const blocked = await req(
      'POST',
      `/v1/send/${first.sendId}/authorize`,
      {},
      true,
    );
    expect(blocked.statusCode).toBe(423);
    expect(blocked.json().error).toBe('AUSD_GUARD_BLOCKED');
    frozen = false;
    const two = (
      await req('POST', `/v1/send/${first.sendId}/authorize`, {}, true)
    ).json();
    expect(two.record.state).toBe('AUTHORIZED');
    expect(two.grant.grantId).toBe(hex('9a', 32));

    const tx = hex('7e', 32);
    const execution = {
      transactionHash: tx,
      blockNumber: '100',
      recipientBalanceBefore: '0',
      recipientBalanceAfter: '1000000',
      explorer: null,
    };
    // Single time unit: second-resolution or reversed timestamps are refused.
    for (const times of [
      { submittedAt: NOW + 1, confirmedAt: NOW + 2 },
      { submittedAt: NOW * 1000 + 2_500, confirmedAt: NOW * 1000 + 1_000 },
      { submittedAt: NOW * 1000, confirmedAt: (NOW + 3_600) * 1000 },
    ]) {
      const bad = await req(
        'POST',
        `/v1/send/${first.sendId}/execution`,
        { ...execution, ...times },
        true,
      );
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toBe('EXECUTION_TIME_INVALID');
    }
    await req(
      'POST',
      `/v1/send/${first.sendId}/execution`,
      {
        transactionHash: tx,
        blockNumber: '100',
        submittedAt: NOW * 1000 + 1_000,
        confirmedAt: NOW * 1000 + 2_500,
        recipientBalanceBefore: '0',
        recipientBalanceAfter: '1000000',
        explorer: null,
      },
      true,
    );
    const delayed = (
      await req('POST', `/v1/send/${first.sendId}/reconcile`, {}, true)
    ).json() as SendRecord;
    expect(delayed.state).toBe('CONFIRMED');
    indexed = { block: 101, tx: hex('66', 32), amount: '1000000' };
    const wrong = await req(
      'POST',
      `/v1/send/${first.sendId}/reconcile`,
      {},
      true,
    );
    expect(wrong.json().error).toBe('INDEXED_EXECUTION_MISMATCH');
    indexed = { block: 101, tx, amount: '1000000' };
    const done = (
      await req('POST', `/v1/send/${first.sendId}/reconcile`, {}, true)
    ).json() as SendRecord;
    expect(done.state).toBe('INDEXED');
    expect(done.receipt?.recipientDelta).toBe('1000000');
    expect(done.receipt?.latencyMs.submitToConfirmed).toBe(1_500);
    expect(done.receipt?.latencyMs.submitToIndexed).toBeGreaterThanOrEqual(
      1_500,
    );
    expect(done.history.map((h) => h.state)).toEqual([
      'PREVIEWED',
      'CONFIRMING',
      'PENDING_APPROVAL',
      'AUTHORIZED',
      'SUBMITTED',
      'CONFIRMED',
      'INDEXED',
    ]);
    const times = done.history.map((h) => h.at);
    expect(times.every((t) => t >= NOW * 1000)).toBe(true);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('concurrent signed confirmations run one proposal and Kernel decision', async () => {
    const p = (
      await req('POST', '/v1/send/previews', {
        groupId: GROUP,
        recipientId: `contact:${CONTACT}`,
        amount: '0.25',
      })
    ).json() as SendPreview;
    const body = await confirmBody(p);
    const before = calls.length;
    const results = await Promise.all(
      Array.from({ length: 8 }, () => req('POST', '/v1/send', body)),
    );
    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(calls.length - before).toBe(1);
    expect(new Set(results.map((r) => r.json().sendId)).size).toBe(1);
  });

  it('treasury, status, directory and preview requests require authentication', async () => {
    for (const url of [
      `/v1/groups/${GROUP}/treasury`,
      `/v1/send/${GROUP}/recipients`,
      `/v1/send/${hex('ab', 32)}`,
    ])
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect(
      (
        await req(
          'POST',
          '/v1/send/previews',
          { groupId: GROUP, recipientId: `contact:${CONTACT}`, amount: '1' },
          false,
        )
      ).statusCode,
    ).toBe(401);
  });
  it('P08 recovered grants rerun the guard before exposing execution authority', async () => {
    const p = (
      await req('POST', '/v1/send/previews', {
        groupId: GROUP,
        recipientId: `contact:${CONTACT}`,
        amount: '0.25',
      })
    ).json() as SendPreview;
    const record = (
      await req('POST', '/v1/send', await confirmBody(p))
    ).json() as SendRecord;
    const decision = await deps.kernel.authorize({ approvals: [{}, {}] });
    deps.kernel.recover = async () => ({ status: 'RECOVERED', decision });
    const before = calls.length;
    try {
      frozen = true;
      const blocked = await req(
        'POST',
        `/v1/send/${record.sendId}/authorize`,
        {},
        true,
      );
      expect(blocked.statusCode).toBe(423);
      expect(blocked.json().error).toBe('AUSD_GUARD_BLOCKED');
      expect((await store.get(record.sendId))?.state).toBe('PENDING_APPROVAL');
      frozen = false;
      const recovered = await req(
        'POST',
        `/v1/send/${record.sendId}/authorize`,
        {},
        true,
      );
      expect(recovered.json().grant.grantId).toBe(hex('9a', 32));
      expect(calls.length).toBe(before);
    } finally {
      frozen = false;
      delete deps.kernel.recover;
    }
  });
});
