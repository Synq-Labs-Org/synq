import { describe, expect, it, beforeEach } from 'vitest';
import type { Asset, DelegationPolicy, GrantDraft } from '@synq/schemas';
import {
  DelegationService,
  GrantApprovalGateway,
  MembershipService,
  PrincipalService,
  StoreApprovalLedger,
  StoreMembershipDirectory,
  approvalAttestationTypedData,
  challengeRequestTypedData,
  grantPreview,
  grantTypedData,
  identityChallengeTypedData,
  type IdentityConfig,
  type IdentityStore,
} from '../../packages/identity/src/server.js';
import {
  approveGrantWithMera,
  enrollMeraPrincipal,
  recoverMeraPrincipal,
  signMeraIdentityChallenge,
  type MeraCredential,
} from '../../packages/identity/src/mera-browser.js';
import {
  DeterministicAuthenticator,
  addr,
  fixtureAccounts,
  makeDraft,
  testAusd,
  word,
} from './fixtures.js';

export type StoreHarness = {
  fresh(): Promise<IdentityStore>;
  reopen(): Promise<IdentityStore>;
};

const rpId = 'synq.test';
const origin = 'https://synq.test';
const groupId = word(0xa1);
const MODULE = addr(0x5151);
const account = addr(0xacc);

export function identityContract(label: string, harness: StoreHarness) {
  describe(label, () => {
    let clock = 1000;
    let store: IdentityStore;
    const config = (): IdentityConfig => ({
      profile: 'sandbox/monad-testnet',
      rpId,
      origin,
      challengeTtlSeconds: 120,
      now: () => clock,
    });
    const services = (s = store) => ({
      principals: new PrincipalService(s, config()),
      membership: new MembershipService(s, config()),
      approvals: new GrantApprovalGateway(s, config(), {
        executionModules: { 10143: MODULE },
      }),
      delegation: new DelegationService(s, config()),
    });
    beforeEach(async () => {
      clock = 1000;
      store = await harness.fresh();
    });

    async function enrollMera(secret: string, s = services()) {
      const auth = new DeterministicAuthenticator(secret);
      const result = await enrollMeraPrincipal(
        {
          rpId,
          rpName: 'Synq',
          user: { name: secret, displayName: secret },
          requestChallenge: ({ signer, credential }) =>
            s.principals.issueEnrollmentChallenge({
              kind: 'MERA_HUMAN',
              signer,
              credential: {
                ...credential,
                transports: [...(credential.transports ?? [])],
              },
              rpId,
              origin,
            }),
        },
        { webAuthnClient: auth },
      );
      const view = await s.principals.enroll({
        challengeId: result.challenge.challengeId,
        signature: result.signature,
      });
      return { auth, record: result.record, view };
    }
    type Human = Awaited<ReturnType<typeof enrollMera>>;

    async function join(h: Human, memberId: string, s = services()) {
      const challenge = await s.membership.issueJoinChallenge({
        groupId,
        memberId,
        principalId: h.record.principalId,
      });
      const signature = await signMeraIdentityChallenge(h.record, challenge, {
        webAuthnClient: h.auth,
      });
      return s.membership.join({
        groupId,
        challengeId: challenge.challengeId,
        signature,
      });
    }

    async function trio(threshold = 2) {
      const s = services();
      const humans = [
        await enrollMera('alice', s),
        await enrollMera('bob', s),
        await enrollMera('carol', s),
      ];
      await s.membership.createGroup({
        groupId,
        chainGroupId: groupId,
        chainId: 10143,
        account,
        owners: humans.map((h) => h.record.signer),
        threshold,
      });
      for (const [i, h] of humans.entries()) await join(h, `member_${i}`, s);
      return { s, humans };
    }

    async function approve(
      s: ReturnType<typeof services>,
      h: Human,
      memberId: string,
      draft: GrantDraft,
      asset: Asset = testAusd,
    ) {
      return approveGrantWithMera(
        {
          record: h.record as MeraCredential,
          memberId,
          draft,
          asset,
          confirmedPreview: grantPreview(draft, asset),
          requestChallenge: (request) => s.approvals.issueChallenge(request),
          now: () => clock,
        },
        { webAuthnClient: h.auth },
      );
    }
    const submit = (
      s: ReturnType<typeof services>,
      x: Awaited<ReturnType<typeof approve>>,
      over: Partial<{
        grantSignature: string;
        attestationSignature: string;
      }> = {},
    ) =>
      s.approvals.submit({
        challengeId: x.challenge.challengeId,
        grantSignature: x.grantSignature,
        attestationSignature: x.attestationSignature,
        ...over,
      });
    async function keyRequest(
      key: (typeof fixtureAccounts)[number],
      draft: GrantDraft,
      memberId: string,
      principalId: string,
    ) {
      const request = { principalId, memberId, requestedAt: clock };
      return {
        ...request,
        draftDigest: draft.digest,
        requestSignature: await key.signTypedData(
          challengeRequestTypedData(draft, request),
        ),
      };
    }

    async function operatorPrincipal(s = services(), n = 0) {
      const key = fixtureAccounts[n]!;
      const challenge = await s.principals.issueEnrollmentChallenge({
        kind: 'DYNAMIC_OPERATOR',
        signer: key.address,
        rpId,
        origin,
        providerRef: `wallet-${n}`,
      });
      const signature = await key.signTypedData(
        identityChallengeTypedData(challenge),
      );
      return s.principals.enroll({
        challengeId: challenge.challengeId,
        signature,
      });
    }

    describe('principal registration (proof of possession)', () => {
      it('enrolls a Mera principal only with a signature from the claimed signer', async () => {
        const { view, record } = await enrollMera('alice');
        expect(view).toMatchObject({
          principalId: `mera:${record.signer}`,
          kind: 'MERA_HUMAN',
          signer: record.signer,
          rpId,
          credential: {
            credentialId: record.credential.credentialId,
            transports: ['internal'],
          },
        });
      });

      it('makes first-claim squatting of a victim signer impossible', async () => {
        const s = services();
        const victim = await enrollMeraPrincipal(
          {
            rpId,
            rpName: 'Synq',
            user: { name: 'v', displayName: 'v' },
            requestChallenge: async ({ signer, credential }) => {
              const attackerChallenge =
                await s.principals.issueEnrollmentChallenge({
                  kind: 'MERA_HUMAN',
                  signer,
                  credential: { credentialId: credential.credentialId },
                  rpId,
                  origin,
                });
              const forged = await fixtureAccounts[0]!.signTypedData(
                identityChallengeTypedData(attackerChallenge),
              );
              await expect(
                s.principals.enroll({
                  challengeId: attackerChallenge.challengeId,
                  signature: forged,
                }),
              ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
              return s.principals.issueEnrollmentChallenge({
                kind: 'MERA_HUMAN',
                signer,
                credential: { credentialId: credential.credentialId },
                rpId,
                origin,
              });
            },
          },
          { webAuthnClient: new DeterministicAuthenticator('victim') },
        );
        await expect(
          s.principals.get(victim.challenge.principalId),
        ).rejects.toMatchObject({
          code: 'PRINCIPAL_NOT_FOUND',
        });
        await s.principals.enroll({
          challengeId: victim.challenge.challengeId,
          signature: victim.signature,
        });
        expect(
          (await s.principals.get(victim.challenge.principalId)).signer,
        ).toBe(victim.record.signer);
      });

      it('rejects replay, expiry, wrong origin, duplicate signer and fixture kinds outside local', async () => {
        const s = services();
        const auth = new DeterministicAuthenticator('dup');
        let captured: { challengeId: string; signature: `0x${string}` } | null =
          null;
        const go = () =>
          enrollMeraPrincipal(
            {
              rpId,
              rpName: 'Synq',
              user: { name: 'd', displayName: 'd' },
              requestChallenge: ({ signer, credential }) =>
                s.principals.issueEnrollmentChallenge({
                  kind: 'MERA_HUMAN',
                  signer,
                  credential: { credentialId: credential.credentialId },
                  rpId,
                  origin,
                }),
            },
            { webAuthnClient: auth },
          );
        const first = await go();
        captured = {
          challengeId: first.challenge.challengeId,
          signature: first.signature,
        };
        clock += 121;
        await expect(s.principals.enroll(captured)).rejects.toMatchObject({
          code: 'CHALLENGE_EXPIRED',
        });
        clock -= 121;
        await s.principals.enroll(captured);
        await expect(s.principals.enroll(captured)).rejects.toMatchObject({
          code: 'CHALLENGE_CONSUMED',
        });
        await expect(
          s.principals.issueEnrollmentChallenge({
            kind: 'MERA_HUMAN',
            signer: first.record.signer,
            credential: { credentialId: 'other' },
            rpId,
            origin,
          }),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_EXISTS' });
        const second = await go();
        expect(second.record.signer).not.toBe(first.record.signer);
        await expect(
          s.principals.issueEnrollmentChallenge({
            kind: 'MERA_HUMAN',
            signer: addr(5),
            credential: { credentialId: 'abc' },
            rpId,
            origin: 'https://evil.test',
          }),
        ).rejects.toMatchObject({ code: 'ORIGIN_MISMATCH' });
        await expect(
          s.principals.issueEnrollmentChallenge({
            kind: 'LOCAL_FIXTURE',
            signer: addr(5),
            rpId,
            origin,
          }),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_KIND_FORBIDDEN' });
      });

      it('persists principals, memberships and epochs across a new store and service instance', async () => {
        const { humans } = await trio();
        const reopened = services(await harness.reopen());
        const group = await reopened.membership.getGroup(groupId);
        expect(group.membershipEpoch).toBe(3);
        expect(
          group.memberships.map((m) => [m.memberId, m.signer, m.status]),
        ).toEqual(
          humans.map((h, i) => [`member_${i}`, h.record.signer, 'ACTIVE']),
        );
        expect(
          (await reopened.principals.get(humans[1]!.record.principalId))
            .credential,
        ).toEqual(humans[1]!.view.credential);
      });
    });

    describe('membership and recovery', () => {
      it('rejects joining as a non-owner, duplicate memberships and stale join challenges', async () => {
        const s = services();
        const [a, b, c] = [
          await enrollMera('a', s),
          await enrollMera('b', s),
          await enrollMera('c', s),
        ];
        await s.membership.createGroup({
          groupId,
          chainGroupId: groupId,
          chainId: 10143,
          account,
          owners: [a.record.signer, b.record.signer, addr(0x77)],
          threshold: 2,
        });
        await expect(join(c, 'member_c', s)).rejects.toMatchObject({
          code: 'NOT_SAFE_OWNER',
        });
        const staleA = await s.membership.issueJoinChallenge({
          groupId,
          memberId: 'member_a',
          principalId: a.record.principalId,
        });
        await join(b, 'member_b', s);
        const sig = await signMeraIdentityChallenge(a.record, staleA, {
          webAuthnClient: a.auth,
        });
        await expect(
          s.membership.join({
            groupId,
            challengeId: staleA.challengeId,
            signature: sig,
          }),
        ).rejects.toMatchObject({ code: 'MEMBERSHIP_CHANGED' });
        await join(a, 'member_a', s);
        await expect(join(a, 'member_a2', s)).rejects.toMatchObject({
          code: 'DUPLICATE_MEMBERSHIP',
        });
        await expect(join(b, 'member_a', s)).rejects.toMatchObject({
          code: 'DUPLICATE_MEMBERSHIP',
        });
      });

      it('recovers the same principal and memberships from the same passkey; a wrong passkey is rejected', async () => {
        const { s, humans } = await trio();
        const alice = humans[0]!;
        const recover = (auth: DeterministicAuthenticator) =>
          recoverMeraPrincipal(
            {
              rpId,
              requestChallenge: ({ signer, credentialId }) =>
                s.principals.issueRecoveryChallenge({
                  signer,
                  credentialId,
                  rpId,
                  origin,
                }),
            },
            { webAuthnClient: auth },
          );
        const recovered = await recover(alice.auth);
        const session = await s.principals.recover({
          challengeId: recovered.challenge.challengeId,
          signature: recovered.signature,
        });
        expect(session.principal.signer).toBe(alice.record.signer);
        expect(session.memberships.map((m) => m.memberId)).toEqual([
          'member_0',
        ]);
        const stranger = new DeterministicAuthenticator('stranger');
        await enrollMeraPrincipal(
          {
            rpId,
            rpName: 'x',
            user: { name: 'x', displayName: 'x' },
            requestChallenge: async () => {
              throw new Error('local only');
            },
          },
          { webAuthnClient: stranger },
        ).catch(() => undefined);
        await expect(recover(stranger)).rejects.toMatchObject({
          code: 'PRINCIPAL_NOT_FOUND',
        });
      });
    });

    describe('grant approvals (ADR-0011 with Amendment 1)', () => {
      it('reaches 2-of-3 only with distinct members and attributable signers', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        const pending = await s.approvals.registerDraft({
          draft,
          asset: testAusd,
        });
        expect(pending.status).toBe('PENDING_APPROVAL');
        expect(pending.preview).toMatchObject({
          recipient: addr(0xbeef),
          amount: { display: '12.5' },
          executor: addr(0xe1),
          verifyingContract: MODULE,
          calldataHash: word(0xca11),
          nonce: '7',
        });
        const first = await submit(
          s,
          await approve(s, humans[0]!, 'member_0', draft),
        );
        expect(first).toMatchObject({
          principalKind: 'MERA_HUMAN',
          signer: humans[0]!.record.signer,
          membershipEpoch: 3,
        });
        expect((await s.approvals.quorum(draft.digest)).satisfied).toBe(false);
        await expect(
          approve(s, humans[0]!, 'member_0', draft),
        ).rejects.toMatchObject({
          code: 'ALREADY_APPROVED',
        });
        await submit(s, await approve(s, humans[2]!, 'member_2', draft));
        const quorum = await s.approvals.quorum(draft.digest);
        expect(quorum.satisfied).toBe(true);
        expect(new Set(quorum.counted.map((x) => x.signer))).toEqual(
          new Set([humans[0]!.record.signer, humans[2]!.record.signer]),
        );
        expect(
          (await s.approvals.pendingIntent(draft.grant.intentHash)).status,
        ).toBe('APPROVED');
      });

      it('binds each approval to its challenge with a second, attestation signature', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const a = await approve(s, humans[0]!, 'member_0', draft);
        const b = await approve(s, humans[1]!, 'member_1', draft);
        await expect(
          submit(s, a, { attestationSignature: b.attestationSignature }),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
        await expect(
          submit(s, a, { attestationSignature: a.grantSignature }),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
        await expect(
          submit(s, b, {
            grantSignature: a.grantSignature,
            attestationSignature: a.attestationSignature,
          }),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
        await submit(s, a);
        await submit(s, b);
        expect((await s.approvals.quorum(draft.digest)).satisfied).toBe(true);
      });

      it('regression: harvested signatures cannot restore quorum after an epoch change (critic repro A)', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const a = await approve(s, humans[0]!, 'member_0', draft);
        const c = await approve(s, humans[2]!, 'member_2', draft);
        await submit(s, a);
        await submit(s, c);
        const harvested = (await s.approvals.quorum(draft.digest)).counted;
        expect(harvested).toHaveLength(2);
        await s.membership.revoke({ groupId, memberId: 'member_1' });
        const after = await s.approvals.quorum(draft.digest);
        expect(after).toMatchObject({
          draftStatus: 'INVALIDATED',
          satisfied: false,
          counted: [],
        });
        expect(
          (await s.approvals.pendingIntent(draft.grant.intentHash)).status,
        ).toBe('INVALIDATED');
        const callsBefore = humans.map((h) => ({ ...h.auth.calls }));
        for (const approval of harvested)
          await expect(
            s.approvals.issueChallenge({
              draftDigest: draft.digest,
              memberId: approval.memberId,
              principalId: approval.principalId,
              requestedAt: clock,
              requestSignature: approval.signature,
            }),
          ).rejects.toMatchObject({ code: 'DRAFT_INVALIDATED' });
        await expect(submit(s, a)).rejects.toMatchObject({
          code: 'DRAFT_INVALIDATED',
        });
        const redraft = makeDraft({ nonce: '8' });
        await s.approvals.registerDraft({ draft: redraft, asset: testAusd });
        for (const approval of harvested)
          await expect(
            s.approvals.issueChallenge({
              draftDigest: redraft.digest,
              memberId: approval.memberId,
              principalId: approval.principalId,
              requestedAt: clock,
              requestSignature: approval.signature,
            }),
          ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
        expect(humans.map((h) => ({ ...h.auth.calls }))).toEqual(callsBefore);
        expect((await s.approvals.quorum(redraft.digest)).counted).toHaveLength(
          0,
        );
        await submit(s, await approve(s, humans[0]!, 'member_0', redraft));
        await submit(s, await approve(s, humans[2]!, 'member_2', redraft));
        expect((await s.approvals.quorum(redraft.digest)).satisfied).toBe(true);
      });

      it('rejects unsigned, stale and impersonated challenge requests', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const alice = humans[0]!.record.principalId;
        const forged = await keyRequest(
          fixtureAccounts[0]!,
          draft,
          'member_0',
          alice,
        );
        await expect(s.approvals.issueChallenge(forged)).rejects.toMatchObject({
          code: 'SIGNATURE_MISMATCH',
        });
        clock += 121;
        await expect(s.approvals.issueChallenge(forged)).rejects.toMatchObject({
          code: 'CHALLENGE_EXPIRED',
        });
        clock -= 121;
        await expect(
          approveGrantWithMera(
            {
              record: humans[1]!.record,
              memberId: 'member_0',
              draft,
              asset: testAusd,
              confirmedPreview: grantPreview(draft, testAusd),
              requestChallenge: (request) =>
                s.approvals.issueChallenge(request),
              now: () => clock,
            },
            { webAuthnClient: humans[1]!.auth },
          ),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
      });

      it('rejects challenge reuse, expiry and impersonation (SEC-008/SEC-020)', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const forAlice = await approve(s, humans[0]!, 'member_0', draft);
        const bobSignsAsAlice = await approveGrantWithMera(
          {
            record: humans[1]!.record,
            memberId: 'member_0',
            draft,
            asset: testAusd,
            confirmedPreview: grantPreview(draft, testAusd),
            requestChallenge: async () => ({
              ...forAlice.challenge,
              signer: humans[1]!.record.signer,
              principalId: humans[1]!.view.principalId,
            }),
            now: () => clock,
          },
          { webAuthnClient: humans[1]!.auth },
        );
        await expect(
          submit(s, forAlice, {
            grantSignature: bobSignsAsAlice.grantSignature,
            attestationSignature: bobSignsAsAlice.attestationSignature,
          }),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
        const ok = await approve(s, humans[1]!, 'member_1', draft);
        clock += 121;
        await expect(submit(s, ok)).rejects.toMatchObject({
          code: 'CHALLENGE_EXPIRED',
        });
        clock -= 121;
        await submit(s, ok);
        await expect(submit(s, ok)).rejects.toMatchObject({
          code: 'CHALLENGE_CONSUMED',
        });
        expect((await s.approvals.quorum(draft.digest)).counted).toHaveLength(
          1,
        );
      });

      it('revocation invalidates the draft, outstanding challenges and counted approvals; a new draft is required', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        await submit(s, await approve(s, humans[0]!, 'member_0', draft));
        const b = await approve(s, humans[1]!, 'member_1', draft);
        const group = await s.membership.revoke({
          groupId,
          memberId: 'member_1',
        });
        expect(group.membershipEpoch).toBe(4);
        await expect(submit(s, b)).rejects.toMatchObject({
          code: 'DRAFT_INVALIDATED',
        });
        await expect(
          approve(s, humans[0]!, 'member_0', draft),
        ).rejects.toMatchObject({ code: 'DRAFT_INVALIDATED' });
        expect((await s.approvals.quorum(draft.digest)).counted).toHaveLength(
          0,
        );
        await expect(
          s.approvals.registerDraft({ draft, asset: testAusd }),
        ).rejects.toMatchObject({ code: 'DRAFT_EXISTS' });
        const redraft = makeDraft({ nonce: '8' });
        await s.approvals.registerDraft({ draft: redraft, asset: testAusd });
        await expect(
          approve(s, humans[1]!, 'member_1', redraft),
        ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
        await submit(s, await approve(s, humans[0]!, 'member_0', redraft));
        await submit(s, await approve(s, humans[2]!, 'member_2', redraft));
        expect((await s.approvals.quorum(redraft.digest)).satisfied).toBe(true);
        expect(
          (await s.approvals.pendingIntent(draft.grant.intentHash)).draft
            .digest,
        ).toBe(redraft.digest);
      });

      it('does not carry approvals to a new mandate version draft (quorum change)', async () => {
        const { s, humans } = await trio();
        const v1 = makeDraft();
        const v2 = makeDraft(
          { mandateVersion: '2', intentHash: word(0x1e) },
          { requiredApprovals: 3 },
        );
        await s.approvals.registerDraft({ draft: v1, asset: testAusd });
        await s.approvals.registerDraft({ draft: v2, asset: testAusd });
        const firstV1 = await approve(s, humans[0]!, 'member_0', v1);
        await submit(s, firstV1);
        await submit(s, await approve(s, humans[1]!, 'member_1', v1));
        expect((await s.approvals.quorum(v1.digest)).satisfied).toBe(true);
        expect((await s.approvals.quorum(v2.digest)).counted).toHaveLength(0);
        const v2Alice = await approve(s, humans[0]!, 'member_0', v2);
        await expect(
          submit(s, v2Alice, { grantSignature: firstV1.grantSignature }),
        ).rejects.toMatchObject({ code: 'SIGNATURE_MISMATCH' });
      });

      it('rejects drafts inconsistent with their digest, module, group binding, executor or threshold', async () => {
        const { s } = await trio();
        const draft = makeDraft();
        const bad = (d: GrantDraft) =>
          expect(
            s.approvals.registerDraft({ draft: d, asset: testAusd }),
          ).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
        await bad({ ...draft, digest: word(1) });
        await bad(makeDraft({ account: addr(0xdead) }));
        await bad(makeDraft({}, { requiredApprovals: 1 }));
        await bad(makeDraft({ groupId: word(0xa2) }));
        await bad(
          makeDraft(
            {},
            { domain: { ...draft.domain, verifyingContract: addr(0x6666) } },
          ),
        );
        const owners = (await s.membership.getGroup(groupId)).owners;
        await bad(makeDraft({ executor: owners[0]! }));
      });

      it('enforces the allowed executor list when the group binding declares one', async () => {
        const s = services();
        const humans = [await enrollMera('x1', s), await enrollMera('x2', s)];
        await s.membership.createGroup({
          groupId,
          chainGroupId: groupId,
          chainId: 10143,
          account,
          owners: humans.map((h) => h.record.signer),
          threshold: 2,
          executors: [addr(0xe2)],
        });
        await expect(
          s.approvals.registerDraft({ draft: makeDraft(), asset: testAusd }),
        ).rejects.toMatchObject({ code: 'DRAFT_INVALID' });
        expect(
          (
            await s.approvals.registerDraft({
              draft: makeDraft({ executor: addr(0xe2) }),
              asset: testAusd,
            })
          ).status,
        ).toBe('PENDING_APPROVAL');
      });

      it('counts one approval per member when the same member races two challenges', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const first = await approve(s, humans[0]!, 'member_0', draft);
        const second = await approve(s, humans[0]!, 'member_0', draft);
        const results = await Promise.allSettled(
          [first, second].map((x) => submit(s, x)),
        );
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        expect(
          (
            results.find(
              (r) => r.status === 'rejected',
            ) as PromiseRejectedResult
          ).reason,
        ).toMatchObject({ code: 'ALREADY_APPROVED' });
        expect((await s.approvals.quorum(draft.digest)).counted).toHaveLength(
          1,
        );
      });

      it('exposes consumed approvals and current memberships to the Kernel through read-only ports', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const approval = await submit(
          s,
          await approve(s, humans[0]!, 'member_0', draft),
        );
        const ledger = new StoreApprovalLedger(store);
        expect(await ledger.isConsumed(approval)).toBe(true);
        expect(
          await ledger.isConsumed({ ...approval, approvalId: 'forged' }),
        ).toBe(false);
        expect(
          await ledger.isConsumed({ ...approval, membershipEpoch: 99 }),
        ).toBe(false);
        const directory = new StoreMembershipDirectory(store);
        expect(await directory.activeMember(groupId, 'member_0')).toMatchObject(
          {
            principalKind: 'MERA_HUMAN',
            role: 'APPROVER',
            signer: humans[0]!.record.signer,
            membershipEpoch: 3,
            ownerOfAccount: true,
          },
        );
        await s.membership.revoke({ groupId, memberId: 'member_0' });
        expect(await directory.activeMember(groupId, 'member_0')).toBeNull();
        expect(await directory.membershipEpoch(groupId)).toBe(4);
      });

      it('defines the attestation under the SynqIdentity domain of the deployed module', () => {
        const draft = makeDraft();
        const typed = approvalAttestationTypedData(draft, {
          schemaVersion: 1,
          challengeId: word(1),
          challengeNonce: word(2),
          groupId: draft.groupId,
          memberId: 'm' as never,
          principalId: 'p' as never,
          principalKind: 'MERA_HUMAN',
          signer: addr(1),
          draftDigest: draft.digest,
          membershipEpoch: 3,
          issuedAt: 1,
          expiresAt: 2,
        });
        expect(typed.domain).toEqual({
          name: 'SynqIdentity',
          version: '1',
          chainId: 10143n,
          verifyingContract: MODULE,
        });
        expect(
          typed.types.SynqApprovalAttestation.map(
            (f) => `${f.type} ${f.name}`,
          ).join(','),
        ).toBe(
          'bytes32 challengeId,bytes32 challengeNonce,bytes32 draftDigest,bytes32 groupId,uint256 membershipEpoch,uint256 expiresAt',
        );
        expect(grantTypedData(draft).domain.name).toBe('SynqExecutionModule');
      });
    });

    describe('Dynamic operator isolation', () => {
      it('an operator principal can never own, join as approver, approve or count toward quorum', async () => {
        const { s, humans } = await trio();
        const operator = await operatorPrincipal(s, 0);
        expect(operator.kind).toBe('DYNAMIC_OPERATOR');
        await expect(
          s.membership.issueJoinChallenge({
            groupId,
            memberId: 'op',
            principalId: operator.principalId,
          }),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_NOT_ELIGIBLE' });
        const bound = await s.membership.bindOperator({
          groupId,
          memberId: 'op',
          principalId: operator.principalId,
        });
        expect(bound.role).toBe('OPERATOR');
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        await expect(
          s.approvals.issueChallenge(
            await keyRequest(
              fixtureAccounts[0]!,
              draft,
              'op',
              operator.principalId,
            ),
          ),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_NOT_ELIGIBLE' });
        await expect(
          s.membership.bindOperator({
            groupId,
            memberId: 'op2',
            principalId: humans[0]!.record.principalId,
          }),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_NOT_ELIGIBLE' });
      });

      it('binding or revoking an operator leaves the approver epoch and counted approvals intact', async () => {
        const { s, humans } = await trio();
        const draft = makeDraft();
        await s.approvals.registerDraft({ draft, asset: testAusd });
        const a = await approve(s, humans[0]!, 'member_0', draft);
        await submit(s, a);
        const outstanding = await approve(s, humans[1]!, 'member_1', draft);
        const operator = await operatorPrincipal(s, 3);
        await s.membership.bindOperator({
          groupId,
          memberId: 'op',
          principalId: operator.principalId,
        });
        const afterRevoke = await s.membership.revoke({
          groupId,
          memberId: 'op',
        });
        expect(afterRevoke.membershipEpoch).toBe(3);
        await submit(s, outstanding);
        expect((await s.approvals.quorum(draft.digest)).satisfied).toBe(true);
      });

      it('an operator whose signer is a Safe owner cannot be bound', async () => {
        const s = services();
        const op = await operatorPrincipal(s, 1);
        await s.membership.createGroup({
          groupId,
          chainGroupId: groupId,
          chainId: 10143,
          account,
          owners: [op.signer, addr(0x71)],
          threshold: 1,
        });
        await expect(
          s.membership.bindOperator({
            groupId,
            memberId: 'op',
            principalId: op.principalId,
          }),
        ).rejects.toMatchObject({ code: 'OPERATOR_IS_OWNER' });
      });
    });

    describe('Privy delegation policy enforcement', () => {
      async function delegated() {
        const { s, humans } = await trio();
        const key = fixtureAccounts[2]!;
        const challenge = await s.principals.issueEnrollmentChallenge({
          kind: 'PRIVY_DELEGATE',
          signer: key.address,
          rpId,
          origin,
          providerRef: 'privy-wallet-1',
        });
        const delegate = await s.principals.enroll({
          challengeId: challenge.challengeId,
          signature: await key.signTypedData(
            identityChallengeTypedData(challenge),
          ),
        });
        const policy: DelegationPolicy = {
          schemaVersion: 1,
          policyId: 'weekly_contribution',
          groupId: groupId as DelegationPolicy['groupId'],
          delegatePrincipalId: delegate.principalId,
          delegatorMemberId:
            'member_0' as DelegationPolicy['delegatorMemberId'],
          asset: testAusd,
          recipient: account,
          maxAmountPerPeriod: '20000000',
          maxAmountPerExecution: '20000000',
          periodSeconds: 7 * 86400,
          maxExecutionsPerPeriod: 1,
          minIntervalSeconds: 0,
          validAfter: 1000,
          validUntil: 1000 + 10 * 7 * 86400,
          revokedAt: null,
        };
        await s.delegation.createPolicy(policy);
        return { s, humans, policy, delegate };
      }
      const req = (amount: string) => ({
        amount,
        token: testAusd.address,
        chainId: 10143,
        recipient: account,
      });

      it('allows a contribution within cap and denies amount, frequency, revoked and replay changes', async () => {
        const { s } = await delegated();
        await expect(
          s.delegation.authorize({
            policyId: 'weekly_contribution',
            usageId: 'u1',
            request: req('20000001'),
          }),
        ).rejects.toMatchObject({
          code: 'DELEGATION_DENIED',
          detail: 'PER_EXECUTION_CAP_EXCEEDED',
        });
        const ok = await s.delegation.authorize({
          policyId: 'weekly_contribution',
          usageId: 'u1',
          request: req('15000000'),
        });
        expect(ok).toMatchObject({ allowed: true, replayed: false });
        expect(
          (
            await s.delegation.authorize({
              policyId: 'weekly_contribution',
              usageId: 'u1',
              request: req('15000000'),
            })
          ).replayed,
        ).toBe(true);
        await expect(
          s.delegation.authorize({
            policyId: 'weekly_contribution',
            usageId: 'u1',
            request: req('1'),
          }),
        ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        clock += 3600;
        await expect(
          s.delegation.authorize({
            policyId: 'weekly_contribution',
            usageId: 'u2',
            request: req('1000000'),
          }),
        ).rejects.toMatchObject({ detail: 'FREQUENCY_EXCEEDED' });
        clock += 7 * 86400;
        expect(
          (
            await s.delegation.authorize({
              policyId: 'weekly_contribution',
              usageId: 'u3',
              request: req('20000000'),
            })
          ).allowed,
        ).toBe(true);
        await s.delegation.revokePolicy('weekly_contribution');
        clock += 7 * 86400;
        await expect(
          s.delegation.authorize({
            policyId: 'weekly_contribution',
            usageId: 'u4',
            request: req('1'),
          }),
        ).rejects.toMatchObject({ detail: 'REVOKED' });
      });

      it('rejects a delegation for a non-Privy principal or a non-member delegator', async () => {
        const { s, policy, humans } = await delegated();
        await expect(
          s.delegation.createPolicy({
            ...policy,
            policyId: 'p2',
            delegatePrincipalId: humans[0]!.view.principalId,
          }),
        ).rejects.toMatchObject({ code: 'PRINCIPAL_NOT_ELIGIBLE' });
        await expect(
          s.delegation.createPolicy({
            ...policy,
            policyId: 'p3',
            delegatorMemberId: 'ghost' as DelegationPolicy['delegatorMemberId'],
          }),
        ).rejects.toMatchObject({ code: 'MEMBERSHIP_NOT_FOUND' });
      });

      it('regression: a usage id from another policy never authorizes unrecorded spend (critic repro B)', async () => {
        const { s, policy } = await delegated();
        await s.delegation.createPolicy({ ...policy, policyId: 'policy_b' });
        const first = await s.delegation.authorize({
          policyId: 'weekly_contribution',
          usageId: 'usage_shared',
          request: req('20000000'),
        });
        expect(first).toMatchObject({ allowed: true, replayed: false });
        for (let i = 0; i < 5; i++) {
          clock += 60;
          await expect(
            s.delegation.authorize({
              policyId: 'policy_b',
              usageId: 'usage_shared',
              request: req('20000000'),
            }),
          ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
        }
        expect(
          await s.delegation.authorize({
            policyId: 'policy_b',
            usageId: 'usage_b1',
            request: req('20000000'),
          }),
        ).toMatchObject({ allowed: true, replayed: false });
        await expect(
          s.delegation.authorize({
            policyId: 'policy_b',
            usageId: 'usage_b2',
            request: req('1'),
          }),
        ).rejects.toMatchObject({ detail: 'FREQUENCY_EXCEEDED' });
        const replay = await s.delegation.authorize({
          policyId: 'policy_b',
          usageId: 'usage_b1',
          request: req('20000000'),
        });
        expect(replay.replayed).toBe(true);
      });

      it('regression: revoking the delegator membership stops the delegation (critic repro C)', async () => {
        const { s } = await delegated();
        await s.membership.revoke({ groupId, memberId: 'member_0' });
        clock += 8 * 86400;
        await expect(
          s.delegation.authorize({
            policyId: 'weekly_contribution',
            usageId: 'usage_after_revoke',
            request: req('20000000'),
          }),
        ).rejects.toMatchObject({ code: 'DELEGATION_DENIED' });
      });
    });
  });
}
