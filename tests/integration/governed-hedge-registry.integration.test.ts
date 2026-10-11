import { afterAll, beforeAll, expect, it } from 'vitest';
import { artifactHash, onchainMandateId, toMandateConfig } from '@synq/kernel';
import { startAnvil } from '../../apps/demo/src/anvil.js';
import { deployLocalSynq } from '../../apps/demo/src/safe.js';
import { RegistryGovernedParentMandateReader } from '@synq/perpl-executor';
import { mandate as fixtureMandate, hash } from '../kernel/fixtures.js';

let node: Awaited<ReturnType<typeof startAnvil>>;
beforeAll(async () => {
  node = await startAnvil();
});
afterAll(async () => {
  await node?.close();
});
it('the production hedge parent reader binds the exact governed hash/version/status to the RPC registry', async () => {
  const chain = await deployLocalSynq(node.url);
  const now = Number((await chain.client.getBlock()).timestamp);
  let parent = fixtureMandate({
    validAfter: now - 60,
    validUntil: now + 3600,
    groupId: 'governed_hedge',
    mandateId: 'governed_parent',
    chainGroupId: chain.chainGroupId,
    account: chain.account,
    inputAsset: {
      ...fixtureMandate().inputAsset,
      address: chain.token.toLowerCase(),
      canonicalAssetId: `eip155:${fixtureMandate().network.chainId}/erc20:${chain.token.toLowerCase()}`,
    },
    hedgePolicyHash: hash(701),
  });
  await chain.governance.configureMandate(
    onchainMandateId(parent),
    toMandateConfig(parent),
  );
  const reader = new RegistryGovernedParentMandateReader({
    kernel: { listMandates: () => [parent] },
    client: chain.client,
    registry: chain.registry,
  });
  expect(artifactHash(await reader.current(parent.groupId))).toBe(
    artifactHash(parent),
  );
  const original = parent;
  parent = { ...parent, hedgePolicyHash: hash(702) };
  await expect(reader.current(parent.groupId)).rejects.toThrow(
    'parent not current',
  );
  parent = original;
  await chain.governance.revokeMandate(onchainMandateId(parent));
  await expect(reader.current(parent.groupId)).rejects.toThrow(
    'parent not current',
  );
  parent = { ...parent, status: 'REVOKED' };
  expect((await reader.current(parent.groupId)).status).toBe('REVOKED');
}, 60000);
