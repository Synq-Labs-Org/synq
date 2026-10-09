import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import {
  AddressSchema,
  LOCAL_CHAIN_ID,
  MONAD_MAINNET_CHAIN_ID,
  MONAD_TESTNET_CHAIN_ID,
  ProfileNameSchema,
  type ProfileName,
} from '@synq/schemas';

const PROFILE_CHAIN: Record<ProfileName, number> = {
  'local/anvil': LOCAL_CHAIN_ID,
  'sandbox/monad-testnet': MONAD_TESTNET_CHAIN_ID,
  'proof/monad-mainnet': MONAD_MAINNET_CHAIN_ID,
};
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
import { readModelFromEnvironment } from './server.js';

const EnvSchema = z.object({
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
});

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
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid API configuration: ${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  const config = parsed.data;
  const chainId = PROFILE_CHAIN[config.SYNQ_PROFILE];
  const pool = new pg.Pool({
    connectionString: config.SYNQ_DATABASE_URL,
    max: 10,
  });
  const store = new PostgresIdentityStore(pool);
  await store.migrate();
  const app = createV1Api({
    store,
    config: {
      profile: config.SYNQ_PROFILE,
      rpId: config.SYNQ_RP_ID,
      origin: config.SYNQ_ORIGIN,
    },
    adminToken: config.SYNQ_API_ADMIN_TOKEN,
    executionModules: executionModuleFor(
      chainId,
      config.SYNQ_DEPLOYMENTS_DIR,
      config.SYNQ_EXECUTION_MODULE,
    ),
    ...(config.SYNQ_TRUST_PROXY ? { trustProxy: config.SYNQ_TRUST_PROXY } : {}),
    rateLimit: {
      capacity: config.SYNQ_RATE_LIMIT_CAPACITY,
      refillPerSecond: config.SYNQ_RATE_LIMIT_REFILL_PER_SECOND,
    },
    privy: new PrivyAdapter(env),
    dynamic: new DynamicAdapter(env),
    ...(env.SYNQ_RM_DATABASE_URL
      ? {
          mandates: mandateReader((await readModelFromEnvironment()).snapshots),
        }
      : {}),
    logger: {
      level: 'info',
      redact: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["idempotency-key"]',
      ],
    },
  });
  app.addHook('onClose', async () => pool.end());
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
