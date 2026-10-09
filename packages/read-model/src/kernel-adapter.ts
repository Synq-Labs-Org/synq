import { parseAbi, type PublicClient } from 'viem';
import type {
  DirectVerification,
  DirectVerifier,
  FreshnessObservation,
  FreshnessProbe,
  FreshnessQuery,
} from '@synq/kernel';
import {
  GrantExecutionObservationSchema,
  type GrantExecutionObservation,
} from '@synq/schemas';
import type { ProjectionConfig } from './config.js';
import { ReadModelError } from './errors.js';
import type { ChainEventOf } from './events.js';
import type { ChainHeadObserver } from './freshness.js';
import type { SnapshotSource } from './reader.js';
import type { Hex } from './tables.js';

const erc20 = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
]);
const registryAbi = parseAbi([
  'struct MandateState { uint8 status; uint256 currentVersion; uint256 minValidVersion; uint256 spentToken; uint256 spentNative; }',
  'function mandateState(address account, bytes32 mandateId) view returns (MandateState)',
]);
const moduleAbi = parseAbi([
  'function paused(address account) view returns (bool)',
]);

export class ReadModelFreshnessProbe implements FreshnessProbe {
  constructor(
    private readonly source: SnapshotSource,
    private readonly head: ChainHeadObserver,
  ) {}
  async observe(query: FreshnessQuery): Promise<FreshnessObservation> {
    if (query.chainId !== this.source.chainId)
      throw new ReadModelError('CONFIG_MISMATCH', `chain ${query.chainId}`);
    const account = query.account.toLowerCase();
    const progress = await this.source.progress();
    const entry = progress.groups.find((g) => g.account === account);
    if (!entry) throw new ReadModelError('NOT_FOUND', account);
    const [snapshot, head] = await Promise.all([
      this.source.groupSnapshot(entry.groupId as Hex),
      this.head.head(),
    ]);
    if (!snapshot) throw new ReadModelError('NOT_FOUND', entry.groupId);
    if (snapshot.group.accountingStatus === 'FROZEN')
      throw new ReadModelError('ACCOUNTING_FROZEN', entry.groupId);
    return {
      chainId: snapshot.sourceChainId,
      indexedThroughBlock: snapshot.indexedThroughBlock,
      headBlock: head.block,
      accountPaused: snapshot.group.paused,
    };
  }
}

export class RpcKernelDirectVerifier implements DirectVerifier {
  constructor(
    private readonly client: PublicClient,
    private readonly config: ProjectionConfig,
  ) {}
  async verify(query: FreshnessQuery): Promise<DirectVerification> {
    if (query.chainId !== this.config.chainId)
      throw new ReadModelError('CONFIG_MISMATCH', `chain ${query.chainId}`);
    const account = query.account.toLowerCase() as Hex;
    const blockNumber = await this.client.getBlockNumber({ cacheTime: 0 });
    const [paused, state, balances] = await Promise.all([
      this.client.readContract({
        address: this.config.module,
        abi: moduleAbi,
        functionName: 'paused',
        args: [account],
        blockNumber,
      }),
      this.client.readContract({
        address: this.config.registry,
        abi: registryAbi,
        functionName: 'mandateState',
        args: [account, query.mandateId],
        blockNumber,
      }),
      Promise.all(
        query.assets.map(async (asset) => ({
          account,
          asset,
          balance: (
            await ('native' in asset
              ? this.client.getBalance({ address: account, blockNumber })
              : this.client.readContract({
                  address: asset.address,
                  abi: erc20,
                  functionName: 'balanceOf',
                  args: [account],
                  blockNumber,
                }))
          ).toString(),
        })),
      ),
    ]);
    const version = Number(state.currentVersion);
    if (!Number.isSafeInteger(version))
      throw new ReadModelError('INCONSISTENT_WITH_CHAIN', 'mandate version');
    return {
      chainId: this.config.chainId,
      account,
      blockNumber: Number(blockNumber),
      paused,
      mandate: {
        mandateId: query.mandateId.toLowerCase() as Hex,
        active: state.status === 1,
        version,
      },
      balances,
    };
  }
}

export function grantExecutionObservation(
  event: ChainEventOf<'GrantExecuted'>,
): GrantExecutionObservation {
  return GrantExecutionObservationSchema.parse({
    schemaVersion: 1,
    chainId: event.chainId,
    transactionHash: event.transactionHash,
    blockNumber: String(event.blockNumber),
    receiptStatus: 'success',
    emitter: event.contract,
    event: event.payload,
  });
}
