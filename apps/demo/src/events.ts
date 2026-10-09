import { decodeEventLog, type Abi, type Address } from 'viem';
import { ChainEventSchema, type ChainEvent } from '@synq/read-model';
import { moduleAbi, registryAbi, tokenAbi } from '@synq/execution-worker/abi';
import type { LocalSynq } from './safe.js';

const PROJECTED = new Set([
  'MandateConfigured',
  'MandateRevoked',
  'Paused',
  'Unpaused',
  'GrantExecuted',
  'Transfer',
]);

export async function indexedEvents(
  chain: LocalSynq,
): Promise<{ events: ChainEvent[]; checkpoint: number }> {
  const checkpoint = Number(
    await chain.client.getBlockNumber({ cacheTime: 0 }),
  );
  const logs = await chain.client.getLogs({
    address: [chain.registry, chain.module, chain.token],
    fromBlock: 0n,
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
    const address = log.address.toLowerCase();
    const abi: Abi =
      address === chain.registry.toLowerCase()
        ? registryAbi
        : address === chain.module.toLowerCase()
          ? moduleAbi
          : tokenAbi;
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
    if (!decoded.eventName || !PROJECTED.has(decoded.eventName)) continue;
    const payload = JSON.parse(
      JSON.stringify(decoded.args, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as unknown;
    events.push(
      ChainEventSchema.parse({
        schemaVersion: 1,
        chainId: 31337,
        blockNumber: Number(log.blockNumber),
        blockHash: log.blockHash,
        transactionHash: log.transactionHash,
        transactionIndex: log.transactionIndex,
        logIndex: log.logIndex,
        contract: log.address as Address,
        eventName: decoded.eventName,
        payload,
      }),
    );
  }
  return { events, checkpoint };
}
