import { describe, it, expect } from 'vitest';
import {
  ApprovalService,
  MemoryChallengeStore,
} from '../../packages/identity/src/index.js';
import {
  ApprovalCalculator,
  approvalTypedData,
} from '../../packages/kernel/src/index.js';
import { intent, mandate, owners, now } from '../kernel/fixtures.js';

function service() {
  const s = new ApprovalService(new MemoryChallengeStore(), 'local/anvil');
  owners.forEach((owner, i) => {
    s.register({
      principalId: `fixture_${i}`,
      kind: 'HUMAN',
      provider: 'fixture',
      signer: owner.address,
    });
    s.bindMembership('group_1', `member_${i}`, `fixture_${i}`);
  });
  return s;
}
describe('cryptographic approval attribution (fixture wallets, not real Mera humans)', () => {
  it('invalidates an outstanding challenge across membership revocation and rejoin', async () => {
    const s = service(),
      input = intent(),
      policy = mandate();
    const c = await s.issue(input, policy, 'member_0', now);
    const signed = {
      ...c.approval,
      signature: await owners[0]!.signTypedData(
        approvalTypedData(input, c.approval),
      ),
    };
    s.revokeMembership(input.groupId, 'member_0');
    s.bindMembership(input.groupId, 'member_0', 'fixture_0');
    await expect(
      s.submit(c.challengeId, signed, input, policy, now),
    ).rejects.toThrow('Membership binding');
  });
  it('rejects revocation during asynchronous consumption and a fresh binding after service restart', async () => {
    class RevokingStore extends MemoryChallengeStore {
      revoke = () => {};
      override async consume(id: string): Promise<boolean> {
        this.revoke();
        return super.consume(id);
      }
    }
    const store = new RevokingStore(),
      s = new ApprovalService(store, 'local/anvil');
    s.register({
      principalId: 'fixture_0',
      kind: 'HUMAN',
      provider: 'fixture',
      signer: owners[0]!.address,
    });
    s.bindMembership('group_1', 'member_0', 'fixture_0');
    const c = await s.issue(intent(), mandate(), 'member_0', now);
    const signed = {
      ...c.approval,
      signature: await owners[0]!.signTypedData(
        approvalTypedData(intent(), c.approval),
      ),
    };
    const restarted = new ApprovalService(store, 'local/anvil');
    restarted.register({
      principalId: 'fixture_0',
      kind: 'HUMAN',
      provider: 'fixture',
      signer: owners[0]!.address,
    });
    restarted.bindMembership('group_1', 'member_0', 'fixture_0');
    await expect(
      restarted.submit(c.challengeId, signed, intent(), mandate(), now),
    ).rejects.toThrow('Membership binding');
    store.revoke = () => s.revokeMembership('group_1', 'member_0');
    await expect(
      s.submit(c.challengeId, signed, intent(), mandate(), now),
    ).rejects.toThrow('Membership binding');
  });
  it('collects independently signed 2-of-3 and a repeated signer cannot satisfy quorum', async () => {
    const s = service(),
      input = intent(),
      policy = mandate();
    const approvals = await Promise.all(
      [0, 1].map(async (i) => {
        const c = await s.issue(input, policy, `member_${i}`, now);
        return s.submit(
          c.challengeId,
          {
            ...c.approval,
            signature: await owners[i]!.signTypedData(
              approvalTypedData(input, c.approval),
            ),
          },
          input,
          policy,
          now,
        );
      }),
    );
    await expect(
      new ApprovalCalculator().verify(
        input,
        policy,
        approvals,
        'CONSENSUS',
        now,
      ),
    ).resolves.toBe(2);
    await expect(
      new ApprovalCalculator().verify(
        input,
        policy,
        [approvals[0]!, approvals[0]!],
        'CONSENSUS',
        now,
      ),
    ).rejects.toThrow();
    await expect(
      new ApprovalCalculator().verify(
        input,
        mandate({ quorum: 3 }),
        approvals,
        'CONSENSUS',
        now,
      ),
    ).rejects.toThrow();
    const revoked = mandate({
      members: policy.members.map((member, i) => ({
        ...member,
        active: i !== 0,
      })),
    });
    await expect(
      new ApprovalCalculator().verify(
        input,
        revoked,
        approvals,
        'CONSENSUS',
        now,
      ),
    ).rejects.toThrow();
  });
  it('rejects expired, wrong wallet, wrong group, mutated amount and revoked member', async () => {
    const s = service(),
      input = intent(),
      policy = mandate(),
      c = await s.issue(input, policy, 'member_0', now, 10);
    const signed = {
      ...c.approval,
      signature: await owners[0]!.signTypedData(
        approvalTypedData(input, c.approval),
      ),
    };
    await expect(
      s.submit(c.challengeId, signed, input, policy, now + 10),
    ).rejects.toThrow('Expired');
    await expect(
      s.submit(
        c.challengeId,
        {
          ...signed,
          signature: await owners[1]!.signTypedData(
            approvalTypedData(input, c.approval),
          ),
        },
        input,
        policy,
        now,
      ),
    ).rejects.toThrow('Signature');
    await expect(
      s.submit(
        c.challengeId,
        signed,
        intent({ groupId: 'group_wrong' }),
        policy,
        now,
      ),
    ).rejects.toThrow('Wrong');
    await expect(
      s.submit(
        c.challengeId,
        signed,
        intent({ maxInputAmount: '61' }),
        policy,
        now,
      ),
    ).rejects.toThrow('binding');
    s.revokeMembership(input.groupId, 'member_0');
    await expect(
      s.submit(c.challengeId, signed, input, policy, now),
    ).rejects.toThrow('membership');
  });
  it('consumes a challenge atomically including concurrent submits and rejects replay after success', async () => {
    const s = service(),
      input = intent(),
      policy = mandate(),
      c = await s.issue(input, policy, 'member_0', now);
    const signed = {
      ...c.approval,
      signature: await owners[0]!.signTypedData(
        approvalTypedData(input, c.approval),
      ),
    };
    const results = await Promise.allSettled([
      s.submit(c.challengeId, signed, input, policy, now),
      s.submit(c.challengeId, signed, input, policy, now),
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await expect(
      s.submit(c.challengeId, signed, input, policy, now),
    ).rejects.toThrow('consumed');
  });
  it('prevents duplicate signers/memberships, provider impersonation and operator owner privileges', () => {
    const s = service();
    expect(() =>
      s.register({
        principalId: 'another',
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owners[0]!.address,
      }),
    ).toThrow('Duplicate');
    expect(() => s.bindMembership('group_1', 'alias', 'fixture_0')).toThrow(
      'Duplicate',
    );
    expect(() =>
      new ApprovalService(new MemoryChallengeStore()).register({
        principalId: 'test',
        kind: 'HUMAN',
        provider: 'fixture',
        signer: owners[0]!.address,
      }),
    ).toThrow('Fixture');
    s.register({
      principalId: 'operator',
      kind: 'AGENT',
      provider: 'dynamic',
      signer: '0x0000000000000000000000000000000000000099',
      environmentId: 'test',
    });
    expect(() =>
      s.bindMembership('group_1', 'operator_member', 'operator'),
    ).toThrow('human');
  });
});
