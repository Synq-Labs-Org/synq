import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { DeploymentManifestSchema } from '../packages/chain-registry/src/index.js';
import { AddressSchema } from '../packages/schemas/src/index.js';
const proof = z
  .object({
    manifest: DeploymentManifestSchema,
    localTestToken: AddressSchema,
    rpcUrl: z.url().refine((url) => /^http:\/\/127\.0\.0\.1:[0-9]+$/.test(url)),
  })
  .parse(
    JSON.parse(readFileSync('artifacts/local/demonstration.json', 'utf8')),
  );
if (proof.manifest.network.chainId !== 31337)
  throw new Error('LOCAL_INDEXER_ONLY');
const env = {
  PATH: process.env.PATH ?? '',
  HOME: process.env.HOME ?? '',
  SYNQ_CHAIN_ID: '31337',
  SYNQ_START_BLOCK: '0',
  SYNQ_INDEXER_RPC_URL: proof.rpcUrl,
  SYNQ_REGISTRY_ADDRESS: proof.manifest.mandateRegistry,
  SYNQ_MODULE_ADDRESS: proof.manifest.executionModule,
  SYNQ_TREASURY_TOKEN: proof.localTestToken,
  ENVIO_PG_HOST: '127.0.0.1',
  ENVIO_PG_PORT: '55432',
  ENVIO_PG_USER: 'postgres',
  ENVIO_PG_PASSWORD: 'synq_local',
  ENVIO_PG_DATABASE: 'synq_test',
  ENVIO_PG_SCHEMA: 'envio',
  ENVIO_TUI: 'false',
  ENVIO_HASURA: 'false',
  ENVIO_INDEXER_PORT: '9899',
};
const action = process.argv[2];
if (action !== 'start' && action !== 'migrate')
  throw new Error('Expected start or migrate');
const result = spawnSync(
  process.execPath,
  [
    resolve('indexer/envio/node_modules/envio/bin.mjs'),
    ...(action === 'start' ? ['start'] : ['db-migrate', 'up']),
  ],
  { cwd: resolve('indexer/envio'), env, stdio: 'inherit' },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
