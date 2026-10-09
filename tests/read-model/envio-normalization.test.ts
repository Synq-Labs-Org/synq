import { it, expect } from 'vitest';
import { canonicalEventPayload } from '../../indexer/envio/src/normalize.js';
it('normalizes only ABI bytes4 selector zero padding observed in real Envio3.14', () => {
  expect(
    canonicalEventPayload({
      selector: `0xa9059cbb${'0'.repeat(56)}`,
      amount: 12n,
    }),
  ).toEqual({ selector: '0xa9059cbb', amount: '12' });
  expect(canonicalEventPayload({ selector: '0xa9059cbb' })).toEqual({
    selector: '0xa9059cbb',
  });
  expect(() =>
    canonicalEventPayload({ selector: `0xa9059cbb${'0'.repeat(55)}1` }),
  ).toThrow('padding');
  expect(() => canonicalEventPayload({ selector: '0xa9059c' })).toThrow(
    'padding',
  );
  expect(canonicalEventPayload({ grantHash: `0x${'f'.repeat(64)}` })).toEqual({
    grantHash: `0x${'f'.repeat(64)}`,
  });
});
