import { describe, expect, it } from 'vitest';
import {
  demoReferences,
  scanRuntime,
} from '../../scripts/check-no-demo-data.mjs';
describe('G12 no demo identities in shipped runtime', () => {
  it('rejects known identities and address prefixes even in identifiers and mixed case', () => {
    for (const text of [
      'Sarah',
      'PRiYA',
      'Arjun',
      'Goa crew',
      '0xb781505e',
      '0x6bd6abcd',
      'sarahVerified',
    ])
      expect(demoReferences(text)).toHaveLength(1);
    expect(demoReferences('verifiedRecipient')).toEqual([]);
  });
  it('scans runtime source while keeping preview samples and tests separate', () => {
    expect(scanRuntime()).toEqual([]);
  });
});
