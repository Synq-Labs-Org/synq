import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { AuthorityError } from '@synq/kernel/arc';
import { admitEscrowGrant, escrowIntentId } from '@synq/kernel/arc-escrow';
import { availableToSpend, walletCashWei } from '@synq/ledger';
import {
  DealRoomError,
  acceptsFor,
  contextFromGuestQuery,
  fundingMismatches,
  milestoneKey,
  proposeDeterministic,
  resolveCitations,
  termProblems,
  type DealRoomService,
  type Terms,
} from '@synq/dealroom';
import type { StructuredReasoner } from '@synq/agent-runtime';
import {
  ESCROW,
  T0,
  USDC,
  acceptSig,
  arbiter,
  attestation,
  client,
  commitEvidence,
  declineSig,
  drafted,
  enrolledChat,
  fence,
  freelancer,
  fundedRecord,
  GRANT_CONFIG,
  kernel,
  mallory,
  mandate,
  parties,
  room,
  signedBoth,
} from './harness.js';

const code = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as DealRoomError | AuthorityError).code;
  }
  return 'NO_ERROR';
};

/** A model that cites whatever message ids it is told to (for citation tests). */
function fakeModel(proposal: unknown): StructuredReasoner {
  return {
    provider: 'openai',
    model: 'fake',
    availability: () => ({
      providerId: 'OPENAI',
      installed: true,
      credentialsPresent: false,
      mode: 'REPLAY',
    }),
    complete: async () => ({
      text: JSON.stringify(proposal),
      toolCalls: [],
      inputTokens: 1,
      outputTokens: 1,
      provider: 'openai',
      model: 'fake',
      mode: 'REPLAY',
      fixtureLabel: 'HAND_AUTHORED_FIXTURE',
      requestHash: `0x${'11'.repeat(32)}`,
      responseHash: `0x${'22'.repeat(32)}`,
      structuredMode: 'JSON_SCHEMA',
    }),
  };
}
const modelProposal = (citeId: string, quote: string) => ({
  title: 'Landing page',
  scope: 'Rebuild the landing page',
  deliverables: ['hero section'],
  total: '0.03',
  milestones: [
    {
      title: 'Hero',
      amount: '0.01',
      dueInDays: 7,
      acceptanceCondition: 'hero merged',
      evidenceType: 'GITHUB_COMMIT',
    },
    {
      title: 'Rest',
      amount: '0.02',
      dueInDays: 14,
      acceptanceCondition: 'rest delivered',
      evidenceType: 'GITHUB_COMMIT',
    },
  ],
  citations: [{ term: 'total', messageId: citeId, quote }],
  ambiguities: [],
});

/** Funds a both-signed deal in the service (Kernel grant + recorded chain facts). */
async function fund(r: ReturnType<typeof room>, dealId: string) {
  const v = (await r.service.view(dealId)).current;
  const m = await mandate({
    owner: client,
    id: 'mnd_fund',
    payer: client.address,
    recipients: [ESCROW],
    purposes: ['ESCROW_FUNDING'],
    cap: v.terms.total,
    budget: v.terms.total,
  });
  const auth = await r.service.authorizeFunding(dealId, kernel(m));
  if (auth.decision.outcome !== 'ALLOW')
    throw new Error(auth.decision.reasons.join(';'));
  await r.service.recordFunded({ dealId, ...fundedRecord(v) });
  return { auth, v };
}

async function deliverAndAccept(
  svc: DealRoomService,
  dealId: string,
  i: number,
) {
  let v = (await svc.view(dealId)).current;
  await svc.attest(
    await attestation({
      v,
      milestone: i,
      kind: 'DELIVERED',
      role: 'FREELANCER',
      evidence: commitEvidence(),
    }),
  );
  v = (await svc.view(dealId)).current;
  return svc.attest(
    await attestation({
      v,
      milestone: i,
      kind: 'ACCEPT_RELEASE',
      role: 'CLIENT',
      evidence: commitEvidence(),
    }),
  );
}

