import { describe, expect, it } from 'vitest';
import type {
  ApprovalLedger,
  DelegationPolicy,
  GrantDraft,
} from '@synq/schemas';
import type {
  DelegationEvaluator,
  MembershipDirectory,
} from '../../packages/kernel/src/index.js';
import {
  DelegationService,
  GrantApprovalGateway,
  MembershipService,
  MemoryIdentityStore,
  PrincipalService,
  StoreApprovalLedger,
  StoreDelegationEvaluator,
  StoreMembershipDirectory,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantTypedData,
  identityChallengeTypedData,
} from '../../packages/identity/src/server.js';
import {
  ACCOUNT,
  CHAIN_GROUP,
  MODULE,
  OPERATOR,
  RECIPIENT,
  asset,
  evidence,
  harness,
  intent,
  mandate,
  outsider,
  owners,
} from '../kernel/fixtures.js';

type Key = (typeof owners)[number];

async function setup() {
  const store = new MemoryIdentityStore();
  const directory: MembershipDirectory = new StoreMembershipDirectory(store);
  const ledger: ApprovalLedger = new StoreApprovalLedger(store);
  const delegations: DelegationEvaluator = new StoreDelegationEvaluator(store);
  const input = evidence(intent());
  const h = harness(input, [mandate()], {
    membershipDirectory: directory,
    approvalLedger: ledger,
    delegations,
  });
  const config = {
    profile: 'local/anvil' as const,
    rpId: 'localhost',
    origin: 'http://localhost',
    now: () => h.clock.now(),
  };
  const principals = new PrincipalService(store, config);
  const membership = new MembershipService(store, config);
  const gateway = new GrantApprovalGateway(store, config, {
    executionModules: { 31337: MODULE },
    localAssets: [asset],
  });
  const delegation = new DelegationService(store, config);
  const enroll = async (key: Key, kind: 'LOCAL_FIXTURE' | 'PRIVY_DELEGATE') => {
    const c = await principals.issueEnrollmentChallenge({
      kind,
      signer: key.address,
      rpId: config.rpId,
      origin: config.origin,
      ...(kind === 'PRIVY_DELEGATE' ? { providerRef: 'privy-wallet' } : {}),
    });
    return principals.enroll({
      challengeId: c.challengeId,
      signature: await key.signTypedData(identityChallengeTypedData(c)),
    });
  };
  const ids: string[] = [];
  for (const owner of owners)
    ids.push((await enroll(owner, 'LOCAL_FIXTURE')).principalId);
  await membership.createGroup({
    groupId: 'group_1',
    chainGroupId: CHAIN_GROUP,
    chainId: 31337,
    account: ACCOUNT,
    owners: owners.map((o) => o.address),
    threshold: 2,
    executors: [OPERATOR],
  });
  for (const [i, owner] of owners.entries()) {
    const c = await membership.issueJoinChallenge({
      groupId: 'group_1',
      memberId: `member_${i}`,
      principalId: ids[i]!,
    });
    await membership.join({
      groupId: 'group_1',
      challengeId: c.challengeId,
      signature: await owner.signTypedData(identityChallengeTypedData(c)),
    });
  }
  const approve = async (i: number, draft: GrantDraft) => {
    const key = owners[i]!;
    const request = {
      principalId: ids[i]!,
      memberId: `member_${i}`,
      requestedAt: h.clock.now(),
    };
    const challenge = await gateway.issueChallenge({
      ...request,
      draftDigest: draft.digest,
      requestSignature: await key.signTypedData(
        challengeRequestTypedData(draft, request),
      ),
    });
    return gateway.submit({
      challengeId: challenge.challengeId,
      grantSignature: await key.signTypedData(grantTypedData(draft)),
      attestationSignature: await key.signTypedData(
        approvalAttestationTypedData(draft, challenge),
      ),
    });
  };
  return { store, h, input, gateway, membership, delegation, enroll, approve };
}

