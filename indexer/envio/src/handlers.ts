import { indexer } from 'envio';
import { canonicalEventPayload } from './normalize.js';

type Event = {
  chainId: number;
  block: { number: number; hash: string };
  transaction: { hash: string; transactionIndex: number };
  logIndex: number;
  srcAddress: string;
  params: object;
};
function row(event: Event, eventName: string) {
  const payload = canonicalEventPayload(event.params);
  const chainEvent = {
    schemaVersion: 1,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    transactionHash: event.transaction.hash,
    transactionIndex: event.transaction.transactionIndex,
    logIndex: event.logIndex,
    contract: event.srcAddress,
    eventName,
    payload,
  };
  return {
    id: `${event.chainId}:${event.block.hash}:${event.transaction.hash}:${event.logIndex}`,
    chainId: event.chainId,
    blockNumber: event.block.number,
    blockHash: event.block.hash,
    transactionHash: event.transaction.hash,
    transactionIndex: event.transaction.transactionIndex,
    logIndex: event.logIndex,
    contract: event.srcAddress,
    eventName,
    eventJson: JSON.stringify(chainEvent),
  };
}
const fields = {
  block: ['hash'],
  transaction: ['hash', 'transactionIndex'],
} as const;
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'MandateConfigured', fields },
  async ({ event, context }) => {
    context.ChainEvent.set(row(event, 'MandateConfigured'));
  },
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'MandateRevoked', fields },
  async ({ event, context }) => {
    context.ChainEvent.set(row(event, 'MandateRevoked'));
  },
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'PauseChanged', fields },
  async ({ event, context }) => {
    context.ChainEvent.set(row(event, 'PauseChanged'));
  },
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'GrantExecuted', fields },
  async ({ event, context }) => {
    context.ChainEvent.set(row(event, 'GrantExecuted'));
  },
);
indexer.onEvent(
  { contract: 'TreasuryToken', event: 'Transfer', fields },
  async ({ event, context }) => {
    context.ChainEvent.set(row(event, 'Transfer'));
  },
);
