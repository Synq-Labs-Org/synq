import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { sourceFiles } from './architecture.mjs';
const files = ['packages', 'apps', 'workers', 'scripts'].flatMap(sourceFiles);
const violations = [];
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  if (
    /-----BEGIN(?: RSA| EC| OPENSSH)? PRIVATE KEY-----/.test(source) ||
    /\b(?:sk-proj|sk-ant)-[A-Za-z0-9_-]{20,}/.test(source)
  )
    violations.push(file);
  if (
    /(?:PRIVATE_KEY|privateKey)\s*[:=]\s*['"](?:0x)?[0-9a-fA-F]{64}['"]/.test(
      source,
    )
  )
    violations.push(file);
}
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
for (const file of tracked) {
  if (
    (/\/(?:\.env|.*\.key)$/.test('/' + file) &&
      !file.endsWith('.env.example')) ||
    file.includes('Synq_Agent_Build_Pack')
  )
    violations.push(file);
}
if (existsSync('../Synq_Agent_Build_Pack_v1.2/.git'))
  violations.push('Reference pack must not have a Git repository');
if (violations.length) {
  console.error(
    `Repository boundary/secret scan failed: ${[...new Set(violations)].join(', ')}`,
  );
  process.exitCode = 1;
} else console.log('Secret and reference-pack exclusion checks pass.');
