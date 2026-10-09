import type { PublicClient } from 'viem';
import { expect, it } from 'vitest';
import {
  MemoryProjectionStore,
  ProjectionReader,
  Projector,
  ReadModelError,
  RpcDirectVerifier,
} from '../../packages/read-model/src/index.js';
import { chainId, config, groupId, lifecycle } from './fixtures.js';

it('direct verification with an empty target list is a typed error, never consistent', async () => {
  const cfg = config();
  const store = new MemoryProjectionStore(chainId);
  await new Projector(store, cfg).applyWindow({
    fromBlockExclusive: 99,
    toBlockInclusive: 110,
    events: lifecycle(),
  });
  let rpcCalls = 0;
  const client = new Proxy(
    {},
    {
      get: () => () => {
        rpcCalls++;
        throw new Error('no RPC expected');
      },
    },
  ) as PublicClient;
  const verifier = new RpcDirectVerifier(
    client,
    cfg,
    new ProjectionReader(store, cfg),
  );
  for (const run of [
    () => verifier.verifyIndexed(groupId, []),
    () => verifier.readAtHead(groupId, 120, []),
  ]) {
    const error = await run().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReadModelError);
    expect((error as ReadModelError).code).toBe('NO_VERIFICATION_TARGETS');
  }
  expect(rpcCalls).toBe(0);
});
