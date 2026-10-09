import { parseAbi, type PublicClient } from 'viem';
import { z } from 'zod';
import type { ProjectionConfig } from './config.js';
import { ReadModelError } from './errors.js';
import { canonicalJson } from './events.js';
import type { SnapshotSource } from './reader.js';
import type { Hex } from './tables.js';
import type { GroupSnapshot } from './views.js';

const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);
const safe = parseAbi([
  'function getOwners() view returns (address[])',
  'function getThreshold() view returns (uint256)',
  'function isModuleEnabled(address module) view returns (bool)',
]);
const registryAbi = parseAbi([
  'struct MandateState { uint8 status; uint256 currentVersion; uint256 minValidVersion; uint256 spentToken; uint256 spentNative; }',
  'function mandateState(address account, bytes32 mandateId) view returns (MandateState)',
  'function accountOf(bytes32 groupId) view returns (address)',
]);
const moduleAbi = parseAbi([
  'function paused(address account) view returns (bool)',
]);

export type VerificationTarget =
  | { kind: 'TREASURY_BALANCE'; asset: Hex }
  | { kind: 'OWNERS' }
  | { kind: 'MANDATE'; mandateId: Hex }
  | { kind: 'MODULE' };
export interface Observation {
  target: VerificationTarget;
  chain: Record<string, unknown>;
  projected: Record<string, unknown>;
  matches: boolean;
}
export interface DirectVerificationResult {
  groupId: Hex;
  account: Hex;
  sourceChainId: number;
  checkedAtBlock: number;
  indexedThroughBlock: number;
  observations: Observation[];
  consistent: boolean;
}

export class ReadModelInconsistencyError extends ReadModelError {
  constructor(readonly result: DirectVerificationResult) {
    super(
      'INCONSISTENT_WITH_CHAIN',
      `${result.groupId} differs from chain at block ${result.checkedAtBlock}: ${result.observations
        .filter((o) => !o.matches)
        .map((o) => o.target.kind)
        .join(',')}`,
    );
    this.name = 'ReadModelInconsistencyError';
  }
}

const STATUS = ['NONE', 'ACTIVE', 'REVOKED'] as const;
const lower = (a: string) => a.toLowerCase();
const uint = (v: unknown) => z.bigint().nonnegative().parse(v).toString();

export const DEFAULT_VERIFICATION_TARGETS = (
  config: ProjectionConfig,
  snapshot: GroupSnapshot,
): VerificationTarget[] => [
  ...config.treasuryAssets.map(
    (asset) => ({ kind: 'TREASURY_BALANCE', asset }) as const,
  ),
  { kind: 'OWNERS' },
  { kind: 'MODULE' },
  ...snapshot.group.mandates.map(
    (m) => ({ kind: 'MANDATE', mandateId: m.mandateId as Hex }) as const,
  ),
];

export class RpcDirectVerifier {
  constructor(
    private readonly client: PublicClient,
    private readonly config: ProjectionConfig,
    private readonly source: SnapshotSource,
  ) {}

