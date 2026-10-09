import { spawnSync } from 'node:child_process';
import { resolve, delimiter, dirname } from 'node:path';
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
for (const args of [
  ['node_modules/turbo/bin/turbo', 'run', 'build'],
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
