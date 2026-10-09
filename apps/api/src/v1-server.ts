import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import {
  AddressSchema,
  PluginManifestSchema,
  ProfileNameSchema,
  type PluginManifest,
} from '@synq/schemas';
import { chainIdForProfile, profileConfiguration } from '@synq/chain-registry';
import {
  KERNEL_AUDIT_KEY_ENV,
  loadKernelAuditKey,
} from '@synq/execution-worker/integrity';
import {
  DynamicAdapter,
  PostgresIdentityStore,
  PrivyAdapter,
} from '@synq/identity/server';
import {
  MIN_ADMIN_TOKEN_LENGTH,
  createV1Api,
  type MandateReadPort,
} from './v1/app.js';
import type { GroupSnapshot } from '@synq/read-model';
import { readModelRuntime, type ReadModelRuntime } from './server.js';
import {
  createIntentKernel,
  identityPorts,
  kernelStateFromReadModel,
} from './kernel-runtime.js';

const LOCAL_PROFILE = 'local/anvil';
const KERNEL_ENV = [
  'SYNQ_RM_DATABASE_URL',
  'SYNQ_RM_REDIS_URL',
  KERNEL_AUDIT_KEY_ENV,
  'SYNQ_KERNEL_PLUGINS_FILE',
] as const;

const EnvSchema = z
  .object({
    SYNQ_DATABASE_URL: z.string().min(1),
    SYNQ_PROFILE: ProfileNameSchema.default('sandbox/monad-testnet'),
    SYNQ_RP_ID: z.string().min(1),
    SYNQ_ORIGIN: z.string().min(1),
    SYNQ_API_ADMIN_TOKEN: z.string().min(MIN_ADMIN_TOKEN_LENGTH),
    SYNQ_DEPLOYMENTS_DIR: z.string().default('contracts/deployments'),
    SYNQ_EXECUTION_MODULE: AddressSchema.optional(),
    SYNQ_RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).default(30),
    SYNQ_RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().positive().default(1),
    SYNQ_TRUST_PROXY: z.string().optional(),
    SYNQ_API_PORT: z.coerce.number().int().min(1).max(65535).default(3200),
    SYNQ_RM_DATABASE_URL: z.string().min(1).optional(),
    SYNQ_RM_REDIS_URL: z.string().min(1).optional(),
    [KERNEL_AUDIT_KEY_ENV]: z.string().min(1).optional(),
    SYNQ_KERNEL_PLUGINS_FILE: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.SYNQ_PROFILE === LOCAL_PROFILE) return;
    for (const key of KERNEL_ENV)
      if (!env[key])
        ctx.addIssue({
          code: 'custom',
          path: [key],
          message: `required for ${env.SYNQ_PROFILE}`,
        });
  });
type V1Env = z.output<typeof EnvSchema>;

export function parseV1Environment(env: NodeJS.ProcessEnv): V1Env {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid API configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return parsed.data;
}

export function pluginManifests(path: string): PluginManifest[] {
  return z
    .array(PluginManifestSchema)
    .min(1)
    .parse(JSON.parse(readFileSync(resolve(path), 'utf8')));
}

export async function intentKernelFromEnvironment(input: {
  config: V1Env;
  env: NodeJS.ProcessEnv;
  identity: PostgresIdentityStore;
  readModel: ReadModelRuntime;
  executionModule: `0x${string}`;
}) {
  const { config, env } = input;
  if (!config.SYNQ_KERNEL_PLUGINS_FILE) return null;
  if (config.SYNQ_PROFILE !== LOCAL_PROFILE && !config[KERNEL_AUDIT_KEY_ENV])
    throw new Error(`Invalid API configuration: ${KERNEL_AUDIT_KEY_ENV}`);
  const auditKey = config[KERNEL_AUDIT_KEY_ENV]
    ? loadKernelAuditKey([config.SYNQ_DEPLOYMENTS_DIR], {
        ...env,
        SYNQ_NETWORK: config.SYNQ_PROFILE,
      }).bytes
    : undefined;
  return createIntentKernel({
    network: profileConfiguration(config.SYNQ_PROFILE).network,
    executionModule: input.executionModule,
    identity: identityPorts(input.identity),
    client: input.readModel.client,
    projection: input.readModel.projection,
    snapshots: async () => input.readModel.snapshots,
    head: input.readModel.head,
    maxLagBlocks: input.readModel.maxLagBlocks,
    ...(auditKey ? { auditKey } : {}),
    plugins: pluginManifests(config.SYNQ_KERNEL_PLUGINS_FILE),
    state: await kernelStateFromReadModel(input.readModel.reader),
  });
}