  private async observe(
    snapshot: GroupSnapshot,
    target: VerificationTarget,
    blockNumber: bigint,
  ): Promise<Observation> {
    const account = snapshot.group.account as Hex;
    let chain: Record<string, unknown>;
    let projected: Record<string, unknown>;
    switch (target.kind) {
      case 'TREASURY_BALANCE': {
        const balance = await this.client.readContract({
          address: target.asset,
          abi: erc20,
          functionName: 'balanceOf',
          args: [account],
          blockNumber,
        });
        chain = { balance: uint(balance) };
        projected = {
          balance:
            snapshot.group.treasury.find((t) => t.asset === target.asset)
              ?.balance ?? null,
        };
        break;
      }
      case 'OWNERS': {
        const [owners, threshold] = await Promise.all([
          this.client.readContract({
            address: account,
            abi: safe,
            functionName: 'getOwners',
            blockNumber,
          }),
          this.client.readContract({
            address: account,
            abi: safe,
            functionName: 'getThreshold',
            blockNumber,
          }),
        ]);
        chain = {
          owners: [...owners].map(lower).sort(),
          threshold: uint(threshold),
        };
        projected = {
          owners: [...snapshot.group.owners].sort(),
          threshold: snapshot.group.threshold,
        };
        break;
      }
      case 'MODULE': {
        const [paused, enabled, bound] = await Promise.all([
          this.client.readContract({
            address: this.config.module,
            abi: moduleAbi,
            functionName: 'paused',
            args: [account],
            blockNumber,
          }),
          this.client.readContract({
            address: account,
            abi: safe,
            functionName: 'isModuleEnabled',
            args: [this.config.module],
            blockNumber,
          }),
          this.client.readContract({
            address: this.config.registry,
            abi: registryAbi,
            functionName: 'accountOf',
            args: [snapshot.group.groupId as Hex],
            blockNumber,
          }),
        ]);
        chain = { paused, moduleEnabled: enabled, account: lower(bound) };
        projected = {
          paused: snapshot.group.paused,
          moduleEnabled:
            snapshot.group.safeModules.find(
              (m) => m.module === this.config.module,
            )?.enabled ?? false,
          account,
        };
        break;
      }
      case 'MANDATE': {
        const state = await this.client.readContract({
          address: this.config.registry,
          abi: registryAbi,
          functionName: 'mandateState',
          args: [account, target.mandateId],
          blockNumber,
        });
        chain = {
          status: STATUS[state.status] ?? 'UNKNOWN',
          currentVersion: uint(state.currentVersion),
          minValidVersion: uint(state.minValidVersion),
          spentToken: uint(state.spentToken),
          spentNative: uint(state.spentNative),
        };
        const m = snapshot.group.mandates.find(
          (x) => x.mandateId === target.mandateId,
        );
        projected = m
          ? {
              status: m.status,
              currentVersion: m.currentVersion,
              minValidVersion: m.minValidVersion,
              spentToken: m.spentToken,
              spentNative: m.spentNative,
            }
          : {
              status: 'NONE',
              currentVersion: '0',
              minValidVersion: '0',
              spentToken: '0',
              spentNative: '0',
            };
        break;
      }
    }
    return {
      target,
      chain,
      projected,
      matches: canonicalJson(chain) === canonicalJson(projected),
    };
  }

  private async run(
    groupId: Hex,
    blockFor: (snapshot: GroupSnapshot) => Promise<number>,
    targets?: readonly VerificationTarget[],
  ): Promise<{ result: DirectVerificationResult; snapshot: GroupSnapshot }> {
    const snapshot = await this.source.groupSnapshot(groupId);
    if (!snapshot) throw new ReadModelError('NOT_FOUND', groupId);
    const block = await blockFor(snapshot);
    const list = targets ?? DEFAULT_VERIFICATION_TARGETS(this.config, snapshot);
    if (list.length === 0)
      throw new ReadModelError('NO_VERIFICATION_TARGETS', groupId);
    let observations: Observation[];
    try {
      observations = await Promise.all(
        list.map((t) => this.observe(snapshot, t, BigInt(block))),
      );
    } catch (error) {
      throw new ReadModelError('SOURCE_UNAVAILABLE', 'direct RPC read failed', {
        cause: error,
      });
    }
    return {
      snapshot,
      result: {
        groupId: snapshot.group.groupId as Hex,
        account: snapshot.group.account as Hex,
        sourceChainId: this.config.chainId,
        checkedAtBlock: block,
        indexedThroughBlock: snapshot.indexedThroughBlock,
        observations,
        consistent: observations.every((o) => o.matches),
      },
    };
  }

  async verifyIndexed(
    groupId: Hex,
    targets?: readonly VerificationTarget[],
  ): Promise<DirectVerificationResult> {
    const { result } = await this.run(
      groupId,
      async (s) => s.indexedThroughBlock,
      targets,
    );
    if (!result.consistent) throw new ReadModelInconsistencyError(result);
    return result;
  }

  async readAtHead(
    groupId: Hex,
    head: number,
    targets?: readonly VerificationTarget[],
  ): Promise<DirectVerificationResult> {
    const { result } = await this.run(groupId, async () => head, targets);
    return result;
  }
}