describe('identity ports wired into the real Kernel (fixture wallets, not real Mera humans)', () => {
  it('the Kernel authorizes a grant only with approvals issued, attested and consumed by the identity gateway', async () => {
    const { h, input, gateway, approve } = await setup();
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    expect(pending.status).toBe('PENDING_APPROVAL');
    const draft = (pending as { draft: GrantDraft }).draft;
    const view = await gateway.registerDraft({ draft, asset });
    expect(view.preview.verifyingContract).toBe(MODULE);
    const first = await approve(0, draft);
    const partial = await h.kernel.authorize({ ...input, approvals: [first] });
    expect(partial.status).toBe('PENDING_APPROVAL');
    const second = await approve(1, draft);
    const decision = await h.kernel.authorize({
      ...input,
      approvals: [first, second],
    });
    expect(decision.status).toBe('AUTHORIZED');
    const forged = { ...second, approvalId: 'not-consumed' };
    const replay = await h.kernel.authorize({
      ...evidence(intent({ nonce: '2', intentId: 'intent_2' })),
      approvals: [first, forged],
    });
    expect(replay.status).not.toBe('AUTHORIZED');
  });

  it('an approver-set change after approval makes the Kernel reject the stale approvals and invalidates the draft', async () => {
    const { h, input, gateway, membership, approve } = await setup();
    const pending = await h.kernel.authorize({ ...input, approvals: [] });
    const draft = (pending as { draft: GrantDraft }).draft;
    await gateway.registerDraft({ draft, asset });
    const approvals = [await approve(0, draft), await approve(1, draft)];
    await membership.revoke({ groupId: 'group_1', memberId: 'member_2' });
    const decision = await h.kernel.authorize({ ...input, approvals });
    expect(decision.status).toBe('PENDING_APPROVAL');
    expect(
      (
        decision as { rejectedApprovals: { code: string }[] }
      ).rejectedApprovals.map((r) => r.code),
    ).toEqual(['APPROVAL_EPOCH_STALE', 'APPROVAL_EPOCH_STALE']);
    expect((await gateway.quorum(draft.digest)).draftStatus).toBe(
      'INVALIDATED',
    );
  });

  it('the delegation evaluator applies the Synq DelegationPolicy for a live delegator only', async () => {
    const { h, delegation, membership, enroll } = await setup();
    const delegate = await enroll(outsider, 'PRIVY_DELEGATE');
    const policy: DelegationPolicy = {
      schemaVersion: 1,
      policyId: 'weekly',
      groupId: 'group_1' as DelegationPolicy['groupId'],
      delegatePrincipalId: delegate.principalId,
      delegatorMemberId: 'member_0' as DelegationPolicy['delegatorMemberId'],
      asset,
      recipient: RECIPIENT,
      maxAmountPerPeriod: '100',
      maxAmountPerExecution: '60',
      periodSeconds: 3600,
      maxExecutionsPerPeriod: 1,
      minIntervalSeconds: 0,
      validAfter: 900,
      validUntil: 5000,
      revokedAt: null,
    };
    await delegation.createPolicy(policy);
    const evaluator = new StoreDelegationEvaluator(delegation.store);
    const request = {
      groupId: 'group_1',
      mandateId: 'mandate_1',
      memberId: 'member_0',
      principalId: delegate.principalId,
      signer: outsider.address,
      action: 'TRANSFER',
      token: asset.address,
      chainId: 31337,
      recipient: RECIPIENT,
      amount: '60',
      nativeValue: '0',
      at: h.clock.now(),
    };
    expect(await evaluator.evaluate(request, () => [])).toEqual({
      allowed: true,
      policyId: 'weekly',
    });
    expect(
      await evaluator.evaluate(request, () => [{ amount: '60', at: 990 }]),
    ).toEqual({ allowed: false, reason: 'FREQUENCY_EXCEEDED' });
    expect(
      await evaluator.evaluate({ ...request, amount: '61' }, () => []),
    ).toEqual({ allowed: false, reason: 'PER_EXECUTION_CAP_EXCEEDED' });
    expect(
      await evaluator.evaluate({ ...request, nativeValue: '1' }, () => []),
    ).toEqual({ allowed: false, reason: 'ACTION_NOT_DELEGATED' });
    await membership.revoke({ groupId: 'group_1', memberId: 'member_0' });
    expect((await evaluator.evaluate(request, () => [])).allowed).toBe(false);
  });
});
