import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

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
const BIP39 = new Set(wordlist);
const MNEMONIC_LENGTHS = [24, 21, 18, 15, 12];
const BARE_HASH_ALLOWED = [
  /^reports\/(evidence|tests)\//,
  /^contracts\/(evidence|abi|out|lib)\//,
  /(^|\/)pnpm-lock\.yaml$/,
];
export function sensitiveName(name) {
  const snake = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/-/g, '_');
  return (
    /(private_?key|privkey|secret|mnemonic|seed|passphrase|signer_?key)/.test(
      snake,
    ) || /(^|[_.])(pk|sk|key)$/.test(snake)
  );
}
function labelledHexKeys(text) {
  const found = [];
  const pattern =
    /([A-Za-z_][A-Za-z0-9_.-]*)["'`]?\s*[:=]\s*["'`]?(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
  for (const match of text.matchAll(pattern))
    if (sensitiveName(match[1])) found.push(match[1]);
  return found;
}
function hasBareHexLine(text) {
  return /^[ \t]*["'`]?(?:0x)?[0-9a-fA-F]{64}["'`]?[,;]?[ \t]*$/m.test(text);
}
export function findMnemonic(text) {
  const words = text.toLowerCase().split(/[^a-z]+/);
  let run = [];
  const check = () => {
    for (const size of MNEMONIC_LENGTHS)
      for (let i = 0; i + size <= run.length; i++)
        if (validateMnemonic(run.slice(i, i + size).join(' '), wordlist))
          return true;
    return false;
  };
  for (const word of [...words, '']) {
    if (BIP39.has(word)) {
      run.push(word);
      continue;
    }
    if (run.length >= 12 && check()) return true;
    run = [];
  }
  return false;
}
function labelledMnemonic(text) {
  const pattern =
    /(mnemonic|seed[_ -]?phrase|recovery[_ -]?phrase|seed)["'`]?\s*[:=]\s*["'`]?([a-z]+(?:[ \t]+[a-z]+){11,23})/gi;
  for (const match of text.matchAll(pattern))
    if (
      match[2]
        .toLowerCase()
        .split(/\s+/)
        .every((w) => BIP39.has(w))
    )
      return true;
  return false;
}

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
    if (labelledHexKeys(text).length)
      violations.push({ file, rule: 'labelled-hex-key' });
    if (!BARE_HASH_ALLOWED.some((p) => p.test(file)) && hasBareHexLine(text))
      violations.push({ file, rule: 'bare-hex-secret' });
    if (labelledMnemonic(text) || findMnemonic(text))
      violations.push({ file, rule: 'bip39-mnemonic' });
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
