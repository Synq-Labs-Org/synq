import { describe, expect, it } from 'vitest';
import {
  Kernel,
  RiskAttestationGate,
  type RiskAttestationObservation,
  type RiskAttestationQuery,
  type RiskAttestationReader,
} from '@synq/kernel';
import {
  ACCOUNT,
  TOKEN,
  address,
  allPlugins,
  approve,
  evidence,
  harness,
  hash,
  intent,
  mandate,
  now,
  outputAsset,
  owners,
  quote,
  swapIntent,
  tradeMandate,
  FixtureDelegations,
  type Harness,
  type Prepared,
} from '../kernel/fixtures.js';

const REGISTRY = address(70);
const AUSD_ID = hash(0xa05d);

class FixtureReader implements RiskAttestationReader {
  calls: RiskAttestationQuery[] = [];
  constructor(
    public next:
      | Partial<RiskAttestationObservation>
      | null
      | (() => Promise<unknown>),
  ) {}
  async latest(query: RiskAttestationQuery) {
    this.calls.push(query);
    if (typeof this.next === 'function')
      return (await this.next()) as RiskAttestationObservation;
    if (this.next === null) return null;
    return {
      chainId: query.chainId,
      registry: query.registry,
      assetId: query.assetId,
      status: 'HEALTHY',
      timestamp: now - 60,
      referencePrice: '99983010',
      deviationBps: 2,
      stalenessSec: 120,
      sourceConfigHash: hash(5),
      blockNumber: '99',
      ...this.next,
    } as RiskAttestationObservation;
  }
}

function gate(reader: RiskAttestationReader) {
  return {
    stableRisk: {
      reader,
      chainId: 31337,
      registry: REGISTRY,
      assets: [{ address: TOKEN, assetId: AUSD_ID }],
      maxAttestationAgeSeconds: 3600,
    },
  };
}
const knownOutput = tradeMandate({ outputAssets: [outputAsset] });
const swap = () => evidence(swapIntent({ maxInputAmount: '10' }), quote);

async function firstDecision(h: Harness, input: Prepared) {
  return h.kernel.authorize({ ...input, approvals: [] });
}

