import { describe, it, expect } from 'vitest';
import { PrincipalRegistry } from '../../packages/identity/src/index.js';
import { executionGrantTypedData } from '../../packages/schemas/src/index.js';
import { LocalApprovalDesk } from '../../apps/demo/src/approval-desk.js';
import {
  evidence,
  expectDraft,
  harness,
  intent,
  now,
  owners,
} from '../kernel/fixtures.js';

function registry() {
  const r = new PrincipalRegistry('local/anvil', () =>
    owners.map((o) => o.address),
  );
  owners.forEach((owner, i) => {
    r.register({
      principalId: `principal_${i}`,
      kind: 'HUMAN',
      provider: 'fixture',
      signer: owner.address,
    });
    r.bindMembership('group_1', `member_${i}`, `principal_${i}`);
  });
  return r;
}

describe('principal registry as the Kernel membership directory (fixture wallets, not real Mera humans)', () => {
  it('reports principal kind, owner status and a membership epoch that changes on revocation', async () => {
    const r = registry();
    const member = await r.activeMember('group_1', 'member_0');
    expect(member).toMatchObject({
      principalKind: 'LOCAL_FIXTURE',
      role: 'APPROVER',
      ownerOfAccount: true,
      signer: owners[0]!.address.toLowerCase(),
    });
    const epoch = member!.membershipEpoch;
    r.revokeMembership('group_1', 'member_2');
    expect(
      (await r.activeMember('group_1', 'member_0'))!.membershipEpoch,
    ).not.toBe(epoch);
    expect(await r.activeMember('group_1', 'member_2')).toBeNull();
  });

  it('end to end: desk approvals count in the Kernel and are invalidated by a later membership change', async () => {
    const input = evidence(intent());
    const r = registry();
    const desk = new LocalApprovalDesk(r);
    const h = harness(input, undefined, {
      approvalLedger: desk,
      membershipDirectory: r,
    });
    const draft = expectDraft(
      await h.kernel.authorize({ ...input, approvals: [] }),
    );
    const approve = async (i: number) => {
      const c = await desk.issue(draft, `member_${i}`, now);
      return desk.submit(
        c.challengeId,
        await owners[i]!.signTypedData(
          executionGrantTypedData(draft.domain, draft.grant),
        ),
        now,
      );
    };
    const approvals = [
      await approve(0),
      { ...(await approve(1)), approvalId: 'approval_unconsumed' },
    ];
    expect(await h.kernel.authorize({ ...input, approvals })).toMatchObject({
      code: 'APPROVAL_NOT_CONSUMED',
    });
    const fresh = [approvals[0]!, await approve(1)];
    r.revokeMembership('group_1', 'member_2');
    expect(
      await h.kernel.authorize({ ...input, approvals: fresh }),
    ).toMatchObject({
      code: 'APPROVAL_EPOCH_STALE',
    });
    const again = [await approve(0), await approve(1)];
    expect(
      (await h.kernel.authorize({ ...input, approvals: again })).status,
    ).toBe('AUTHORIZED');
  });

  it('rejects wrong wallets and replayed challenges', async () => {
    const input = evidence(intent());
    const desk = new LocalApprovalDesk(registry());
    const draft = expectDraft(
      await harness(input).kernel.authorize({ ...input, approvals: [] }),
    );
    const c = await desk.issue(draft, 'member_0', now);
    const typed = executionGrantTypedData(draft.domain, draft.grant);
    await expect(
      desk.submit(c.challengeId, await owners[1]!.signTypedData(typed), now),
    ).rejects.toThrow('LOCAL_DESK_SIGNATURE_INVALID');
    await desk.submit(
      c.challengeId,
      await owners[0]!.signTypedData(typed),
      now,
    );
    await expect(
      desk.submit(c.challengeId, await owners[0]!.signTypedData(typed), now),
    ).rejects.toThrow('LOCAL_DESK_CHALLENGE_INVALID');
  });

  it('prevents duplicate signers/memberships, provider impersonation and operator owner privileges', () => {
    const r = registry();
    expect(() =>
      r.register({
        principalId: 'another',
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owners[0]!.address,
      }),
    ).toThrow('Duplicate');
    expect(() => r.bindMembership('group_1', 'alias', 'principal_0')).toThrow(
      'Duplicate',
    );
    expect(() =>
      new PrincipalRegistry('sandbox/monad-testnet').register({
        principalId: 'test',
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owners[0]!.address,
      }),
    ).toThrow('Fixture');
    r.register({
      principalId: 'operator',
      kind: 'AGENT',
      provider: 'dynamic',
      signer: '0x0000000000000000000000000000000000000099',
      environmentId: 'test',
    });
    expect(() =>
      r.bindMembership('group_1', 'operator_member', 'operator'),
    ).toThrow('human');
  });
});
