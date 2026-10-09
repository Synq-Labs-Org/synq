import { describe, expect, it } from 'vitest';
import { canonicalSignature } from '../../packages/kernel/src/index.js';
import type { VerifiedApproval } from '../../packages/schemas/src/index.js';
import {
  ACCOUNT,
  OPERATOR,
  approve,
  asset,
  evidence,
  expectDraft,
  harness,
  hash,
  intent,
  mandate,
  manifest,
  nativeAsset,
  now,
  outsider,
  owners,
  FixtureDelegations,
  type FixtureDelegation,
  type Harness,
  type Prepared,
} from './fixtures.js';

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
async function pending(h: Harness, input: Prepared) {
  return expectDraft(await h.kernel.authorize({ ...input, approvals: [] }));
}
async function submit(h: Harness, input: Prepared, approvals: unknown[]) {
  return h.kernel.authorize({ ...input, approvals });
}

describe('ADR-0011 approval evidence (R5, B02.6)', () => {
  it('regression: a validly signed approval without a consumed challenge never counts', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = await pending(h, input);
    const unconsumed = await approve(h, draft, [0, 1], { consume: false });
    expect(await submit(h, input, unconsumed)).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'APPROVAL_NOT_CONSUMED',
      countedApprovals: 0,
    });
    const forged = (await approve(h, draft, [0, 1])).map((a, i) =>
      i === 0 ? { ...a, membershipEpoch: 9 } : a,
    );
    expect(await submit(h, input, forged)).toMatchObject({
      code: 'APPROVAL_NOT_CONSUMED',
    });
  });

  it('regression: operator/agent principals can never count toward quorum', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = await pending(h, input);
    const operator = await approve(h, draft, [0], { kind: 'DYNAMIC_OPERATOR' });
    const human = await approve(h, draft, [1]);
    expect(await submit(h, input, [...operator, ...human])).toMatchObject({
      code: 'PRINCIPAL_KIND_INELIGIBLE',
      status: 'PENDING_APPROVAL',
    });
    expect(
      mandate().approvalPolicy.eligibleKinds.includes('DYNAMIC_OPERATOR'),
    ).toBe(false);
    expect(() =>
      mandate({
        approvalPolicy: {
          ...mandate().approvalPolicy,
          eligibleKinds: ['MERA_HUMAN', 'DYNAMIC_OPERATOR'],
        },
      }),
    ).toThrow();
    const asOperator = (await approve(h, draft, [0]))[0]!;
    expect(
      await submit(h, input, [{ ...asOperator, signer: OPERATOR }, human[0]]),
    ).toMatchObject({ code: 'PRINCIPAL_KIND_INELIGIBLE' });
  });

  it('LOCAL_FIXTURE approvals are eligible only on local/anvil', async () => {
    const testnet = {
      profile: 'sandbox/monad-testnet',
      chainId: 10143,
      providerEnvironment: 'sandbox',
    } as const;
    const testnetAsset = {
      ...asset,
      chainId: 10143 as const,
      canonicalAssetId: `eip155:10143/erc20:${asset.address}`,
    };
    const policy = mandate({ network: testnet, inputAsset: testnetAsset });
    const input = evidence(intent({ chainId: 10143 }), {
      evidence: [
        {
          source: 'testnet-reference',
          retrievedAt: now,
          chainId: 10143,
          artifactHash: hash(9),
          untrusted: false,
        },
      ],
    });
    const h = harness(input, [policy], {
      network: testnet,
      plugins: [
        {
          ...manifest,
          chains: [10143],
          environments: ['sandbox/monad-testnet'],
        },
      ],
      balances: [{ account: ACCOUNT, asset: testnetAsset, balance: '10000' }],
    });
    h.probe.observation = { ...h.probe.observation, chainId: 10143 };
    const draft = await pending(h, input);
    expect(draft.domain.chainId).toBe(10143);
    expect(
      await submit(h, input, await approve(h, draft, [0, 1])),
    ).toMatchObject({ code: 'PRINCIPAL_KIND_INELIGIBLE' });
    expect(
      await submit(
        h,
        input,
        await approve(h, draft, [0, 1], { kind: 'MERA_HUMAN' }),
      ),
    ).toMatchObject({ status: 'AUTHORIZED' });
    void nativeAsset;
  });

  it('approvals must sign exactly the recomputed draft digest (AUSD-006)', async () => {
    const input = evidence(intent());
    const other = evidence(intent({ maxInputAmount: '61' }));
    const h = harness([input, other]);
    const draft = await pending(h, input);
    const otherDraft = await pending(h, other);
    expect(otherDraft.digest).not.toBe(draft.digest);
    expect(await submit(h, other, await approve(h, draft))).toMatchObject({
      code: 'APPROVAL_DRAFT_MISMATCH',
    });
    const relabelled = (await approve(h, draft)).map((a) => ({
      ...a,
      draftDigest: otherDraft.digest,
    }));
    for (const a of relabelled) h.ledger.consumed.delete(a.approvalId);
    expect(await submit(h, other, relabelled)).toMatchObject({
      code: 'APPROVAL_SIGNATURE_INVALID',
    });
  });

  it('the draft is deterministic for the same intent, mandate, profile and evidence', async () => {
    const input = evidence(intent());
    const a = await pending(harness(input), input);
    const b = await pending(harness(input), input);
    expect(a).toEqual(b);
  });

  it('signatures must recover to the member signer, be canonical, and members must be active owners', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = await pending(h, input);
    const wrongKey = await approve(h, draft, [0], {
      signerOverride: owners[2],
    });
    const good = await approve(h, draft, [1]);
    expect(await submit(h, input, [...wrongKey, ...good])).toMatchObject({
      code: 'APPROVAL_SIGNATURE_INVALID',
    });
    const [base] = await approve(h, draft, [0]);
    const sig = base!.signature;
    const s = BigInt(`0x${sig.slice(66, 130)}`);
    const v = Number.parseInt(sig.slice(130), 16);
    const malleated =
      `${sig.slice(0, 66)}${(N - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}` as `0x${string}`;
    expect(canonicalSignature(sig)).toBe(true);
    expect(canonicalSignature(malleated)).toBe(false);
    const high = { ...base!, signature: malleated } as VerifiedApproval;
    expect(await submit(h, input, [high, ...good])).toMatchObject({
      code: 'APPROVAL_SIGNATURE_INVALID',
    });
    const [stranger] = await approve(h, draft, [0], {
      signerOverride: outsider,
    });
    expect(
      await submit(h, input, [
        { ...stranger!, signer: outsider.address.toLowerCase() },
        ...good,
      ]),
    ).toMatchObject({ code: 'APPROVER_NOT_MEMBER' });
    const inactive = harness(input, [
      mandate({
        members: mandate().members.map((m, i) => ({ ...m, active: i !== 0 })),
      }),
    ]);
    const d2 = await pending(inactive, input);
    expect(
      await submit(inactive, input, await approve(inactive, d2, [0, 1])),
    ).toMatchObject({ code: 'APPROVER_NOT_MEMBER' });
  });

  it('members, signers, principals and challenges are counted once', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = await pending(h, input);
    const [a] = await approve(h, draft, [0]);
    expect(await submit(h, input, [a, a])).toMatchObject({
      code: 'DUPLICATE_APPROVER',
    });
    const [b] = await approve(h, draft, [1]);
    const samePrincipal = { ...b!, principalId: a!.principalId };
    expect(await submit(h, input, [a, samePrincipal])).toMatchObject({
      code: 'DUPLICATE_APPROVER',
    });
    expect(await submit(h, input, [a, b])).toMatchObject({
      status: 'AUTHORIZED',
    });
  });

  it('an approval ledger failure fails closed', async () => {
    const input = evidence(intent());
    const h = harness(input);
    const draft = await pending(h, input);
    const approvals = await approve(h, draft);
    h.ledger.isConsumed = async () => {
      throw new Error('ledger down');
    };
    expect(await submit(h, input, approvals)).toMatchObject({
      code: 'APPROVAL_NOT_CONSUMED',
    });
  });
});

