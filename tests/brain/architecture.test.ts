import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';

function workspace(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'synq-brain-boundary-'));
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
const ZONES = [
  ['packages/agent-runtime', '@synq/agent-runtime'],
  ['packages/world-model', '@synq/world-model'],
  ['plugins/qwen', '@synq/plugin-qwen'],
  ['plugins/kimi', '@synq/plugin-kimi'],
] as const;

describe('B06.9 Brain zones cannot reach signing, key or execution-secret code', () => {
  it('the repository itself passes', () => {
    expect(checkArchitecture(process.cwd())).toEqual([]);
  });

  it.each(ZONES)(
    '%s cannot import the execution worker, identity signer or wallet core',
    (dir, name) => {
      for (const specifier of [
        '@synq/execution-worker',
        '@synq/execution-worker/integrity',
        '@synq/identity',
        '@synq/identity/mera-browser',
        '@synq/wallet-core',
      ]) {
        const errors = workspace({
          [`${dir}/package.json`]: pkg(name),
          [`${dir}/index.ts`]: `import { x } from '${specifier}';\nexport const y = x;\n`,
        });
        expect(
          errors.some((e) => e.includes('Brain zone imports')),
          specifier,
        ).toBe(true);
      }
    },
  );

  it.each(ZONES)(
    '%s cannot reference key loaders or secret key material',
    (dir, name) => {
      const loader = workspace({
        [`${dir}/package.json`]: pkg(name),
        [`${dir}/index.ts`]:
          'export const k = (loadKernelAuditKey: () => 1) => loadKernelAuditKey();\n',
      });
      expect(
        loader.some((e) => e.includes('key loader loadKernelAuditKey')),
      ).toBe(true);
      for (const literal of [
        'SYNQ_JOURNAL_KEY_FILE',
        'SYNQ_TESTNET_KEY_FILE',
        'DEPLOYER_PRIVATE_KEY',
        'CRE_ETH_PRIVATE_KEY',
        '.synq/secrets.env',
      ]) {
        const errors = workspace({
          [`${dir}/package.json`]: pkg(name),
          [`${dir}/index.ts`]: `export const v = process.env['${literal}'];\n`,
        });
        expect(
          errors.some((e) => e.includes('secret key material')),
          literal,
        ).toBe(true);
      }
    },
  );

  it('transitive reach into the execution worker or contract owner keys is caught', () => {
    const errors = workspace({
      'packages/agent-runtime/package.json': pkg('@synq/agent-runtime'),
      'packages/agent-runtime/index.ts':
        "import { run } from '@synq/helper';\nexport const r = run;\n",
      'packages/helper/package.json': pkg('@synq/helper'),
      'packages/helper/index.ts':
        "export { loadJournalKey as run } from '@synq/execution-worker';\n",
      'workers/execution/package.json': pkg('@synq/execution-worker'),
      'workers/execution/index.ts':
        "import { privateKeyToAccount } from 'viem/accounts';\nexport const loadJournalKey = privateKeyToAccount;\n",
      'plugins/kimi/package.json': pkg('@synq/plugin-kimi'),
      'plugins/kimi/index.ts': "import '../../contracts/script/Deploy.s.ts';\n",
    });
    expect(errors).toContain(
      'planner transitive signing authority: packages/agent-runtime -> packages/helper -> workers/execution',
    );
    expect(
      errors.some((e) =>
        e.startsWith('plugins/kimi/index.ts: Brain zone imports'),
      ),
    ).toBe(true);
  });

  it('model API keys stay allowed: they are not signing keys', () => {
    expect(
      workspace({
        'plugins/qwen/package.json': pkg('@synq/plugin-qwen'),
        'plugins/qwen/index.ts':
          "export const key = process.env['QWEN_API_KEY'] ?? process.env['DASHSCOPE_API_KEY'];\n",
      }),
    ).toEqual([]);
  });
});
