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
  it('refuses imports of forge build output, which CI typechecks before building', () => {
    // Split so this file does not trip the rule it tests.
    const out = ['contracts', 'out'].join('/');
    const errors = workspace({
      'tests/a.test.ts': `import token from '../${out}/T.sol/T.json' with { type: 'json' };\n`,
      'tests/b.test.ts': `const t = await import('../${out}/T.sol/T.json');\n`,
      'tests/c.test.ts': `const t = readFileSync(new URL('../${out}/T.sol/T.json', import.meta.url));\n`,
    });
    const flagged = errors.filter((e) => e.includes('forge build output'));
    expect(flagged).toEqual([
      'tests/a.test.ts: imports forge build output from contracts/out',
      'tests/b.test.ts: imports forge build output from contracts/out',
    ]);
  });
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
  it.each([
    [
      'plugins/kuru/index.ts',
      'export const load = (m: string) => import(m);\n',
    ],
    [
      'packages/kernel/index.ts',
      'declare const require: (m: string) => unknown;\nexport const load = (m: string) => require(m);\n',
    ],
    [
      'apps/web/page.ts',
      "import { createRequire } from 'node:module';\nconst req = createRequire(import.meta.url);\nexport const v = req('viem' + '/accounts');\n",
    ],
    [
      'packages/agent-runtime/index.ts',
      'export const load = (m: string) => import(`viem/${m}`);\n',
    ],
  ])('computed module loading fails closed in %s', (file, source) => {
    expect(
      workspace({ [file]: source }).some((e) =>
        e.includes('unresolvable dynamic module loading'),
      ),
    ).toBe(true);
  });
  it('literal dynamic imports resolve normally and stay unflagged when harmless', () => {
    expect(
      workspace({
        'plugins/kuru/index.ts':
          "export const load = () => import('zod');\nexport const tpl = () => import(`zod`);\n",
      }),
    ).toEqual([]);
  });
  it('plugins and planners may not reach the demo controller, which holds keys', () => {
    expect(
      workspace({
        'apps/demo/package.json': pkg('@synq/demo'),
        'apps/demo/index.ts':
          "import { privateKeyToAccount } from 'viem/accounts';\nexport const keys = privateKeyToAccount;\n",
        'plugins/kuru/package.json': pkg('@synq/plugin-kuru'),
        'plugins/kuru/index.ts': "import { keys } from '@synq/demo';\n",
      }),
    ).toContain(
      'planner transitive signing authority: plugins/kuru -> apps/demo',
    );
  });
  it('node:crypto signing primitives are forbidden in Kernel and planner zones', () => {
    for (const [file, source] of [
      ['packages/kernel/index.ts', "import { sign } from 'node:crypto';\n"],
      [
        'packages/kernel/index.ts',
        "import { generateKeyPairSync } from 'crypto';\n",
      ],
      [
        'packages/agent-runtime/index.ts',
        "import * as crypto from 'node:crypto';\nexport const s = () => crypto.createSign('sha256');\n",
      ],
      [
        'plugins/kuru/index.ts',
        "import nodeCrypto from 'node:crypto';\nexport const k = () => nodeCrypto.generateKeyPair;\n",
      ],
    ] as const)
      expect(workspace({ [file]: source }), source).not.toEqual([]);
    expect(
      workspace({
        'packages/kernel/index.ts':
          "import { randomUUID, createHash } from 'node:crypto';\nexport const v = [randomUUID, createHash];\n",
      }),
    ).toEqual([]);
  });
  it('dynamic crypto loading, element access, WebCrypto signing and code evaluation are flagged in restricted zones', () => {
    const flagged = [
      "export const f = async () => { const { sign } = await import('node:crypto'); return sign; };\n",
      "export const f = async () => { const { sign: s } = await import('crypto'); return s; };\n",
      "export const f = async () => { const c = await import('node:crypto'); return c.createSign('sha256'); };\n",
      "export const f = async () => (await import('node:crypto')).generateKeyPairSync;\n",
      "export const f = async () => (await import('node:crypto'))['sign'];\n",
      "export const f = () => import('node:crypto').then((c) => c.sign);\n",
      "export const f = async () => { const { ...all } = await import('node:crypto'); return all; };\n",
      "import * as c from 'node:crypto';\nexport const f = () => c['sign'];\n",
      "import * as c from 'node:crypto';\nconst k = 'si' + 'gn';\nexport const f = () => c[k];\n",
      "const { sign } = require('node:crypto');\nexport const f = sign;\n",
      "export const f = () => process.getBuiltinModule('node:crypto');\n",
      "export const f = (k: CryptoKey, d: Uint8Array) => crypto.subtle.sign('ECDSA', k, d);\n",
      "export const f = (k: CryptoKey, d: Uint8Array) => globalThis.crypto.subtle['sign']('ECDSA', k, d);\n",
      "export const f = () => new Function('return 1');\n",
      "export const f = () => new globalThis.Function('return 1');\n",
      "export const f = () => eval('1');\n",
      "export const f = () => globalThis.require('node:crypto');\n",
      "export const f = () => module.require('node:crypto');\n",
      "export const f = () => globalThis['require'];\n",
    ];
    for (const source of flagged)
      for (const file of [
        'packages/kernel/index.ts',
        'packages/agent-runtime/index.ts',
      ])
        expect(workspace({ [file]: source }), `${file}: ${source}`).not.toEqual(
          [],
        );
    for (const source of [
      "export const f = async () => { const { createHash, randomUUID } = await import('node:crypto'); return [createHash, randomUUID]; };\n",
      "export const f = async () => (await import('node:crypto')).createHmac;\n",
      "import * as c from 'node:crypto';\nexport const f = () => c['createHash']('sha256');\n",
      "export const f = (d: Uint8Array) => crypto.subtle.digest('SHA-256', d);\n",
      "export const f = (o: { sign: number }) => o['sign'];\n",
    ])
      expect(workspace({ 'packages/kernel/index.ts': source }), source).toEqual(
        [],
      );
    expect(
      workspace({
        'workers/execution/index.ts':
          "export const f = async () => (await import('node:crypto')).sign;\n",
      }),
    ).toEqual([]);
  });
  it('type-only references to signing modules are not runtime authority', () => {
    expect(
      workspace({
        'apps/web/page.ts': [
          "import type { PrivateKeyAccount } from 'viem/accounts';",
          "import { type LocalAccount } from 'viem/accounts';",
          "import type { privateKeyToAccount } from 'viem/accounts';",
          "export type A = import('viem/accounts').PrivateKeyAccount;",
          'export type B = PrivateKeyAccount | LocalAccount;',
          'export type C = typeof privateKeyToAccount;',
          "export type { HDKey } from '@scure/bip32';",
          '',
        ].join('\n'),
        'packages/kernel/index.ts':
          "import type { Wallet } from 'ethers';\nexport type W = Wallet;\n",
      }),
    ).toEqual([]);
    expect(
      workspace({
        'apps/web/page.ts':
          "import { type LocalAccount, privateKeyToAccount } from 'viem/accounts';\nexport type L = LocalAccount;\nexport const p = privateKeyToAccount;\n",
      }).some((e) => e.includes('signing authority')),
    ).toBe(true);
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
  it('forbids raw chain-id literal comparisons outside the registry packages', () => {
    expect(
      workspace({
        'workers/execution/index.ts':
          'export const f = (g: { chainId: number }) => g.chainId === 143;\n',
        'apps/api/index.ts':
          'export const f = (chainId: number) => 31337 !== chainId;\n',
      }).sort(),
    ).toEqual([
      'apps/api/index.ts: raw chain-id comparison 31337 !== chainId; use @synq/chain-registry profile helpers',
      'workers/execution/index.ts: raw chain-id comparison g.chainId === 143; use @synq/chain-registry profile helpers',
    ]);
    expect(
      workspace({
        'workers/execution/deployment.ts':
          "import { z } from 'zod';\nexport const s = z.literal(10143);\nexport const local = { chainId: 31337 };\n",
        'apps/demo/safe.ts':
          'export const f = async (c: { getChainId(): Promise<number> }) => (await c.getChainId()) !== 143;\n',
      }).sort(),
    ).toEqual([
      'apps/demo/safe.ts: raw chain-id comparison (await c.getChainId()) !== 143; use @synq/chain-registry profile helpers',
      'workers/execution/deployment.ts: raw chain-id comparison 10143, 31337; use @synq/chain-registry profile helpers',
    ]);
    expect(
      workspace({
        'packages/schemas/index.ts':
          'export const f = (chainId: number) => chainId === 143;\n',
        'workers/execution/index.test.ts':
          'export const f = (chainId: number) => chainId === 143;\n',
        'workers/execution/other.ts':
          'export const f = (g: { count: number }) => g.count === 143;\n',
      }),
    ).toEqual([]);
  });

  it('P01-03 keeps archived Monad integrations out of the Arc runtime, even transitively', () => {
    const direct = workspace({
      'packages/invoices/package.json': pkg('@synq/invoices'),
      'packages/invoices/index.ts':
        "import { kuru } from '@synq/plugin-kuru';\n",
      'plugins/kuru/package.json': pkg('@synq/plugin-kuru'),
      'plugins/kuru/index.ts': 'export const kuru = 1;\n',
    });
    expect(direct.some((e) => e.includes('archived Monad integration'))).toBe(
      true,
    );
    const transitive = workspace({
      'packages/settlement/package.json': pkg('@synq/settlement'),
      'packages/settlement/index.ts': "import { x } from '@synq/bridge';\n",
      'packages/bridge/package.json': pkg('@synq/bridge'),
      'packages/bridge/index.ts':
        "import { perpl } from '@synq/perpl-executor';\nexport const x = perpl;\n",
      'workers/perpl-executor/package.json': pkg('@synq/perpl-executor'),
      'workers/perpl-executor/index.ts': 'export const perpl = 1;\n',
    });
    expect(
      transitive.some((e) =>
        e.includes('settlement -> packages/bridge -> workers/perpl-executor'),
      ),
    ).toBe(true);
  });
  it('P01-06 brain packages still cannot import restricted signers', () => {
    const errors = workspace({
      'packages/agent-runtime/package.json': pkg('@synq/agent-runtime'),
      'packages/agent-runtime/index.ts':
        "import { sign } from '@synq/execution-worker';\n",
      'workers/execution/package.json': pkg('@synq/execution-worker'),
      'workers/execution/index.ts':
        "import { privateKeyToAccount } from 'viem/accounts';\nexport const sign = privateKeyToAccount;\n",
    });
    expect(
      errors.some(
        (e) => e.includes('signing authority') || e.includes('Brain zone'),
      ),
    ).toBe(true);
  });
});
