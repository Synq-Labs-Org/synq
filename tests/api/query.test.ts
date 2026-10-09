import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it, expect } from 'vitest';
import { createApi } from '../../apps/api/src/server.js';
import { ProofQueryService } from '../../apps/api/src/service.js';
import { binding, proof, treasuryToken } from '../read-model/fixtures.js';
it('queries reconstructed proof and rejects malformed ingress without exposing signing controls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'synq-api-'));
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
  const api = createApi(new ProofQueryService(path));
  try {
    const reply = await api.inject({
      url: `/dev/groups/${binding.groupId}/state`,
    });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({
      currentHeadVerified: false,
      state: { treasuryBalance: '900000' },
    });
    expect(
      (await api.inject({ url: '/dev/groups/not-a-hash/state' })).statusCode,
    ).toBe(400);
    expect(
      (await api.inject({ method: 'POST', url: '/dev/execute', payload: {} }))
        .statusCode,
    ).toBe(404);
  } finally {
    await api.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
