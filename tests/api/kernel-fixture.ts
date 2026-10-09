import { encodeFunctionData, erc20Abi, keccak256 } from 'viem';
import { monadTestnetProfile, officialAsset } from '@synq/chain-registry';
import {
  BoundActionIntentSchema,
  MandateSchema,
  type ApprovalLedger,
  type RiskPacket,
  type Simulation,
} from '@synq/schemas';
import {
  Kernel,
  artifactHash,
  economicIntentHash,
  intentHash,
  type MembershipDirectory,
} from '../../packages/kernel/src/index.js';

export const AUSD = officialAsset('testnetAUSD');
const zero = `0x${'0'.repeat(64)}` as const;

export const sandboxManifest = {
  id: 'sandbox-transfer',
  version: '0.1.0',
  capabilities: ['TRANSFER'],
  chains: [10143],
  environments: ['sandbox/monad-testnet'],
  riskClass: 'FINANCIAL_EXECUTION',
  requiresSimulation: true,
  maxGrantTtlSeconds: 300,
  dependencies: { viem: '2.57.4' },
  sourceIds: ['SYNQ-006'],
  health: { maxStalenessSeconds: 60, checks: ['RPC'] },
} as const;

export type SandboxGroup = {
  groupId: string;
  chainGroupId: `0x${string}`;
  account: `0x${string}`;
  executor: `0x${string}`;
  recipient: `0x${string}`;
  members: { memberId: string; signer: `0x${string}` }[];
};

export function sandboxMandate(g: SandboxGroup, now: number) {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: 'mandate_send',
    groupId: g.groupId,
    version: 1,
    status: 'ACTIVE',
    network: monadTestnetProfile.network,
    account: g.account,
    chainGroupId: g.chainGroupId,
    operators: [g.executor],
    bindings: [
      {
        pluginId: 'sandbox-transfer',
        action: 'TRANSFER',
        target: AUSD.address,
        selector: '0xa9059cbb',
      },
    ],
    recipients: [{ address: g.recipient, purpose: 'COUNTERPARTY' }],
    inputAsset: AUSD,
    outputAssets: [],
    perActionCap: '100000000',
    cumulativeBudget: '1000000000',
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 50,
    maxReferenceDeviationBps: 50,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '1000000', reviewMax: '5000000' },
      nativeSpend: { autoMax: '0', reviewMax: '0' },
      actionFloors: [],
      newOutputAsset: 'CONSENSUS',
      leverage: 'BLOCKED',
      withdrawal: 'UNANIMOUS',
    },
    approvalPolicy: {
      quorum: 2,
      reviewApprovals: 1,
      accountThreshold: 2,
      eligibleKinds: ['MERA_HUMAN'],
    },
    delegationScope: null,
    members: g.members.map((m) => ({ ...m, active: true })),
    validAfter: now - 100,
    validUntil: now + 30 * 86400,
    quoteTtlSeconds: 300,
    evidenceTtlSeconds: 300,
    simulationTtlSeconds: 300,
    maxGrantTtlSeconds: 300,
    minIntervalSeconds: 0,
    maxExecutions: 100,
  });
}

export function sandboxKernel(input: {
  executionModule: `0x${string}`;
  now: () => number;
  approvalLedger: ApprovalLedger;
  membershipDirectory: MembershipDirectory;
}) {
  const probe = {
    async observe() {
      return {
        chainId: 10143,
        indexedThroughBlock: 100,
        headBlock: 100,
        accountPaused: false,
      };
    },
  };
  return new Kernel({
    network: monadTestnetProfile.network,
    executionModule: input.executionModule,
    clock: { now: input.now },
    approvalLedger: input.approvalLedger,
    membershipDirectory: input.membershipDirectory,
    freshness: { probe, maxLagBlocks: 0 },
    plugins: [sandboxManifest],
    mandates: [],
  });
}

export function configureSandboxGroup(
  kernel: Kernel,
  g: SandboxGroup,
  now: number,
) {
  kernel.configureMandate(sandboxMandate(g, now));
  kernel.observeBalance(
    { account: g.account, asset: AUSD, balance: '1000000000' },
    '100',
  );
}

export function sandboxProposal(
  kernel: Kernel,
  g: SandboxGroup,
  input: { amount: bigint; nonce: string; now: number },
) {
  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [g.recipient, input.amount],
  });
  const base = BoundActionIntentSchema.parse({
    schemaVersion: 1,
    intentId: `send_${input.nonce}`,
    groupId: g.groupId,
    mandateId: 'mandate_send',
    mandateVersion: 1,
    action: 'TRANSFER',
    chainId: 10143,
    account: g.account,
    operator: g.executor,
    recipient: g.recipient,
    pluginId: 'sandbox-transfer',
    target: AUSD.address,
    selector: '0xa9059cbb',
    calldataHash: keccak256(data),
    inputToken: AUSD.address,
    maxInputAmount: String(input.amount),
    minOutputAmount: '0',
    nativeValue: '0',
    maxSlippageBps: 25,
    leverageBps: 0,
    validAfter: input.now - 10,
    validUntil: input.now + 3600,
    nonce: input.nonce,
    evidenceHash: zero,
    riskPacketHash: zero,
  });
  const risk: RiskPacket = {
    schemaVersion: 1,
    intentHash: economicIntentHash(base),
    evaluatedAt: input.now,
    quoteAt: input.now,
    quoteExpiresAt: input.now + 300,
    slippageBps: 0,
    referenceDeviationBps: 0,
    maxReferenceDeviationBps: 50,
    blocked: false,
    evidence: [
      {
        source: 'sandbox-transfer-fixture',
        retrievedAt: input.now,
        chainId: 10143,
        artifactHash: keccak256(data),
        untrusted: false,
      },
    ],
  };
  const intent = BoundActionIntentSchema.parse({
    ...base,
    evidenceHash: artifactHash(risk.evidence),
    riskPacketHash: artifactHash(risk),
  });
  const simulation: Simulation = {
    intentHash: intentHash(intent),
    calldataHash: intent.calldataHash,
    chainId: intent.chainId,
    account: intent.account,
    target: intent.target,
    succeeded: true,
    simulatedAt: input.now,
    blockNumber: '100',
    artifactHash: keccak256(data),
  };
  kernel.attestEvidence({
    riskPacketHashes: [artifactHash(risk)],
    simulationHashes: [artifactHash(simulation)],
  });
  return { intent, risk, simulation };
}
