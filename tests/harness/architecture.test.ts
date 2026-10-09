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
  it.each([
    ['ethers Wallet', "import { Wallet } from 'ethers';\n"],
    ['ethers namespace', "import * as ethers from 'ethers';\n"],
    ['ethers HD wallet', "import { HDNodeWallet } from 'ethers';\n"],
    [
      'viem/actions signMessage',
      "import { signMessage } from 'viem/actions';\n",
    ],
    [
      'viem/actions signTypedData',
      "import { signTypedData } from 'viem/actions';\n",
    ],
    [
      'viem/actions writeContract',
      "import { writeContract } from 'viem/actions';\n",
    ],
    [
      'viem/actions sendTransaction',
      "import { sendTransaction } from 'viem/actions';\n",
    ],
    [
      'noble secp256k1',
      "import { secp256k1 } from '@noble/curves/secp256k1';\n",
    ],
    ['noble secp256k1 package', "import * as secp from '@noble/secp256k1';\n"],
    ['scure bip32 HDKey', "import { HDKey } from '@scure/bip32';\n"],
    [
      'dynamic viem accounts',
      "export const load = () => import('viem/accounts');\n",
    ],
  ])(
    'signing primitive %s is forbidden in UI, planner, plugin and Kernel zones',
    (_name, source) => {
      for (const zone of [
        'apps/web/page.ts',
        'packages/agent-runtime/index.ts',
        'plugins/kuru/index.ts',
        'packages/kernel/index.ts',
      ])
        expect(
          workspace({ [zone]: source }).some(
            (e) =>
              e.includes('signing authority') ||
              e.includes('deterministic authority imports forbidden'),
          ),
          zone,
        ).toBe(true);
    },
  );
  it('verification-only APIs stay available to the Kernel and UI', () => {
    expect(
      workspace({
        'packages/kernel/index.ts':
          "import { recoverTypedDataAddress, verifyTypedData, hashTypedData, keccak256 } from 'viem';\nimport { verifyTypedData as verify, TypedDataEncoder } from 'ethers';\nexport const v = [recoverTypedDataAddress, verifyTypedData, hashTypedData, keccak256, verify, TypedDataEncoder];\n",
        'apps/web/page.ts':
          "import { createPublicClient, http, readContract } from 'viem';\nexport const c = [createPublicClient, http, readContract];\n",
      }),
    ).toEqual([]);
  });
  it('UI may reach the human-signing identity boundary; planners, plugins and the Kernel may not', () => {
    const base = {
      'packages/identity/package.json': pkg('@synq/identity'),
      'packages/identity/index.ts':
        "import { HDKey } from '@scure/bip32';\nexport const derive = HDKey;\n",
    };
    expect(
      workspace({
        ...base,
        'apps/web/package.json': pkg('@synq/web'),
        'apps/web/page.ts': "import { derive } from '@synq/identity';\n",
      }),
    ).toEqual([]);
    expect(
      workspace({
        ...base,
        'plugins/kuru/package.json': pkg('@synq/plugin-kuru'),
        'plugins/kuru/index.ts': "import { derive } from '@synq/identity';\n",
      }),
    ).toContain(
      'planner transitive signing authority: plugins/kuru -> packages/identity',
    );
    expect(
      workspace({
        ...base,
        'packages/kernel/package.json': pkg('@synq/kernel'),
        'packages/kernel/index.ts':
          "import { derive } from '@synq/identity';\n",
      }),
    ).toContain(
      'deterministic authority transitive signing authority: packages/kernel -> packages/identity',
    );
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
