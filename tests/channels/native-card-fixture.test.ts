import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CardLinkIssuer,
  InteractiveCardService,
  renderNativeLiveLayout,
} from '@synq/channels';

const FIXTURE = join(
  import.meta.dirname,
  '../../apps/ios-messages/Checks/native-card-fixture.json',
);

/** Deterministic native payload; the Swift check decodes the same file. */
export function nativeFixture() {
  const now = 1_800_000_000;
  const links = new CardLinkIssuer({
    key: 'native-fixture-key-0123456789abcdef',
    webBaseUrl: 'https://synq.example',
    now: () => now,
    ttlSeconds: 3600,
  });
  // Fixed nonce so the fixture is stable.
  links.nonce = () => 'v1.r.tsk2ou.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB';
  const card = new InteractiveCardService({
    webBaseUrl: 'https://synq.example',
    explorerTxUrl: 'https://testnet.monadexplorer.com/tx/',
    now: () => now,
    links,
  }).approval({
    groupId: `0x${'a1'.repeat(32)}`,
    groupLabel: 'Trip fund',
    approval: {
      intentHash: `0x${'11'.repeat(32)}`,
      draftDigest: `0x${'22'.repeat(32)}`,
      label: 'Send 1.5 AUSD to carol',
      counted: 1,
      required: 2,
      status: 'PENDING',
      kind: 'SEND',
      amount: { amount: '1.5', symbol: 'AUSD' },
      recipient: { label: 'carol', address: null },
    },
  });
  return renderNativeLiveLayout(card);
}

describe('native extension fixture', () => {
  it('matches the current native renderer output', () => {
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(JSON.parse(JSON.stringify(nativeFixture()))).toEqual(expected);
  });
});
