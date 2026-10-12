import { createHash, randomBytes } from 'node:crypto';
import { verifyTypedData, type Hex } from 'viem';
import type { MembershipDirectory } from '@synq/schemas';
import {
  SendAccessChallengeSchema,
  sendAccessTypedData,
  type SendAccessChallenge,
} from '@synq/identity/server';
import type { SendGroupContext } from './send-routes.js';
import {
  DevelopmentSendAccessStore,
  type SendAccessStore,
} from './send-access-store.js';

export function createSendMemberAccess(input: {
  directory: MembershipDirectory;
  context(groupId: string): Promise<SendGroupContext | null>;
  now(): number;
  store?: SendAccessStore;
}) {
  const store = input.store ?? new DevelopmentSendAccessStore();
  const hash = (token: string) =>
    createHash('sha256').update(token).digest('hex');
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
  async function session(token: string, groupId: string) {
    await store.prune(input.now());
    const stored = await store.session(hash(token));
    return !!stored &&
      stored.expiresAt > input.now() &&
      stored.challenge.groupId === groupId.toLowerCase() &&
      (await current(stored.challenge))
      ? {
          groupId: stored.challenge.groupId,
          memberId: stored.challenge.memberId,
          principalId: stored.challenge.principalId,
          signer: stored.challenge.signer,
          scope: stored.challenge.scope,
        }
      : null;
  }
  return {
    async challenge(
      groupId: string,
      principalId: string,
      scope: SendAccessChallenge['scope'] = 'SEND_READ_PREVIEW',
    ) {
      await store.prune(input.now());
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
        scope,
        issuedAt: now,
        expiresAt: now + 120,
      });
      return store.createChallenge(c);
    },
    async issue(challengeId: string, signature: Hex) {
      await store.prune(input.now());
      const c = await store.challenge(challengeId);
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
      if (
        !valid ||
        c.expiresAt <= input.now() ||
        !(await store.consumeChallenge(challengeId))
      )
        return null;
      const token = randomBytes(32).toString('base64url');
      const expiresAt = input.now() + 300;
      await store.saveSession(hash(token), { challenge: c, expiresAt });
      return {
        token,
        expiresAt,
        memberId: c.memberId,
        principalId: c.principalId,
        groupId: c.groupId,
        scope: c.scope,
      };
    },
    verify: async (token: string, groupId: string) =>
      (await session(token, groupId)) !== null,
    session,
  };
}
