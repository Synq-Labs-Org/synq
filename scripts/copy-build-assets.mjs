import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
mkdirSync('dist/packages/read-model/sql', { recursive: true });
cpSync('packages/read-model/sql', 'dist/packages/read-model/sql', {
  recursive: true,
});
mkdirSync('dist/packages/identity/sql', { recursive: true });
cpSync('packages/identity/sql', 'dist/packages/identity/sql', {
  recursive: true,
});
const toJs = (target) => target.replace(/\.ts$/, '.js');
for (const group of ['packages', 'workers', 'apps']) {
  for (const entry of readdirSync(group, { withFileTypes: true })) {
    const manifestPath = join(group, entry.name, 'package.json');
    if (!entry.isDirectory() || !existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    const out = join('dist', group, entry.name);
    if (!existsSync(out)) continue;
    const exports =
      typeof manifest.exports === 'string'
        ? toJs(manifest.exports)
        : manifest.exports
          ? Object.fromEntries(
              Object.entries(manifest.exports).map(([k, v]) => [k, toJs(v)]),
            )
          : undefined;
    writeFileSync(
      join(out, 'package.json'),
      JSON.stringify({ name: manifest.name, type: 'module', exports }) + '\n',
    );
    const link = join('dist/node_modules', manifest.name);
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true, recursive: true });
    symlinkSync(relative(dirname(link), out), link, 'dir');
  }
}
