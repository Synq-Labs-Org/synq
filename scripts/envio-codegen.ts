import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DeploymentManifestSchema } from '../packages/chain-registry/src/index.js';
import { AddressSchema } from '../packages/schemas/src/index.js';
const evidence = z
  .object({ manifest: DeploymentManifestSchema, localTestToken: AddressSchema })
  .parse(
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
      SYNQ_CHAIN_ID: '31337',
      SYNQ_START_BLOCK: '0',
      SYNQ_INDEXER_RPC_URL: 'http://127.0.0.1:8545',
      SYNQ_REGISTRY_ADDRESS: evidence.manifest.mandateRegistry,
      SYNQ_MODULE_ADDRESS: evidence.manifest.executionModule,
      SYNQ_TREASURY_TOKEN: evidence.localTestToken,
    },
  },
);
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
