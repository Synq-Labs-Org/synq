import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { registryDeploymentSettings } from './envio-env.js';

const [profileName = 'sandbox/monad-testnet', observedPath] =
  process.argv.slice(2);
const { env } = registryDeploymentSettings(profileName, {
  observedAccounts: observedPath
    ? (JSON.parse(readFileSync(resolve(observedPath), 'utf8')) as unknown[])
    : [],
});
const result = spawnSync(
  process.execPath,
  [resolve('indexer/envio/node_modules/envio/bin.mjs'), 'start'],
  {
    cwd: resolve('indexer/envio'),
    env: {
      ...process.env,
      ENVIO_TUI: 'false',
      ENVIO_HASURA: 'false',
      ...env,
    },
    stdio: 'inherit',
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
