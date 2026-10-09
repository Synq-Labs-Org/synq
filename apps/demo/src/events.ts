import { decodeEventLog, parseAbi } from 'viem';
import {
  EVENT_NAMES,
  parseChainEvent,
  type ChainEvent,
} from '@synq/read-model';
import type { LocalSynq } from './safe.js';

const indexedAbi = parseAbi([
  'event GroupCreated(bytes32 indexed groupId, address indexed account, address[] owners, uint256 threshold, address module, address registry, address indexed creator, bytes32 salt)',
  'event GroupBound(bytes32 indexed groupId, address indexed account, address indexed module)',
  'event GroupModuleChanged(bytes32 indexed groupId, address indexed account, address previousModule, address newModule)',
  'event MandateConfigured(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account, bytes32 mandateHash, address token, uint256 maxTokenPerAction, uint256 maxNativePerAction, uint256 cumulativeTokenCap, uint256 cumulativeNativeCap, uint256 validAfter, uint256 validUntil, address[] callTargets, bytes4[] callSelectors, address[] recipients)',
  'event MandateSuperseded(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed newVersion, address account, uint256 previousVersion, bool securitySensitive, uint256 minValidVersion)',
  'event MandateRevoked(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account)',
  'event SpendRecorded(bytes32 indexed groupId, bytes32 indexed mandateId, uint256 indexed version, address account, address module, uint256 tokenAmount, uint256 nativeAmount, uint256 spentToken, uint256 spentNative)',
  'event ExecutorSet(bytes32 indexed groupId, address indexed account, address indexed executor, bool allowed)',
  'event Paused(bytes32 indexed groupId, address indexed account)',
  'event Unpaused(bytes32 indexed groupId, address indexed account)',
  'event NonceCancelled(bytes32 indexed groupId, address indexed account, uint256 indexed nonce)',
  'event GrantExecuted(bytes32 indexed groupId, bytes32 indexed intentHash, bytes32 indexed mandateId, uint256 mandateVersion, address account, address executor, bytes32 pluginId, uint256 chainId, uint256 nonce, bytes32 grantHash, address target, bytes4 selector, bytes32 calldataHash, address token, address recipient, uint256 tokenAmount, uint256 nativeValue, uint256 outputAmount)',
  'event SafeSetup(address indexed initiator, address[] owners, uint256 threshold, address initializer, address fallbackHandler)',
  'event AddedOwner(address indexed owner)',
  'event RemovedOwner(address indexed owner)',
  'event ChangedThreshold(uint256 threshold)',
  'event EnabledModule(address indexed module)',
  'event DisabledModule(address indexed module)',
  'event ChangedGuard(address indexed guard)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
]);
const names = new Set<string>(EVENT_NAMES);

export async function indexedEvents(
  chain: LocalSynq,
): Promise<{ events: ChainEvent[]; checkpoint: number }> {
  if (chain.deploymentBlock === null) throw new Error('DEPLOYMENT_BLOCK');
  const checkpoint = Number(
    await chain.client.getBlockNumber({ cacheTime: 0 }),
  );
  const account = chain.account.toLowerCase();
  const logs = await chain.client.getLogs({
    address: [
      chain.factory,
      chain.registry,
      chain.module,
      chain.token,
      chain.account,
    ],
    fromBlock: chain.deploymentBlock,
    toBlock: BigInt(checkpoint),
  });
  const events: ChainEvent[] = [];
  for (const log of logs) {
    if (
      log.blockNumber === null ||
      log.blockHash === null ||
      log.transactionHash === null ||
      log.transactionIndex === null ||
      log.logIndex === null
    )
      throw new Error('PENDING_LOG');
    let decoded;
    try {
      decoded = decodeEventLog({
        abi: indexedAbi,
        data: log.data,
        topics: log.topics,
      });
    } catch {
      continue;
    }
    if (!names.has(decoded.eventName)) continue;
    const payload = JSON.parse(
      JSON.stringify(decoded.args, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as Record<string, unknown>;
    if (
      decoded.eventName === 'Transfer' &&
      String(payload.from).toLowerCase() !== account &&
      String(payload.to).toLowerCase() !== account
    )
      continue;
    events.push(
      parseChainEvent({
        schemaVersion: 1,
        chainId: 31337,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        contract: log.address,
        eventName: decoded.eventName,
        payload,
      }),
    );
  }
  return { events, checkpoint };
}
