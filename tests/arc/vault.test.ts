import { describe, expect, it } from 'vitest';
import {
  encodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import legacy from '../../sources/chain_registry.json' with { type: 'json' };
import arcDeployment from '../../contracts/deployments/5042002.json' with { type: 'json' };
import { contract, token } from '@synq/chain-registry/arc';
import {
  OPERATION,
  VAULT_POLICY_ABI,
  collectSignatures,
  packSignatures,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  readVault,
  revertReason,
  safeTxHash,
  type SafeTx,
} from '@synq/execution-worker/vault';
import { CHAINS } from '@synq/chain-registry/arc';
import type { ArcChain } from '@synq/execution-worker/arc';

const ownerA = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const ownerB = privateKeyToAccount(`0x${'22'.repeat(32)}`);
const ownerC = privateKeyToAccount(`0x${'33'.repeat(32)}`);

describe('Arc governed vault (Safe v1.4.1 + SynqArcVaultPolicy)', () => {
  it('P07-01 SafeTx hash matches the on-chain getTransactionHash of the live 2-of-3 withdrawal', () => {
    // Vector from the Arc testnet proof: Safe.getTransactionHash returned this
    // value for nonce 0 of the pinned proof vault before execution.
    const v = arcDeployment.safeTxVector;
    const safe = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address;
    expect(getAddress(v.safe)).toBe(getAddress(safe));
    const usdc = token('arc-testnet', 'USDC');
    const tx: SafeTx = {
      to: usdc.address,
      value: 0n,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [getAddress(v.recipient), BigInt(v.amount)],
      }),
      operation: OPERATION.CALL,
      nonce: BigInt(v.nonce),
    };
    expect(safeTxHash(v.chainId, safe, tx)).toBe(v.safeTxHash);
    // Domain separation: another chain or another Safe gives another hash.
    expect(safeTxHash(5042, safe, tx)).not.toBe(v.safeTxHash);
    expect(safeTxHash(v.chainId, ownerC.address, tx)).not.toBe(v.safeTxHash);
  });

  it('P07-01 signatures are collected per owner, recovered, and packed in ascending owner order', async () => {
    const safe = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address;
    const tx: SafeTx = {
      to: ownerC.address,
      value: 0n,
      data: '0x',
      operation: OPERATION.CALL,
      nonce: 7n,
    };
    const sigs = await collectSignatures(5042002, safe, tx, [ownerA, ownerB]);
    const packed = packSignatures(sigs);
    expect(packed.length).toBe(2 + 2 * 65 * 2);
    const order = [...sigs].sort((a, b) =>
      BigInt(a.owner) < BigInt(b.owner) ? -1 : 1,
    );
    expect(packed.slice(2, 132)).toBe(order[0]!.signature.slice(2));
    expect(() => packSignatures([sigs[0]!, sigs[0]!])).toThrow(/duplicate/);
    // A signer that does not sign as its claimed owner is rejected.
    const impostor = { ...ownerA, address: ownerB.address };
    await expect(
      collectSignatures(5042002, safe, tx, [impostor]),
    ).rejects.toThrow(/SIGNER_MISMATCH|!=/);
  });

  it('P07-07 Safe infrastructure on Arc is pinned to the same v1.4.1 bytecode as the audited Monad pins', () => {
    const pins = legacy.contracts as unknown as Record<
      string,
      { address: string; codeHash: string; version: string; chainId: number }
    >;
    for (const [kind, key] of [
      ['SAFE_L2_SINGLETON', 'testnetSafeL2'],
      ['SAFE_PROXY_FACTORY', 'testnetSafeProxyFactory'],
      ['SAFE_FALLBACK_HANDLER', 'testnetSafeFallbackHandler'],
      ['SAFE_MULTI_SEND_CALL_ONLY', 'testnetSafeMultiSendCallOnly'],
    ] as const) {
      const arc = contract('arc-testnet', kind);
      expect(pins[key]!.version).toBe('1.4.1');
      expect(getAddress(arc.address)).toBe(getAddress(pins[key]!.address));
      expect(arc.codeHash).toBe(pins[key]!.codeHash);
    }
    // Synq vault contracts are pinned, non-proxy (no hidden implementation); the vault itself is a Safe proxy.
    for (const kind of [
      'SYNQ_ARC_VAULT_FACTORY',
      'SYNQ_ARC_VAULT_SETUP',
      'SYNQ_ARC_FALLBACK_HANDLER',
      'SYNQ_ARC_VAULT_POLICY',
      'SYNQ_MILESTONE_ESCROW',
    ] as const) {
      expect(contract('arc-testnet', kind).codeHash).toMatch(
        /^0x[0-9a-f]{64}$/,
      );
      expect(contract('arc-testnet', kind).proxy).toBe(false);
    }
    expect(contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').proxy).toBe(true);
    expect(() => contract('arc-mainnet', 'SYNQ_ARC_VAULT_FACTORY')).toThrow();
  });

  it('decodes policy custom errors and Safe GS codes from reverts', () => {
    const data = encodeErrorResult({
      abi: VAULT_POLICY_ABI,
      errorName: 'CapExceeded',
      args: [11_000n, 10_000n],
    });
    expect(revertReason({ cause: { data } })).toBe('CapExceeded(11000,10000)');
    expect(
      revertReason({
        shortMessage:
          'The contract function "execTransaction" reverted with the following reason:\nGS020',
      }),
    ).toBe('GS020');
  });

  it('P07-07 readVault reports a vault healthy only with the pinned singleton, Synq handler, bound policy and no extra module', async () => {
    const safe = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address;
    const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY').address;
    const word = (a: string) =>
      `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as const;
    const sentinel = '0x0000000000000000000000000000000000000001';
    const fake = (o: {
      handler?: string;
      singleton?: string;
      modules?: string[];
      policySafe?: string;
    }) =>
      ({
        profile: CHAINS['arc-testnet'],
        client: {
          readContract: async ({
            functionName,
            args,
          }: {
            functionName: string;
            args?: readonly unknown[];
          }) => {
            switch (functionName) {
              case 'getOwners':
                return [ownerA.address, ownerB.address, ownerC.address];
              case 'getThreshold':
                return 2n;
              case 'nonce':
                return 0n;
              case 'VERSION':
                return '1.4.1';
              case 'getModulesPaginated':
                return [o.modules ?? [policy], sentinel];
              case 'safe':
                return o.policySafe ?? safe;
              case 'getStorageAt': {
                const slot = args![0] as bigint;
                if (slot === SAFE_GUARD_SLOT) return word(policy);
                if (slot === SAFE_FALLBACK_HANDLER_SLOT)
                  return word(
                    o.handler ??
                      contract('arc-testnet', 'SYNQ_ARC_FALLBACK_HANDLER')
                        .address,
                  );
                return word(
                  o.singleton ??
                    contract('arc-testnet', 'SAFE_L2_SINGLETON').address,
                );
              }
              default:
                throw new Error(functionName);
            }
          },
        },
      }) as unknown as ArcChain;
    expect((await readVault(fake({}), safe)).healthy).toBe(true);
    const stock = contract('arc-testnet', 'SAFE_FALLBACK_HANDLER').address;
    const bad = [
      await readVault(fake({ handler: stock }), safe),
      await readVault(fake({ modules: [policy, ownerC.address] }), safe),
      await readVault(fake({ policySafe: ownerC.address }), safe),
      await readVault(
        fake({ singleton: contract('arc-testnet', 'SAFE_SINGLETON').address }),
        safe,
      ),
    ];
    for (const r of bad) expect(r.healthy).toBe(false);
    expect(bad[0]!.problems.join()).toMatch(/fallbackHandler/);
    expect(bad[1]!.problems.join()).toMatch(/unexpected modules/);
    expect(bad[2]!.problems.join()).toMatch(/not bound/);
    expect(bad[3]!.problems.join()).toMatch(/singleton/);
  });
});
