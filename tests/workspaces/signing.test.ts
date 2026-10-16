import { describe, expect, it } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { chainProfile } from '@synq/chain-registry/arc';
import { boundedWorkspaceSigner } from '@synq/execution-worker/workspace-signing';
describe('G4/G6 bounded workspace signer — LOCAL_FIXTURE', () => {
  it('enforces a narrower proof gas ceiling before invoking the signer', async () => {
    const owner = privateKeyToAccount(generatePrivateKey());
    let signed = 0;
    const signer = boundedWorkspaceSigner(
      {
        address: owner.address,
        signTransaction: async (tx) => {
          signed++;
          return owner.signTransaction(tx);
        },
      },
      10n,
    );
    const tx = {
      chainId: chainProfile('arc-testnet').chainId,
      to: owner.address,
      data: '0x' as const,
      value: 0n,
      nonce: 0,
      gas: 2n,
      maxFeePerGas: 6n,
      maxPriorityFeePerGas: 1n,
    };
    await expect(signer.signTransaction(tx)).rejects.toMatchObject({
      code: 'FEE_ABOVE_CAP',
    });
    expect(signed).toBe(0);
    await expect(
      signer.signTransaction({ ...tx, maxFeePerGas: 5n }),
    ).resolves.toMatch(/^0x/);
    expect(signed).toBe(1);
    expect(() =>
      boundedWorkspaceSigner(owner, 50_000_000_000_000_001n),
    ).toThrow();
  });
  it('rejects a signer that changes the destination or gas in returned bytes', async () => {
    const owner = privateKeyToAccount(generatePrivateKey()),
      other = privateKeyToAccount(generatePrivateKey());
    const signer = boundedWorkspaceSigner({
      address: owner.address,
      signTransaction: (tx) =>
        owner.signTransaction({ ...tx, to: other.address }),
    });
    await expect(
      signer.signTransaction({
        chainId: chainProfile('arc-testnet').chainId,
        to: owner.address,
        data: '0x',
        value: 0n,
        nonce: 0,
        gas: 21000n,
        maxFeePerGas: 1n,
        maxPriorityFeePerGas: 1n,
      }),
    ).rejects.toMatchObject({ code: 'TX_MISMATCH' });
  });
});