export function mandateReader(snapshots: {
  groupSnapshot(groupId: `0x${string}`): Promise<GroupSnapshot | null>;
}): MandateReadPort {
  return {
    async read(groupId, mandateId) {
      const snapshot = await snapshots.groupSnapshot(
        groupId.toLowerCase() as `0x${string}`,
      );
      const mandate = snapshot?.group.mandates.find(
        (m) => m.mandateId === mandateId.toLowerCase(),
      );
      return snapshot && mandate
        ? {
            groupId,
            mandateId,
            version: mandate.currentVersion,
            active: mandate.status === 'ACTIVE',
            terms: {
              status: mandate.status,
              minValidVersion: mandate.minValidVersion,
              spentToken: mandate.spentToken,
              spentNative: mandate.spentNative,
              indexedThroughBlock: String(snapshot.indexedThroughBlock),
            },
            source: 'indexed-read-model',
            currentHeadVerified: false,
          }
        : null;
    },
  };
}

export function executionModuleFor(
  chainId: number,
  deploymentsDir: string,
  override?: string,
): Record<number, string> {
  if (override) return { [chainId]: override };
  const manifest = z
    .object({ chainId: z.literal(chainId), ExecutionModule: AddressSchema })
    .parse(
      JSON.parse(
        readFileSync(resolve(deploymentsDir, `${chainId}.json`), 'utf8'),
      ),
    );
  return { [chainId]: manifest.ExecutionModule };
}

export async function startV1Server(env: NodeJS.ProcessEnv = process.env) {
  const config = parseV1Environment(env);
  const chainId = chainIdForProfile(config.SYNQ_PROFILE);
  const executionModules = executionModuleFor(
    chainId,
    config.SYNQ_DEPLOYMENTS_DIR,
    config.SYNQ_EXECUTION_MODULE,
  );
  const pool = new pg.Pool({
    connectionString: config.SYNQ_DATABASE_URL,
    max: 10,
  });
  const store = new PostgresIdentityStore(pool);
  await store.migrate();
  const readModel = config.SYNQ_RM_DATABASE_URL
    ? await readModelRuntime(env, config.SYNQ_PROFILE)
    : null;
  const intents = readModel
    ? await intentKernelFromEnvironment({
        config,
        env,
        identity: store,
        readModel,
        executionModule: AddressSchema.parse(executionModules[chainId]),
      })
    : null;
  const app = createV1Api({
    store,
    config: {
      profile: config.SYNQ_PROFILE,
      rpId: config.SYNQ_RP_ID,
      origin: config.SYNQ_ORIGIN,
    },
    adminToken: config.SYNQ_API_ADMIN_TOKEN,
    executionModules,
    ...(intents ? { intents } : {}),
    ...(config.SYNQ_TRUST_PROXY ? { trustProxy: config.SYNQ_TRUST_PROXY } : {}),
    rateLimit: {
      capacity: config.SYNQ_RATE_LIMIT_CAPACITY,
      refillPerSecond: config.SYNQ_RATE_LIMIT_REFILL_PER_SECOND,
    },
    privy: new PrivyAdapter(env),
    dynamic: new DynamicAdapter(env),
    ...(readModel ? { mandates: mandateReader(readModel.snapshots) } : {}),
    logger: {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
      ],
    },
  });
  app.addHook('onClose', async () => {
    await readModel?.close();
    await pool.end();
  });
  await app.listen({ port: config.SYNQ_API_PORT, host: '127.0.0.1' });
  return app;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await startV1Server();
  const stop = () => void app.close().then(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
