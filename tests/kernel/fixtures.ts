import { privateKeyToAccount } from 'viem/accounts';
import {
  ActionIntentSchema,
  MandateSchema,
  type ActionIntent,
  type Approval,
  type RiskPacket,
  type Simulation,
} from '../../packages/schemas/src/index.js';
import {
  approvalTypedData,
  artifactHash,
  economicIntentHash,
  intentHash,
} from '../../packages/kernel/src/index.js';
export const now = 1000;
export const owners = [1, 2, 3].map((n) =>
  privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`),
);
export const address = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, '0')}`;
export const network = {
  profile: 'local',
  chainId: 31337,
  providerEnvironment: 'local',
} as const;
export const asset = {
  canonicalAssetId: `eip155:31337/erc20:${address(10)}`,
  chainId: 31337,
  address: address(10),
  symbol: 'OTHER',
  decimals: 6,
} as const;
export function mandate(overrides: Record<string, unknown> = {}) {
  return MandateSchema.parse({
    schemaVersion: 1,
    mandateId: 'mandate_1',
    groupId: 'group_1',
    version: 1,
    status: 'ACTIVE',
    network,
    account: address(20),
    operators: [address(30)],
    plugins: ['local-transfer'],
    actions: ['TRANSFER', 'SPOT_TRADE'],
    targets: [address(10)],
    selectors: ['0xa9059cbb'],
    inputAsset: asset,
    outputAssets: [],
    allowNewOutputAssets: true,
    perActionCap: '100',
    cumulativeBudget: '200',
    maxNativeValue: '0',
    maxSlippageBps: 50,
    maxReferenceDeviationBps: 50,
    maxLeverageBps: 0,
    autoCap: '20',
    reviewCap: '50',
    quorum: 2,
    members: owners.map((o, i) => ({
      memberId: `member_${i}`,
      signer: o.address,
      active: true,
    })),
    validAfter: 900,
    validUntil: 2000,
    quoteTtlSeconds: 30,
    evidenceTtlSeconds: 60,
    simulationTtlSeconds: 30,
    maxGrantTtlSeconds: 20,
    minIntervalSeconds: 0,
    maxExecutions: 10,
    ...overrides,
  });
}
export function intent(overrides: Record<string, unknown> = {}): ActionIntent {
  return ActionIntentSchema.parse({
    schemaVersion: 1,
    intentId: 'intent_1',
    groupId: 'group_1',
    mandateId: 'mandate_1',
    mandateVersion: 1,
    action: 'TRANSFER',
    network,
    chainId: 31337,
    account: address(20),
    operator: address(30),
    pluginId: 'local-transfer',
    target: address(10),
    selector: '0xa9059cbb',
    calldataHash: hash(1),
    inputAsset: asset,
    maxInputAmount: '60',
    outputAsset: null,
    minOutputAmount: '0',
    nativeValue: '0',
    maxSlippageBps: 25,
    leverageBps: 0,
    validAfter: 900,
    validUntil: 1500,
    nonce: '1',
    evidenceHash: hash(0),
    riskPacketHash: hash(0),
    ...overrides,
  });
}
export function evidence(
  input: ActionIntent,
  overrides: Partial<RiskPacket> = {},
) {
  const entries = [
    {
      source: 'local-reference',
      retrievedAt: now,
      chainId: 31337 as const,
      artifactHash: hash(9),
      untrusted: false,
    },
  ];
  const risk: RiskPacket = {
    schemaVersion: 1,
    intentHash: economicIntentHash(input),
    evaluatedAt: now,
    quoteAt: now,
    quoteExpiresAt: now + 30,
    slippageBps: 25,
    referenceDeviationBps: 10,
    maxReferenceDeviationBps: 50,
    blocked: false,
    evidence: entries,
    ...overrides,
  };
  const prepared = ActionIntentSchema.parse({
    ...input,
    evidenceHash: artifactHash(risk.evidence),
    riskPacketHash: artifactHash(risk),
  });
  const simulation: Simulation = {
    intentHash: intentHash(prepared),
    calldataHash: prepared.calldataHash,
    chainId: prepared.chainId,
    account: prepared.account,
    target: prepared.target,
    succeeded: true,
    simulatedAt: now,
    blockNumber: '1',
    artifactHash: hash(8),
  };
  return { intent: prepared, risk, simulation };
}
export async function approvals(
  input: ActionIntent,
  indexes = [0, 1],
): Promise<Approval[]> {
  return Promise.all(
    indexes.map(async (i) => {
      const owner = owners[i]!;
      const unsigned = {
        schemaVersion: 1 as const,
        groupId: input.groupId,
        mandateId: input.mandateId,
        mandateVersion: input.mandateVersion,
        intentHash: intentHash(input),
        memberId: `member_${i}`,
        signer: owner.address.toLowerCase() as `0x${string}`,
        expiresAt: 1100,
        nonce: String(i),
      };
      return {
        ...unsigned,
        signature: await owner.signTypedData(
          approvalTypedData(input, unsigned),
        ),
      };
    }),
  );
}
export async function request(overrides: Record<string, unknown> = {}) {
  const value = evidence(intent(overrides));
  return { ...value, approvals: await approvals(value.intent), now };
}
