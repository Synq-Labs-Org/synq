import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import pg from 'pg';
import { createClient } from 'redis';
import { createPublicClient, http } from 'viem';
import { assetForRole, profileConfiguration } from '@synq/chain-registry';
import {
  ChainHeadObserver,
  ProjectionReader,
  RedisSnapshotCache,
  deploymentFacts,
  projectionConfigFromDeployment,
} from '@synq/read-model';
import { PostgresProjectionStore } from '@synq/read-model/storage';
import {
  readModelErrorStatus,
  readModelRoutes,
  type ReadModelRouteDeps,
} from './read-model-routes.js';

export function createApi(options: { readModel?: ReadModelRouteDeps } = {}) {
  const api = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  api.get('/health', async () => ({ status: 'ok', mode: 'derived-read-only' }));
  if (options.readModel) api.register(readModelRoutes, options.readModel);
  api.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError ? 400 : (readModelErrorStatus(error) ?? 503);
    reply.code(status).send({
      error:
        status === 400
          ? 'INVALID_REQUEST'
          : status === 404
            ? 'GROUP_NOT_FOUND'
            : 'READ_MODEL_UNAVAILABLE',
    });
  });
  return api;
}

async function readModelFromEnvironment(): Promise<ReadModelRouteDeps> {
  const env = z
    .object({
      SYNQ_NETWORK: z.string().default('sandbox/monad-testnet'),
      SYNQ_RM_DATABASE_URL: z.string().min(1),
      SYNQ_RM_SCHEMA: z.string().default('synq_read_model'),
      SYNQ_RM_REDIS_URL: z.string().min(1),
      SYNQ_RM_REORG_WINDOW: z.coerce.number().int().positive().default(200),
    })
    .parse(process.env);
  const profile = profileConfiguration(
    z
      .enum(['local/anvil', 'sandbox/monad-testnet', 'proof/monad-mainnet'])
      .parse(env.SYNQ_NETWORK),
  );
  const chainId = profile.network.chainId;
  const facts = deploymentFacts(
    JSON.parse(readFileSync(`contracts/deployments/${chainId}.json`, 'utf8')),
    JSON.parse(
      readFileSync(`contracts/deployments/${chainId}.receipts.json`, 'utf8'),
    ),
  );
  const config = projectionConfigFromDeployment({
    facts,
    profile: profile.network.profile,
    treasuryAssets: [assetForRole(profile, 'treasuryAsset').address],
    reorgWindowBlocks: env.SYNQ_RM_REORG_WINDOW,
    confirmationDepth: profile.confirmationDepth,
  });
  const store = new PostgresProjectionStore(
    {
      pool: new pg.Pool({ connectionString: env.SYNQ_RM_DATABASE_URL, max: 4 }),
    },
    chainId,
    env.SYNQ_RM_SCHEMA,
  );
  const redis = createClient({ url: env.SYNQ_RM_REDIS_URL });
  await redis.connect();
  const rpcUrl = process.env[profile.rpcEnvironment] ?? profile.defaultRpcUrl;
  return {
    snapshots: new RedisSnapshotCache(
      redis,
      new ProjectionReader(store, config),
    ),
    head: new ChainHeadObserver(
      createPublicClient({ transport: http(rpcUrl) }),
      chainId,
      { ttlMs: 1000 },
    ),
    maxLagBlocks: Number(profile.maxIndexLagBlocks),
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const port = z.coerce
    .number()
    .int()
    .min(1)
    .max(65535)
    .parse(process.env.SYNQ_PORT ?? 3000);
  const api = createApi({ readModel: await readModelFromEnvironment() });
  await api.listen({ port, host: '127.0.0.1' });
  console.log(`Synq read API: http://127.0.0.1:${port}`);
}
