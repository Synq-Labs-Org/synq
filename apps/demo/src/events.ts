import { decodeEventLog, type Address } from 'viem';
import { ChainEventSchema, type ChainEvent } from '@synq/read-model';
import { registryAbi, moduleAbi, tokenAbi } from '@synq/execution-worker/abi';
import type { sandbox } from './sandbox.js';
export async function indexedEvents(
  chain: Awaited<ReturnType<typeof sandbox>>,
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
    const abi =
      address === chain.registry.toLowerCase()
        ? registryAbi
        : address === chain.module.toLowerCase()
          ? moduleAbi
          : tokenAbi;
    const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics });
    const payload = JSON.parse(
      JSON.stringify(decoded.args, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      ),
    ) as unknown;
    const event = ChainEventSchema.parse({
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
    });
    events.push(event);
  }
  return { events, checkpoint };
}
