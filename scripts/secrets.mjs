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
const KEY_TOKENS = new Set([
  'key',
  'keys',
  'pk',
  'sk',
  'privkey',
  'secret',
  'secrets',
  'mnemonic',
  'passphrase',
  'wallet',
  'signer',
  'owner',
  'deployer',
  'account',
  'operator',
  'relayer',
  'admin',
]);
const HASH_TOKENS = new Set([
  'hash',
  'lineage',
  'tx',
  'txs',
  'transaction',
  'transactions',
  'hashes',
  'typehash',
  'codehash',
  'id',
  'ids',
  'root',
  'digest',
  'salt',
  'slot',
  'storage',
  'topic',
  'topics',
  'nonce',
  'signature',
  'sig',
  'commitment',
  'leaf',
  'selector',
]);
function tokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
export function hashName(name) {
  return tokens(name).some((t) => HASH_TOKENS.has(t));
}
export function sensitiveName(name) {
  const parts = tokens(name);
  const joined = parts.join('');
  if (parts.some((t) => HASH_TOKENS.has(t))) return false;
  return (
    parts.some((t) => KEY_TOKENS.has(t)) ||
    /privatekey|seedphrase|recoveryphrase|signingkey/.test(joined)
  );
}
const NAME = String.raw`([A-Za-z_][A-Za-z0-9_.-]*)["'\x60]?\s*[:=]\s*`;
function labelledHexKeys(text) {
  const found = [];
  const pattern = new RegExp(
    NAME + String.raw`["'\x60]?(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])`,
    'g',
  );
  for (const match of text.matchAll(pattern))
    if (sensitiveName(match[1])) found.push(match[1]);
  return found;
}
function labelledEncodedKeys(text) {
  const base64 = new RegExp(
    NAME + String.raw`["'\x60]([A-Za-z0-9+/]{43}=?)["'\x60]`,
    'g',
  );
  for (const match of text.matchAll(base64))
    if (
      sensitiveName(match[1]) &&
      Buffer.from(match[2], 'base64').length === 32
    )
      return true;
  const bare = new RegExp(
    String.raw`([A-Za-z_][A-Za-z0-9_.-]*)\s*[:=][ \t]*([A-Za-z0-9+/]{43}=?)(?![A-Za-z0-9+/=])`,
    'g',
  );
  for (const match of text.matchAll(bare))
    if (
      sensitiveName(match[1]) &&
      /[0-9+/]/.test(match[2]) &&
      /[A-Z]/.test(match[2]) &&
      /[a-z]/.test(match[2]) &&
      Buffer.from(match[2], 'base64').length === 32
    )
      return true;
  const bytes = new RegExp(
    NAME +
      String.raw`(?:new\s+Uint8Array\(\s*|Buffer\.from\(\s*)?\[((?:\s*(?:0x[0-9a-fA-F]{1,2}|\d{1,3})\s*,){31}\s*(?:0x[0-9a-fA-F]{1,2}|\d{1,3})\s*,?\s*)\]`,
    'g',
  );
  for (const match of text.matchAll(bytes))
    if (sensitiveName(match[1])) return true;
  return false;
}
const SIGNER_CALL =
  /\b(?:privateKeyToAccount|privateKeyToAddress|toAccount|Wallet|SigningKey|fromPrivateKey|fromSecretKey|getPublicKey)\s*\(/g;
const QUOTED_KEY = /["'`](?:0x)?[0-9a-fA-F]{64}["'`]/;
function callArguments(text, open) {
  let depth = 0;
  for (let i = open; i < text.length && i < open + 2000; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1, open + 2000);
}
function signingConstructorLiteral(text) {
  for (const match of text.matchAll(SIGNER_CALL)) {
    const args = callArguments(text, match.index + match[0].length - 1);
    if (QUOTED_KEY.test(args) || hexPieces(args)) return true;
  }
  return false;
}
function unlabelledHexJson(text) {
  for (const match of text.matchAll(
    /"([^"\n]{1,80})"\s*:\s*"(?:0x)?[0-9a-fA-F]{64}"/g,
  ))
    if (!hashName(match[1])) return true;
  return false;
}
const PIECE = String.raw`["'\x60](?:0x)?[0-9a-fA-F]{8,56}["'\x60]`;
function piecesTotal64(run) {
  const hex = [...run.matchAll(/["'`](?:0x)?([0-9a-fA-F]+)["'`]/g)]
    .map((m) => m[1])
    .join('');
  return hex.length === 64;
}
function hexPieces(text) {
  const plus = new RegExp(String.raw`${PIECE}(?:\s*\+\s*${PIECE}){1,7}`, 'g');
  for (const match of text.matchAll(plus))
    if (piecesTotal64(match[0])) return true;
  const array = new RegExp(
    String.raw`\[\s*${PIECE}(?:\s*,\s*${PIECE}){1,7}\s*,?\s*\]\s*\.\s*join\s*\(`,
    'g',
  );
  for (const match of text.matchAll(array))
    if (piecesTotal64(match[0])) return true;
  for (const match of text.matchAll(/`([^`]{0,400})`/g)) {
    if (!match[1].includes('${')) continue;
    const inlined = match[1]
      .replace(/\$\{\s*["'](?:0x)?([0-9a-fA-F]+)["']\s*\}/g, '$1')
      .replace(/^0x/, '');
    if (/(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/.test(inlined))
      return true;
  }
  return false;
}
function splitHexKey(text) {
  return hexPieces(text);
}
const TABLE_KEY = /^`?(?:0x)?[0-9a-fA-F]{64}`?$/;
function tableCellKeys(text) {
  let header = null;
  for (const line of text.split(/\r?\n/)) {
    if (!/^\s*\|.*\|\s*$/.test(line)) {
      header = null;
      continue;
    }
    const cells = line
      .trim()
      .slice(1, -1)
      .split('|')
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{3,}:?$/.test(c))) continue;
    if (!header) {
      header = cells;
      continue;
    }
    for (const [i, cell] of cells.entries()) {
      const value = cell.replace(/^\*+|\*+$/g, '');
      const bare = value.replace(/`/g, '');
      const encoded =
        /^[A-Za-z0-9+/]{43}=?$/.test(bare) &&
        /[0-9+/]/.test(bare) &&
        Buffer.from(bare, 'base64').length === 32;
      if (!TABLE_KEY.test(value) && !encoded) continue;
      const label = (cells[i - 1] ?? '').replace(/[`*]/g, '');
      const column = (header[i] ?? '').replace(/[`*]/g, '');
      if (sensitiveName(label) || sensitiveName(column)) return true;
    }
  }
  return false;
}
function keystoreJson(text) {
  return (
    /"crypto"\s*:/i.test(text) &&
    /"ciphertext"\s*:/.test(text) &&
    /"kdf"\s*:/.test(text)
  );
}
function bareHexLines(text) {
  const result = { bare: false, labelled: false };
  const lines = text.split(/\r?\n/);
  for (const [i, line] of lines.entries()) {
    if (!/^[ \t]*["'`]?(?:0x)?[0-9a-fA-F]{64}["'`]?[,;)]?[ \t]*$/.test(line))
      continue;
    const previous = lines
      .slice(0, i)
      .reverse()
      .find((l) => l.trim() !== '');
    const declared = previous?.match(/([A-Za-z_][A-Za-z0-9_]*)\s*([:=])\s*$/);
    if (declared && sensitiveName(declared[1])) {
      result.labelled = true;
      continue;
    }
    if (declared?.[2] === '=') continue;
    if (previous && /\b(keccak256|sha256|hash\w*)\s*\(\s*$/i.test(previous))
      continue;
    result.bare = true;
  }
  return result;
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
    if (labelledEncodedKeys(text))
      violations.push({ file, rule: 'labelled-encoded-key' });
    if (signingConstructorLiteral(text))
      violations.push({ file, rule: 'key-literal-in-signer' });
    if (unlabelledHexJson(text))
      violations.push({ file, rule: 'unlabelled-hex-json' });
    if (splitHexKey(text)) violations.push({ file, rule: 'split-hex-key' });
    if (tableCellKeys(text))
      violations.push({ file, rule: 'markdown-table-key' });
    if (keystoreJson(text)) violations.push({ file, rule: 'keystore-json' });
    const bare = bareHexLines(text);
    if (bare.labelled) violations.push({ file, rule: 'labelled-hex-key' });
    if (bare.bare && !BARE_HASH_ALLOWED.some((p) => p.test(file)))
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