describe('Deal Room drafting from authorized context', () => {
  it('drafts integer terms with message citations and model interpretation kept distinct', async () => {
    const { view } = await drafted();
    const t = view.current.terms;
    expect(view.deal.status).toBe('DRAFT');
    expect(t.total).toBe(30_000n);
    expect(t.milestones.map((m) => m.amount)).toEqual([10_000n, 20_000n]);
    expect(t.milestones.map((m) => (m.deadline - T0) / 86_400)).toEqual([
      7, 14,
    ]);
    expect(t.milestones.every((m) => m.payee === freelancer.address)).toBe(
      true,
    );
    expect(t.asset.token).toBe(USDC.address);
    expect(termProblems(t)).toEqual([]);
    const total = view.current.provenance.total!;
    expect(total.map((p) => p.kind)).toEqual([
      'ORIGINAL_MESSAGE',
      'AI_INTERPRETATION',
    ]);
    expect(total[0]).toMatchObject({
      messageId: '902',
      quote: '0.03 USDC total',
    });
    expect(
      view.current.provenance[milestoneKey(0, 'deadline')]![0],
    ).toMatchObject({ messageId: '903', quote: 'within 7 days' });
    // Wallets come from verified links only: no provenance from chat or model.
    expect(view.current.provenance['milestones.0.payee']).toMatchObject([
      { kind: 'VERIFIED_LINK' },
    ]);
  });

  it('P13-01: an unreceived old group message cannot be cited', async () => {
    const { old, stored, context } = await enrolledChat();
    expect(old).toBe('NOT_DISCLOSED');
    expect(stored).toEqual(['STORED', 'STORED', 'STORED']);
    expect(context.messages.map((m) => m.messageId)).not.toContain('800');
    // A model citing the pre-disclosure message is refused, whatever it quotes.
    const r = room();
    expect(
      await code(
        r.service.draft({
          workspaceId: 'w',
          context,
          request: 'x',
          parties,
          reasoner: fakeModel(modelProposal('800', '5 USDC total')),
        }),
      ),
    ).toBe('CITATION_NOT_AUTHORIZED');
    // A quote that is not in the cited message is refused too.
    expect(
      await code(
        r.service.draft({
          workspaceId: 'w',
          context,
          request: 'x',
          parties,
          reasoner: fakeModel(modelProposal('902', '5 USDC total')),
        }),
      ),
    ).toBe('CITATION_MISMATCH');
    expect(() =>
      resolveCitations(context, [
        { term: 'total', messageId: '799', quote: 'x' },
      ]),
    ).toThrow(/not permitted/);
    // The deterministic extractor never sees message 800.
    expect(JSON.stringify(proposeDeterministic(context))).not.toContain('800');
  });

  it('P13-01: a guest invocation may cite only the trigger and the one replied-to message', () => {
    const ctx = contextFromGuestQuery({
      envelope: {
        channel: 'telegram',
        externalGroupId: '-100777',
        messageId: '51',
        externalUserId: '7001',
        body: '@asksynqbot draft a deal',
        timestamp: T0,
      },
      reference: {
        messageId: '50',
        externalUserId: '7002',
        timestamp: T0 - 30,
        text: '0.03 USDC total',
        textSha256: 'a'.repeat(64),
      },
    });
    expect(ctx.messages.map((m) => m.messageId)).toEqual(['50', '51']);
    expect(
      resolveCitations(ctx, [
        { term: 'total', messageId: '50', quote: '0.03 USDC total' },
      ]).total![0],
    ).toMatchObject({ source: 'GUEST_INVOCATION' });
    expect(() =>
      resolveCitations(ctx, [
        { term: 'total', messageId: '49', quote: '0.03 USDC total' },
      ]),
    ).toThrow(DealRoomError);
  });

  it('refuses unverified participants', async () => {
    const { context } = await enrolledChat();
    const bad = {
      ...parties,
      freelancer: {
        ...parties.freelancer,
        verification: { ...parties.freelancer.verification, reference: '' },
      },
    };
    expect(
      await code(
        room().service.draft({
          workspaceId: 'w',
          context,
          request: 'x',
          parties: bad,
          reasoner: null,
        }),
      ),
    ).toBe('PARTY_NOT_VERIFIED');
  });
});

