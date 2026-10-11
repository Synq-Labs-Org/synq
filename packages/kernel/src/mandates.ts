import {
  encodeAbiParameters,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { MandateSchema, type Mandate } from '@synq/schemas';
import { artifactHash, canonicalJson, type Hash } from './canonical.js';
import { KernelError, parseAs, requireRule } from './errors.js';

export function mandateKey(m: { groupId: string; mandateId: string }): string {
  return JSON.stringify([m.groupId, m.mandateId]);
}
export function onchainMandateId(m: {
  groupId: string;
  mandateId: string;
}): Hash {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'string' }, { type: 'string' }],
      [m.groupId, m.mandateId],
    ),
  );
}
export function onchainPluginId(pluginId: string): Hash {
  return keccak256(stringToHex(pluginId));
}

export type MandateConfig = {
  mandateHash: Hash;
  token: Address;
  maxTokenPerAction: bigint;
  maxNativePerAction: bigint;
  cumulativeTokenCap: bigint;
  cumulativeNativeCap: bigint;
  validAfter: bigint;
  validUntil: bigint;
  callTargets: Address[];
  callSelectors: Hex[];
  recipients: Address[];
};
export function toMandateConfig(raw: Mandate): MandateConfig {
  const m = MandateSchema.parse(raw);
  const calls = new Map<string, { target: Address; selector: Hex }>();
  for (const b of m.bindings)
    calls.set(`${b.target}:${b.selector}`, {
      target: b.target,
      selector: b.selector,
    });
  return {
    mandateHash: artifactHash(m),
    token: m.inputAsset.address,
    maxTokenPerAction: BigInt(m.perActionCap),
    maxNativePerAction: BigInt(m.maxNativeValue),
    cumulativeTokenCap: BigInt(m.cumulativeBudget),
    cumulativeNativeCap: BigInt(m.cumulativeNativeBudget),
    validAfter: BigInt(m.validAfter),
    validUntil: BigInt(m.validUntil),
    callTargets: [...calls.values()].map((c) => c.target),
    callSelectors: [...calls.values()].map((c) => c.selector),
    recipients: m.recipients.map((r) => r.address),
  };
}

type Rule = (previous: Mandate, next: Mandate) => boolean;
const ge = (a: string, b: string) => BigInt(a) >= BigInt(b);
const same =
  <K extends keyof Mandate>(key: K): Rule =>
  (p, n) =>
    canonicalJson(p[key]) === canonicalJson(n[key]);
const keeps = <T>(
  previous: readonly T[],
  next: readonly T[],
  key: (x: T) => string,
) => {
  const kept = new Set(next.map(key));
  return previous.every((x) => kept.has(key(x)));
};
const TIER_RANK = { AUTO: 0, REVIEW: 1, CONSENSUS: 2, BLOCKED: 3 } as const;
const WITHDRAWAL_RANK = { CONSENSUS: 0, UNANIMOUS: 1, BLOCKED: 2 } as const;
const STRICT_RANK = { CONSENSUS: 0, BLOCKED: 1 } as const;

function tierPolicyWidens(p: Mandate, n: Mandate): boolean {
  const a = p.tierPolicy,
    b = n.tierPolicy;
  const floor = (m: Mandate['tierPolicy'], action: string) =>
    TIER_RANK[m.actionFloors.find((f) => f.action === action)?.tier ?? 'AUTO'];
  const actions = new Set(
    [...a.actionFloors, ...b.actionFloors].map((f) => f.action),
  );
  return (
    ge(b.tokenSpend.autoMax, a.tokenSpend.autoMax) &&
    ge(b.tokenSpend.reviewMax, a.tokenSpend.reviewMax) &&
    ge(b.nativeSpend.autoMax, a.nativeSpend.autoMax) &&
    ge(b.nativeSpend.reviewMax, a.nativeSpend.reviewMax) &&
    [...actions].every((x) => floor(b, x) <= floor(a, x)) &&
    STRICT_RANK[b.newOutputAsset] <= STRICT_RANK[a.newOutputAsset] &&
    STRICT_RANK[b.leverage] <= STRICT_RANK[a.leverage] &&
    WITHDRAWAL_RANK[b.withdrawal] <= WITHDRAWAL_RANK[a.withdrawal]
  );
}