describe('identity directory port: membership epoch and owner status (ADR-0011 §4–5)', () => {
  it('an approval from an older membership epoch, a non-owner or an operator role never counts', async () => {
    const input = evidence(intent());
    for (const patch of [
      { membershipEpoch: 2 },
      { ownerOfAccount: false },
      { role: 'OPERATOR' as const },
      { principalId: 'someone_else' },
    ]) {
      const h = harness(input);
      const draft = await pending(h, input);
      const approvals = await approve(h, draft);
      h.directory.members.set('member_0', {
        ...h.directory.members.get('member_0')!,
        ...patch,
      });
      expect(await submit(h, input, approvals)).toMatchObject({
        status: 'PENDING_APPROVAL',
        code:
          'membershipEpoch' in patch
            ? 'APPROVAL_EPOCH_STALE'
            : 'APPROVER_NOT_MEMBER',
      });
    }
    const gone = harness(input);
    const draft = await pending(gone, input);
    const approvals = await approve(gone, draft);
    gone.directory.members.delete('member_1');
    expect(await submit(gone, input, approvals)).toMatchObject({
      code: 'APPROVER_NOT_MEMBER',
    });
  });
});

describe('PRIVY_DELEGATE delegation (amount, frequency, expiry, revocation) through the DelegationEvaluator port', () => {
  const scope = {
    actions: ['TRANSFER'],
    maxInputPerAction: '70',
    maxNativePerAction: '0',
    periodSeconds: 3600,
    maxUsesPerPeriod: 1,
  };
  const delegatedMandate = mandate({
    approvalPolicy: {
      ...mandate().approvalPolicy,
      eligibleKinds: ['LOCAL_FIXTURE', 'PRIVY_DELEGATE'],
    },
    delegationScope: scope,
  });
  const policy = (overrides: Partial<FixtureDelegation> = {}) => ({
    policyId: 'delegation_1',
    memberId: 'member_1',
    principalId: 'principal_1',
    signer: owners[1]!.address.toLowerCase(),
    actions: ['TRANSFER'],
    maxAmountPerExecution: '65',
    periodSeconds: 3600,
    maxExecutionsPerPeriod: 5,
    validAfter: 900,
    validUntil: 1900,
    revokedAt: null,
    ...overrides,
  });
  async function delegatedRequest(h: Harness, input: Prepared) {
    const draft = await pending(h, input);
    return submit(h, input, [
      ...(await approve(h, draft, [0])),
      ...(await approve(h, draft, [1], { kind: 'PRIVY_DELEGATE' })),
    ]);
  }
  it('delegated approvals count only inside an evaluated delegation and the mandate scope', async () => {
    const input = evidence(intent());
    const none = harness(input, [delegatedMandate]);
    expect(await delegatedRequest(none, input)).toMatchObject({
      code: 'DELEGATION_SCOPE',
    });
    const h = harness(input, [delegatedMandate], {
      delegations: new FixtureDelegations([policy()]),
    });
    expect(await delegatedRequest(h, input)).toMatchObject({
      status: 'AUTHORIZED',
    });
    expect(h.kernel.snapshot().delegations).toEqual([
      ['delegation_1', [{ amount: '60', at: now }]],
    ]);
    const again = evidence(intent({ nonce: '2' }));
    const frequent = harness([input, again], [delegatedMandate], {
      delegations: new FixtureDelegations([policy()]),
    });
    await delegatedRequest(frequent, input);
    expect(await delegatedRequest(frequent, again)).toMatchObject({
      code: 'DELEGATION_SCOPE',
    });
  });
  it.each([
    ['amount', { maxAmountPerExecution: '59' }],
    ['expiry', { validUntil: 1000 }],
    ['revocation', { revokedAt: 950 }],
    ['action', { actions: ['SPOT_TRADE'] }],
    ['frequency', { maxExecutionsPerPeriod: 0 }],
  ])('rejects delegated approval outside %s', async (_name, patch) => {
    const input = evidence(intent());
    const h = harness(input, [delegatedMandate], {
      delegations: new FixtureDelegations([policy(patch)]),
    });
    expect(await delegatedRequest(h, input)).toMatchObject({
      code: 'DELEGATION_SCOPE',
    });
  });
  it('an evaluator failure fails closed and the mandate scope caps every delegation', async () => {
    const input = evidence(intent());
    const broken = harness(input, [delegatedMandate], {
      delegations: {
        evaluate: () => {
          throw new Error('identity down');
        },
      },
    });
    expect(await delegatedRequest(broken, input)).toMatchObject({
      code: 'DELEGATION_SCOPE',
    });
    const over = evidence(intent({ maxInputAmount: '71' }));
    const o = harness(over, [delegatedMandate], {
      delegations: new FixtureDelegations([
        policy({ maxAmountPerExecution: '100' }),
      ]),
    });
    expect(await delegatedRequest(o, over)).toMatchObject({
      code: 'DELEGATION_SCOPE',
    });
  });
});
