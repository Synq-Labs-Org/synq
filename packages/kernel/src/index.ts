import {
  hashTypedData,
  keccak256,
  recoverTypedDataAddress,
  stringToHex,
} from 'viem';
import { z } from 'zod';
import {
  ACTION_TERMINAL_REJECTIONS,
  BoundActionIntentSchema,
  AmountSchema,
  ApprovalSchema,
  ExecutionGrantSchema,
  MandateSchema,
  NetworkProfileSchema,
  RiskPacketSchema,
  SimulationSchema,
  TreasuryBalanceSchema,
  type BoundActionIntent,
  type ActionState,
  type Approval,
  type Asset,
  type ExecutionGrant,
  type Mandate,
  type NetworkProfile,
  type RiskPacket,
  type Simulation,
} from '@synq/schemas';

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(',')}}`;
  if (typeof value === 'bigint') throw new Error('BIGINT_WIRE_VALUE');
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('UNDEFINED_CANONICAL_VALUE');
  return result;
}
export function artifactHash(value: unknown): `0x${string}` {
  return keccak256(stringToHex(canonicalJson(value)));
}
export function intentHash(intent: BoundActionIntent): `0x${string}` {
  return artifactHash(BoundActionIntentSchema.parse(intent));
}
export function economicIntentHash(intent: BoundActionIntent): `0x${string}` {
  const economic: Partial<BoundActionIntent> =
    BoundActionIntentSchema.parse(intent);
  delete economic.evidenceHash;
  delete economic.riskPacketHash;
  return artifactHash(economic);
}
export type UnsignedApproval = Omit<Approval, 'signature'>;
export function approvalTypedData(
  intent: BoundActionIntent,
  approval: UnsignedApproval,
) {
  return {
    domain: {
      name: 'Synq Approval',
      version: '1',
      chainId: intent.chainId,
      verifyingContract: intent.account,
    },
    primaryType: 'Approval' as const,
    types: {
      Approval: [
        { name: 'groupId', type: 'string' },
        { name: 'mandateId', type: 'string' },
        { name: 'mandateVersion', type: 'uint256' },
        { name: 'intentHash', type: 'bytes32' },
        { name: 'memberId', type: 'string' },
        { name: 'signer', type: 'address' },
        { name: 'expiresAt', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
      ],
    },
    message: {
      groupId: approval.groupId,
      mandateId: approval.mandateId,
      mandateVersion: BigInt(approval.mandateVersion),
      intentHash: approval.intentHash,
      memberId: approval.memberId,
      signer: approval.signer,
      expiresAt: BigInt(approval.expiresAt),
      nonce: BigInt(approval.nonce),
    },
  };
}
export function approvalDigest(
  intent: BoundActionIntent,
  approval: UnsignedApproval,
): `0x${string}` {
  return hashTypedData(approvalTypedData(intent, approval));
}
export type Tier = 'AUTO' | 'REVIEW' | 'CONSENSUS' | 'BLOCKED';
export type Failure =
  | 'INVALID_INPUT'
  | 'MANDATE_NOT_FOUND'
  | 'MANDATE_VERSION'
  | 'MANDATE_REVOKED'
  | 'NETWORK_MISMATCH'
  | 'GROUP_MISMATCH'
  | 'ACCOUNT_MISMATCH'
  | 'OPERATOR_FORBIDDEN'
  | 'PLUGIN_FORBIDDEN'
  | 'ACTION_FORBIDDEN'
  | 'TARGET_FORBIDDEN'
  | 'SELECTOR_FORBIDDEN'
  | 'ASSET_FORBIDDEN'
  | 'AMOUNT_CAP'
  | 'NATIVE_VALUE_CAP'
  | 'SLIPPAGE_CAP'
  | 'LEVERAGE_CAP'
  | 'TIME_WINDOW'
  | 'BUDGET_EXHAUSTED'
  | 'INSUFFICIENT_BALANCE'
  | 'FREQUENCY_CAP'
  | 'RECURRING_CAP'
  | 'STALE_QUOTE'
  | 'STALE_EVIDENCE'
  | 'RISK_REJECTED'
  | 'EVIDENCE_MISMATCH'
  | 'SIMULATION_FAILED'
  | 'SIMULATION_MISMATCH'
  | 'STALE_SIMULATION'
  | 'INVALID_APPROVAL'
  | 'DUPLICATE_APPROVER'
  | 'MISSING_QUORUM'
  | 'NONCE_REPLAY'
  | 'GRANT_UNKNOWN'
  | 'GRANT_MISMATCH'
  | 'GRANT_EXPIRED'
  | 'GRANT_REPLAY'
  | 'RECONCILIATION_INVALID';
const RISK_FAILURES: readonly Failure[] = [
  'RISK_REJECTED',
  'STALE_QUOTE',
  'STALE_EVIDENCE',
  'EVIDENCE_MISMATCH',
  'SIMULATION_FAILED',
  'SIMULATION_MISMATCH',
  'STALE_SIMULATION',
];
export type ActionRejection = (typeof ACTION_TERMINAL_REJECTIONS)[number];
export function decisionStatus(
  code: Failure,
): Extract<ActionState, 'PENDING_APPROVAL'> | ActionRejection {
  if (code === 'MISSING_QUORUM') return 'PENDING_APPROVAL';
  return RISK_FAILURES.includes(code) ? 'RISK_REJECTED' : 'POLICY_REJECTED';
}
export class KernelError extends Error {
  constructor(public readonly code: Failure) {
    super(code);
  }
}
function requireRule(condition: boolean, code: Failure): asserts condition {
  if (!condition) throw new KernelError(code);
}
function sameAsset(a: Asset, b: Asset): boolean {
  return (
    a.chainId === b.chainId &&
    a.address === b.address &&
    a.decimals === b.decimals &&
    a.symbol === b.symbol
  );
}
function mandateKey(m: Pick<Mandate, 'groupId' | 'mandateId'>): string {
  return `${m.groupId}:${m.mandateId}`;
}
export class MandateResolver {
  private readonly mandates = new Map<string, Mandate>();
  constructor(mandates: readonly Mandate[]) {
    for (const value of mandates) this.update(value);
  }
  update(value: Mandate): void {
    const mandate = MandateSchema.parse(value);
    const old = this.mandates.get(mandateKey(mandate));
    if (old && !sameAsset(old.inputAsset, mandate.inputAsset))
      throw new KernelError('ASSET_FORBIDDEN');
    if (old && mandate.version < old.version)
      throw new KernelError('MANDATE_VERSION');
    if (
      old &&
      mandate.version === old.version &&
      !(old.status === 'ACTIVE' && mandate.status === 'REVOKED') &&
      artifactHash(old) !== artifactHash(mandate)
    )
      throw new KernelError('MANDATE_VERSION');
    this.mandates.set(mandateKey(mandate), mandate);
  }
  resolve(intent: BoundActionIntent): Mandate {
    const value = this.mandates.get(mandateKey(intent));
    requireRule(value !== undefined, 'MANDATE_NOT_FOUND');
    return structuredClone(value);
  }
  values(): Mandate[] {
    return [...this.mandates.values()].map((v) => structuredClone(v));
  }
}
export class PolicyEngine {
  evaluate(
    intent: BoundActionIntent,
    mandate: Mandate,
    network: NetworkProfile,
    now: number,
  ): Tier {
    requireRule(intent.groupId === mandate.groupId, 'GROUP_MISMATCH');
    requireRule(
      intent.mandateId === mandate.mandateId &&
        intent.mandateVersion === mandate.version,
      'MANDATE_VERSION',
    );
    requireRule(mandate.status === 'ACTIVE', 'MANDATE_REVOKED');
    requireRule(
      intent.chainId === network.chainId &&
        canonicalJson(mandate.network) === canonicalJson(network),
      'NETWORK_MISMATCH',
    );
    requireRule(intent.account === mandate.account, 'ACCOUNT_MISMATCH');
    requireRule(
      mandate.operators.includes(intent.operator),
      'OPERATOR_FORBIDDEN',
    );
    requireRule(mandate.plugins.includes(intent.pluginId), 'PLUGIN_FORBIDDEN');
    requireRule(mandate.actions.includes(intent.action), 'ACTION_FORBIDDEN');
    requireRule(mandate.targets.includes(intent.target), 'TARGET_FORBIDDEN');
    requireRule(
      mandate.selectors.includes(intent.selector),
      'SELECTOR_FORBIDDEN',
    );
    requireRule(
      intent.inputToken === mandate.inputAsset.address,
      'ASSET_FORBIDDEN',
    );
    const newAsset =
      intent.outputToken !== undefined &&
      !mandate.outputAssets.some((a) => a.address === intent.outputToken);
    requireRule(!newAsset || mandate.allowNewOutputAssets, 'ASSET_FORBIDDEN');
    requireRule(
      BigInt(intent.maxInputAmount) <= BigInt(mandate.perActionCap),
      'AMOUNT_CAP',
    );
    requireRule(
      BigInt(intent.nativeValue) <= BigInt(mandate.maxNativeValue),
      'NATIVE_VALUE_CAP',
    );
    requireRule(
      intent.maxSlippageBps <= mandate.maxSlippageBps,
      'SLIPPAGE_CAP',
    );
    requireRule(intent.leverageBps <= mandate.maxLeverageBps, 'LEVERAGE_CAP');
    requireRule(
      now >= mandate.validAfter &&
        now >= intent.validAfter &&
        now < mandate.validUntil &&
        now < intent.validUntil &&
        intent.validAfter >= mandate.validAfter &&
        intent.validUntil <= mandate.validUntil,
      'TIME_WINDOW',
    );
    return newAsset || BigInt(intent.maxInputAmount) > BigInt(mandate.reviewCap)
      ? 'CONSENSUS'
      : BigInt(intent.maxInputAmount) > BigInt(mandate.autoCap)
        ? 'REVIEW'
        : 'AUTO';
  }
}
export class RiskGate {
  verify(
    intent: BoundActionIntent,
    mandate: Mandate,
    risk: RiskPacket,
    now: number,
  ): void {
    requireRule(
      risk.intentHash === economicIntentHash(intent) &&
        artifactHash(risk) === intent.riskPacketHash,
      'EVIDENCE_MISMATCH',
    );
    requireRule(
      artifactHash(risk.evidence) === intent.evidenceHash,
      'EVIDENCE_MISMATCH',
    );
    requireRule(
      !risk.blocked &&
        risk.slippageBps <= mandate.maxSlippageBps &&
        risk.slippageBps <= intent.maxSlippageBps &&
        risk.referenceDeviationBps <= mandate.maxReferenceDeviationBps &&
        risk.maxReferenceDeviationBps === mandate.maxReferenceDeviationBps,
      'RISK_REJECTED',
    );
    requireRule(
      risk.quoteAt <= now &&
        now - risk.quoteAt <= mandate.quoteTtlSeconds &&
        risk.quoteExpiresAt > now,
      'STALE_QUOTE',
    );
    requireRule(
      risk.evaluatedAt <= now &&
        now - risk.evaluatedAt <= mandate.evidenceTtlSeconds &&
        risk.evidence.every(
          (e) =>
            !e.untrusted &&
            e.chainId === intent.chainId &&
            e.retrievedAt <= now &&
            now - e.retrievedAt <= mandate.evidenceTtlSeconds,
        ),
      'STALE_EVIDENCE',
    );
  }
}
export class SimulationGate {
  verify(
    intent: BoundActionIntent,
    mandate: Mandate,
    simulation: Simulation,
    now: number,
  ): void {
    requireRule(simulation.succeeded, 'SIMULATION_FAILED');
    requireRule(
      simulation.intentHash === intentHash(intent) &&
        simulation.calldataHash === intent.calldataHash &&
        simulation.chainId === intent.chainId &&
        simulation.account === intent.account &&
        simulation.target === intent.target,
      'SIMULATION_MISMATCH',
    );
    requireRule(
      simulation.simulatedAt <= now &&
        now - simulation.simulatedAt <= mandate.simulationTtlSeconds,
      'STALE_SIMULATION',
    );
  }
}
export class ApprovalCalculator {
  async verify(
    intent: BoundActionIntent,
    mandate: Mandate,
    approvals: readonly Approval[],
    tier: Tier,
    now: number,
  ): Promise<number> {
    const required =
      tier === 'AUTO' ? 0 : tier === 'REVIEW' ? 1 : mandate.quorum;
    const members = new Set<string>();
    const signers = new Set<string>();
    for (const raw of approvals) {
      const approval = ApprovalSchema.parse(raw);
      requireRule(
        approval.groupId === intent.groupId &&
          approval.mandateId === intent.mandateId &&
          approval.mandateVersion === mandate.version &&
          approval.intentHash === intentHash(intent) &&
          approval.expiresAt > now &&
          approval.expiresAt <= intent.validUntil,
        'INVALID_APPROVAL',
      );
      const member = mandate.members.find(
        (m) =>
          m.memberId === approval.memberId &&
          m.signer === approval.signer &&
          m.active,
      );
      requireRule(member !== undefined, 'INVALID_APPROVAL');
      requireRule(
        !members.has(member.memberId) && !signers.has(member.signer),
        'DUPLICATE_APPROVER',
      );
      try {
        const recovered = await recoverTypedDataAddress({
          ...approvalTypedData(intent, approval),
          signature: approval.signature,
        });
        requireRule(
          recovered.toLowerCase() === member.signer,
          'INVALID_APPROVAL',
        );
      } catch {
        throw new KernelError('INVALID_APPROVAL');
      }
      members.add(member.memberId);
      signers.add(member.signer);
    }
    requireRule(members.size >= required, 'MISSING_QUORUM');
    return required;
  }
}
type Ledger = {
  spent: string;
  reserved: string;
  issued: number;
  lastIssued: number | null;
};
type GrantRecord = {
  grant: ExecutionGrant;
  state: 'RESERVED' | 'CONSUMED' | 'RELEASED' | 'RECONCILED';
  actualSpent: string | null;
};
export type TrustedEvidence = {
  riskPacketHashes: readonly string[];
  simulationHashes: readonly string[];
};
export type TreasuryBalance = {
  account: `0x${string}`;
  asset: Asset;
  balance: string;
};
export type KernelSnapshot = {
  version: 1;
  network: NetworkProfile;
  mandates: Mandate[];
  ledger: [string, Ledger][];
  grants: [string, GrantRecord][];
  nonces: string[];
  trustedEvidence: TrustedEvidence;
  balances: TreasuryBalance[];
};
export type AuthorizationRequest = {
  intent: BoundActionIntent;
  risk: RiskPacket;
  simulation: Simulation;
  approvals: readonly Approval[];
  now: number;
};
export type AuthorizationDecision =
  | {
      status: 'AUTHORIZED';
      tier: Exclude<Tier, 'BLOCKED'>;
      requiredApprovals: number;
      grant: ExecutionGrant;
      auditHash: `0x${string}`;
    }
  | {
      status: Extract<ActionState, 'PENDING_APPROVAL'> | ActionRejection;
      tier: Tier;
      code: Failure;
      auditHash: `0x${string}`;
    };
export class Kernel {
  readonly mandates: MandateResolver;
  private readonly network: NetworkProfile;
  private readonly ledger = new Map<string, Ledger>();
  private readonly grants = new Map<string, GrantRecord>();
  private readonly nonces = new Set<string>();
  private readonly trustedRisk = new Set<string>();
  private readonly trustedSimulation = new Set<string>();
  private readonly balances = new Map<string, TreasuryBalance>();
  constructor(options: {
    network: NetworkProfile;
    mandates: readonly Mandate[];
    trustedEvidence?: TrustedEvidence;
    balances?: readonly TreasuryBalance[];
  }) {
    this.network = NetworkProfileSchema.parse(options.network);
    this.mandates = new MandateResolver(options.mandates);
    for (const hash of options.trustedEvidence?.riskPacketHashes ?? [])
      this.trustedRisk.add(hash);
    for (const hash of options.trustedEvidence?.simulationHashes ?? [])
      this.trustedSimulation.add(hash);
    for (const raw of options.balances ?? []) {
      const balance = TreasuryBalanceSchema.parse(raw);
      const key = `${balance.account.toLowerCase()}:${balance.asset.canonicalAssetId}`;
      requireRule(!this.balances.has(key), 'INVALID_INPUT');
      this.balances.set(key, structuredClone(balance));
    }
  }
  private budget(mandate: Mandate): Ledger {
    return (
      this.ledger.get(mandateKey(mandate)) ?? {
        spent: '0',
        reserved: '0',
        issued: 0,
        lastIssued: null,
      }
    );
  }
  private ledgerGate(
    intent: BoundActionIntent,
    mandate: Mandate,
    now: number,
  ): void {
    const state = this.budget(mandate);
    requireRule(
      !this.nonces.has(`${intent.groupId}:${intent.account}:${intent.nonce}`),
      'NONCE_REPLAY',
    );
    requireRule(
      BigInt(state.spent) +
        BigInt(state.reserved) +
        BigInt(intent.maxInputAmount) <=
        BigInt(mandate.cumulativeBudget),
      'BUDGET_EXHAUSTED',
    );
    const balance = this.balances.get(
      `${intent.account}:${mandate.inputAsset.canonicalAssetId}`,
    );
    const reserved = [...this.grants.values()]
      .filter(
        (r) =>
          ['RESERVED', 'CONSUMED'].includes(r.state) &&
          r.grant.account === intent.account &&
          sameAsset(r.grant.inputAsset, mandate.inputAsset),
      )
      .reduce((sum, r) => sum + BigInt(r.grant.maxInputAmount), 0n);
    requireRule(
      balance !== undefined &&
        sameAsset(balance.asset, mandate.inputAsset) &&
        BigInt(balance.balance) >= reserved + BigInt(intent.maxInputAmount),
      'INSUFFICIENT_BALANCE',
    );
    requireRule(state.issued < mandate.maxExecutions, 'RECURRING_CAP');
    requireRule(
      state.lastIssued === null ||
        now - state.lastIssued >= mandate.minIntervalSeconds,
      'FREQUENCY_CAP',
    );
  }
  async authorize(
    request: AuthorizationRequest,
  ): Promise<AuthorizationDecision> {
    let tier: Tier = 'BLOCKED';
    const now = request.now;
    try {
      const intent = BoundActionIntentSchema.parse(request.intent),
        risk = RiskPacketSchema.parse(request.risk),
        simulation = SimulationSchema.parse(request.simulation);
      requireRule(Number.isSafeInteger(now) && now >= 0, 'INVALID_INPUT');
      const approvals = request.approvals.map((raw) =>
        ApprovalSchema.parse(raw),
      );
      const mandate = this.mandates.resolve(intent);
      tier = new PolicyEngine().evaluate(intent, mandate, this.network, now);
      this.ledgerGate(intent, mandate, now);
      requireRule(
        this.trustedRisk.has(artifactHash(risk)) &&
          this.trustedSimulation.has(artifactHash(simulation)),
        'EVIDENCE_MISMATCH',
      );
      new RiskGate().verify(intent, mandate, risk, now);
      new SimulationGate().verify(intent, mandate, simulation, now);
      const requiredApprovals = await new ApprovalCalculator().verify(
        intent,
        mandate,
        approvals,
        tier,
        now,
      );
      requireRule(
        artifactHash(mandate) === artifactHash(this.mandates.resolve(intent)),
        'MANDATE_VERSION',
      );
      this.ledgerGate(intent, mandate, now);
      const hash = intentHash(intent);
      const grant = ExecutionGrantSchema.parse({
        schemaVersion: 1,
        grantId: artifactHash({ intentHash: hash, issuedAt: now }),
        intentHash: hash,
        groupId: intent.groupId,
        mandateId: intent.mandateId,
        mandateVersion: intent.mandateVersion,
        operator: intent.operator,
        pluginId: intent.pluginId,
        chainId: intent.chainId,
        account: intent.account,
        target: intent.target,
        selector: intent.selector,
        calldataHash: intent.calldataHash,
        inputAsset: mandate.inputAsset,
        maxInputAmount: intent.maxInputAmount,
        outputToken: intent.outputToken ?? null,
        minOutputAmount: intent.minOutputAmount,
        nativeValue: intent.nativeValue,
        validAfter: now,
        validUntil: Math.min(
          intent.validUntil,
          mandate.validUntil,
          now + mandate.maxGrantTtlSeconds,
          risk.quoteExpiresAt,
          ...approvals.map((approval) => approval.expiresAt),
          risk.quoteAt + mandate.quoteTtlSeconds,
          risk.evaluatedAt + mandate.evidenceTtlSeconds,
          ...risk.evidence.map(
            (e) => e.retrievedAt + mandate.evidenceTtlSeconds,
          ),
          simulation.simulatedAt + mandate.simulationTtlSeconds,
        ),
        nonce: intent.nonce,
        evidenceHash: intent.evidenceHash,
        riskPacketHash: intent.riskPacketHash,
        simulationHash: artifactHash(simulation),
        tier,
      });
      const state = this.budget(mandate);
      this.ledger.set(mandateKey(mandate), {
        ...state,
        reserved: (
          BigInt(state.reserved) + BigInt(intent.maxInputAmount)
        ).toString(),
        issued: state.issued + 1,
        lastIssued: now,
      });
      this.grants.set(grant.grantId, {
        grant,
        state: 'RESERVED',
        actualSpent: null,
      });
      this.nonces.add(`${intent.groupId}:${intent.account}:${intent.nonce}`);
      return {
        status: 'AUTHORIZED',
        tier: tier as Exclude<Tier, 'BLOCKED'>,
        requiredApprovals,
        grant: structuredClone(grant),
        auditHash: artifactHash({
          intentHash: hash,
          tier,
          requiredApprovals,
          grantId: grant.grantId,
        }),
      };
    } catch (error) {
      const code = error instanceof KernelError ? error.code : 'INVALID_INPUT';
      return {
        status: decisionStatus(code),
        tier,
        code,
        auditHash: artifactHash({
          intentId: request.intent?.intentId ?? 'invalid',
          code,
          tier,
        }),
      };
    }
  }
  verify(
    grantInput: ExecutionGrant,
    intentInput: BoundActionIntent,
    now: number,
  ): ExecutionGrant {
    const grant = ExecutionGrantSchema.parse(grantInput),
      intent = BoundActionIntentSchema.parse(intentInput);
    const record = this.grants.get(grant.grantId);
    requireRule(record !== undefined, 'GRANT_UNKNOWN');
    requireRule(
      artifactHash(grant) === artifactHash(record.grant) &&
        grant.intentHash === intentHash(intent),
      'GRANT_MISMATCH',
    );
    requireRule(record.state === 'RESERVED', 'GRANT_REPLAY');
    requireRule(
      now >= grant.validAfter && now < grant.validUntil,
      'GRANT_EXPIRED',
    );
    new PolicyEngine().evaluate(
      intent,
      this.mandates.resolve(intent),
      this.network,
      now,
    );
    return structuredClone(grant);
  }
  consume(grant: ExecutionGrant, intent: BoundActionIntent, now: number): void {
    const valid = this.verify(grant, intent, now);
    this.grants.get(valid.grantId)!.state = 'CONSUMED';
  }
  reconcile(grantId: string, actualSpent: string): void {
    const record = this.grants.get(grantId);
    requireRule(
      record !== undefined && record.state === 'CONSUMED',
      'RECONCILIATION_INVALID',
    );
    requireRule(
      /^(0|[1-9][0-9]*)$/.test(actualSpent) &&
        BigInt(actualSpent) <= BigInt(record.grant.maxInputAmount),
      'RECONCILIATION_INVALID',
    );
    const key = mandateKey(record.grant),
      state = this.ledger.get(key)!;
    this.ledger.set(key, {
      ...state,
      reserved: (
        BigInt(state.reserved) - BigInt(record.grant.maxInputAmount)
      ).toString(),
      spent: (BigInt(state.spent) + BigInt(actualSpent)).toString(),
    });
    const balance = this.balances.get(
      `${record.grant.account}:${record.grant.inputAsset.canonicalAssetId}`,
    )!;
    balance.balance = (
      BigInt(balance.balance) - BigInt(actualSpent)
    ).toString();
    record.state = 'RECONCILED';
    record.actualSpent = actualSpent;
  }
  releaseExpired(now: number): number {
    let count = 0;
    for (const record of this.grants.values())
      if (record.state === 'RESERVED' && record.grant.validUntil <= now) {
        const key = mandateKey(record.grant),
          state = this.ledger.get(key)!;
        this.ledger.set(key, {
          ...state,
          reserved: (
            BigInt(state.reserved) - BigInt(record.grant.maxInputAmount)
          ).toString(),
        });
        record.state = 'RELEASED';
        count++;
      }
    return count;
  }
  accounting(groupId: string, mandateId: string): Readonly<Ledger> {
    return structuredClone(
      this.ledger.get(`${groupId}:${mandateId}`) ?? {
        spent: '0',
        reserved: '0',
        issued: 0,
        lastIssued: null,
      },
    );
  }
  snapshot(): KernelSnapshot {
    return structuredClone({
      version: 1,
      network: this.network,
      mandates: this.mandates.values(),
      ledger: [...this.ledger],
      grants: [...this.grants],
      nonces: [...this.nonces],
      trustedEvidence: {
        riskPacketHashes: [...this.trustedRisk],
        simulationHashes: [...this.trustedSimulation],
      },
      balances: [...this.balances.values()],
    });
  }
  static restore(snapshot: KernelSnapshot): Kernel {
    const parsed = z
      .strictObject({
        version: z.literal(1),
        network: NetworkProfileSchema,
        mandates: z.array(MandateSchema),
        ledger: z.array(
          z.tuple([
            z.string(),
            z.strictObject({
              spent: AmountSchema,
              reserved: AmountSchema,
              issued: z.number().int().nonnegative(),
              lastIssued: z.number().int().nonnegative().nullable(),
            }),
          ]),
        ),
        grants: z.array(
          z.tuple([
            z.string(),
            z.strictObject({
              grant: ExecutionGrantSchema,
              state: z.enum(['RESERVED', 'CONSUMED', 'RELEASED', 'RECONCILED']),
              actualSpent: AmountSchema.nullable(),
            }),
          ]),
        ),
        nonces: z.array(z.string()),
        trustedEvidence: z.strictObject({
          riskPacketHashes: z.array(z.string()),
          simulationHashes: z.array(z.string()),
        }),
        balances: z.array(TreasuryBalanceSchema),
      })
      .parse(snapshot);
    requireRule(
      new Set(parsed.ledger.map(([k]) => k)).size === parsed.ledger.length &&
        new Set(parsed.grants.map(([k]) => k)).size === parsed.grants.length &&
        new Set(parsed.nonces).size === parsed.nonces.length,
      'INVALID_INPUT',
    );
    const expectedNonces = new Set<string>();
    for (const [key, record] of parsed.grants) {
      requireRule(
        key === record.grant.grantId &&
          (record.state === 'RECONCILED'
            ? record.actualSpent !== null &&
              BigInt(record.actualSpent) <= BigInt(record.grant.maxInputAmount)
            : record.actualSpent === null),
        'INVALID_INPUT',
      );
      const nonce = `${record.grant.groupId}:${record.grant.account}:${record.grant.nonce}`;
      requireRule(!expectedNonces.has(nonce), 'INVALID_INPUT');
      expectedNonces.add(nonce);
      requireRule(
        parsed.ledger.some(([k]) => k === mandateKey(record.grant)),
        'INVALID_INPUT',
      );
    }
    requireRule(
      expectedNonces.size === parsed.nonces.length &&
        parsed.nonces.every((nonce) => expectedNonces.has(nonce)),
      'INVALID_INPUT',
    );
    for (const [key, ledger] of parsed.ledger) {
      const records = parsed.grants
        .filter(([, r]) => mandateKey(r.grant) === key)
        .map(([, r]) => r);
      const spent = records.reduce(
        (sum, r) => sum + BigInt(r.actualSpent ?? '0'),
        0n,
      );
      const reserved = records
        .filter((r) => r.state === 'RESERVED' || r.state === 'CONSUMED')
        .reduce((sum, r) => sum + BigInt(r.grant.maxInputAmount), 0n);
      requireRule(
        BigInt(ledger.spent) === spent &&
          BigInt(ledger.reserved) === reserved &&
          ledger.issued === records.length &&
          ledger.lastIssued ===
            (records.length === 0
              ? null
              : Math.max(...records.map((r) => r.grant.validAfter))),
        'INVALID_INPUT',
      );
    }
    const kernel = new Kernel(parsed);
    for (const [key, value] of parsed.ledger) kernel.ledger.set(key, value);
    for (const [key, value] of parsed.grants) kernel.grants.set(key, value);
    for (const nonce of parsed.nonces) kernel.nonces.add(nonce);
    return kernel;
  }
}
export class GrantVerifier {
  constructor(private readonly kernel: Kernel) {}
  verify(
    grant: ExecutionGrant,
    intent: BoundActionIntent,
    now: number,
  ): ExecutionGrant {
    return this.kernel.verify(grant, intent, now);
  }
}
export class GrantIssuer {
  constructor(private readonly kernel: Kernel) {}
  issue(request: AuthorizationRequest): Promise<AuthorizationDecision> {
    return this.kernel.authorize(request);
  }
}
