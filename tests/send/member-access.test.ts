import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import {
  MemoryIdentityStore,
  PrincipalService,
  MembershipService,
  StoreMembershipDirectory,
} from '@synq/identity/server';
import {
  enrollMeraPrincipal,
  signMeraIdentityChallenge,
  signMeraSendAccess,
} from '@synq/identity/mera-browser';
import {
  MemorySendStore,
  newSendRecord,
  type SendPreview,
} from '@synq/funding';
import { createSendMemberAccess } from '../../apps/api/src/send-access.js';
import {
  sendRoutes,
  type SendRouteDeps,
} from '../../apps/api/src/send-routes.js';
import {
  DeterministicAuthenticator,
  fixtureAccounts,
  word,
  addr,
} from '../identity/fixtures.js';
import { sandboxMandate } from '../api/kernel-fixture.js';

describe('Mera-scoped Send member reads and previews (SIMULATION)', () => {
  it('signs through verified P05 enrollment/join and never grants worker access; expiry/epoch/revocation fail closed', async () => {
    let clock = 1000;
    const identity = new MemoryIdentityStore();
    const config = {
      profile: 'sandbox/monad-testnet' as const,
      rpId: 'synq.test',
      origin: 'https://synq.test',
      now: () => clock,
    };
    const principals = new PrincipalService(identity, config);
    const membership = new MembershipService(identity, config);
    const authenticator = new DeterministicAuthenticator('send-member-fixture');
    const enrolled = await enrollMeraPrincipal(
      {
        rpId: config.rpId,
        rpName: 'Synq',
        user: { name: 'alice', displayName: 'Alice' },
        requestChallenge: ({ signer, credential }) =>
          principals.issueEnrollmentChallenge({
            kind: 'MERA_HUMAN',
            signer,
            credential: {
              ...credential,
              transports: [...(credential.transports ?? [])],
            },
            rpId: config.rpId,
            origin: config.origin,
          }),
      },
      { webAuthnClient: authenticator },
    );
    await principals.enroll({
      challengeId: enrolled.challenge.challengeId,
      signature: enrolled.signature,
    });
    const groupId = word(801);
    const members = [
      { memberId: 'alice', signer: enrolled.record.signer },
      {
        memberId: 'bob',
        signer: fixtureAccounts[1]!.address.toLowerCase() as `0x${string}`,
      },
      {
        memberId: 'carol',
        signer: fixtureAccounts[2]!.address.toLowerCase() as `0x${string}`,
      },
    ];
    await membership.createGroup({
      groupId,
      chainGroupId: groupId,
      chainId: 10143,
      account: addr(802),
      owners: members.map((m) => m.signer),
      threshold: 2,
    });
    const join = await membership.issueJoinChallenge({
      groupId,
      memberId: 'alice',
      principalId: enrolled.record.principalId,
    });
    await membership.join({
      groupId,
      challengeId: join.challengeId,
      signature: await signMeraIdentityChallenge(enrolled.record, join, {
        webAuthnClient: authenticator,
      }),
    });
    const mandate = sandboxMandate(
      {
        groupId,
        chainGroupId: groupId,
        account: addr(802),
        executor: addr(803),
        recipient: addr(804),
        members,
      },
      clock,
    );
    const context = async (g: string) =>
      g === groupId
        ? {
            groupId,
            mandate,
            members: members.map((m) => ({
              ...m,
              principalId:
                m.memberId === 'alice'
                  ? enrolled.record.principalId
                  : `mera:${m.signer}`,
            })),
            contacts: [{ label: 'contact', address: addr(804) }],
          }
        : null;
    const access = createSendMemberAccess({
      directory: new StoreMembershipDirectory(identity),
      context,
      now: () => clock,
    });
    const store = new MemorySendStore();
    const deps: SendRouteDeps = {
      store,
      adminToken: 'serveronly'.repeat(8),
      now: () => clock,
      memberAccess: access,
      groups: { context },
      members: {
        activeSigner: async (g, m) =>
          (await new StoreMembershipDirectory(identity).activeMember(g, m))
            ?.signer ?? null,
      },
      treasury: { view: async () => ({ core: { free: '10000000' } }) as never },
      guard: {
        check: async ({ recipient, amount }) => ({
          status: 'PASS',
          chainId: 10143,
          token: mandate.inputAsset.address,
          account: mandate.account,
          recipient,
          amount: String(amount),
          blockNumber: '1',
          checks: [],
          reasons: [],
        }),
      },
      proposer: {
        propose: async () => {
          throw new Error('UNEXPECTED_ECONOMIC_PROPOSAL');
        },
      },
      kernel: {
        authorize: async () => {
          throw new Error('UNEXPECTED_KERNEL_AUTHORIZATION');
        },
      },
      drafts: {
        register: async () => ({}),
        verifiedApprovals: async () => ({ satisfied: false, counted: [] }),
      },
      index: {
        executed: async () => ({
          indexedThroughBlock: 0,
          transactionHash: null,
          recipient: null,
          tokenAmount: null,
        }),
      },
    };
    const api = Fastify();
    await api.register(sendRoutes, deps);
    await api.ready();
    try {
      const requestChallenge = async () => {
        const response = await api.inject({
          method: 'POST',
          url: '/v1/send/access/challenges',
          payload: { groupId, principalId: enrolled.record.principalId },
        });
        expect(response.statusCode).toBe(201);
        return response.json();
      };
      const challenge = await requestChallenge();
      const signature = await signMeraSendAccess(enrolled.record, challenge, {
        webAuthnClient: authenticator,
      });
      const issued = await api.inject({
        method: 'POST',
        url: '/v1/send/access',
        payload: { challengeId: challenge.challengeId, signature },
      });
      expect(issued.statusCode).toBe(201);
      const session = issued.json();
      expect(session).toMatchObject({
        memberId: 'alice',
        groupId,
        scope: 'SEND_READ_PREVIEW',
        expiresAt: clock + 300,
      });
      expect(session.token).not.toBe(deps.adminToken);
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/v1/send/access',
            payload: { challengeId: challenge.challengeId, signature },
          })
        ).statusCode,
      ).toBe(401);
      const headers = { authorization: `Bearer ${session.token}` };
      for (const url of [
        `/v1/groups/${groupId}/treasury`,
        `/v1/send/${groupId}/recipients`,
      ]) {
        expect((await api.inject({ method: 'GET', url })).statusCode).toBe(401);
        expect(
          (await api.inject({ method: 'GET', url, headers })).statusCode,
        ).toBe(200);
      }
      expect(
        (
          await api.inject({
            method: 'GET',
            url: `/v1/send/${word(899)}/recipients`,
            headers,
          })
        ).statusCode,
      ).toBe(401);
      const p = await api.inject({
        method: 'POST',
        url: '/v1/send/previews',
        headers,
        payload: { groupId, recipientId: `contact:${addr(804)}`, amount: '1' },
      });
      expect(p.statusCode).toBe(201);
      const preview = p.json() as SendPreview;
      const created = await store.createOnce(
        newSendRecord(preview, clock * 1000),
      );
      expect(
        (
          await api.inject({
            method: 'GET',
            url: `/v1/send/${created.record.sendId}`,
            headers,
          })
        ).statusCode,
      ).toBe(200);
      for (const route of ['authorize', 'execution', 'recover', 'reconcile'])
        expect(
          (
            await api.inject({
              method: 'POST',
              url: `/v1/send/${created.record.sendId}/${route}`,
              headers,
              payload: {},
            })
          ).statusCode,
        ).toBe(401);
      await identity.transaction((tx) =>
        tx.setGroupEpoch(groupId, challenge.membershipEpoch + 1),
      );
      expect(
        (
          await api.inject({
            method: 'GET',
            url: `/v1/send/${groupId}/recipients`,
            headers,
          })
        ).statusCode,
      ).toBe(401);
      const stale = await requestChallenge();
      const fresh = await requestChallenge();
      const proof = await signMeraSendAccess(enrolled.record, fresh, {
        webAuthnClient: authenticator,
      });
      // A newer challenge supersedes the outstanding one for the same member.
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/v1/send/access',
            payload: {
              challengeId: stale.challengeId,
              signature: await signMeraSendAccess(enrolled.record, stale, {
                webAuthnClient: authenticator,
              }),
            },
          })
        ).statusCode,
      ).toBe(401);
      await identity.transaction((tx) =>
        tx.revokeMembership(groupId, 'alice', clock),
      );
      expect(
        (
          await api.inject({
            method: 'POST',
            url: '/v1/send/access',
            payload: { challengeId: fresh.challengeId, signature: proof },
          })
        ).statusCode,
      ).toBe(401);
      clock += 301;
      expect(await access.verify(session.token, groupId)).toBe(false);
    } finally {
      await api.close();
    }
  });
});
