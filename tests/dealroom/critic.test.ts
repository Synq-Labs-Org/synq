import { describe, expect, it } from 'vitest';
import { admitEscrowGrant } from '@synq/kernel/arc-escrow';
import {
  dealLinkToken,
  verifyDealLink,
  termsFromProposal,
  proposeDeterministic,
} from '@synq/dealroom';
import {
  ASSET,
  ESCROW,
  enrolledChat,
  parties,
  attestation,
  commitEvidence,
  T0,
  GRANT_CONFIG,
  acceptSig,
  client,
  freelancer,
  fundedRecord,
  kernel,
  mandate,
  signedBoth,
} from './harness.js';

async function funding(r: Awaited<ReturnType<typeof signedBoth>>) {
  const m = await mandate({
    owner: client,
    id: `mnd_${r.view.deal.dealId}`,
    payer: client.address,
    recipients: [ESCROW],
    purposes: ['ESCROW_FUNDING'],
    cap: r.view.current.terms.total,
    budget: r.view.current.terms.total,
  });
  const auth = await r.service.authorizeFunding(r.view.deal.dealId, kernel(m));
  if (auth.decision.outcome !== 'ALLOW')
    throw new Error(auth.decision.reasons.join());
  return { auth, m, grant: auth.decision.grant };
}

