import { createHash, randomBytes } from 'node:crypto';
import { verifyTypedData, type Hex } from 'viem';
import type { MembershipDirectory } from '@synq/schemas';
import {
  SendAccessChallengeSchema,
  sendAccessTypedData,
  type SendAccessChallenge,
} from '@synq/identity/server';
import type { SendGroupContext } from './send-routes.js';

export function createSendMemberAccess(input: {
  directory: MembershipDirectory;
  context(groupId: string): Promise<SendGroupContext | null>;
  now(): number;
}) {
  const challenges = new Map<string, SendAccessChallenge>();
  const sessions = new Map<
    string,
    { challenge: SendAccessChallenge; expiresAt: number }
  >();
  const hash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  function prune() {
    const now = input.now();
    for (const [id, c] of challenges)
      if (c.expiresAt <= now) challenges.delete(id);
    for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
  }
  async function current(c: SendAccessChallenge) {
    const member = await input.directory.activeMember(c.groupId, c.memberId);
    const context = await input.context(c.groupId);
    return (
      !!member &&
      member.principalKind === 'MERA_HUMAN' &&
      member.principalId === c.principalId &&
      member.signer.toLowerCase() === c.signer &&
      member.membershipEpoch === c.membershipEpoch &&
      context?.mandate.account === c.account &&
      context.mandate.network.chainId === c.chainId
    );
  }
  return {
    async challenge(groupId: string, principalId: string) {
      prune();
      const context = await input.context(groupId);
      const m = context?.members.find((m) => m.principalId === principalId);
      const member = m
        ? await input.directory.activeMember(groupId, m.memberId)
        : null;
      if (
        !context ||
        !member ||
        member.principalKind !== 'MERA_HUMAN' ||
        member.principalId !== principalId
      )
        return null;
      const now = input.now();
      const c = SendAccessChallengeSchema.parse({
        challengeId: `0x${randomBytes(32).toString('hex')}`,
        groupId,
        memberId: member.memberId,
        principalId,
        signer: member.signer,
        membershipEpoch: member.membershipEpoch,
        chainId: context.mandate.network.chainId,
        account: context.mandate.account,
        scope: 'SEND_READ_PREVIEW',
        issuedAt: now,
        expiresAt: now + 120,
      });
      // One outstanding challenge per member bounds unauthenticated growth.
      for (const [id, o] of challenges)
        if (o.groupId === c.groupId && o.memberId === c.memberId)
          challenges.delete(id);
      challenges.set(c.challengeId, c);
      return c;
    },
    async issue(challengeId: string, signature: Hex) {
      prune();
      const c = challenges.get(challengeId);
      if (!c || !(await current(c))) return null;
      let valid = false;
      try {
        valid = await verifyTypedData({
          ...sendAccessTypedData(c),
          address: c.signer,
          signature,
        });
      } catch {
        return null;
      }
      if (!valid || challenges.get(challengeId) !== c) return null;
      challenges.delete(challengeId);
      const token = randomBytes(32).toString('base64url');
      const expiresAt = input.now() + 300;
      sessions.set(hash(token), { challenge: c, expiresAt });
      return {
        token,
        expiresAt,
        memberId: c.memberId,
        principalId: c.principalId,
        groupId: c.groupId,
        scope: c.scope,
      };
    },
    async verify(token: string, groupId: string) {
      prune();
      const session = sessions.get(hash(token));
      return (
        !!session &&
        session.challenge.groupId === groupId.toLowerCase() &&
        (await current(session.challenge))
      );
    },
  };
}
