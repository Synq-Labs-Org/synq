import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
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
          { file: 'infra/config.yaml', rule: 'labelled-hex-key' },
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
  it('P00-003 detects labelled, bare and mnemonic key material in any form', () => {
    const hex = 'ab'.repeat(32);
    const twelve = generateMnemonic(wordlist, 128);
    const twentyFour = generateMnemonic(wordlist, 256);
    const planted: Record<string, [string, string]> = {
      'deploy/testnet.env.sh': [
        `PRIVATE_KEY_TESTNET=0x${hex}\n`,
        'labelled-hex-key',
      ],
      'deploy/config.yaml': [`deployer_pk: ${hex}\n`, 'labelled-hex-key'],
      'src/wallet.ts': [
        `const operatorKey = '0x${hex}';\n`,
        'labelled-hex-key',
      ],
      'notes/backup.txt': [`0x${hex}\n`, 'bare-hex-secret'],
      'notes/raw.md': [`keep safe:\n${hex}\n`, 'bare-hex-secret'],
      'deploy/mnemonic.env.sh': [`MNEMONIC="${twelve}"\n`, 'bip39-mnemonic'],
      'docs/recovery.md': [
        `Write this down:\n${twentyFour}\n`,
        'bip39-mnemonic',
      ],
      'reports/evidence/run.json': [
        JSON.stringify({
          txHash: `0x${'cd'.repeat(32)}`,
          signerKey: `0x${hex}`,
        }),
        'labelled-hex-key',
      ],
    };
    const dirty = repo(
      Object.fromEntries(Object.entries(planted).map(([f, [c]]) => [f, c])),
    );
    try {
      const { violations } = scanRepository(dirty);
      for (const [file, [, rule]] of Object.entries(planted))
        expect(violations, file).toContainEqual({ file, rule });
    } finally {
      rmSync(dirty, { recursive: true, force: true });
    }
  });
  it('P00-003 legitimate 32-byte hashes in code and evidence are not flagged', () => {
    const hash = `0x${'cd'.repeat(32)}`;
    const clean = repo({
      'contracts/src/Domain.sol': `bytes32 constant TYPEHASH = ${hash};\n`,
      'src/hash.ts': `export const evidenceHash = '${hash}';\nexport const groupId = '${hash}';\n`,
      'reports/evidence/deploy.json': JSON.stringify(
        {
          txHash: hash,
          blockHash: hash,
          mandateId: hash,
          deploymentTransactions: [hash, hash],
        },
        null,
        2,
      ),
      'docs/prose.md':
        'Abandon ability able about above absent absorb abstract absurd abuse access accident account.\n',
    });
    try {
      expect(scanRepository(clean).violations).toEqual([]);
    } finally {
      rmSync(clean, { recursive: true, force: true });
    }
  });
  it('P00-003 the application repository itself carries no tracked secret', () => {
    const result = scanRepository(process.cwd());
    expect(result.scanned).toBeGreaterThan(100);
    expect(result.violations).toEqual([]);
  });
});