describe('Deal Room critic regressions', () => {
  it.each([1, 3])(
    'CR-01: counteroffer with %i milestones is rebuilt and exactly mirrors funding',
    async (count) => {
      const r = await signedBoth();
      const v = r.view.current;
      const milestones = Array.from({ length: count }, (_, index) => ({
        ...v.terms.milestones[0]!,
        index,
        amount: 10_000n,
        deadline: T0 + (index + 1) * 86400,
      }));
      const terms = {
        ...v.terms,
        milestones,
        total: BigInt(count) * 10_000n,
        deposit: BigInt(count) * 10_000n,
      };
      const prep = await r.service.prepareCounteroffer({
        dealId: v.dealId,
        baseVersion: 1,
        by: 'FREELANCER',
        terms,
      });
      let next = await r.service.counteroffer({
        dealId: v.dealId,
        baseVersion: 1,
        by: 'FREELANCER',
        terms,
        signature: await freelancer.signTypedData(prep.typedData),
      });
      expect(next.deal.milestones).toHaveLength(count);
      next = await r.service.sign({
        dealId: v.dealId,
        version: 2,
        role: 'CLIENT',
        signature: await acceptSig(r.service, next.current, 'CLIENT'),
      });
      await funding({ ...r, view: next });
      const funded = await r.service.recordFunded({
        dealId: v.dealId,
        ...fundedRecord(next.current),
      });
      expect(funded.deal.milestones).toHaveLength(count);
      expect(funded.deal.milestones.every((m) => m.status === 'FUNDED')).toBe(
        true,
      );
    },
  );

  it('CR-02: ambiguous broadcast stays in review and cannot produce a second funding grant', async () => {
    const r = await signedBoth();
    const { m } = await funding(r);
    const view = await r.service.fundingFailed(r.view.deal.dealId, {
      reason: 'receipt timeout',
      broadcast: [
        {
          step: 'OPEN',
          hash: fundedRecord(r.view.current).execution.txs[0]!.hash,
        },
      ],
    });
    expect(view.deal.status).toBe('NEEDS_REVIEW');
    await expect(
      r.service.authorizeFunding(view.deal.dealId, kernel(m)),
    ).rejects.toThrow();
  });

  it('CR-02: a proven non-broadcast retires the first funding grant before permitting a retry', async () => {
    const r = await signedBoth();
    const { auth, grant, m } = await funding(r);
    expect(
      (
        await r.service.fundingFailed(r.view.deal.dealId, {
          reason: 'before broadcast',
          broadcast: [],
        })
      ).deal.status,
    ).toBe('ACCEPTED');
    await expect(
      admitEscrowGrant({
        grantKey: GRANT_CONFIG.grantKey,
        grant,
        call: auth.call,
        now: T0,
        mandateRevoked: false,
        fence: r.executorFence,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_REPLAYED' });
    expect(
      (await r.service.authorizeFunding(r.view.deal.dealId, kernel(m))).decision
        .outcome,
    ).toBe('ALLOW');
  });

  it('CR-03: an asset word cannot support a fabricated amount or a chat-sourced wallet', async () => {
    const { context } = await enrolledChat();
    const proposal = proposeDeterministic(context);
    const out = termsFromProposal({
      proposal: {
        ...proposal,
        total: '900',
        citations: [
          { term: 'total', messageId: '902', quote: 'USDC' },
          { term: 'milestones.0.payee', messageId: '902', quote: 'USDC' },
          { term: 'arbiter', messageId: '903', quote: 'Synq Labs' },
        ],
      },
      interpretation: {
        kind: 'AI_INTERPRETATION',
        provider: 'fixture',
        model: 'fixture',
        mode: 'REPLAY',
        requestHash: null,
        responseHash: null,
      },
      context,
      parties,
      asset: ASSET,
      escrow: ESCROW,
      now: T0,
      settings: {
        disputePeriodSeconds: 30 * 86400,
        refundGraceSeconds: 7 * 86400,
        offerTtlSeconds: 3 * 86400,
      },
    });
    expect(
      out.provenance.total!.some((p) => p.kind === 'ORIGINAL_MESSAGE'),
    ).toBe(false);
    expect(out.provenance['milestones.0.payee']).toMatchObject([
      { kind: 'VERIFIED_LINK' },
    ]);
    expect(out.provenance.arbiter).toMatchObject([{ kind: 'VERIFIED_LINK' }]);
    expect(out.ambiguities.length).toBeGreaterThan(0);
  });

  it('CR-04/06: client metadata cannot verify evidence or reuse another milestone execution', async () => {
    const r = await signedBoth();
    await funding(r);
    const v = r.view.current;
    const id = v.dealId;
    await r.service.recordFunded({ dealId: id, ...fundedRecord(v) });
    const evidence = { ...commitEvidence(), verifiedBy: 'GITHUB_API' as const };
    const delivered = await r.service.attest(
      await attestation({
        v,
        milestone: 0,
        kind: 'DELIVERED',
        role: 'FREELANCER',
        evidence,
      }),
    );
    expect(delivered.attestations[0]!.evidence!.verifiedBy).toBeNull();
    for (const milestone of [0, 1])
      await r.service.attest(
        await attestation({
          v,
          milestone,
          kind: 'CANCEL_REFUND',
          role: 'FREELANCER',
          evidence: null,
        }),
      );
    const hash = `0x${'ba'.repeat(32)}` as const;
    const execution = {
      op: 'REFUND' as const,
      milestone: 0,
      escrowDealId: 7n,
      txs: [{ hash, label: 'refund', from: freelancer.address, feeWei: 1n }],
      transfers: [
        {
          hash,
          logIndex: 1,
          from: ESCROW,
          to: client.address,
          value: v.terms.milestones[0]!.amount,
        },
      ],
    };
    await r.service.recordRefunded({ dealId: id, milestone: 0, execution });
    await expect(
      r.service.recordRefunded({ dealId: id, milestone: 1, execution }),
    ).rejects.toMatchObject({ code: 'FUNDING_MISMATCH' });
    expect((await r.service.view(id)).deal.milestones[1]!.status).toBe(
      'REFUNDING',
    );
  });

  it('CR-04: the transfer log hash must belong to the reported transaction', async () => {
    const r = await signedBoth();
    await funding(r);
    const rec = fundedRecord(r.view.current);
    await expect(
      r.service.recordFunded({
        dealId: r.view.deal.dealId,
        ...rec,
        execution: {
          ...rec.execution,
          transfers: rec.execution.transfers.map((t) => ({
            ...t,
            hash: `0x${'ab'.repeat(32)}` as const,
          })),
        },
      }),
    ).rejects.toMatchObject({ code: 'FUNDING_MISMATCH' });
    expect((await r.service.view(r.view.deal.dealId)).deal.status).toBe(
      'FUNDING',
    );
  });

  it('CR-05: a signed dispute period cannot differ from the deployed contract period', async () => {
    const r = await signedBoth();
    await expect(
      r.service.prepareCounteroffer({
        dealId: r.view.deal.dealId,
        baseVersion: 1,
        by: 'FREELANCER',
        terms: {
          ...r.view.current.terms,
          dispute: { ...r.view.current.terms.dispute, periodSeconds: 60 },
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TERMS' });
  });

  it('CR-09: forwardable links expire and revocation changes the epoch', () => {
    const key = new Uint8Array(32).fill(42);
    const token = dealLinkToken(key, 'deal_test', {
      expiresAt: T0 + 10,
      epoch: 0,
    });
    expect(verifyDealLink(key, 'deal_test', token, { now: T0, epoch: 0 })).toBe(
      true,
    );
    expect(
      verifyDealLink(key, 'deal_test', token, { now: T0 + 10, epoch: 0 }),
    ).toBe(false);
    expect(verifyDealLink(key, 'deal_test', token, { now: T0, epoch: 1 })).toBe(
      false,
    );
  });
});
