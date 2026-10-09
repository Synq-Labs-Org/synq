import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';

function workspace(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'synq-boundary-'));
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

describe('dependency boundary rules', () => {
  it('detects indirect forbidden planner signing imports and dependency cycles', () => {
    const errors = workspace({
      'packages/agent-runtime/index.ts':
        "import { signer } from '../../workers/execution/index.js';\n",
      'workers/execution/index.ts':
        "import '../../packages/agent-runtime/index.js';\n",
    });
    expect(errors.some((e) => e.includes('signing authority'))).toBe(true);
    expect(errors.some((e) => e.includes('cycle'))).toBe(true);
    expect(
      errors.some((e) => e.includes('cross-package relative import')),
    ).toBe(true);
  });
  it('resolves @synq/* workspace imports for transitive signer reachability', () => {
    const errors = workspace({
      'apps/web/package.json': pkg('@synq/web'),
      'apps/web/page.ts': "import { run } from '@synq/adapter';\n",
      'packages/adapter/package.json': pkg('@synq/adapter'),
      'packages/adapter/index.ts':
        "export { sign as run } from '@synq/execution-worker/journal';\n",
      'workers/execution/package.json': pkg('@synq/execution-worker'),
      'workers/execution/journal.ts': 'export const sign = () => 1;\n',
    });
    expect(errors).toContain(
      'planner transitive signing authority: apps/web -> packages/adapter -> workers/execution',
    );
  });
  it('flags packages that hold viem accounts as signers for UI and plugin paths', () => {
    const errors = workspace({
      'plugins/kuru/package.json': pkg('@synq/plugin-kuru'),
      'plugins/kuru/index.ts': "import { wallet } from '@synq/keys';\n",
      'packages/keys/package.json': pkg('@synq/keys'),
      'packages/keys/index.ts':
        "import { privateKeyToAccount } from 'viem/accounts';\nexport const wallet = privateKeyToAccount;\n",
    });
    expect(
      errors.some((e) =>
        e.startsWith('planner transitive signing authority: plugins/kuru'),
      ),
    ).toBe(true);
  });
  it('forbids viem account and wallet APIs directly in UI code', () => {
    for (const source of [
      "import { privateKeyToAccount } from 'viem/accounts';\n",
      "import { createWalletClient } from 'viem';\n",
      'export const send = (c: { sendTransaction(): void }) => c.sendTransaction();\n',
    ])
      expect(
        workspace({ 'apps/web/page.ts': source }).some((e) =>
          e.includes('signing authority'),
        ),
        source,
      ).toBe(true);
    expect(
      workspace({
        'apps/web/page.ts':
          "import { recoverTypedDataAddress } from 'viem';\nexport const r = recoverTypedDataAddress;\n",
      }),
    ).toEqual([]);
  });
  it('detects @synq/* cycles and deterministic-authority model or signer imports', () => {
    const cycle = workspace({
      'packages/a/package.json': pkg('@synq/a'),
      'packages/a/index.ts': "export * from '@synq/b';\n",
      'packages/b/package.json': pkg('@synq/b'),
      'packages/b/index.ts': "export * from '@synq/a';\n",
    });
    expect(cycle.filter((e) => e.startsWith('dependency cycle'))).toHaveLength(
      1,
    );
    const kernel = workspace({
      'packages/kernel/index.ts':
        "import OpenAI from 'openai';\nimport '@synq/execution-worker';\n",
      'workers/execution/package.json': pkg('@synq/execution-worker'),
      'workers/execution/index.ts': 'export {};\n',
    });
    expect(
      kernel.filter((e) => e.includes('deterministic authority imports')),
    ).toHaveLength(2);
    expect(workspace({ 'packages/kernel/index.ts': "import 'x';\n" })).toEqual(
      [],
    );
  });
  it('uses the syntax tree for any detection rather than text matching', () => {
    expect(
      workspace({ 'packages/domain/index.ts': 'export const x: any = 1;\n' }),
    ).toEqual(['packages/domain/index.ts: unchecked any']);
    expect(
      workspace({
        'packages/domain/index.ts':
          "export const note = 'cast as any is forbidden';\n",
      }),
    ).toEqual([]);
    expect(
      workspace({ 'packages/domain/index.ts': "import '@synq/missing';\n" }),
    ).toEqual([
      'packages/domain/index.ts: unknown workspace package @synq/missing',
    ]);
  });
});