export const WIDENING_RULES: { readonly [K in keyof Mandate]-?: Rule } = {
  schemaVersion: same('schemaVersion'),
  mandateId: same('mandateId'),
  groupId: same('groupId'),
  version: (p, n) => n.version === p.version + 1,
  status: (_p, n) => n.status === 'ACTIVE',
  network: same('network'),
  account: same('account'),
  chainGroupId: same('chainGroupId'),
  operators: (p, n) => keeps(p.operators, n.operators, (x) => x),
  bindings: (p, n) =>
    keeps(p.bindings, n.bindings, (b) =>
      canonicalJson([b.pluginId, b.action, b.target, b.selector]),
    ),
  recipients: (p, n) =>
    keeps(p.recipients, n.recipients, (r) => `${r.address}:${r.purpose}`),
  inputAsset: same('inputAsset'),
  outputAssets: (p, n) =>
    keeps(p.outputAssets, n.outputAssets, (a) => a.canonicalAssetId),
  perActionCap: (p, n) => ge(n.perActionCap, p.perActionCap),
  cumulativeBudget: (p, n) => ge(n.cumulativeBudget, p.cumulativeBudget),
  maxNativeValue: (p, n) => ge(n.maxNativeValue, p.maxNativeValue),
  cumulativeNativeBudget: (p, n) =>
    ge(n.cumulativeNativeBudget, p.cumulativeNativeBudget),
  maxSlippageBps: (p, n) => n.maxSlippageBps >= p.maxSlippageBps,
  maxReferenceDeviationBps: (p, n) =>
    n.maxReferenceDeviationBps >= p.maxReferenceDeviationBps,
  maxLeverageBps: (p, n) => n.maxLeverageBps >= p.maxLeverageBps,
  maxAllocationBps: (p, n) => n.maxAllocationBps >= p.maxAllocationBps,
  tierPolicy: tierPolicyWidens,
  approvalPolicy: (p, n) =>
    n.approvalPolicy.quorum <= p.approvalPolicy.quorum &&
    n.approvalPolicy.reviewApprovals <= p.approvalPolicy.reviewApprovals &&
    n.approvalPolicy.accountThreshold === p.approvalPolicy.accountThreshold &&
    keeps(
      p.approvalPolicy.eligibleKinds,
      n.approvalPolicy.eligibleKinds,
      (k) => k,
    ),
  delegationScope: (p, n) => {
    const a = p.delegationScope,
      b = n.delegationScope;
    if (a === null) return true;
    return (
      b !== null &&
      keeps(a.actions, b.actions, (x) => x) &&
      ge(b.maxInputPerAction, a.maxInputPerAction) &&
      ge(b.maxNativePerAction, a.maxNativePerAction) &&
      b.periodSeconds <= a.periodSeconds &&
      b.maxUsesPerPeriod >= a.maxUsesPerPeriod
    );
  },
  members: same('members'),
  validAfter: (p, n) => n.validAfter <= p.validAfter,
  validUntil: (p, n) => n.validUntil >= p.validUntil,
  quoteTtlSeconds: (p, n) => n.quoteTtlSeconds >= p.quoteTtlSeconds,
  evidenceTtlSeconds: (p, n) => n.evidenceTtlSeconds >= p.evidenceTtlSeconds,
  simulationTtlSeconds: (p, n) =>
    n.simulationTtlSeconds >= p.simulationTtlSeconds,
  maxGrantTtlSeconds: (p, n) => n.maxGrantTtlSeconds >= p.maxGrantTtlSeconds,
  minIntervalSeconds: (p, n) => n.minIntervalSeconds <= p.minIntervalSeconds,
  maxExecutions: (p, n) => n.maxExecutions >= p.maxExecutions,
  hedgePolicyHash: (p, n) => p.hedgePolicyHash === n.hedgePolicyHash,
};

export function narrowedFields(previous: Mandate, next: Mandate): string[] {
  return (Object.keys(WIDENING_RULES) as (keyof Mandate)[]).filter(
    (k) => !WIDENING_RULES[k](previous, next),
  );
}
export function isPureWidening(previous: Mandate, next: Mandate): boolean {
  return narrowedFields(previous, next).length === 0;
}

export type MandateRecord = {
  versions: Mandate[];
  minValidVersion: number;
  revoked: boolean;
};

