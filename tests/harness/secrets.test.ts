import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanRepository } from '../../scripts/secrets.mjs';

const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=synq-test',
      '-c',
      'user.email=test@synq.invalid',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'synq-secrets-'));
  git(dir, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  return dir;
}
const pem = [
  '-----BEGIN',
  'PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----',
].join(' ');
const hexKey = `PRIVATE_KEY=0x${'ab'.repeat(32)}`;

describe('P00-003 repository secret scan', () => {
  it('P00-003 passes a clean committed tree and flags secrets anywhere in it', () => {
    const clean = repo({
      'README.md': 'hello',
      '.env.example': 'SYNQ_NETWORK=local/anvil\n',
    });
    const dirty = repo({
      'README.md': 'hello',
      'docs/deep/nested/notes.md': pem,
      'infra/config.yaml': hexKey,
      '.env': 'SYNQ_TESTNET_KEY_FILE=/tmp/key\n',
      'deploy/operator.key': 'x',
      'reports/run.log': `Authorization: Bearer ${'x'.repeat(40)}`,
    });
    try {
      expect(scanRepository(clean)).toEqual({ scanned: 2, violations: [] });
      const { scanned, violations } = scanRepository(dirty);
      expect(scanned).toBe(6);
      expect(violations).toEqual(
        expect.arrayContaining([
          { file: 'docs/deep/nested/notes.md', rule: 'pem-private-key' },
          { file: 'infra/config.yaml', rule: 'hex-private-key-assignment' },
          { file: '.env', rule: 'dotenv-file' },
          { file: 'deploy/operator.key', rule: 'key-file' },
          { file: 'reports/run.log', rule: 'bearer-token' },
        ]),
      );
    } finally {
      rmSync(clean, { recursive: true, force: true });
      rmSync(dirty, { recursive: true, force: true });
    }
  });
  it('P00-003 the application repository itself carries no tracked secret', () => {
    const result = scanRepository(process.cwd());
    expect(result.scanned).toBeGreaterThan(100);
    expect(result.violations).toEqual([]);
  });
});
