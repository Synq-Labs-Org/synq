// Stage a production copy for `mm plugins install file:<dir>`. The plugin must share the host's
// @metamask/agent-wallet instance: a second copy (the devDependency) breaks the host lifecycle.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = join(root, '.mm-stage');
const host = realpathSync(
  process.env.MM_HOST_DIR ??
    join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(), '@metamask', 'agent-wallet'),
);
if (host.startsWith(root)) throw new Error('host resolved to the devDependency copy; set MM_HOST_DIR');
const hostPkg = JSON.parse(readFileSync(join(host, 'package.json'), 'utf8'));
if (hostPkg.name !== '@metamask/agent-wallet') throw new Error(`mm resolves to ${host}, not @metamask/agent-wallet`);
for (const required of ['dist', 'oclif.manifest.json'])
  if (!existsSync(join(root, required))) throw new Error(`run npm run build first (${required} missing)`);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage);
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
cpSync(join(root, 'dist'), join(stage, 'dist'), { recursive: true });
cpSync(join(root, 'oclif.manifest.json'), join(stage, 'oclif.manifest.json'));
execFileSync('npm', ['install', '--omit=dev', '--omit=peer', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock'], {
  cwd: stage,
  stdio: 'inherit',
});
mkdirSync(join(stage, 'node_modules', '@metamask'), { recursive: true });
symlinkSync(host, join(stage, 'node_modules', '@metamask', 'agent-wallet'), 'dir');
console.log(`staged ${pkg.name}@${pkg.version} for mm ${hostPkg.version} at ${stage}`);
