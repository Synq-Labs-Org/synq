import { describe, expect, it } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contract } from '@synq/chain-registry/arc';
import {
  GatewayAccount,
  GatewayError,
  assertSigner,
  burnIntent,
  burnIntentTypedData,
  gatewayChain,
  withdrawalRoute,
} from '@synq/plugin-circle-gateway';

const owner = privateKeyToAccount(`0x${'44'.repeat(32)}`);
const salt = `0x${'5a'.repeat(32)}` as Hex;

describe('Circle Gateway (P10)', () => {
  it('P10-01 / P10-02 a deposit leaves free source funds at once and is not spendable until Gateway credits it', () => {
    const a = new GatewayAccount(10_000_000n);
    a.deposit(4_000_000n);
    expect([a.sourceFree, a.pending, a.spendable()]).toEqual([
      6_000_000n,
      4_000_000n,
      0n,
    ]);
    expect(() => a.reserve(salt, 1n)).toThrow(GatewayError);
    a.observeAvailable(0n); // Gateway still shows nothing new
    expect(a.spendable()).toBe(0n);
    a.observeAvailable(4_000_000n);
    expect([a.pending, a.spendable(), a.sourceFree]).toEqual([
      0n,
      4_000_000n,
      6_000_000n,
    ]);
    // Total never exceeds what existed: no double counting of source + Gateway.
    expect(a.sourceFree + a.pending + a.spendable()).toBe(10_000_000n);
    expect(() => a.deposit(7_000_000n)).toThrow(GatewayError);
    expect(() => a.observeAvailable(99_000_000n)).toThrow(
      /more than was deposited/,
    );
  });

  it('P10-03 only supported signer kinds may sign burn intents', () => {
    expect(() => assertSigner('EOA')).not.toThrow();
    for (const k of ['CIRCLE_SCA', 'OPERATOR_KEY', 'MERA_PASSKEY'])
      expect(() => assertSigner(k)).toThrow(/cannot sign Gateway burn intents/);
    expect(() => gatewayChain('base-sepolia')).toThrow(GatewayError); // no Gateway contracts registered there
  });

  it('P10-04 the burn intent binds source/destination contracts, recipient and value and recovers to the signer', async () => {
    const i = burnIntent({
      source: 'eth-sepolia',
      destination: 'arc-testnet',
      depositor: owner.address,
      signer: owner.address,
      recipient: owner.address,
      value: 500_000n,
      maxFee: 2_010_000n,
      salt,
    });
    expect(i.spec.sourceDomain).toBe(0);
    expect(i.spec.destinationDomain).toBe(26);
    expect(i.spec.destinationContract.toLowerCase()).toContain(
      contract('arc-testnet', 'GATEWAY_MINTER').address.slice(2).toLowerCase(),
    );
    const typed = burnIntentTypedData(i);
    const sig = await owner.signTypedData(typed);
    expect(await recoverTypedDataAddress({ ...typed, signature: sig })).toBe(
      owner.address,
    );
    expect(() =>
      burnIntent({
        source: 'eth-sepolia',
        destination: 'arc-testnet',
        depositor: owner.address,
        signer: owner.address,
        recipient: owner.address,
        value: 0n,
        maxFee: 1n,
        salt,
      }),
    ).toThrow(GatewayError);
  });

  it('P10-05 one intent (salt) settles once', () => {
    const a = new GatewayAccount(5_000_000n);
    a.deposit(5_000_000n);
    a.observeAvailable(5_000_000n);
    a.reserve(salt, 1_000_000n);
    expect(() => a.reserve(salt, 1_000_000n)).toThrow(
      expect.objectContaining({ code: 'DUPLICATE_SPEND' }),
    );
    a.settle(1_000_000n);
    expect(() => a.settle(1n)).toThrow(GatewayError);
  });

  it('P10-06 withdrawal back to the source wallet is disclosed as not automated', () => {
    expect(() => withdrawalRoute()).toThrow(
      expect.objectContaining({ code: 'WITHDRAWAL_UNAVAILABLE' }),
    );
  });
});
