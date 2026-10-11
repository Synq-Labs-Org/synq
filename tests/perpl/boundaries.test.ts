import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkArchitecture } from '../../scripts/architecture.mjs';
import { PerplRestClient, exchangeAbi } from '@synq/plugin-perpl';

function workspace(files: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), 'synq-perpl-boundary-'));
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
const signerPkg = {
  'workers/perpl-executor/package.json': pkg('@synq/perpl-executor'),
  'workers/perpl-executor/index.ts': 'export const loadPerplKey = () => 1;\n',
};

describe('Perpl signer boundary', () => {
  it.each([
    'packages/agent-runtime',
    'packages/world-model',
    'plugins/qwen',
    'plugins/kimi',
    'plugins/perpl',
  ])('%s cannot import the Perpl signer or key loader', (dir) => {
    const errors = workspace({
      ...signerPkg,
      [`${dir}/package.json`]: pkg(`@synq/${dir.split('/')[1]}`),
      [`${dir}/index.ts`]:
        "export { loadPerplKey } from '@synq/perpl-executor';\n",
    });
    expect(
      errors.some((e) => e.includes('planner imports the Perpl signer')),
    ).toBe(true);
    expect(errors.some((e) => e.includes('transitive signing authority'))).toBe(
      true,
    );
  });

  it('planner zones cannot name Perpl API-key or operator key files', () => {
    for (const source of [
      'export const p = process.env.SYNQ_PERPL_TRADE_KEY_FILE;\n',
      "export const p = process.env['SYNQ_TESTNET_KEY_FILE'];\n",
      "export const p = '~/.synq/perpl/trade.key';\n",
    ])
      expect(
        workspace({
          'packages/agent-runtime/package.json': pkg('@synq/agent-runtime'),
          'packages/agent-runtime/index.ts': source,
        }).some((e) => e.includes('Perpl or operator key material')),
      ).toBe(true);
  });

  it('the repository passes the rule and plugins/perpl holds no signing primitive', () => {
    expect(
      checkArchitecture(process.cwd()).filter((e) => /perpl/i.test(e)),
    ).toEqual([]);
    const files = readdirSync('plugins/perpl/src').map((f) =>
      readFileSync(join('plugins/perpl/src', f), 'utf8'),
    );
    for (const text of files) {
      expect(text).not.toMatch(
        /@noble\/ed25519|from 'node:crypto'.*\bsign\b|privateKeyToAccount|createWalletClient/,
      );
    }
  });

  it('the client exposes no withdraw or transfer path', () => {
    const names = exchangeAbi.map((e) => e.name);
    expect(
      names.filter((n) => /withdraw|transfer|xfer|decrease/i.test(n)),
    ).toEqual([]);
    const methods = Object.getOwnPropertyNames(PerplRestClient.prototype);
    expect(methods.filter((m) => /withdraw|transfer/i.test(m))).toEqual([]);
    const sources = readdirSync('plugins/perpl/src')
      .map((f) => readFileSync(join('plugins/perpl/src', f), 'utf8'))
      .join('\n');
    expect(sources).not.toMatch(/['"`]\/v1\/[^'"`]*(withdraw|transfer)/i);
  });
});
