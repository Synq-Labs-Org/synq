import { expect, it } from 'vitest';
import { createV1Api } from '../../apps/api/src/v1/app.js';
import { mandateReader } from '../../apps/api/src/v1-server.js';
import {
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
} from '../../packages/read-model/src/index.js';
import { MemoryIdentityStore } from '../../packages/identity/src/server.js';
import {
  chainId,
  config,
  creation,
  funding,
  governance,
  groupId,
  mandateId,
  word,
} from '../read-model/fixtures.js';

it('serves /v1/mandates from the indexed projection and labels head verification', async () => {
  const store = new MemoryProjectionStore(chainId);
  const cfg = config();
  await new Projector(store, cfg).applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: [...creation(), funding(102), ...governance()],
  });
  const api = createV1Api({
    store: new MemoryIdentityStore(),
    config: {
      profile: 'sandbox/monad-testnet',
      rpId: 'localhost',
      origin: 'http://localhost:3100',
    },
    adminToken: null,
    executionModules: {},
    mandates: mandateReader(new ProjectionReader(store, cfg)),
  });
  try {
    const found = await api.inject({
      url: `/v1/mandates/${groupId}/${mandateId}`,
    });
    expect(found.statusCode).toBe(200);
    expect(found.json()).toMatchObject({
      groupId,
      mandateId,
      version: '1',
      active: true,
      source: 'indexed-read-model',
      currentHeadVerified: false,
      terms: { status: 'ACTIVE', indexedThroughBlock: '110' },
    });
    expect(
      (await api.inject({ url: `/v1/mandates/${groupId}/${word('nope')}` }))
        .statusCode,
    ).toBe(404);
    expect(
      (await api.inject({ url: `/v1/mandates/${groupId}/nope` })).statusCode,
    ).toBe(400);
    const unavailable = createV1Api({
      store: new MemoryIdentityStore(),
      config: {
        profile: 'sandbox/monad-testnet',
        rpId: 'localhost',
        origin: 'http://localhost:3100',
      },
      adminToken: null,
      executionModules: {},
    });
    expect(
      (
        await unavailable.inject({
          url: `/v1/mandates/${groupId}/${mandateId}`,
        })
      ).json(),
    ).toMatchObject({ error: 'READ_MODEL_UNAVAILABLE' });
  } finally {
    await api.close();
  }
});
