import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  keccak256,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { moneyFromDecimal } from '@synq/domain';
import { contract, token } from '@synq/chain-registry/arc';
import {
  ArcExecutionError,
  connectChain,
  prepareTransfer,
  reconcileTransfer,
  signPrepared,
  verifyContract,
} from '@synq/execution-worker/arc';

const USDC = token('arc-testnet', 'USDC');
const PINNED_USDC_CODE =
  '0xc9987bd3af6b26a030951faa7eacc017b68343aeedf3ce5fe68f821c4b93939d';
// Live Arc testnet USDC bytecode (eth_getCode, 2026-10-16); hashes to the registry pin.
const USDC_CODE = readFileSync(
  new URL('./fixtures/arc-testnet-usdc.code', import.meta.url),
  'utf8',
).trim() as Hex;
const payer = privateKeyToAccount(`0x${'42'.repeat(32)}`);
const payee = '0x00000000000000000000000000000000000beef1' as const;

/** Minimal JSON-RPC double: only the calls the executor makes. */
function fakeClient(o: {
  chainId?: number;
  code?: Hex;
  tokenUnits?: bigint;
  nativeWei?: bigint;
  simulateOk?: boolean;
  receipt?: Record<string, unknown>;
}) {
  // Choose bytecode whose keccak matches the registry pin unless overridden.
  const code = o.code ?? ('0x' as Hex);
  return {
    getChainId: async () => o.chainId ?? 5042002,
    getCode: async () => code,
    readContract: async () => o.tokenUnits ?? 50_000_000n,
    getBalance: async () => o.nativeWei ?? 50n * 10n ** 18n,
    getTransactionCount: async () => 7,
    estimateFeesPerGas: async () => ({
      maxFeePerGas: 1_000_000_000n,
      maxPriorityFeePerGas: 0n,
    }),
    call: async () => {
      if (o.simulateOk === false) throw new Error('execution reverted');
      return { data: encodeAbiParameters([{ type: 'bool' }], [true]) };
    },
    estimateGas: async () => 60_000n,
    waitForTransactionReceipt: async () => o.receipt,
  } as unknown as PublicClient;
}

