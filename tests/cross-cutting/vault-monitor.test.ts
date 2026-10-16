import { describe, expect, it } from 'vitest';
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  erc20Abi,
  keccak256,
  parseAbi,
  parseEventLogs,
  toHex,
  type Address,
  type Hex,
  type Log,
} from 'viem';
import { contract, token } from '@synq/chain-registry/arc';
import {
  OPERATION,
  SAFE_ABI,
  VAULT_POLICY_ABI,
  classifyQueuedOperation,
} from '@synq/execution-worker/vault';

/**
 * Residual risks R3–R6 of the vault policy register cannot be closed without
 * a contract change; the cheap off-chain mitigation is to flag the risky
 * timelocked operations while their delay runs. These tests drive the
 * classifier from real OperationQueued logs (LOCAL_FIXTURE logs, real ABI).
 */
const SAFE = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address as Address;
const POLICY = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const USDC = token('arc-testnet', 'USDC').address;
const OTHER = `0x${'0e'.repeat(20)}` as Address;
const EXTRA = parseAbi([
  'function enableModule(address module)',
  'function setGuard(address guard)',
  'function setFallbackHandler(address handler)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
]);

function queuedLog(
  to: Address,
  value: bigint,
  operation: number,
  data: Hex,
): Log {
  const id = keccak256(toHex(`${to}:${data}:${operation}`));
  return {
    address: POLICY,
    topics: encodeEventTopics({
      abi: VAULT_POLICY_ABI,
      eventName: 'OperationQueued',
      args: { id, to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters(
      [
        { type: 'uint256' },
        { type: 'uint8' },
        { type: 'bytes' },
        { type: 'uint256' },
      ],
      [value, operation, data, 1_800_000_000n],
    ),
    blockNumber: 1n,
    blockHash: `0x${'aa'.repeat(32)}` as Hex,
    transactionHash: `0x${'bb'.repeat(32)}` as Hex,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
  };
}

const classify = (to: Address, data: Hex, operation = 0, value = 0n) => {
  const [ev] = parseEventLogs({
    abi: VAULT_POLICY_ABI,
    eventName: 'OperationQueued',
    logs: [queuedLog(to, value, operation, data)],
  });
  return classifyQueuedOperation(ev!.args, { safe: SAFE, policy: POLICY });
};

describe('P23-07 vault residual-risk monitor (R3-R6, no contract redeploy)', () => {
  it('P23-07 R4/R5: queued module, guard, fallback-handler and owner changes are HIGH', () => {
    for (const data of [
      encodeFunctionData({
        abi: EXTRA,
        functionName: 'enableModule',
        args: [OTHER],
      }),
      encodeFunctionData({
        abi: EXTRA,
        functionName: 'setGuard',
        args: [OTHER],
      }),
      encodeFunctionData({
        abi: EXTRA,
        functionName: 'setFallbackHandler',
        args: [OTHER],
      }),
      encodeFunctionData({
        abi: EXTRA,
        functionName: 'swapOwner',
        args: [OTHER, OTHER, OTHER],
      }),
      encodeFunctionData({
        abi: SAFE_ABI,
        functionName: 'changeThreshold',
        args: [1n],
      }),
    ]) {
      const r = classify(SAFE, data);
      expect(r.risk).toBe('HIGH');
      expect(r.reasons.join()).toMatch(/Safe configuration change/);
    }
  });

  it('P23-07 R6: any DELEGATECALL (SignMessageLib) is HIGH', () => {
    const r = classify(OTHER, '0x85a5affe', OPERATION.DELEGATECALL);
    expect(r.risk).toBe('HIGH');
    expect(r.reasons[0]).toMatch(/DELEGATECALL/);
  });

  it('P23-07 R3: a non-zero token allowance is HIGH; revoking one (zero) is not', () => {
    const approve = (n: bigint) =>
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [OTHER, n],
      });
    expect(classify(USDC, approve(1n)).risk).toBe('HIGH');
    expect(classify(USDC, approve(0n))).toEqual({
      risk: 'NORMAL',
      reasons: [],
    });
  });

  it('P23-07 policy role changes are HIGH; an ordinary token transfer queued by owners is NORMAL', () => {
    expect(
      classify(
        POLICY,
        encodeFunctionData({
          abi: VAULT_POLICY_ABI,
          functionName: 'setOperator',
          args: [OTHER],
        }),
      ).risk,
    ).toBe('HIGH');
    expect(
      classify(
        USDC,
        encodeFunctionData({
          abi: erc20Abi,
          functionName: 'transfer',
          args: [OTHER, 5n],
        }),
      ).risk,
    ).toBe('NORMAL');
  });
});
