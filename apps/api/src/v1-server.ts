import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { ProfileNameSchema } from '@synq/schemas';
import {
  DynamicAdapter,
  PostgresIdentityStore,
  PrivyAdapter,
} from '@synq/identity/server';
import { createV1Api, type MandateReadPort } from './v1/app.js';
import { ProofQueryService } from './service.js';

const EnvSchema = z.object({
  SYNQ_DATABASE_URL: z.string().min(1),
  SYNQ_PROFILE: ProfileNameSchema.default('sandbox/monad-testnet'),
  SYNQ_RP_ID: z.string().min(1),
  SYNQ_ORIGIN: z.string().min(1),
  SYNQ_ADMIN_TOKEN: z.string().min(32).optional(),
  SYNQ_API_PORT: z.coerce.number().int().min(1).max(65535).default(3200),
  SYNQ_PROOF_ARTIFACT: z.string().optional(),
});

export function mandateReader(proof: ProofQueryService): MandateReadPort {
  return {
    async read(groupId, mandateId) {
      const { state, currentHeadVerified } = await proof.state(groupId);
      const mandate = state.mandates[mandateId.toLowerCase()];
      return mandate
        ? {
            groupId,
            mandateId,
            version: mandate.version,
            active: mandate.active,
            terms: mandate.terms,
            source: 'indexed-read-model',
            currentHeadVerified,
          }
        : null;
    },
  };
}

export async function startV1Server(env: NodeJS.ProcessEnv = process.env) {
  const config = EnvSchema.parse(env);
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
    adminToken: config.SYNQ_ADMIN_TOKEN ?? null,
    privy: new PrivyAdapter(env),
    dynamic: new DynamicAdapter(env),
    ...(config.SYNQ_PROOF_ARTIFACT
      ? {
          mandates: mandateReader(
            new ProofQueryService(resolve(config.SYNQ_PROOF_ARTIFACT)),
          ),
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
