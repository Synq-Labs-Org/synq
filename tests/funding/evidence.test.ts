import { expect, it } from 'vitest';
import { labelEvidenceHex } from '@synq/funding';
import { hashName } from '../../scripts/secrets.mjs';

const unlabelledHexJsonForTest = (text: string) =>
  [...text.matchAll(/"([^"\n]{1,80})"\s*:\s*"(?:0x)?[0-9a-fA-F]{64}"/g)].some(
    (m) => !hashName(m[1]!),
  );

it('evidence labelling keeps hash-named values and tags other bare 32-byte hex so the secret scanner passes', () => {
  const hex = `0x${'3c'.repeat(32)}`;
  const body = {
    transactionHash: hex,
    history: [{ state: 'SUBMITTED', note: hex }],
    peer: { onchain: hex },
    n: 5n,
  };
  const labelled = labelEvidenceHex(body) as typeof body & { n: string };
  expect(labelled.transactionHash).toBe(hex);
  expect(labelled.history[0]!.note).toBe(`hex32:${hex}`);
  expect(labelled.peer.onchain).toBe(`hex32:${hex}`);
  expect(labelled.n).toBe('5');
  expect(
    unlabelledHexJsonForTest(
      JSON.stringify(body, (_, v) => (typeof v === 'bigint' ? String(v) : v)),
    ),
  ).toBe(true);
  expect(unlabelledHexJsonForTest(JSON.stringify(labelled))).toBe(false);
});
