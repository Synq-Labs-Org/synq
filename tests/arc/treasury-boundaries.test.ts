import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';

function workspace(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'synq-treasury-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
    return checkArchitecture(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const pkg = (name: string) => JSON.stringify({ name, exports: './index.ts' });
const kuru = {
  'plugins/kuru/package.json': pkg('@synq/plugin-kuru'),
  'plugins/kuru/index.ts': 'export const kuru = 1;\n',
};

describe('Circle treasury packages stay on the Arc path and hold no keys', () => {
  it('Arc swap, USYC and strategies cannot reach archived Monad venues (Kuru/Perpl)', () => {
    for (const [dir, name] of [
      ['plugins/arc-swap', '@synq/plugin-arc-swap'],
      ['plugins/usyc', '@synq/plugin-usyc'],
      ['plugins/circle-earn', '@synq/plugin-circle-earn'],
      ['packages/strategies', '@synq/strategies'],
    ] as const) {
      const errors = workspace({
        ...kuru,
        [`${dir}/package.json`]: pkg(name),
        [`${dir}/index.ts`]: "import { kuru } from '@synq/plugin-kuru';\n",
      });
      expect([
        dir,
        errors.some((e) => e.includes('archived Monad integration')),
      ]).toEqual([dir, true]);
    }
    // Transitively through the old strategy engine as well.
    const transitive = workspace({
      'packages/strategies/package.json': pkg('@synq/strategies'),
      'packages/strategies/index.ts':
        "import { x } from '@synq/strategy-engine';\n",
      'packages/strategy-engine/package.json': pkg('@synq/strategy-engine'),
      'packages/strategy-engine/index.ts':
        "import { perpl } from '@synq/plugin-perpl';\nexport const x = perpl;\n",
      'plugins/perpl/package.json': pkg('@synq/plugin-perpl'),
      'plugins/perpl/index.ts': 'export const perpl = 1;\n',
    });
    expect(
      transitive.some((e) => e.includes('archived Monad integration')),
    ).toBe(true);
  });

  it('the Earn, swap, USYC, paymaster and gas plugins are planner zones: no signing primitives', () => {
    for (const dir of [
      'plugins/circle-earn',
      'plugins/arc-swap',
      'plugins/usyc',
      'plugins/circle-paymaster',
      'packages/strategies',
    ]) {
      const errors = workspace({
        [`${dir}/package.json`]: pkg(`@synq/${dir.split('/')[1]}`),
        [`${dir}/index.ts`]:
          "import { privateKeyToAccount } from 'viem/accounts';\nexport const a = privateKeyToAccount;\n",
      });
      expect([dir, errors.length > 0]).toEqual([dir, true]);
    }
  });

  it('the real packages import no signer and no legacy venue', () => {
    for (const f of [
      'plugins/circle-app-kit/src/index.ts',
      'plugins/circle-earn/src/index.ts',
      'plugins/arc-swap/src/index.ts',
      'plugins/usyc/src/index.ts',
      'plugins/circle-paymaster/src/index.ts',
      'plugins/circle-gas/src/index.ts',
      'packages/strategies/src/index.ts',
    ]) {
      const src = readFileSync(f, 'utf8');
      expect([
        f,
        /viem\/accounts|plugin-(kuru|perpl)|execution-worker/.test(src),
      ]).toEqual([f, false]);
    }
  });
});
