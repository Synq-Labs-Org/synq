import { describe, expect, it, vi } from 'vitest';
import { keccak256, toHex, zeroAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  TEAM_ROLES,
  agentRegistration,
  capabilityManifestHash,
  canonicalManifest,
} from '@synq/agent-runtime';
import { contract, token } from '@synq/chain-registry/arc';
import {
  decide,
  mandateTypedData,
  intentApprovalTypedData,
  MemoryNonceFence,
  type PaymentIntent,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  admitAgentJobGrant,
  agentJobIntentId,
  agentJobValue,
  type AgentJobCall,
} from '@synq/kernel/arc-agent-jobs';
const client = privateKeyToAccount(
  keccak256(toHex('agent-job-client-fixture')),
);
const evaluator = privateKeyToAccount(
  keccak256(toHex('agent-job-evaluator-fixture')),
);
const provider = privateKeyToAccount(
  keccak256(toHex('agent-job-provider-fixture')),
);
const now = 1792146000;
const usdc = token('arc-testnet', 'USDC');
const cfg = {
  grantKey: new Uint8Array(32).fill(9),
  operator: 'agent-job-executor',
  grantTtlSeconds: 120,
  riskRequiredAbove: 1000000n,
};
function call(over: Partial<AgentJobCall> = {}): AgentJobCall {
  return {
    op: 'FUND',
    chainId: usdc.chainId,
    token: usdc.address,
    contract: contract('arc-testnet', 'ERC8183_AGENTIC_COMMERCE').address,
    sender: client.address,
    client: client.address,
    provider: provider.address,
    evaluator: evaluator.address,
    jobId: 1n,
    budget: 1000n,
    expiredAt: BigInt(now + 3600),
    descriptionHash: keccak256(toHex('fixture')),
    hook: zeroAddress,
    reason: keccak256(toHex('accepted fixture work')),
    platformFeeBps: 0n,
    evaluatorFeeBps: 0n,
    platformTreasury: zeroAddress,
    ...over,
  };
}
async function approval(c: AgentJobCall, signer = client) {
  const value = agentJobValue(c);
  const m: PaymentMandate = {
    mandateId: 'job',
    version: 1,
    workspaceId: 'test',
    owner: client.address,
    chainId: c.chainId,
    token: c.token,
    payer: value.payer,
    recipients: [value.recipient],
    purposes: ['GROUP_EXPENSE'],
    perActionCap: 1000n,
    periodBudget: 1000n,
    periodSeconds: 86400,
    validFrom: now - 60,
    validUntil: now + 3600,
  };
  const intent: PaymentIntent = {
    ...value,
    intentId: agentJobIntentId(c),
    mandateId: m.mandateId,
    mandateVersion: 1,
    purpose: 'GROUP_EXPENSE',
    obligationRef: 'job:1:fund',
    evidenceHash: c.descriptionHash,
    proposedBy: 'script',
  };
  const args = {
    config: cfg,
    mandate: m,
    mandateSignature: await client.signTypedData(mandateTypedData(m)),
    state: { revoked: false, spends: [] },
    intent,
    risk: { flags: [], available: true },
    simulationOk: true,
    now,
    requireOwnerApproval: true,
  };
  const first = await decide(args);
  if (first.outcome !== 'REQUIRE_OWNER_APPROVAL')
    throw new Error('approval challenge missing');
  const ownerApproval = {
    ...first.approval,
    signature: await signer.signTypedData(
      intentApprovalTypedData(intent, first.approval),
    ),
  };
  return decide({ ...args, ownerApproval });
}

describe('agent identity has no spending authority', () => {
  it('every card commits to the canonical actual capability manifest and explicitly grants none', () => {
    for (const role of TEAM_ROLES) {
      const r = agentRegistration(role);
      const decoded = JSON.parse(
        Buffer.from(r.uri.split(',')[1]!, 'base64').toString(),
      );
      expect(decoded).toMatchObject({
        role,
        manifestHash: capabilityManifestHash(r.manifest),
        cardHash: r.manifestHash,
        authority: 'NONE',
        canSign: false,
      });
      expect(decoded).not.toHaveProperty('grant');
      const compact = JSON.parse(
        r.compactUri.slice('data:application/json,'.length),
      );
      expect(compact.role).toBe(role);
      expect(
        `0x${Buffer.from(compact.sha256, 'base64url').toString('hex')}`,
      ).toBe(r.manifestHash);
    }
  });
  it('commitments are independent of object insertion order and change with capabilities', () => {
    expect(canonicalManifest({ b: 1n, a: 2 })).toBe(
      canonicalManifest({ a: 2, b: 1n }),
    );
    expect(capabilityManifestHash({ limit: 1n })).not.toBe(
      capabilityManifestHash({ limit: 2n }),
    );
    expect(() => canonicalManifest({ bad: Number.NaN })).toThrow();
  });
});

describe('job funding and evaluation require exact owner-approved Kernel grants', () => {
  it('requires the payer signature and consumes a valid grant only once', async () => {
    const c = call();
    expect((await approval(c, provider)).outcome).toBe('DENY');
    const result = await approval(c);
    if (result.outcome !== 'ALLOW') throw new Error('not granted');
    const request = {
      call: c,
      grant: result.grant,
      grantKey: cfg.grantKey,
      now,
      mandateRevoked: false,
      fence: new MemoryNonceFence(),
    };
    await admitAgentJobGrant(request);
    await expect(admitAgentJobGrant(request)).rejects.toMatchObject({
      code: 'GRANT_REPLAYED',
    });
  });
  it('refuses a wrong evaluator or changed job economics before nonce consumption', async () => {
    const c = call({ op: 'COMPLETE', sender: evaluator.address });
    const result = await approval(c);
    if (result.outcome !== 'ALLOW') throw new Error('not granted');
    const consume = vi.fn(async () => true),
      fence = { consume };
    for (const over of [
      { sender: provider.address },
      { jobId: 2n },
      { budget: 999n },
      { reason: keccak256(toHex('changed')) },
      { platformFeeBps: 1n },
      { hook: provider.address },
    ])
      await expect(
        admitAgentJobGrant({
          call: { ...c, ...over },
          grant: result.grant,
          grantKey: cfg.grantKey,
          now,
          mandateRevoked: false,
          fence,
        }),
      ).rejects.toMatchObject({ code: 'GRANT_MISMATCH' });
    expect(consume).not.toHaveBeenCalled();
  });
  it('refuses an expired or revoked grant', async () => {
    const c = call(),
      result = await approval(c);
    if (result.outcome !== 'ALLOW') throw new Error('not granted');
    const base = {
      call: c,
      grant: result.grant,
      grantKey: cfg.grantKey,
      now,
      mandateRevoked: false,
      fence: new MemoryNonceFence(),
    };
    await expect(
      admitAgentJobGrant({ ...base, now: now + 121 }),
    ).rejects.toThrow();
    await expect(
      admitAgentJobGrant({ ...base, mandateRevoked: true }),
    ).rejects.toThrow();
  });
});
