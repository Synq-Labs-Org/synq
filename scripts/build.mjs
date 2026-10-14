import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, delimiter, dirname, join } from 'node:path';
if (process.versions.node.split('.')[0] !== '22')
  throw new Error('Node 22 is required for the Synq build');
const env = {
  ...process.env,
  PATH: [
    resolve('scripts/bin'),
    dirname(process.execPath),
    process.env.PATH,
  ].join(delimiter),
};
// Most workspace packages "build" by typechecking the whole repository, which the
// tsconfig.build.json compile below already does once. Run only the packages with
// a real build (the web app, the oclif plugin) instead of repeating it per package.
const TYPECHECK_DELEGATE = 'tsc --noEmit -p ../../tsconfig.json';
const excluded = [
  ...readFileSync('pnpm-workspace.yaml', 'utf8').matchAll(/-\s+'!([^']+)'/g),
].map((m) => m[1]);
const realBuilds = ['packages', 'apps', 'workers', 'plugins']
  .flatMap((root) =>
    existsSync(root) ? readdirSync(root).map((dir) => join(root, dir)) : [],
  )
  .filter((dir) => !excluded.includes(dir))
  .map((dir) => join(dir, 'package.json'))
  .filter((file) => existsSync(file))
  .map((file) => JSON.parse(readFileSync(file, 'utf8')))
  .filter(
    (pkg) => pkg.scripts?.build && pkg.scripts.build !== TYPECHECK_DELEGATE,
  )
  .map((pkg) => `--filter=${pkg.name}`);
for (const args of [
  [
    'node_modules/turbo/bin/turbo',
    'run',
    'build',
    '--only',
    '--concurrency=1',
    ...realBuilds,
  ],
  ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'],
]) {
  const child = spawnSync(process.execPath, args, { stdio: 'inherit', env });
  if (child.error) throw child.error;
  if (child.status !== 0) {
    process.exitCode = child.status ?? 1;
    break;
  }
}

if (!process.exitCode) await import('./copy-build-assets.mjs');
