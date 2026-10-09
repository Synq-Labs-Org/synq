import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { envioEnvironment } from './envio-env.js';

const environment = envioEnvironment(
  'local/anvil',
  JSON.parse(
    readFileSync(resolve('reports/evidence/local-deployment.json'), 'utf8'),
  ),
);
const child = spawnSync(
  process.execPath,
  [resolve('indexer/envio/node_modules/envio/bin.mjs'), 'codegen'],
  {
    cwd: resolve('indexer/envio'),
    stdio: 'inherit',
    env: {
      ...process.env,
      ...environment,
      SYNQ_INDEXER_RPC_URL: 'http://127.0.0.1:8545',
    },
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
