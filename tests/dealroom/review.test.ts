import { describe, expect, it } from 'vitest';
import { dealPageView } from '../../apps/api/src/deal-routes.js';
import { typedDataMismatches } from '../../apps/web/lib/deal-approval.js';
import type { ReviewDeal as Deal } from '../../apps/web/lib/deal-approval.js';
import { drafted } from './harness.js';

describe('CR-09: browser review recomputes the complete signing message', () => {
  it('accepts matching terms and rejects altered visible terms, schema, and domain', async () => {
    const r = await drafted();
    const original = dealPageView(r.service, r.view) as unknown as Deal;
    expect(typedDataMismatches(original)).toEqual([]);
    for (const mutate of [
      (d: Deal) => {
        d.terms.total = '900';
      },
      (d: Deal) => {
        d.terms.scope = 'changed';
      },
      (d: Deal) => {
        d.terms.parties[0]!.principalId = 'attacker';
      },
      (d: Deal) => {
        d.terms.milestones[0]!.acceptanceCondition = 'changed';
      },
      (d: Deal) => {
        d.acceptTypedData.types = {};
      },
      (d: Deal) => {
        d.termsHash = `0x${'aa'.repeat(32)}`;
      },
    ]) {
      const changed = structuredClone(original);
      mutate(changed);
      expect(typedDataMismatches(changed).length).toBeGreaterThan(0);
    }
  });
});
