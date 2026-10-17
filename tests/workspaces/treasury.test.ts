import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { decodeFunctionData, erc20Abi, getAddress } from 'viem';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { token } from '@synq/chain-registry/arc';
import {
  SafeActionSchema,
  safeActionCall,
  safeActionGrantCall,
  type SafeAction,
} from '@synq/kernel/arc-safe-action';
import { appKitAdapter } from '@synq/plugin-circle-app-kit';
import { assertTreasuryAction } from '@synq/execution-worker/workspace-treasury';
import { relayFeeCap } from '@synq/execution-worker/workspace-governance';

const usdc = token('arc-testnet', 'USDC'),
  eurc = token('arc-testnet', 'EURC');
const safe = privateKeyToAccount(generatePrivateKey()).address;
const base = (opId: string) => ({
  id: randomUUID(),
  workspaceId: randomUUID(),
  chainId: 5042002,
  safe,
  policy: privateKeyToAccount(generatePrivateKey()).address,
  token: usdc.address,
  treasuryOpId: opId,
  nonce: '3',
  expiresAt: 2_000_000_900,
});
const approveAction = (opId: string, amount = '20000') =>
  SafeActionSchema.parse({
    ...base(opId),
    kind: 'TREASURY_APPROVE',
    spender: appKitAdapter(),
    approveToken: usdc.address,
    amount,
  });
const sqlWith = (row: Record<string, unknown> | null) => ({
  query: async () => ({ rows: row ? [row] : [] }),
});
const opRow = (a: SafeAction, overrides: Record<string, unknown> = {}) => ({
  id: 'treasuryOpId' in a ? a.treasuryOpId : '',
  workspace_id: a.workspaceId,
  state: 'APPROVE',
  data: {
    from: 'USDC',
    to: 'EURC',
    amountIn: '20000',
    slippageBps: 100,
    estimatedOut: '17000',
    minOut: '16830',
    step: null,
  },
  approve_action_id: a.id,
  execute_action_id: null,
  evidence: null,
  last_error: null,
  ...overrides,
});

describe('G9 treasury steps are exact vault actions', () => {
  it('encodes the allowance as approve(adapter, exact amount) on the input token and binds the grant to the adapter', () => {
    const a = approveAction(randomUUID());
    const call = safeActionCall(a);
    expect(getAddress(call.to)).toBe(getAddress(usdc.address));
    const d = decodeFunctionData({ abi: erc20Abi, data: call.data });
    expect(d.functionName).toBe('approve');
    expect(d.args).toEqual([appKitAdapter(), 20000n]);
    expect(safeActionGrantCall(a)).toMatchObject({
      recipient: appKitAdapter(),
      amount: 0n,
      payer: safe,
    });
    const exec = SafeActionSchema.parse({
      ...base(randomUUID()),
      kind: 'TREASURY_EXECUTE',
      target: appKitAdapter(),
      data: '0xabcdef01',
      tokenIn: usdc.address,
      amountIn: '20000',
      tokenOut: eurc.address,
      minOut: '16830',
    });
    expect(safeActionCall(exec)).toMatchObject({
      to: appKitAdapter(),
      data: '0xabcdef01',
      value: 0n,
    });
    expect(safeActionGrantCall(exec)).toMatchObject({
      recipient: appKitAdapter(),
      amount: 20000n,
    });
  });
  it('refuses to relay a treasury action that is not the current step or differs from the stored terms', async () => {
    const opId = randomUUID();
    const a = approveAction(opId);
    await expect(
      assertTreasuryAction(sqlWith(opRow(a)), a),
    ).resolves.toBeUndefined();
    for (const [row, action] of [
      [null, a],
      [opRow(a, { state: 'EXECUTE' }), a],
      [opRow(a, { approve_action_id: randomUUID() }), a],
      [opRow(a), approveAction(opId, '20001')],
      [
        opRow(a),
        SafeActionSchema.parse({
          ...a,
          spender: privateKeyToAccount(generatePrivateKey()).address,
        }),
      ],
    ] as const)
      await expect(
        assertTreasuryAction(sqlWith(row), action),
      ).rejects.toBeDefined();
  });
  it('lets only a treasury swap relay use the larger, still bounded gas ceiling', () => {
    expect(relayFeeCap({ kind: 'TREASURY_EXECUTE' })).toBe(
      150_000_000_000_000_000n,
    );
    for (const kind of [
      'PAY_VENDOR',
      'REFUND_MEMBER',
      'TREASURY_APPROVE',
      'SET_CAPS',
    ])
      expect(relayFeeCap({ kind })).toBe(50_000_000_000_000_000n);
  });
});
