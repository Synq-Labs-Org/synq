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

export function isPureWidening(previous: Mandate, next: Mandate): boolean {
  const ge = (a: string, b: string) => BigInt(a) >= BigInt(b);
  const tuples = new Set(
    next.bindings.map((b) =>
      canonicalJson([b.pluginId, b.action, b.target, b.selector]),
    ),
  );
  const recipients = new Set(
    next.recipients.map((r) => `${r.address}:${r.purpose}`),
  );
  return (
    ge(next.perActionCap, previous.perActionCap) &&
    ge(next.cumulativeBudget, previous.cumulativeBudget) &&
    ge(next.maxNativeValue, previous.maxNativeValue) &&
    ge(next.cumulativeNativeBudget, previous.cumulativeNativeBudget) &&
    next.validAfter <= previous.validAfter &&
    next.validUntil >= previous.validUntil &&
    previous.bindings.every((b) =>
      tuples.has(canonicalJson([b.pluginId, b.action, b.target, b.selector])),
    ) &&
    previous.recipients.every((r) =>
      recipients.has(`${r.address}:${r.purpose}`),
    )
  );
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