describe('Arc executor safety', () => {
  it('P02-01 refuses an RPC that serves another chain before anything else', async () => {
    await expect(
      connectChain('arc-testnet', undefined, fakeClient({ chainId: 11155111 })),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
    await expect(
      connectChain('arc-testnet', undefined, fakeClient({ chainId: 5042 })),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' });
  });

  it('P02-05 blocks execution when the token bytecode does not match its pin', async () => {
    const chain = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({ code: '0x60806040deadbeef' }),
    );
    await expect(
      prepareTransfer(chain, {
        from: payer.address,
        to: payee,
        amount: moneyFromDecimal(USDC, '1'),
      }),
    ).rejects.toMatchObject({ code: 'CODE_HASH_MISMATCH' });
    const empty = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({ code: '0x' }),
    );
    await expect(
      verifyContract(empty, 'CCTP_TOKEN_MESSENGER_V2'),
    ).rejects.toMatchObject({
      code: 'NO_CODE',
    });
    expect(contract('arc-testnet', 'MEMO').codeHash).toMatch(/^0x/);
  });

  it('refuses mainnet, permissioned and wrong-chain assets', async () => {
    const mainnet = await connectChain(
      'arc-mainnet',
      undefined,
      fakeClient({ chainId: 5042 }),
    );
    await expect(
      prepareTransfer(mainnet, {
        from: payer.address,
        to: payee,
        amount: moneyFromDecimal(token('arc-mainnet', 'USDC'), '1'),
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
    const chain = await connectChain('arc-testnet', undefined, fakeClient({}));
    await expect(
      prepareTransfer(chain, {
        from: payer.address,
        to: payee,
        amount: moneyFromDecimal(token('eth-sepolia', 'USDC'), '1'),
      }),
    ).rejects.toMatchObject({ code: 'ASSET_CHAIN_MISMATCH' });
    await expect(
      prepareTransfer(chain, {
        from: payer.address,
        to: payee,
        amount: moneyFromDecimal(token('arc-testnet', 'USYC'), '1'),
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_DISABLED' });
  });

  it('P02-06 / P02-03 checks value plus worst-case gas against the single Arc USDC balance', async () => {
    expect(keccak256(USDC_CODE)).toBe(PINNED_USDC_CODE);
    const amount = moneyFromDecimal(USDC, '10');
    // Fees: floor 20 gwei applies (estimate says 1 gwei); gas 60k × 1.3 = 78k.
    const worstGasWei = 78_000n * 20_000_000_000n;
    const enough = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({
        code: USDC_CODE,
        tokenUnits: 10_000_000n,
        nativeWei: 10n * 10n ** 18n + worstGasWei,
      }),
    );
    const prepared = await prepareTransfer(enough, {
      from: payer.address,
      to: payee,
      amount,
    });
    expect(prepared).toMatchObject({
      gas: 78_000n,
      maxFeePerGas: 20_000_000_000n,
      nonce: 7,
    });
    expect(prepared.maxGasCostWei).toBe(worstGasWei);
    // Exactly the value but nothing left for gas: refused before signing.
    const noGas = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({
        code: USDC_CODE,
        tokenUnits: 10_000_000n,
        nativeWei: 10n * 10n ** 18n + worstGasWei - 1n,
      }),
    );
    await expect(
      prepareTransfer(noGas, { from: payer.address, to: payee, amount }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_GAS',
    });
    const poor = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({ code: USDC_CODE, tokenUnits: 9_999_999n }),
    );
    await expect(
      prepareTransfer(poor, { from: payer.address, to: payee, amount }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_FUNDS',
    });
    const reverts = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({ code: USDC_CODE, simulateOk: false }),
    );
    await expect(
      prepareTransfer(reverts, { from: payer.address, to: payee, amount }),
    ).rejects.toMatchObject({
      code: 'SIMULATION_FAILED',
    });
    await expect(
      prepareTransfer(enough, {
        from: payer.address,
        to: payee,
        amount,
        maxGasCostWei: worstGasWei - 1n,
      }),
    ).rejects.toMatchObject({ code: 'FEE_ABOVE_CAP' });
  });

  it('signs only the exact prepared transfer and rejects tampering or the wrong signer', async () => {
    const prepared = {
      chain: 'arc-testnet' as const,
      chainId: 5042002,
      from: payer.address,
      to: payee,
      amount: moneyFromDecimal(USDC, '0.25'),
      token: USDC.address,
      data: '0x' as Hex,
      gas: 80_000n,
      maxFeePerGas: 21_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      nonce: 1,
      maxGasCostWei: 80_000n * 21_000_000_000n,
      codeHash: PINNED_USDC_CODE as Hex,
    };
    const { encodeFunctionData } = await import('viem');
    const good = {
      ...prepared,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [payee, 250_000n],
      }),
    };
    const signed = await signPrepared(payer, good);
    expect(signed.hash).toBe(keccak256(signed.raw));
    const redirected = {
      ...good,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: ['0x00000000000000000000000000000000000bad00', 250_000n],
      }),
    };
    await expect(signPrepared(payer, redirected)).rejects.toMatchObject({
      code: 'TX_MISMATCH',
    });
    const other = privateKeyToAccount(`0x${'43'.repeat(32)}`);
    await expect(signPrepared(other, good)).rejects.toMatchObject({
      code: 'SIGNER_MISMATCH',
    });
  });

  it('reconciles only a successful receipt with exactly one matching Transfer', async () => {
    const amount = moneyFromDecimal(USDC, '0.25');
    const log = (to: string, value: bigint) => ({
      address: USDC.address,
      topics: encodeEventTopics({
        abi: erc20Abi,
        eventName: 'Transfer',
        args: { from: payer.address, to: to as `0x${string}` },
      }),
      data: encodeAbiParameters([{ type: 'uint256' }], [value]),
      blockNumber: 1n,
      transactionHash: `0x${'aa'.repeat(32)}`,
      logIndex: 0,
      blockHash: `0x${'bb'.repeat(32)}`,
      transactionIndex: 0,
      removed: false,
    });
    const prepared = {
      chain: 'arc-testnet' as const,
      chainId: 5042002,
      from: payer.address,
      to: payee,
      amount,
      token: USDC.address,
      data: '0x' as Hex,
      gas: 1n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      nonce: 0,
      maxGasCostWei: 1n,
      codeHash: PINNED_USDC_CODE as Hex,
    };
    const receipt = (logs: unknown[], status = 'success') => ({
      status,
      logs,
      blockNumber: 10n,
      blockHash: `0x${'bb'.repeat(32)}`,
      gasUsed: 50_000n,
      effectiveGasPrice: 20_000_000_000n,
    });
    const ok = await connectChain(
      'arc-testnet',
      undefined,
      fakeClient({ receipt: receipt([log(payee, 250_000n)]) }),
    );
    const evidence = await reconcileTransfer(
      ok,
      prepared,
      `0x${'aa'.repeat(32)}`,
    );
    expect(evidence.feeUsdc?.baseUnits).toBe(1000n); // 50k gas × 20 gwei = 0.001 USDC
    expect(evidence.explorer).toBe(
      `https://explorer.testnet.arc.io/tx/0x${'aa'.repeat(32)}`,
    );
    for (const bad of [
      receipt([log(payee, 250_000n)], 'reverted'),
      receipt([log(payee, 249_999n)]),
      receipt([log('0x00000000000000000000000000000000000bad00', 250_000n)]),
      receipt([log(payee, 250_000n), log(payee, 250_000n)]),
      receipt([]),
    ]) {
      const c = await connectChain(
        'arc-testnet',
        undefined,
        fakeClient({ receipt: bad }),
      );
      await expect(
        reconcileTransfer(c, prepared, `0x${'aa'.repeat(32)}`),
      ).rejects.toBeInstanceOf(ArcExecutionError);
    }
  });
});
