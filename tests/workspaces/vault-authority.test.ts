import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { zeroAddress, type Hex } from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  MemoryNonceFence,
  admitVaultCreationGrant,
  decideVaultCreation,
} from '@synq/kernel/arc';
import {
  VaultSetupSchema,
  vaultSetupTypedData,
  vaultSetupHash,
  type VaultSetup,
} from '@synq/kernel/arc-vault-setup';
import { workspaceVaultData } from '@synq/execution-worker/workspace-vault';
import { decodeFunctionData } from 'viem';
import { VAULT_FACTORY_ABI } from '@synq/execution-worker/vault';

const now = 2_000_000_000;
const config = {
  grantKey: new Uint8Array(32).fill(7),
  operator: 'test-worker',
  grantTtlSeconds: 60,
  riskRequiredAbove: 0n,
};
async function signedSetup() {
  const owners = [
    privateKeyToAccount(generatePrivateKey()),
    privateKeyToAccount(generatePrivateKey()),
  ];
  const sponsor = privateKeyToAccount(generatePrivateKey());
  const setup = VaultSetupSchema.parse({
    workspaceId: randomUUID(),
    chainId: 5042002,
    factory: contract('arc-testnet', 'SYNQ_ARC_VAULT_FACTORY').address,
    token: token('arc-testnet', 'USDC').address,
    sponsor: sponsor.address,
    operator: sponsor.address,
    guardian: zeroAddress,
    owners: owners.map((o) => o.address),
    threshold: 1,
    delay: 86400,
    perPaymentCap: '5000000',
    windowCap: '20000000',
    maxGasNativeWei: '200000000000000000',
    salt: `0x${'34'.repeat(32)}`,
    expiresAt: now + 3600,
  });
  const signatures = await Promise.all(
    owners.map(async (owner) => ({
      owner: owner.address,
      signature: await owner.signTypedData(vaultSetupTypedData(setup)),
    })),
  );
  const input = {
    config,
    setup,
    signatures,
    expected: {
      factory: setup.factory,
      token: setup.token,
      sponsor: setup.sponsor,
      operator: setup.operator,
    },
    sponsorReservation: {
      setupHash: vaultSetupHash(setup),
      maxGasNativeWei: setup.maxGasNativeWei,
    },
    simulationOk: true,
    now,
  };
  return { setup, owners, sponsor, signatures, input };
}
describe('G1 G2 vault setup authority', () => {
  it('requires every proposed owner even for a one-of-two final Safe threshold', async () => {
    const f = await signedSetup();
    expect(
      (
        await decideVaultCreation({
          ...f.input,
          signatures: f.signatures.slice(0, 1),
        })
      ).outcome,
    ).toBe('DENY');
    expect(
      (
        await decideVaultCreation({
          ...f.input,
          signatures: [f.signatures[0]!, f.signatures[0]!],
        })
      ).outcome,
    ).toBe('DENY');
    expect((await decideVaultCreation(f.input)).outcome).toBe('ALLOW');
  });
  it('binds every factory parameter and the gas ceiling to the signatures', async () => {
    const f = await signedSetup();
    const changes: Partial<VaultSetup>[] = [
      { threshold: 2 },
      { delay: 3600 },
      { perPaymentCap: '6000000' },
      { windowCap: '21000000' },
      { maxGasNativeWei: '300000000000000000' },
      { salt: `0x${'35'.repeat(32)}` },
      { workspaceId: randomUUID() },
      { guardian: f.sponsor.address },
      { owners: [...f.setup.owners].reverse() },
      { sponsor: f.owners[0]!.address },
      { operator: f.owners[0]!.address },
    ];
    for (const change of changes)
      expect(
        (
          await decideVaultCreation({
            ...f.input,
            setup: { ...f.setup, ...change },
          })
        ).outcome,
      ).toBe('DENY');
  });
  it('fails closed on absent reservation, simulation, expiry and untrusted registry targets', async () => {
    const f = await signedSetup();
    for (const change of [
      { sponsorReservation: null },
      { simulationOk: false },
      { now: f.setup.expiresAt },
      { expected: { ...f.input.expected, factory: f.sponsor.address } },
    ])
      expect(
        (await decideVaultCreation({ ...f.input, ...change })).outcome,
      ).toBe('DENY');
    expect(VaultSetupSchema.safeParse({ ...f.setup, chainId: 1 }).success).toBe(
      false,
    );
    expect(
      VaultSetupSchema.safeParse({
        ...f.setup,
        recipients: [f.owners[0]!.address],
      }).success,
    ).toBe(false);
  });
  it('admits its exact setup once and refuses mutated or forged grants', async () => {
    const f = await signedSetup();
    const result = await decideVaultCreation(f.input);
    if (result.outcome !== 'ALLOW') throw new Error('setup denied');
    const fence = new MemoryNonceFence();
    const input = {
      setup: f.setup,
      grant: result.grant,
      grantKey: config.grantKey,
      now,
      fence,
    };
    await expect(
      admitVaultCreationGrant({
        ...input,
        setup: { ...f.setup, threshold: 2 },
      }),
    ).rejects.toMatchObject({ code: 'GRANT_MISMATCH' });
    await expect(
      admitVaultCreationGrant({
        ...input,
        grant: { ...result.grant, mac: `0x${'00'.repeat(32)}` as Hex },
      }),
    ).rejects.toMatchObject({ code: 'GRANT_FORGED' });
    await admitVaultCreationGrant(input);
    await expect(admitVaultCreationGrant(input)).rejects.toMatchObject({
      code: 'GRANT_REPLAYED',
    });
  });
  it('encodes an empty initial recipient allowlist and the signed owners and caps', async () => {
    const { setup } = await signedSetup();
    const call = decodeFunctionData({
      abi: VAULT_FACTORY_ABI,
      data: workspaceVaultData(setup),
    });
    expect(call.functionName).toBe('createVault');
    if (call.functionName !== 'createVault') throw new Error('wrong call');
    expect(call.args[0]).toMatchObject({
      owners: setup.owners,
      threshold: 1n,
      recipients: [],
      perPaymentCap: 5000000n,
      windowCap: 20000000n,
    });
    expect(call.args[1]).toBe(setup.salt);
  });
});
