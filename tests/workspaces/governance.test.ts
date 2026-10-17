import { randomUUID, randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hashTypedData, type Hex } from 'viem';
import { token } from '@synq/chain-registry/arc';
import {
  decideWorkspaceSafeAction,
  admitGrant,
  MemoryNonceFence,
} from '@synq/kernel/arc';
import {
  SafeActionSchema,
  safeActionCall,
  safeActionApprovalTypedData,
  safeActionTypedData,
  safeActionExecution,
  type SafeActionSignature,
} from '@synq/kernel/arc-safe-action';
import { safeTxTypedData } from '@synq/execution-worker/vault';
const actor = () => privateKeyToAccount(generatePrivateKey());
async function fixture() {
  const owners = [actor(), actor()],
    outsider = actor(),
    now = 2_000_000_000;
  const parsed = SafeActionSchema.parse({
    id: randomUUID(),
    workspaceId: randomUUID(),
    chainId: 5042002,
    safe: actor().address,
    policy: actor().address,
    token: token('arc-testnet', 'USDC').address,
    kind: 'QUEUE_VENDOR',
    vendorId: randomUUID(),
    vendorAddress: actor().address,
    vendorChangeHash: `0x${randomBytes(32).toString('hex')}`,
    nonce: '0',
    expiresAt: now + 900,
  });
  if (!('vendorAddress' in parsed)) throw new Error('expected vendor action');
  const action = parsed;
  const sign = async (a = action, who = owners) =>
    Promise.all(
      who.map(async (o) => ({
        owner: o.address,
        approvalSignature: await o.signTypedData(
          safeActionApprovalTypedData(a),
        ),
        safeSignature: await o.signTypedData(safeActionTypedData(a)),
      })),
    );
  const input = {
    config: {
      operator: 'governance-test',
      grantKey: randomBytes(32),
      grantTtlSeconds: 60,
      riskRequiredAbove: 0n,
    },
    action,
    signatures: await sign(),
    custody: {
      safe: action.safe,
      policy: action.policy,
      owners: owners.map((v) => v.address),
      threshold: 2,
      nonce: 0n,
    },
    vendor: {
      address: action.vendorAddress,
      changeHash: action.vendorChangeHash as Hex,
      eligibleAt: now,
    },
    simulationOk: true,
    now,
  };
  return { input, sign, outsider };
}
describe('G5 Safe governance authority — LOCAL_FIXTURE', () => {
  it('matches standard Safe typed data and requires two independent signatures per owner', async () => {
    const f = await fixture(),
      a = f.input.action;
    expect(hashTypedData(safeActionTypedData(a))).toBe(
      hashTypedData(safeTxTypedData(a.chainId, a.safe, safeActionCall(a))),
    );
    expect((await decideWorkspaceSafeAction(f.input)).outcome).toBe('ALLOW');
    for (const signatures of [
      [],
      f.input.signatures.slice(0, 1),
      [f.input.signatures[0]!, f.input.signatures[0]!],
      await f.sign(a, [f.outsider]),
    ])
      expect(
        (await decideWorkspaceSafeAction({ ...f.input, signatures })).outcome,
      ).toBe('DENY');
    const forged: SafeActionSignature[] = [
      {
        ...f.input.signatures[0]!,
        safeSignature: f.input.signatures[1]!.safeSignature,
      },
      f.input.signatures[1]!,
    ];
    expect(
      (await decideWorkspaceSafeAction({ ...f.input, signatures: forged }))
        .outcome,
    ).toBe('DENY');
  });
  it('refuses stale custody, vendor revisions, cooling, expiry and failed simulation', async () => {
    const f = await fixture(),
      i = f.input;
    for (const overrides of [
      { custody: { ...i.custody, nonce: 1n } },
      { vendor: { ...i.vendor, eligibleAt: i.now + 1 } },
      { vendor: { ...i.vendor, changeHash: `0x${'aa'.repeat(32)}` as Hex } },
      { now: i.action.expiresAt },
      { simulationOk: false },
      { action: { ...i.action, kind: 'ALLOW_VENDOR' as const } },
    ])
      expect(
        (await decideWorkspaceSafeAction({ ...i, ...overrides })).outcome,
      ).toBe('DENY');
  });
  it('MAC binds the exact Safe execution bytes and consumes the grant once', async () => {
    const f = await fixture(),
      i = f.input,
      d = await decideWorkspaceSafeAction(i);
    if (d.outcome !== 'ALLOW') throw new Error('expected allow');
    const check = {
      grant: d.grant,
      grantKey: i.config.grantKey,
      call: {
        chainId: i.action.chainId,
        token: i.action.token,
        payer: i.action.safe,
        recipient: i.action.policy,
        amount: 0n,
      },
      executionCall: safeActionExecution(i.action, i.signatures),
      now: i.now,
      mandateRevoked: false,
    };
    const fence = new MemoryNonceFence();
    await expect(
      admitGrant({
        ...check,
        executionCall: { ...check.executionCall, data: '0x' as Hex },
        fence,
      }),
    ).rejects.toMatchObject({ code: 'GRANT_MISMATCH' });
    await admitGrant({ ...check, fence });
    await expect(admitGrant({ ...check, fence })).rejects.toMatchObject({
      code: 'GRANT_REPLAYED',
    });
    expect(
      safeActionExecution(i.action, [...i.signatures].reverse()).data,
    ).toBe(check.executionCall.data);
  });
});
