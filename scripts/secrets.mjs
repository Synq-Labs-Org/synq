import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const contentRules = [
  [
    'pem-private-key',
    /-----BEGIN(?: RSA| EC| OPENSSH| DSA| ENCRYPTED)? PRIVATE KEY-----/,
  ],
  [
    'openai-or-anthropic-key',
    /\b(?:sk-proj|sk-ant|sk-live)-[A-Za-z0-9_-]{20,}/,
  ],
  ['github-token', /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['slack-token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  [
    'hex-private-key-assignment',
    /(?:PRIVATE_KEY|private_?key|SECRET|secret_?key|MNEMONIC)["']?\s*[:=]\s*["']?(?:0x)?[0-9a-fA-F]{64}\b/i,
  ],
  ['bearer-token', /\bBearer\s+[A-Za-z0-9._~+/-]{32,}=*/],
];
const forbiddenPath = [
  [
    'dotenv-file',
    (f) => /(^|\/)\.env(\.[^/]*)?$/.test(f) && !f.endsWith('.env.example'),
  ],
  ['key-file', (f) => /\.(key|pem|p12|pfx|keystore)$/.test(f)],
  ['ssh-key', (f) => /(^|\/)id_(rsa|ecdsa|ed25519)$/.test(f)],
  ['geth-keystore', (f) => /(^|\/)UTC--\d{4}-/.test(f)],
  ['reference-pack', (f) => f.includes('Synq_Agent_Build_Pack')],
];
const MAX_BYTES = 5 * 1024 * 1024;

export function trackedFiles(root) {
  return execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean);
}
export function scanRepository(root) {
  const violations = [];
  const files = trackedFiles(root);
  for (const file of files) {
    for (const [rule, test] of forbiddenPath)
      if (test(file)) violations.push({ file, rule });
    const path = join(root, file);
    if (!existsSync(path) || statSync(path).size > MAX_BYTES) continue;
    const buffer = readFileSync(path);
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const text = buffer.toString('utf8');
    for (const [rule, pattern] of contentRules)
      if (pattern.test(text)) violations.push({ file, rule });
  }
  return { scanned: files.length, violations };
}
function referencePackHasGit(root) {
  for (let dir = resolve(root); dir !== dirname(dir); dir = dirname(dir))
    if (existsSync(join(dir, '..', 'Synq_Agent_Build_Pack_v1.2', '.git')))
      return true;
  return false;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = process.cwd();
  const { scanned, violations } = scanRepository(root);
  if (referencePackHasGit(root))
    violations.push({
      file: 'Synq_Agent_Build_Pack_v1.2/.git',
      rule: 'reference-pack-git',
    });
  if (violations.length) {
    console.error(
      `Secret scan failed:\n${violations.map((v) => `${v.file}: ${v.rule}`).join('\n')}`,
    );
    process.exitCode = 1;
  } else console.log(`Secret scan passed over ${scanned} tracked files.`);
}