export class MandateResolver {
  private readonly records = new Map<string, MandateRecord>();
  constructor(initial: readonly unknown[] = []) {
    for (const raw of initial) this.load(raw);
  }
  private load(raw: unknown): void {
    const mandate = parseAs(MandateSchema, raw, 'MANDATE_CONFLICT');
    const key = mandateKey(mandate);
    requireRule(!this.records.has(key), 'MANDATE_CONFLICT');
    this.records.set(key, {
      versions: [mandate],
      minValidVersion: mandate.version,
      revoked: mandate.status === 'REVOKED',
    });
  }
  configure(raw: unknown): Mandate {
    const mandate = parseAs(MandateSchema, raw, 'MANDATE_CONFLICT');
    requireRule(
      mandate.version === 1 && mandate.status === 'ACTIVE',
      'MANDATE_CONFLICT',
    );
    this.load(mandate);
    return structuredClone(mandate);
  }
  supersede(raw: unknown, options: { securitySensitive: boolean }): Mandate {
    const next = parseAs(MandateSchema, raw, 'MANDATE_CONFLICT');
    const record = this.records.get(mandateKey(next));
    requireRule(record !== undefined, 'MANDATE_NOT_FOUND');
    requireRule(!record.revoked, 'MANDATE_REVOKED');
    const current = record.versions.at(-1)!;
    requireRule(
      next.version === current.version + 1 && next.status === 'ACTIVE',
      'MANDATE_VERSION',
    );
    requireRule(
      next.inputAsset.canonicalAssetId === current.inputAsset.canonicalAssetId,
      'ASSET_CHANGE_FORBIDDEN',
    );
    requireRule(
      next.account === current.account &&
        next.chainGroupId === current.chainGroupId &&
        canonicalJson(next.network) === canonicalJson(current.network),
      'MANDATE_CONFLICT',
    );
    if (!options.securitySensitive)
      requireRule(
        isPureWidening(current, next),
        'NARROWING_REQUIRES_INVALIDATION',
      );
    record.versions.push(next);
    if (options.securitySensitive) record.minValidVersion = next.version;
    return structuredClone(next);
  }
  revoke(groupId: string, mandateId: string): Mandate {
    const record = this.records.get(mandateKey({ groupId, mandateId }));
    requireRule(record !== undefined, 'MANDATE_NOT_FOUND');
    requireRule(!record.revoked, 'MANDATE_REVOKED');
    record.revoked = true;
    const last = record.versions.at(-1)!;
    record.versions[record.versions.length - 1] = {
      ...last,
      status: 'REVOKED',
    };
    return structuredClone(record.versions.at(-1)!);
  }
  current(groupId: string, mandateId: string): Mandate {
    const record = this.records.get(mandateKey({ groupId, mandateId }));
    if (!record) throw new KernelError('MANDATE_NOT_FOUND');
    return structuredClone(record.versions.at(-1)!);
  }
  version(groupId: string, mandateId: string, version: number): Mandate | null {
    const record = this.records.get(mandateKey({ groupId, mandateId }));
    const found = record?.versions.find((m) => m.version === version);
    return found ? structuredClone(found) : null;
  }
  assertGrantable(groupId: string, mandateId: string, version: number): void {
    const record = this.records.get(mandateKey({ groupId, mandateId }));
    requireRule(record !== undefined, 'MANDATE_NOT_FOUND');
    requireRule(!record.revoked, 'MANDATE_REVOKED');
    requireRule(
      version >= record.minValidVersion &&
        version <= record.versions.at(-1)!.version,
      'MANDATE_VERSION',
    );
  }
  fingerprint(groupId: string, mandateId: string): Hash | null {
    const record = this.records.get(mandateKey({ groupId, mandateId }));
    return record ? artifactHash(record) : null;
  }
  values(): Mandate[] {
    return [...this.records.values()].map((r) =>
      structuredClone(r.versions.at(-1)!),
    );
  }
  clone(): MandateResolver {
    return MandateResolver.fromRecords(this.exportRecords());
  }
  exportRecords(): MandateRecord[] {
    return structuredClone([...this.records.values()]);
  }
  static fromRecords(records: readonly MandateRecord[]): MandateResolver {
    const resolver = new MandateResolver();
    for (const raw of records) {
      const versions = raw.versions.map((v) =>
        parseAs(MandateSchema, v, 'SNAPSHOT_INVALID'),
      );
      const first = versions[0];
      requireRule(first !== undefined, 'SNAPSHOT_INVALID');
      const key = mandateKey(first);
      const last = versions.at(-1)!;
      requireRule(
        !resolver.records.has(key) &&
          versions.every(
            (v, i) =>
              mandateKey(v) === key &&
              v.version === first.version + i &&
              v.inputAsset.canonicalAssetId ===
                first.inputAsset.canonicalAssetId &&
              (v.status === 'ACTIVE' || (raw.revoked && v === last)),
          ) &&
          raw.revoked === (last.status === 'REVOKED') &&
          Number.isSafeInteger(raw.minValidVersion) &&
          raw.minValidVersion >= first.version &&
          raw.minValidVersion <= last.version,
        'SNAPSHOT_INVALID',
      );
      resolver.records.set(key, {
        versions,
        minValidVersion: raw.minValidVersion,
        revoked: raw.revoked,
      });
    }
    return resolver;
  }
}
