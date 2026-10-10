import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { canaryGate, usdCents } from '@synq/plugin-kuru';

describe('Kuru mainnet canary gate', () => {
  it('parses USD caps to cents and rejects malformed caps', () => {
    expect(usdCents('1')).toBe(100n);
    expect(usdCents('0.5')).toBe(50n);
    expect(usdCents('2.05')).toBe(205n);
    for (const bad of [undefined, '', '-1', '1.234', 'abc', '1e3'])
      expect(usdCents(bad)).toBe(0n);
  });
  it('refuses under the run defaults, with flags on but no execution path, and when the notional exceeds the cap', () => {
    const defaults = canaryGate({
      env: {
        SYNQ_ALLOW_MAINNET_BROADCAST: 'false',
        SYNQ_MAINNET_CANARY_MAX_USD: '0',
      },
      notionalUsdCents: 10n,
      executionPathAvailable: false,
    });
    expect(defaults).toMatchObject({ broadcast: false, mode: 'CANARY_READY' });
    expect(defaults.reasons).toHaveLength(3);
    const flagsOn = canaryGate({
      env: {
        SYNQ_ALLOW_MAINNET_BROADCAST: 'true',
        SYNQ_MAINNET_CANARY_MAX_USD: '1',
      },
      notionalUsdCents: 10n,
      executionPathAvailable: false,
    });
    expect(flagsOn.broadcast).toBe(false);
    expect(flagsOn.reasons).toEqual([
      expect.stringContaining('no on-chain swap execution path'),
    ]);
    expect(
      canaryGate({
        env: {
          SYNQ_ALLOW_MAINNET_BROADCAST: 'true',
          SYNQ_MAINNET_CANARY_MAX_USD: '0.05',
        },
        notionalUsdCents: 10n,
        executionPathAvailable: true,
      }).reasons,
    ).toEqual(['trade notional exceeds SYNQ_MAINNET_CANARY_MAX_USD']);
  });
  it('the canary script and the Kuru plugin never reference a signer', () => {
    const grep = spawnSync(
      'grep',
      [
        '-rlE',
        'privateKeyToAccount|createWalletClient|sendTransaction|sendRawTransaction|writeContract|signTransaction|SYNQ_TESTNET_KEY_FILE',
        'scripts/kuru-canary.ts',
        'scripts/kuru-evidence.ts',
        'plugins/kuru/src',
      ],
      { encoding: 'utf8' },
    );
    expect(grep.stdout).toBe('');
  });
});