describe('Deal Room negotiation and signatures', () => {
  it('both parties sign the exact version: ACCEPTED, with distinct signers', async () => {
    const { view, service } = await signedBoth();
    expect(view.deal.status).toBe('ACCEPTED');
    const a = acceptsFor(view.signatures, view.current);
    expect(a.CLIENT!.signer).toBe(client.address);
    expect(a.FREELANCER!.signer).toBe(freelancer.address);
    const prov = service.provenance(view).total!.map((p) => p.kind);
    expect(prov).toEqual([
      'ORIGINAL_MESSAGE',
      'AI_INTERPRETATION',
      'HUMAN_CONFIRMED',
      'HUMAN_CONFIRMED',
      'EXECUTABLE_AUTHORIZATION',
    ]);
  });

  it('wrong signer, stale version and replayed decisions are refused', async () => {
    const r = room();
    const { view } = await drafted(r);
    const id = view.deal.dealId;
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 1,
          role: 'CLIENT',
          signature: await acceptSig(
            r.service,
            view.current,
            'CLIENT',
            mallory,
          ),
        }),
      ),
    ).toBe('WRONG_SIGNER');
    // The freelancer cannot sign as the client.
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 1,
          role: 'CLIENT',
          signature: await acceptSig(r.service, view.current, 'FREELANCER'),
        }),
      ),
    ).toBe('WRONG_SIGNER');
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 2,
          role: 'CLIENT',
          signature: await acceptSig(r.service, view.current, 'CLIENT'),
        }),
      ),
    ).toBe('STALE_VERSION');
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 1,
          role: 'CLIENT',
          signature: '0x1234',
        }),
      ),
    ).toBe('BAD_SIGNATURE');
    const sig = await acceptSig(r.service, view.current, 'CLIENT');
    await r.service.sign({
      dealId: id,
      version: 1,
      role: 'CLIENT',
      signature: sig,
    });
    const again = await r.service.sign({
      dealId: id,
      version: 1,
      role: 'CLIENT',
      signature: sig,
    });
    expect(again.signatures).toHaveLength(1);
  });

  it('P13-02: counterparty rejection prevents the escrow funding mandate', async () => {
    const r = room();
    const { view } = await drafted(r);
    const id = view.deal.dealId;
    await r.service.sign({
      dealId: id,
      version: 1,
      role: 'CLIENT',
      signature: await acceptSig(r.service, view.current, 'CLIENT'),
    });
    const rejected = await r.service.decline({
      dealId: id,
      version: 1,
      role: 'FREELANCER',
      decision: 'REJECT',
      reason: 'deadline too short',
      signature: await declineSig(
        view.current,
        'FREELANCER',
        'REJECT',
        'deadline too short',
      ),
    });
    expect(rejected.deal.status).toBe('NEGOTIATING');
    expect(await code(r.service.fundingCall(id))).toBe('COUNTERPARTY_REJECTED');
    const m = await mandate({
      owner: client,
      id: 'mnd',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30_000n,
      budget: 30_000n,
    });
    expect(await code(r.service.authorizeFunding(id, kernel(m)))).toBe(
      'COUNTERPARTY_REJECTED',
    );
    // The rejecting party cannot then flip it by signing ACCEPT on the same version.
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 1,
          role: 'FREELANCER',
          signature: await acceptSig(r.service, view.current, 'FREELANCER'),
        }),
      ),
    ).toBe('COUNTERPARTY_REJECTED');
    // A rejection signed by someone else is refused.
    expect(
      await code(
        r.service.decline({
          dealId: id,
          version: 1,
          role: 'CLIENT',
          decision: 'REJECT',
          reason: 'x',
          signature: await declineSig(
            view.current,
            'CLIENT',
            'REJECT',
            'x',
            mallory,
          ),
        }),
      ),
    ).toBe('WRONG_SIGNER');
    expect((await r.service.view(id)).deal.funding).toBeNull();
  });

  it('P13-03: editing a signed milestone resets the required approvals', async () => {
    const r = room();
    const { view } = await signedBoth(r);
    const id = view.deal.dealId;
    const v1 = view.current;
    const terms: Terms = {
      ...v1.terms,
      total: 35_000n,
      deposit: 35_000n,
      milestones: v1.terms.milestones.map((m) =>
        m.index === 1 ? { ...m, amount: 25_000n } : m,
      ),
    };
    const prep = await r.service.prepareCounteroffer({
      dealId: id,
      baseVersion: 1,
      by: 'FREELANCER',
      terms,
    });
    // Signing something other than the prepared version is refused.
    const wrongSig = await freelancer.signTypedData(
      r.service.typedData({
        ...prep.version,
        terms: { ...terms, title: 'other' },
      }),
    );
    expect(
      await code(
        r.service.counteroffer({
          dealId: id,
          baseVersion: 1,
          by: 'FREELANCER',
          terms,
          signature: wrongSig,
        }),
      ),
    ).toBe('WRONG_SIGNER');
    const preview = {
      signature: await freelancer.signTypedData(prep.typedData),
    };
    const after = await r.service.counteroffer({
      dealId: id,
      baseVersion: 1,
      by: 'FREELANCER',
      terms,
      signature: preview.signature,
    });
    expect(after.deal.status).toBe('NEGOTIATING');
    expect(after.current.version).toBe(2);
    expect(after.current.parentTermsHash).toBe(v1.termsHash);
    expect(after.current.termsHash).not.toBe(v1.termsHash);
    const a = acceptsFor(after.signatures, after.current);
    expect(a.FREELANCER).not.toBeNull();
    expect(a.CLIENT).toBeNull();
    expect(await code(r.service.fundingCall(id))).toBe('NOT_FULLY_SIGNED');
    // The client's v1 signature does not carry over to v2.
    const v1ClientSig = acceptsFor(after.signatures, v1).CLIENT!.signature;
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 2,
          role: 'CLIENT',
          signature: v1ClientSig,
        }),
      ),
    ).toBe('WRONG_SIGNER');
    expect(
      await code(
        r.service.sign({
          dealId: id,
          version: 1,
          role: 'CLIENT',
          signature: v1ClientSig,
        }),
      ),
    ).toBe('STALE_VERSION');
    // Changed terms are the proposer's, unchanged ones keep their message citations.
    expect(after.current.provenance[milestoneKey(1, 'amount')]).toEqual([
      {
        kind: 'HUMAN_CONFIRMED',
        role: 'FREELANCER',
        wallet: freelancer.address,
        version: 2,
        how: 'PROPOSED',
      },
    ]);
    expect(after.current.provenance[milestoneKey(0, 'amount')]![0]!.kind).toBe(
      'ORIGINAL_MESSAGE',
    );
    const done = await r.service.sign({
      dealId: id,
      version: 2,
      role: 'CLIENT',
      signature: await acceptSig(r.service, after.current, 'CLIENT'),
    });
    expect(done.deal.status).toBe('ACCEPTED');
    expect((await r.service.fundingCall(id)).call.amounts).toEqual([
      10_000n,
      25_000n,
    ]);
  });

  it('a counteroffer cannot change parties or pay someone else', async () => {
    const r = room();
    const { view } = await drafted(r);
    const t = view.current.terms;
    const swapped = {
      ...t,
      milestones: t.milestones.map((m) => ({ ...m, payee: mallory.address })),
    };
    expect(
      await code(
        r.service.counteroffer({
          dealId: view.deal.dealId,
          baseVersion: 1,
          by: 'CLIENT',
          terms: swapped,
          signature: '0x00',
        }),
      ),
    ).toBe('INVALID_TERMS');
    const otherArbiter = {
      ...t,
      arbiter: { ...t.arbiter, wallet: mallory.address },
    };
    expect(
      await code(
        r.service.counteroffer({
          dealId: view.deal.dealId,
          baseVersion: 1,
          by: 'CLIENT',
          terms: otherArbiter,
          signature: '0x00',
        }),
      ),
    ).toBe('PARTY_NOT_VERIFIED');
  });

  it('an expired offer cannot be signed or funded; cancellation before funding ends the deal', async () => {
    const r = room();
    const { view } = await signedBoth(r);
    r.clock.t = view.current.terms.expiresAt;
    expect(await code(r.service.fundingCall(view.deal.dealId))).toBe('EXPIRED');
    expect((await r.service.expire(view.deal.dealId)).deal.status).toBe(
      'EXPIRED',
    );
    const r2 = room();
    const d2 = await drafted(r2);
    const c = await r2.service.decline({
      dealId: d2.view.deal.dealId,
      version: 1,
      role: 'CLIENT',
      decision: 'CANCEL',
      reason: 'project dropped',
      signature: await declineSig(
        d2.view.current,
        'CLIENT',
        'CANCEL',
        'project dropped',
      ),
    });
    expect(c.deal.status).toBe('CANCELLED');
    expect(await code(r2.service.fundingCall(d2.view.deal.dealId))).toBe(
      'WRONG_STATE',
    );
  });
});