describe('Kernel stable-risk attestation gate (AUSD-015/016)', () => {
  it('HEALTHY leaves the policy tier unchanged and records the rule', async () => {
    const reader = new FixtureReader({ status: 'HEALTHY' });
    const input = swap();
    const h = harness(input, [knownOutput], gate(reader));
    const decision = await firstDecision(h, input);
    expect(decision).toMatchObject({
      status: 'PENDING_APPROVAL',
      tier: 'AUTO',
    });
    expect(decision.policy?.matchedRules).toContain(
      'risk.stableAttestation:HEALTHY',
    );
    expect(reader.calls).toEqual([
      { chainId: 31337, registry: REGISTRY, assetId: AUSD_ID },
    ]);
    if (decision.status !== 'PENDING_APPROVAL' || !decision.draft)
      throw new Error('draft');
    const approvals = await approve(h, decision.draft);
    expect(await h.kernel.authorize({ ...input, approvals })).toMatchObject({
      status: 'AUTHORIZED',
      tier: 'AUTO',
    });
  });

  it('DEGRADED escalates to CONSENSUS and humans can still approve', async () => {
    const reader = new FixtureReader({ status: 'DEGRADED', deviationBps: 80 });
    const input = swap();
    const h = harness(input, [knownOutput], gate(reader));
    const decision = await firstDecision(h, input);
    expect(decision).toMatchObject({
      status: 'PENDING_APPROVAL',
      tier: 'CONSENSUS',
    });
    expect(decision.policy?.contributions).toContainEqual({
      rule: 'risk.stableAttestation:DEGRADED',
      tier: 'CONSENSUS',
    });
    if (decision.status !== 'PENDING_APPROVAL' || !decision.draft)
      throw new Error('draft');
    const approvals = await approve(h, decision.draft, [0, 1]);
    expect(await h.kernel.authorize({ ...input, approvals })).toMatchObject({
      status: 'AUTHORIZED',
      tier: 'CONSENSUS',
    });
  });

  it('DEGRADED blocks autonomous (delegated) approval while HEALTHY accepts it', async () => {
    const delegated = tradeMandate({
      outputAssets: [outputAsset],
      approvalPolicy: {
        ...mandate().approvalPolicy,
        eligibleKinds: ['LOCAL_FIXTURE', 'PRIVY_DELEGATE'],
      },
      delegationScope: {
        actions: ['SPOT_TRADE'],
        maxInputPerAction: '70',
        maxNativePerAction: '0',
        periodSeconds: 3600,
        maxUsesPerPeriod: 5,
      },
    });
    const delegation = new FixtureDelegations([
      {
        policyId: 'agent_dca',
        memberId: 'member_1',
        principalId: 'principal_1',
        signer: owners[1]!.address.toLowerCase(),
        actions: ['SPOT_TRADE'],
        maxAmountPerExecution: '65',
        periodSeconds: 3600,
        maxExecutionsPerPeriod: 5,
        validAfter: 900,
        validUntil: 1900,
        revokedAt: null,
      },
    ]);
    const run = async (status: 'HEALTHY' | 'DEGRADED') => {
      const input = swap();
      const h = harness(input, [delegated], {
        ...gate(new FixtureReader({ status })),
        delegations: delegation,
      });
      const first = await firstDecision(h, input);
      if (first.status !== 'PENDING_APPROVAL' || !first.draft)
        throw new Error('draft');
      return h.kernel.authorize({
        ...input,
        approvals: [
          ...(await approve(h, first.draft, [0])),
          ...(await approve(h, first.draft, [1], { kind: 'PRIVY_DELEGATE' })),
        ],
      });
    };
    expect(await run('HEALTHY')).toMatchObject({ status: 'AUTHORIZED' });
    expect(await run('DEGRADED')).toMatchObject({
      status: 'PENDING_APPROVAL',
      code: 'DELEGATION_SCOPE',
    });
  });

  it.each<[string, ConstructorParameters<typeof FixtureReader>[0]]>([
    ['UNKNOWN status (AUSD-015)', { status: 'UNKNOWN', referencePrice: '0' }],
    ['STALE status (CRE stale)', { status: 'STALE' }],
    ['no attestation recorded', null],
    ['attestation older than the allowed age', { timestamp: now - 3601 }],
    ['attestation far in the future', { timestamp: now + 301 }],
    ['reader failure', () => Promise.reject(new Error('rpc down'))],
    ['malformed reader output', () => Promise.resolve({ status: 'HEALTHY' })],
    ['registry echo mismatch', { registry: address(71) }],
    ['asset echo mismatch', { assetId: hash(0xbad) }],
    ['chain echo mismatch', { chainId: 10143 }],
  ])('fails closed on %s', async (_name, next) => {
    const input = swap();
    const h = harness(input, [knownOutput], gate(new FixtureReader(next)));
    expect(await firstDecision(h, input)).toMatchObject({
      status: 'RISK_REJECTED',
      code: 'STABLE_RISK_UNAVAILABLE',
    });
  });

  it('actions that do not touch the attested asset are not gated', async () => {
    const reader = new FixtureReader(() => Promise.reject(new Error('boom')));
    const transfer = evidence(intent({ maxInputAmount: '10' }));
    const h = harness(transfer, [knownOutput], gate(reader));
    expect(await firstDecision(h, transfer)).toMatchObject({
      status: 'PENDING_APPROVAL',
    });
    expect(reader.calls).toHaveLength(0);
  });

  it('a proposal cannot inject or override the attestation', async () => {
    const reader = new FixtureReader({
      status: 'UNKNOWN',
      referencePrice: '0',
    });
    const input = swap();
    const h = harness(input, [knownOutput], gate(reader));
    expect(
      await h.kernel.authorize({
        ...input,
        approvals: [],
        stableRisk: { status: 'HEALTHY' },
      }),
    ).toMatchObject({ code: 'INVALID_REQUEST' });
    const claimed = evidence(swapIntent({ maxInputAmount: '10', nonce: '7' }), {
      ...quote,
      evidence: [
        {
          source: 'chainlink-cre-ausd-healthy',
          retrievedAt: now,
          chainId: 31337,
          artifactHash: hash(1),
          untrusted: false,
        },
      ],
    });
    const claimedHarness = harness(claimed, [knownOutput], gate(reader));
    expect(await firstDecision(claimedHarness, claimed)).toMatchObject({
      code: 'STABLE_RISK_UNAVAILABLE',
    });
  });

  it('the gate survives snapshot and restore', async () => {
    const reader = new FixtureReader({ status: 'STALE' });
    const input = swap();
    const h = harness(input, [knownOutput], gate(reader));
    const restored = Kernel.restore(h.kernel.snapshot(), {
      clock: h.clock,
      approvalLedger: h.ledger,
      membershipDirectory: h.directory,
      freshness: { probe: h.probe, maxLagBlocks: 0 },
      plugins: allPlugins(),
      auditKey: new Uint8Array(32).fill(7),
      ...gate(reader),
    });
    expect(await restored.authorize({ ...input, approvals: [] })).toMatchObject(
      {
        code: 'STABLE_RISK_UNAVAILABLE',
      },
    );
  });

  it('rejects an invalid gate configuration', () => {
    expect(
      () =>
        new RiskAttestationGate({
          ...gate(new FixtureReader(null)).stableRisk,
          maxAttestationAgeSeconds: 0,
        }),
    ).toThrow('INVALID_REQUEST');
    expect(ACCOUNT).not.toBe(TOKEN);
  });
});
