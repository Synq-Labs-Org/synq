import { keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BoundActionIntentSchema,
  MandateSchema,
  executionGrantTypedData,
  type BoundActionIntent,
  type ExecutionGrant,
  type GrantDraft,
  type IdentityPrincipalKind,
  type RiskPacket,
  type Simulation,
  type VerifiedApproval,
} from '../../packages/schemas/src/index.js';
import {
  Kernel,
  artifactHash,
  economicIntentHash,
  intentHash,
  type AuthorizationDecision,
  type DelegationEvaluator,
  type DelegationRequest,
  type DelegationUse,
  type DirectoryMember,
  type FreshnessObservation,
  type KernelOptions,
  type MembershipDirectory,
} from '../../packages/kernel/src/index.js';

export const now = 1000;
export const owners = [1, 2, 3].map((n) =>
  privateKeyToAccount(`0x${n.toString(16).padStart(64, '0')}`),
);
export const outsider = privateKeyToAccount(`0x${'4'.padStart(64, '0')}`);
export const address = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(40, '0')}`;
export const hash = (n: number): `0x${string}` =>
  `0x${n.toString(16).padStart(64, '0')}`;
export const ZERO = address(0);
export const TOKEN = address(10);
export const ACCOUNT = address(20);
export const OPERATOR = address(30);
export const MODULE = address(40);
export const RECIPIENT = address(50);
export const CHAIN_GROUP = hash(77);
export const network = {
  profile: 'local/anvil',
  chainId: 31337,
  providerEnvironment: 'local',
} as const;
export const asset = {
  canonicalAssetId: `eip155:31337/erc20:${TOKEN}`,
  chainId: 31337,
  address: TOKEN,
  symbol: 'OTHER',
  decimals: 6,
} as const;
export const nativeAsset = {
  canonicalAssetId: 'eip155:31337/native',
  chainId: 31337,
  native: true,
  symbol: 'MON',
  decimals: 18,
} as const;
export const manifest = {
  id: 'local-transfer',
  version: '0.1.0',
  capabilities: ['TRANSFER'],
  chains: [31337],
  environments: ['local/anvil'],
  riskClass: 'FINANCIAL_EXECUTION',
  requiresSimulation: true,
  maxGrantTtlSeconds: 120,
  dependencies: { viem: '2.57.4' },
  sourceIds: ['SYNQ-006'],
  health: { maxStalenessSeconds: 60, checks: ['RPC'] },
} as const;
export const transferBinding = {
  pluginId: 'local-transfer',
  action: 'TRANSFER',
  target: TOKEN,
  selector: '0xa9059cbb',
} as const;
export function mandate(overrides: Record<string, unknown> = {}) {
  return MandateSchema.parse({
    schemaVersion: 2,
    mandateId: 'mandate_1',
    groupId: 'group_1',
    version: 1,
    status: 'ACTIVE',
    network,
    account: ACCOUNT,
    chainGroupId: CHAIN_GROUP,
    operators: [OPERATOR],
    bindings: [transferBinding],
    recipients: [{ address: RECIPIENT, purpose: 'COUNTERPARTY' }],
    inputAsset: asset,
    outputAssets: [],
    perActionCap: '100',
    cumulativeBudget: '200',
    maxNativeValue: '0',
    cumulativeNativeBudget: '0',
    maxSlippageBps: 50,
    maxReferenceDeviationBps: 50,
    maxLeverageBps: 0,
    maxAllocationBps: 10_000,
    tierPolicy: {
      tokenSpend: { autoMax: '20', reviewMax: '50' },
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
      eligibleKinds: ['LOCAL_FIXTURE', 'MERA_HUMAN'],
    },
    delegationScope: null,
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
export function intent(
  overrides: Record<string, unknown> = {},
): BoundActionIntent {
  return BoundActionIntentSchema.parse({
    schemaVersion: 1,
    intentId: 'intent_1',
    groupId: 'group_1',
    mandateId: 'mandate_1',
    mandateVersion: 1,
    action: 'TRANSFER',
    chainId: 31337,
    account: ACCOUNT,
    operator: OPERATOR,
    recipient: RECIPIENT,
    pluginId: 'local-transfer',
    target: TOKEN,
    selector: '0xa9059cbb',
    calldataHash: hash(1),
    inputToken: TOKEN,
    maxInputAmount: '60',
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
export function nativeIntent(value: string, overrides = {}) {
  return intent({
    target: RECIPIENT,
    selector: '0x00000000',
    calldataHash: keccak256('0x'),
    inputToken: ZERO,
    maxInputAmount: '0',
    nativeValue: value,
    ...overrides,
  });
}
export type Prepared = {
  intent: BoundActionIntent;
  risk: RiskPacket;
  simulation: Simulation;
};
export function evidence(
  input: BoundActionIntent,
  overrides: Partial<RiskPacket> = {},
  at = now,
): Prepared {
  const risk: RiskPacket = {
    schemaVersion: 1,
    intentHash: economicIntentHash(input),
    evaluatedAt: at,
    quoteAt: at,
    quoteExpiresAt: at + 30,
    slippageBps: 25,
    referenceDeviationBps: 10,
    maxReferenceDeviationBps: 50,
    blocked: false,
    evidence: [
      {
        source: 'local-reference',
        retrievedAt: at,
        chainId: 31337,
        artifactHash: hash(9),
        untrusted: false,
      },
    ],
    ...overrides,
  };
  const prepared = BoundActionIntentSchema.parse({
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
    simulatedAt: at,
    blockNumber: '1',
    artifactHash: hash(8),
  };
  return { intent: prepared, risk, simulation };
}
export function request(overrides: Record<string, unknown> = {}) {
  return { ...evidence(intent(overrides)), approvals: [] as unknown[] };
}

export class FixtureClock {
  constructor(public t = now) {}
  now(): number {
    return this.t;
  }
}
export class FixtureLedger {
  readonly consumed = new Map<string, string>();
  async isConsumed(approval: VerifiedApproval): Promise<boolean> {
    return this.consumed.get(approval.approvalId) === artifactHash(approval);
  }
}
export class FixtureProbe {
  observation: FreshnessObservation = {
    chainId: 31337,
    indexedThroughBlock: 100,
    headBlock: 100,
    accountPaused: false,
  };
  async observe(): Promise<FreshnessObservation> {
    return structuredClone(this.observation);
  }
}
export class FixtureDirectory implements MembershipDirectory {
  readonly members = new Map<string, DirectoryMember>(
    owners.map((o, i) => [
      `member_${i}`,
      {
        groupId: 'group_1',
        memberId: `member_${i}`,
        principalId: `principal_${i}`,
        principalKind: 'LOCAL_FIXTURE',
        role: 'APPROVER',
        signer: o.address.toLowerCase() as `0x${string}`,
        membershipEpoch: 1,
        ownerOfAccount: true,
      },
    ]),
  );
  async activeMember(groupId: string, memberId: string) {
    const m = this.members.get(memberId);
    return m ? { ...m, groupId } : null;
  }
  async membershipEpoch() {
    return 1;
  }
}
export type FixtureDelegation = {
  policyId: string;
  memberId: string;
  principalId: string;
  signer: string;
  actions: string[];
  maxAmountPerExecution: string;
  periodSeconds: number;
  maxExecutionsPerPeriod: number;
  validAfter: number;
  validUntil: number;
  revokedAt: number | null;
};
export class FixtureDelegations implements DelegationEvaluator {
  constructor(readonly policies: FixtureDelegation[] = []) {}
  evaluate(
    r: DelegationRequest,
    history: (policyId: string) => readonly DelegationUse[],
  ) {
    const p = this.policies.find(
      (x) =>
        x.memberId === r.memberId &&
        x.principalId === r.principalId &&
        x.signer === r.signer,
    );
    if (!p) return { allowed: false as const, reason: 'NONE' };
    const recent = history(p.policyId).filter(
      (u) => r.at - u.at < p.periodSeconds,
    );
    const ok =
      (p.revokedAt === null || r.at < p.revokedAt) &&
      r.at >= p.validAfter &&
      r.at < p.validUntil &&
      p.actions.includes(r.action) &&
      BigInt(r.amount) <= BigInt(p.maxAmountPerExecution) &&
      recent.length < p.maxExecutionsPerPeriod;
    return ok
      ? { allowed: true as const, policyId: p.policyId }
      : { allowed: false as const, reason: 'DENIED' };
  }
}
export type Harness = {
  kernel: Kernel;
  clock: FixtureClock;
  ledger: FixtureLedger;
  probe: FixtureProbe;
  directory: FixtureDirectory;
};
export function harness(
  inputs: Prepared | Prepared[] = [],
  policies: unknown[] = [mandate()],
  extra: Partial<KernelOptions> = {},
): Harness {
  const list = Array.isArray(inputs) ? inputs : [inputs];
  const clock = new FixtureClock();
  const ledger = new FixtureLedger();
  const probe = new FixtureProbe();
  const directory = new FixtureDirectory();
  const kernel = new Kernel({
    membershipDirectory: directory,
    network,
    executionModule: MODULE,
    clock,
    approvalLedger: ledger,
    freshness: { probe, maxLagBlocks: 0 },
    plugins: allPlugins(),
    mandates: policies,
    balances: [
      { account: ACCOUNT, asset, balance: '10000' },
      {
        account: ACCOUNT,
        asset: nativeAsset,
        balance: (10n ** 22n).toString(),
      },
    ],
    trustedEvidence: {
      riskPacketHashes: list.map((r) => artifactHash(r.risk)),
      simulationHashes: list.map((r) => artifactHash(r.simulation)),
    },
    ...extra,
  });
  return { kernel, clock, ledger, probe, directory };
}
export function trust(h: Harness, ...inputs: Prepared[]) {
  h.kernel.attestEvidence({
    riskPacketHashes: inputs.map((r) => artifactHash(r.risk)),
    simulationHashes: inputs.map((r) => artifactHash(r.simulation)),
  });
}

let challengeCounter = 0;
export async function approve(
  h: Pick<Harness, 'ledger' | 'directory'>,
  draft: GrantDraft,
  indexes: number[] = [0, 1],
  options: {
    kind?: IdentityPrincipalKind;
    consume?: boolean;
    signerOverride?: (typeof owners)[number];
  } = {},
): Promise<VerifiedApproval[]> {
  return Promise.all(
    indexes.map(async (i) => {
      const owner = owners[i]!;
      const signer = options.signerOverride ?? owner;
      const challengeId = `challenge_${++challengeCounter}`;
      const approval: VerifiedApproval = {
        schemaVersion: 1,
        approvalId: `approval_${challengeCounter}`,
        challengeId,
        groupId: draft.groupId,
        memberId: `member_${i}` as VerifiedApproval['memberId'],
        principalId: `principal_${i}` as VerifiedApproval['principalId'],
        principalKind: options.kind ?? 'LOCAL_FIXTURE',
        signer: owner.address.toLowerCase() as `0x${string}`,
        draftDigest: draft.digest,
        signature: await signer.signTypedData(
          executionGrantTypedData(draft.domain, draft.grant),
        ),
        membershipEpoch: 1,
        verifiedAt: now,
      };
      if (options.consume !== false)
        h.ledger.consumed.set(approval.approvalId, artifactHash(approval));
      const member = h.directory.members.get(`member_${i}`);
      if (member && options.kind)
        h.directory.members.set(`member_${i}`, {
          ...member,
          principalKind: options.kind,
        });
      return approval;
    }),
  );
}

export function expectDraft(decision: AuthorizationDecision): GrantDraft {
  if (decision.status === 'AUTHORIZED') return decision.draft;
  if (decision.status === 'PENDING_APPROVAL' && decision.draft)
    return decision.draft;
  throw new Error(`expected a draft, got ${decision.status}:${decision.code}`);
}
export async function authorizeWith(
  h: Harness,
  input: Prepared,
  indexes: number[] = [0, 1],
): Promise<AuthorizationDecision> {
  const pending = await h.kernel.authorize({ ...input, approvals: [] });
  if (pending.status !== 'PENDING_APPROVAL' || !pending.draft) return pending;
  return h.kernel.authorize({
    ...input,
    approvals: await approve(h, pending.draft, indexes),
  });
}
export async function grantFor(h: Harness, input: Prepared) {
  const decision = await authorizeWith(h, input);
  if (decision.status !== 'AUTHORIZED')
    throw new Error(
      `expected AUTHORIZED, got ${decision.status}:${decision.code}`,
    );
  return decision;
}
export const pluginIdHash = keccak256(stringToHex('local-transfer'));

export const TOKEN_2 = address(11);
export const OUT_TOKEN = address(12);
export const ROUTER = address(60);
export const SWAP_SELECTOR = '0x5ae401dc';
export const secondManifest = { ...manifest, id: 'second-transfer' } as const;
export const swapManifest = {
  ...manifest,
  id: 'local-swap',
  capabilities: ['SPOT_TRADE'],
} as const;
export const outputAsset = {
  canonicalAssetId: `eip155:31337/erc20:${OUT_TOKEN}`,
  chainId: 31337,
  address: OUT_TOKEN,
  symbol: 'OTHER',
  decimals: 18,
} as const;
export function tradeMandate(overrides: Record<string, unknown> = {}) {
  return mandate({
    bindings: [
      transferBinding,
      {
        pluginId: 'local-swap',
        action: 'SPOT_TRADE',
        target: ROUTER,
        selector: SWAP_SELECTOR,
      },
    ],
    recipients: [
      { address: RECIPIENT, purpose: 'COUNTERPARTY' },
      { address: ACCOUNT, purpose: 'SELF' },
    ],
    ...overrides,
  });
}
export function swapIntent(overrides: Record<string, unknown> = {}) {
  return intent({
    action: 'SPOT_TRADE',
    pluginId: 'local-swap',
    target: ROUTER,
    selector: SWAP_SELECTOR,
    recipient: ACCOUNT,
    outputToken: OUT_TOKEN,
    minOutputAmount: '998',
    maxInputAmount: '10',
    ...overrides,
  });
}
export const quote = {
  quotedOutputAmount: '1000',
  postTradeAllocationBps: 100,
};
export function allPlugins() {
  return [manifest, secondManifest, swapManifest];
}
export function executedObservation(
  grant: ExecutionGrant,
  eventOverrides: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
) {
  const d = grant.draft.grant;
  return {
    schemaVersion: 1,
    chainId: grant.chainId,
    transactionHash: hash(0xabc),
    blockNumber: '101',
    receiptStatus: 'success',
    emitter: grant.draft.domain.verifyingContract,
    event: {
      groupId: d.groupId,
      intentHash: d.intentHash,
      mandateId: d.mandateId,
      mandateVersion: d.mandateVersion,
      account: d.account,
      executor: d.executor,
      pluginId: d.pluginId,
      chainId: d.chainId,
      nonce: d.nonce,
      grantHash: grant.grantId,
      target: d.target,
      selector: d.selector,
      calldataHash: d.calldataHash,
      token: d.token,
      recipient: d.recipient,
      tokenAmount: d.maxInputAmount,
      nativeValue: d.nativeValue,
      outputAmount: d.maxInputAmount,
      ...eventOverrides,
    },
    ...overrides,
  };
}
