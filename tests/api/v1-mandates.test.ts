import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import { mandateReader } from '../../apps/api/src/v1-server.js';
import { ProofQueryService } from '../../apps/api/src/service.js';
import { MemoryIdentityStore } from '../../packages/identity/src/server.js';
import { binding, hash, proof, treasuryToken } from '../read-model/fixtures.js';

it('serves /v1/mandates from the indexed read model and labels head verification', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synq-v1-mandate-'));
  const path = join(dir, 'proof.json');
  writeFileSync(
    path,
    JSON.stringify({
      manifest: {
        schemaVersion: 1,
        network: {
          profile: 'local',
          chainId: 31337,
          providerEnvironment: 'local',
        },
        account: binding.account,
        mandateRegistry: binding.registry,
        executionModule: binding.module,
        deploymentTransactions: Array(3).fill(`0x${'1'.repeat(64)}`),
        deploymentBlock: '1',
        sandboxOnly: true,
      },
      localTestToken: treasuryToken,
      bindings: [binding],
      events: proof().map((e) => ({
        ...e,
        chainId: 31337,
        payload:
          e.eventName === 'GrantExecuted'
            ? { ...e.payload, chainId: '31337' }
            : e.payload,
      })),
      checkpoint: 3,
      snapshot: { generatedAt: 1000 },
    }),
  );
  const api = createV1Api({
    store: new MemoryIdentityStore(),
    config: {
      profile: 'local/anvil',
      rpId: 'localhost',
      origin: 'http://localhost:3100',
    },
    adminToken: null,
    executionModules: {},
    mandates: mandateReader(new ProofQueryService(path)),
  });
  try {
    const found = await api.inject({
      url: `/v1/mandates/${binding.groupId}/${hash(2)}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      version: '1',
      source: 'indexed-read-model',
      currentHeadVerified: false,
      terms: { selector: '0xa9059cbb' },
    });
    expect(
      (await api.inject({ url: `/v1/mandates/${binding.groupId}/${hash(9)}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.inject({ url: `/v1/mandates/${binding.groupId}/nope` }))
        .statusCode,
    ).toBe(400);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
