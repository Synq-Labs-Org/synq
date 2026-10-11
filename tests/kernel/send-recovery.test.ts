import { describe, expect, it } from 'vitest';
import { Kernel } from '@synq/kernel';
import {
  harness,
  evidence,
  intent,
  grantFor,
  allPlugins,
  AUDIT_KEY,
  expectDraft,
} from './fixtures.js';
function reopen(h: ReturnType<typeof harness>) {
  return Kernel.restore(h.kernel.snapshot(), {
    clock: h.clock,
    approvalLedger: h.ledger,
    membershipDirectory: h.directory,
    nonceStatus: h.chain,
    freshness: { probe: h.probe, maxLagBlocks: 0 },
    plugins: allPlugins(),
    auditKey: AUDIT_KEY,
  });
}
describe('read-only Send authorization recovery (SIMULATION)', () => {
  it('restores the identical pending draft after restart without another authorization or reservation', async () => {
    const request = evidence(intent({ nonce: '501' }));
    const h = harness(request);
    expect(h.kernel.recoverAuthorization(request)).toEqual({
      status: 'ABSENT',
    });
    const original = await h.kernel.authorize({ ...request, approvals: [] });
    expect(original.status).toBe('PENDING_APPROVAL');
    const kernel = reopen(h);
    const before = kernel.auditLog().length;
    const recovered = kernel.recoverAuthorization(request);
    expect(recovered.status).toBe('RECOVERED');
    if (recovered.status !== 'RECOVERED') throw new Error('missing recovery');
    expect(recovered.decision.status).toBe('PENDING_APPROVAL');
    expect(expectDraft(recovered.decision)).toEqual(expectDraft(original));
    expect(kernel.auditLog()).toHaveLength(before);
    expect(kernel.accounting('group_1', 'mandate_1').reservedToken).toBe('0');
  });
  it('restores the identical issued grant and leaves exactly one reservation after response loss', async () => {
    const request = evidence(intent({ nonce: '502' }));
    const h = harness(request);
    const original = await grantFor(h, request);
    const kernel = reopen(h);
    const before = kernel.auditLog().length;
    for (let i = 0; i < 3; i++) {
      const recovered = kernel.recoverAuthorization(request);
      expect(recovered.status).toBe('RECOVERED');
      if (
        recovered.status !== 'RECOVERED' ||
        recovered.decision.status !== 'AUTHORIZED'
      )
        throw new Error('missing grant');
      expect(recovered.decision.grant).toEqual(original.grant);
      expect(recovered.decision.draft).toEqual(original.draft);
    }
    expect(kernel.auditLog()).toHaveLength(before);
    expect(kernel.snapshot().grants).toHaveLength(1);
    expect(kernel.accounting('group_1', 'mandate_1').reservedToken).toBe(
      request.intent.maxInputAmount,
    );
    expect(
      kernel.recoverAuthorization({
        ...request,
        simulation: {
          ...request.simulation,
          artifactHash: `0x${'aa'.repeat(32)}`,
        },
      }),
    ).toEqual({ status: 'UNKNOWN' });
  });
});
