import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { registryDeploymentSettings } from './envio-env.js';

const { env } = registryDeploymentSettings('sandbox/monad-testnet');
const child = spawnSync(
  process.execPath,
  [resolve('indexer/envio/node_modules/envio/bin.mjs'), 'codegen'],
  {
    cwd: resolve('indexer/envio'),
    stdio: 'inherit',
    env: { ...process.env, ...env },
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