describe('Deal Room escrow funding (Kernel-bound)', () => {
  it('P13-04: the funding grant names the exact escrow call and funded state must equal the agreement', async () => {
    const r = room();
    const { view } = await signedBoth(r);
    const id = view.deal.dealId;
    const m = await mandate({
      owner: client,
      id: 'mnd_fund',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30_000n,
      budget: 30_000n,
    });
    const auth = await r.service.authorizeFunding(id, kernel(m));
    expect(auth.decision.outcome).toBe('ALLOW');
    if (auth.decision.outcome !== 'ALLOW') return;
    const grant = auth.decision.grant;
    expect(grant.intentId).toBe(escrowIntentId(auth.call));
    expect(auth.call).toMatchObject({
      sender: client.address,
      payee: freelancer.address,
      arbiter: arbiter.address,
      termsHash: view.current.termsHash,
      amounts: [10_000n, 20_000n],
    });
    expect((await r.service.view(id)).deal.status).toBe('FUNDING');
    // Executor admission: any change to the call is refused before signing.
    const admit = (call: typeof auth.call, f = fence()) =>
      code(
        admitEscrowGrant({
          grantKey: GRANT_CONFIG.grantKey,
          grant,
          call,
          now: T0,
          mandateRevoked: false,
          fence: f,
        }),
      );
    expect(await admit({ ...auth.call, amounts: [10_000n, 19_999n] })).toBe(
      'GRANT_MISMATCH',
    );
    expect(await admit({ ...auth.call, token: `0x${'ee'.repeat(20)}` })).toBe(
      'GRANT_MISMATCH',
    );
    expect(await admit({ ...auth.call, payee: mallory.address })).toBe(
      'GRANT_MISMATCH',
    );
    expect(
      await admit({ ...auth.call, termsHash: `0x${'01'.repeat(32)}` }),
    ).toBe('GRANT_MISMATCH');
    const f = fence();
    expect(await admit(auth.call, f)).toBe('NO_ERROR');
    expect(await admit(auth.call, f)).toBe('GRANT_REPLAYED');
    // Recorded chain facts must equal the signed version.
    const rec = fundedRecord(view.current);
    expect(
      fundingMismatches(
        view.current.terms,
        view.current.termsHash,
        rec.chain,
        rec.execution,
      ),
    ).toEqual([]);
    const wrongAsset = { ...rec.chain, token: `0x${'ee'.repeat(20)}` as Hex };
    expect(
      fundingMismatches(
        view.current.terms,
        view.current.termsHash,
        wrongAsset,
        rec.execution,
      )[0],
    ).toMatch(/asset/);
    const short = {
      ...rec.execution,
      transfers: [{ ...rec.execution.transfers[0]!, value: 29_999n }],
    };
    expect(
      await code(
        r.service.recordFunded({
          dealId: id,
          execution: short,
          chain: rec.chain,
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    const wrongTerms = {
      ...rec.chain,
      termsHash: `0x${'02'.repeat(32)}` as Hex,
    };
    expect(
      await code(
        r.service.recordFunded({
          dealId: id,
          execution: rec.execution,
          chain: wrongTerms,
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    const wrongPayer = { ...rec.chain, payer: mallory.address };
    expect(
      await code(
        r.service.recordFunded({
          dealId: id,
          execution: rec.execution,
          chain: wrongPayer,
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    const funded = await r.service.recordFunded({ dealId: id, ...rec });
    expect(funded.deal.status).toBe('FUNDED');
    expect(funded.deal.escrow?.termsHash).toBe(view.current.termsHash);
    // Books: client cash -> escrow, restricted as escrow liability.
    const bal = await r.ledger.balances('wsp_dealroom_test', USDC.assetId);
    expect(bal.ESCROW_LIABILITY).toBe(-30_000n);
    expect(
      availableToSpend({
        confirmedCash: 30_000n,
        reservations: 0n,
        escrow: -bal.ESCROW_LIABILITY,
        minimumReserve: 0n,
      }),
    ).toBe(0n);
  });

  it('a funding mandate for another payer or a mandate that is not the client’s cannot fund', async () => {
    const r = room();
    const { view } = await signedBoth(r);
    const notClient = await mandate({
      owner: mallory,
      id: 'mnd_x',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['ESCROW_FUNDING'],
      cap: 30_000n,
      budget: 30_000n,
    });
    expect(
      await code(
        r.service.authorizeFunding(view.deal.dealId, kernel(notClient)),
      ),
    ).toBe('WRONG_SIGNER');
    const wrongPurpose = await mandate({
      owner: client,
      id: 'mnd_y',
      payer: client.address,
      recipients: [ESCROW],
      purposes: ['CONTRACTOR_PAYOUT'],
      cap: 30_000n,
      budget: 30_000n,
    });
    const d = await r.service.authorizeFunding(
      view.deal.dealId,
      kernel(wrongPurpose),
    );
    expect(d.decision.outcome).toBe('DENY');
    expect((await r.service.view(view.deal.dealId)).deal.status).toBe(
      'ACCEPTED',
    );
  });
});

describe('Deal Room milestones: release, dispute, refund', () => {
  async function fundedDeal() {
    const r = room();
    const { view } = await signedBoth(r);
    await fund(r, view.deal.dealId);
    return { r, id: view.deal.dealId };
  }
  const releaseMandate = (amount = 20_000n) =>
    mandate({
      owner: client,
      id: 'mnd_release',
      payer: ESCROW,
      recipients: [freelancer.address],
      purposes: ['ESCROW_RELEASE'],
      cap: amount,
      budget: 30_000n,
    });

  it('P13-05: deliverable proof plus the client attestation releases exactly once', async () => {
    const { r, id } = await fundedDeal();
    // Evidence alone is not a release.
    let v = (await r.service.view(id)).current;
    await r.service.attest(
      await attestation({
        v,
        milestone: 0,
        kind: 'DELIVERED',
        role: 'FREELANCER',
        evidence: commitEvidence(),
      }),
    );
    expect(await code(r.service.releaseCall(id, 0))).toBe('WRONG_STATE');
    // The freelancer cannot accept its own delivery; a forged client attestation is refused.
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'ACCEPT_RELEASE',
            role: 'FREELANCER',
            evidence: commitEvidence(),
          }),
        ),
      ),
    ).toBe('WRONG_SIGNER');
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'ACCEPT_RELEASE',
            role: 'CLIENT',
            evidence: commitEvidence(),
            by: mallory,
          }),
        ),
      ),
    ).toBe('WRONG_SIGNER');
    // The client must accept the delivered evidence, not something else.
    const other = commitEvidence('1'.repeat(40));
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'ACCEPT_RELEASE',
            role: 'CLIENT',
            evidence: other,
          }),
        ),
      ),
    ).toBe('EVIDENCE_INVALID');
    // Expired attestation.
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'ACCEPT_RELEASE',
            role: 'CLIENT',
            evidence: commitEvidence(),
            deadline: T0 - 1,
          }),
        ),
      ),
    ).toBe('EXPIRED');
    const accept = await attestation({
      v,
      milestone: 0,
      kind: 'ACCEPT_RELEASE',
      role: 'CLIENT',
      evidence: commitEvidence(),
    });
    await r.service.attest(accept);
    // Replaying the same signed attestation changes nothing / is refused.
    expect(await code(r.service.attest(accept))).toBe('WRONG_STATE');
    v = (await r.service.view(id)).current;
    const { call } = await r.service.releaseCall(id, 0);
    expect(call).toMatchObject({
      sender: client.address,
      payee: freelancer.address,
      amount: 10_000n,
      index: 0,
      escrowDealId: 7n,
    });
    const m = await releaseMandate();
    const auth = await r.service.authorizeRelease(id, 0, kernel(m));
    expect(auth.decision.outcome).toBe('ALLOW');
    if (auth.decision.outcome !== 'ALLOW') return;
    const f = fence();
    await admitEscrowGrant({
      grantKey: GRANT_CONFIG.grantKey,
      grant: auth.decision.grant,
      call,
      now: T0,
      mandateRevoked: false,
      fence: f,
    });
    expect(
      await code(
        admitEscrowGrant({
          grantKey: GRANT_CONFIG.grantKey,
          grant: auth.decision.grant,
          call,
          now: T0,
          mandateRevoked: false,
          fence: f,
        }),
      ),
    ).toBe('GRANT_REPLAYED');
    // A milestone-0 grant cannot release milestone 1.
    expect(
      await code(
        admitEscrowGrant({
          grantKey: GRANT_CONFIG.grantKey,
          grant: auth.decision.grant,
          call: { ...call, index: 1 },
          now: T0,
          mandateRevoked: false,
          fence: fence(),
        }),
      ),
    ).toBe('GRANT_MISMATCH');
    const hash = `0x${'aa'.repeat(32)}` as Hex;
    const execution = {
      op: 'RELEASE' as const,
      milestone: 0,
      escrowDealId: 7n,
      txs: [
        {
          label: 'release',
          hash,
          from: client.address,
          feeWei: 3_000_000_000_000n,
        },
      ],
      transfers: [
        {
          from: ESCROW,
          to: freelancer.address,
          value: 10_000n,
          logIndex: 0,
          hash,
        },
      ],
    };
    // A report about another escrow deal is refused.
    expect(
      await code(
        r.service.recordReleased({
          dealId: id,
          milestone: 0,
          execution: { ...execution, escrowDealId: 8n },
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    const after = await r.service.recordReleased({
      dealId: id,
      milestone: 0,
      execution,
    });
    expect(after.deal.milestones[0]!.status).toBe('SETTLED');
    expect(after.deal.status).toBe('IN_PROGRESS');
    // Exactly once: a second release has no call, a replayed record posts nothing.
    expect(await code(r.service.releaseCall(id, 0))).toBe('WRONG_STATE');
    await r.service.recordReleased({ dealId: id, milestone: 0, execution });
    const entries = await r.ledger.store.entries('wsp_dealroom_test');
    expect(
      entries.filter((e) => e.entryId.startsWith('je_dealrel_')),
    ).toHaveLength(1);
    // The Kernel also refuses a second grant for the same obligation.
    const again = await r.service.authorize(
      call,
      {
        obligationRef: `deal:${id}:m0:release`,
        evidenceHash: accept.signature.slice(0, 66) as Hex,
        proposedBy: 'x',
      },
      kernel(m, {
        revoked: false,
        spends: [],
        settledObligations: [`deal:${id}:m0:release`],
      }),
    );
    expect(again.decision.outcome).toBe('DENY');
    // Books: escrow cash to freelancer, wallets reconcile to the wei including dust.
    const cash = walletCashWei(entries, USDC.assetId);
    expect(cash.get(`wallet:${freelancer.address.toLowerCase()}`)).toBe(
      10_000n * 10n ** 12n,
    );
  });

  it('P13-06: a dispute prevents automatic (payer) release; only the arbiter resolves', async () => {
    const { r, id } = await fundedDeal();
    await deliverAndAccept(r.service, id, 0);
    let v = (await r.service.view(id)).current;
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'DELIVERED',
        role: 'FREELANCER',
        evidence: commitEvidence('2'.repeat(40)),
      }),
    );
    // The client disputes milestone 1.
    const disputed = await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'DISPUTE',
        role: 'CLIENT',
        evidence: null,
      }),
    );
    expect(disputed.deal.status).toBe('DISPUTED');
    expect(disputed.deal.dispute).toMatchObject({
      milestone: 1,
      raisedBy: 'CLIENT',
    });
    expect(await code(r.service.releaseCall(id, 1))).toBe('MILESTONE_DISPUTED');
    // The escrow freezes payer release deal-wide, so milestone 0 is held too.
    expect(await code(r.service.releaseCall(id, 0))).toBe('MILESTONE_DISPUTED');
    // A party cannot "accept" its way out of a dispute.
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 1,
            kind: 'ACCEPT_RELEASE',
            role: 'CLIENT',
            evidence: commitEvidence('2'.repeat(40)),
          }),
        ),
      ),
    ).toBe('WRONG_STATE');
    // Only the arbiter's signed resolution unlocks it; its release is sent by the arbiter.
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 1,
            kind: 'ARBITER_RELEASE',
            role: 'ARBITER',
            evidence: null,
            by: mallory,
          }),
        ),
      ),
    ).toBe('WRONG_SIGNER');
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'ARBITER_RELEASE',
        role: 'ARBITER',
        evidence: null,
      }),
    );
    v = (await r.service.view(id)).current;
    expect((await r.service.releaseCall(id, 1)).call.sender).toBe(
      arbiter.address,
    );
    // Milestone 0 (client path) stays frozen while the on-chain dispute window runs.
    expect(await code(r.service.releaseCall(id, 0))).toBe('MILESTONE_DISPUTED');
    r.clock.t = T0 + 30 * 86_400 + 1;
    expect((await r.service.releaseCall(id, 0)).call.sender).toBe(
      client.address,
    );
  });

  it('P13-07: a cancelled (refunded) milestone returns to the funder named in the signed terms', async () => {
    const { r, id } = await fundedDeal();
    const v = (await r.service.view(id)).current;
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'DISPUTE',
        role: 'CLIENT',
        evidence: null,
      }),
    );
    // Neither party can force the refund alone; the arbiter decides a dispute.
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 1,
            kind: 'ARBITER_REFUND',
            role: 'CLIENT',
            evidence: null,
          }),
        ),
      ),
    ).toBe('WRONG_SIGNER');
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'ARBITER_REFUND',
        role: 'ARBITER',
        evidence: null,
      }),
    );
    const { call } = await r.service.refundCall(id, 1);
    expect(call).toMatchObject({
      funder: client.address,
      sender: arbiter.address,
      amount: 20_000n,
      index: 1,
    });
    const m = await mandate({
      owner: arbiter,
      id: 'mnd_arb',
      payer: ESCROW,
      recipients: [client.address],
      purposes: ['ESCROW_REFUND'],
      cap: 20_000n,
      budget: 30_000n,
    });
    const auth = await r.service.authorizeRefund(id, 1, kernel(m));
    expect(auth.decision.outcome).toBe('ALLOW');
    if (auth.decision.outcome !== 'ALLOW') return;
    // Refund to the wrong party: the grant does not cover it, and the record is refused.
    expect(
      await code(
        admitEscrowGrant({
          grantKey: GRANT_CONFIG.grantKey,
          grant: auth.decision.grant,
          call: { ...call, funder: freelancer.address },
          now: T0,
          mandateRevoked: false,
          fence: fence(),
        }),
      ),
    ).toBe('GRANT_MISMATCH');
    // A refund mandate naming another recipient is denied by the Kernel.
    const wrong = await mandate({
      owner: arbiter,
      id: 'mnd_arb2',
      payer: ESCROW,
      recipients: [freelancer.address],
      purposes: ['ESCROW_REFUND'],
      cap: 20_000n,
      budget: 30_000n,
    });
    expect(
      (await r.service.authorizeRefund(id, 1, kernel(wrong))).decision.outcome,
    ).toBe('DENY');
    const hash = `0x${'bb'.repeat(32)}` as Hex;
    const toFreelancer = {
      op: 'REFUND' as const,
      milestone: 1,
      escrowDealId: 7n,
      txs: [{ label: 'refund', hash, from: arbiter.address, feeWei: 1n }],
      transfers: [
        {
          from: ESCROW,
          to: freelancer.address,
          value: 20_000n,
          logIndex: 0,
          hash,
        },
      ],
    };
    expect(
      await code(
        r.service.recordRefunded({
          dealId: id,
          milestone: 1,
          execution: toFreelancer,
        }),
      ),
    ).toBe('FUNDING_MISMATCH');
    const ok = {
      ...toFreelancer,
      transfers: [{ ...toFreelancer.transfers[0]!, to: client.address }],
    };
    const after = await r.service.recordRefunded({
      dealId: id,
      milestone: 1,
      execution: ok,
    });
    expect(after.deal.milestones[1]!.status).toBe('REFUNDED');
    expect(await code(r.service.refundCall(id, 1))).toBe('WRONG_STATE');
    // Voluntary cancellation by the payee (milestone 0) also refunds the funder.
    await r.service.attest(
      await attestation({
        v,
        milestone: 0,
        kind: 'CANCEL_REFUND',
        role: 'FREELANCER',
        evidence: null,
      }),
    );
    expect((await r.service.refundCall(id, 0)).call).toMatchObject({
      funder: client.address,
      sender: freelancer.address,
    });
  });

  it('a released milestone cannot be refunded and a refunded one cannot be released', async () => {
    const { r, id } = await fundedDeal();
    await deliverAndAccept(r.service, id, 0);
    const v = (await r.service.view(id)).current;
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'CANCEL_REFUND',
            role: 'FREELANCER',
            evidence: null,
          }),
        ),
      ),
    ).toBe('WRONG_STATE');
    await r.service.attest(
      await attestation({
        v,
        milestone: 1,
        kind: 'CANCEL_REFUND',
        role: 'FREELANCER',
        evidence: null,
      }),
    );
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 1,
            kind: 'DELIVERED',
            role: 'FREELANCER',
            evidence: commitEvidence(),
          }),
        ),
      ),
    ).toBe('WRONG_STATE');
    expect(await code(r.service.releaseCall(id, 1))).toBe('WRONG_STATE');
  });

  it('evidence must be of the agreed type and self-consistent', async () => {
    const { r, id } = await fundedDeal();
    const v = (await r.service.view(id)).current;
    const bad = {
      ...commitEvidence(),
      url: 'https://github.com/someone/else/commit/' + 'f'.repeat(40),
    };
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'DELIVERED',
            role: 'FREELANCER',
            evidence: bad,
          }),
        ),
      ),
    ).toBe('EVIDENCE_INVALID');
    const mismatch = { ...commitEvidence(), commitSha: 'e'.repeat(40) };
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'DELIVERED',
            role: 'FREELANCER',
            evidence: mismatch,
          }),
        ),
      ),
    ).toBe('EVIDENCE_INVALID');
    expect(
      await code(
        r.service.attest(
          await attestation({
            v,
            milestone: 0,
            kind: 'DELIVERED',
            role: 'FREELANCER',
            evidence: null,
          }),
        ),
      ),
    ).toBe('EVIDENCE_INVALID');
  });
});

describe('Deal Room terms rules', () => {
  it('rejects unfundable terms', async () => {
    const { view } = await drafted();
    const t = view.current.terms;
    expect(termProblems({ ...t, total: 1n })[0]).toMatch(/add up/);
    expect(
      termProblems({
        ...t,
        arbiter: { ...t.arbiter, wallet: t.client.wallet },
      }),
    ).toContain(
      'client, freelancer and arbiter must be three different wallets',
    );
    expect(
      termProblems(t, {
        token: `0x${'ee'.repeat(20)}`,
        chainId: t.asset.chainId,
        escrow: ESCROW,
      }),
    ).toContain('asset is not the registry asset for this deployment');
    expect(
      termProblems({ ...t, refundAfter: t.milestones[1]!.deadline }),
    ).toContain('refundAfter must be after the last milestone deadline');
  });
});
