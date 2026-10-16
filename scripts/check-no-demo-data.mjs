import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const forbidden =
  /Sarah|Priya|Arjun|Goa\s+crew|0xB781[0-9a-f]*|0x6BD6[0-9a-f]*/gi;
const skipped = new Set([
  'node_modules',
  'dist',
  '.next',
  'generated',
  'Design',
  'Checks',
  '__tests__',
  'fixtures',
  'coverage',
  '.build',
]);
const source = /\.(?:[cm]?[jt]sx?|swift|json|html|css|vue|svelte)$/;
export function demoReferences(text) {
  return text.split('\n').flatMap((line, i) => {
    const matches = [...line.matchAll(forbidden)];
    return matches.length
      ? [{ line: i + 1, matches: matches.map((m) => m[0]) }]
      : [];
  });
}
export function scanRuntime(root = process.cwd()) {
  const findings = [];
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (skipped.has(entry.name) || entry.isSymbolicLink()) continue;
      const file = join(path, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (
        entry.isFile() &&
        source.test(entry.name) &&
        !/\.(?:test|spec)\./.test(entry.name)
      )
        for (const hit of demoReferences(readFileSync(file, 'utf8')))
          findings.push({ file: relative(root, file), ...hit });
    }
  }
  for (const dir of ['apps', 'packages', 'workers', 'plugins'])
    walk(join(root, dir));
  return findings;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const findings = scanRuntime();
  for (const f of findings)
    process.stderr.write(
      `${f.file}:${f.line}: forbidden demo identity ${f.matches.join(', ')}\n`,
    );
  if (findings.length) process.exitCode = 1;
  else process.stdout.write('Runtime demo-identity and address scan passed.\n');
}
