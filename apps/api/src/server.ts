import Fastify from 'fastify';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { HashSchema } from '@synq/schemas';
import { ProofQueryService } from './service.js';
export function createApi(service: ProofQueryService) {
  const api = Fastify({ logger: false, bodyLimit: 64 * 1024 });
  api.get('/health', async () => ({ status: 'ok', mode: 'derived-read-only' }));
  api.get('/dev/groups', () => service.groups());
  api.get('/dev/groups/:id/state', async (request) =>
    service.state(z.strictObject({ id: HashSchema }).parse(request.params).id),
  );
  api.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Error && error.message === 'Unknown group'
          ? 404
          : 503;
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
  const path = resolve(
    process.env.SYNQ_PROOF_ARTIFACT ?? 'artifacts/local/demonstration.json',
  );
  const api = createApi(new ProofQueryService(path));
  await api.listen({ port, host: '127.0.0.1' });
  console.log(`Synq derived read API: http://127.0.0.1:${port}`);
}
