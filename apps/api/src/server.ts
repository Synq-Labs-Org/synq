import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import pg from 'pg';
import { createClient } from 'redis';
import { createPublicClient, http, type PublicClient } from 'viem';
import { assetForRole, profileConfiguration } from '@synq/chain-registry';
import { ProfileNameSchema, type ProfileName } from '@synq/schemas';
import {
  ChainHeadObserver,
  ProjectionReader,
  type ProjectionConfig,
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

export type ReadModelRuntime = ReadModelRouteDeps & {
  reader: ProjectionReader;
  projection: ProjectionConfig;
  client: PublicClient;
  close(): Promise<void>;
};

const ReadModelEnvSchema = z.object({
  SYNQ_NETWORK: ProfileNameSchema.default('sandbox/monad-testnet'),
  SYNQ_RM_DATABASE_URL: z.string().min(1),
  SYNQ_RM_SCHEMA: z.string().default('synq_read_model'),
  SYNQ_RM_REDIS_URL: z.string().min(1),
  SYNQ_RM_REORG_WINDOW: z.coerce.number().int().positive().default(200),
  SYNQ_DEPLOYMENTS_DIR: z.string().default('contracts/deployments'),
});

export async function readModelRuntime(
  source: NodeJS.ProcessEnv = process.env,
  profileName?: ProfileName,
): Promise<ReadModelRuntime> {
  const env = ReadModelEnvSchema.parse(source);
  const profile = profileConfiguration(profileName ?? env.SYNQ_NETWORK);
  const chainId = profile.network.chainId;
  const facts = deploymentFacts(
    JSON.parse(
      readFileSync(
        resolve(env.SYNQ_DEPLOYMENTS_DIR, `${chainId}.json`),
        'utf8',
      ),
    ),
    JSON.parse(
      readFileSync(
        resolve(env.SYNQ_DEPLOYMENTS_DIR, `${chainId}.receipts.json`),
        'utf8',
      ),
    ),
  );
  const config = projectionConfigFromDeployment({
    facts,
    profile: profile.network.profile,
    treasuryAssets: [assetForRole(profile, 'treasuryAsset').address],
    reorgWindowBlocks: env.SYNQ_RM_REORG_WINDOW,
    confirmationDepth: profile.confirmationDepth,
  });
  const pool = new pg.Pool({
    connectionString: env.SYNQ_RM_DATABASE_URL,
    max: 4,
  });
  const store = new PostgresProjectionStore(
    { pool },
    chainId,
    env.SYNQ_RM_SCHEMA,
  );
  const redis = createClient({ url: env.SYNQ_RM_REDIS_URL });
  await redis.connect();
  const rpcUrl = source[profile.rpcEnvironment] ?? profile.defaultRpcUrl;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const reader = new ProjectionReader(store, config);
  return {
    snapshots: new RedisSnapshotCache(redis, reader),
    head: new ChainHeadObserver(client, chainId, { ttlMs: 1000 }),
    maxLagBlocks: Number(profile.maxIndexLagBlocks),
    reader,
    projection: config,
    client,
    async close() {
      await redis.quit();
      await pool.end();
    },
  };
}

export async function readModelFromEnvironment(): Promise<ReadModelRouteDeps> {
  return readModelRuntime();
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
