import { indexer, type ChainEvent, type EvmOnEventContext } from 'envio';
import { canonicalEventPayload, treasuryAssets } from './normalize.js';

type Event = {
  chainId: number;
  block: { number: number; hash: string };
  transaction: { hash: string; transactionIndex: number };
  logIndex: number;
  srcAddress: string;
  params: object;
};

const assets = treasuryAssets(process.env.SYNQ_TREASURY_ASSETS);

function row(event: Event, eventName: string): ChainEvent {
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
    payload: canonicalEventPayload(event.params),
  };
  return {
    id: `${event.chainId}:${event.transaction.hash.toLowerCase()}:${event.logIndex}`,
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
const store =
  (eventName: string) =>
  async ({ event, context }: { event: Event; context: EvmOnEventContext }) => {
    context.ChainEvent.set(row(event, eventName));
  };
const fields = {
  block: ['hash'],
  transaction: ['hash', 'transactionIndex'],
} as const;

indexer.contractRegister(
  { contract: 'SynqGroupFactory', event: 'GroupCreated' },
  async ({ event, context }) => {
    context.chain.GroupSafe.add(event.params.account);
    context.chain.TreasuryAccount.add(event.params.account);
  },
);
indexer.onEvent(
  { contract: 'SynqGroupFactory', event: 'GroupCreated', fields },
  store('GroupCreated'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'GroupBound', fields },
  store('GroupBound'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'GroupModuleChanged', fields },
  store('GroupModuleChanged'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'MandateConfigured', fields },
  store('MandateConfigured'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'MandateSuperseded', fields },
  store('MandateSuperseded'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'MandateRevoked', fields },
  store('MandateRevoked'),
);
indexer.onEvent(
  { contract: 'MandateRegistry', event: 'SpendRecorded', fields },
  store('SpendRecorded'),
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'ExecutorSet', fields },
  store('ExecutorSet'),
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'Paused', fields },
  store('Paused'),
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'Unpaused', fields },
  store('Unpaused'),
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'NonceCancelled', fields },
  store('NonceCancelled'),
);
indexer.onEvent(
  { contract: 'ExecutionModule', event: 'GrantExecuted', fields },
  store('GrantExecuted'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'SafeSetup', fields },
  store('SafeSetup'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'AddedOwner', fields },
  store('AddedOwner'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'RemovedOwner', fields },
  store('RemovedOwner'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'ChangedThreshold', fields },
  store('ChangedThreshold'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'EnabledModule', fields },
  store('EnabledModule'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'DisabledModule', fields },
  store('DisabledModule'),
);
indexer.onEvent(
  { contract: 'GroupSafe', event: 'ChangedGuard', fields },
  store('ChangedGuard'),
);
indexer.onEvent(
  {
    contract: 'TreasuryAccount',
    event: 'Transfer',
    wildcard: true,
    fields,
    where: ({ chain }) => ({
      params: [
        { from: chain.TreasuryAccount.addresses },
        { to: chain.TreasuryAccount.addresses },
      ],
    }),
  },
  async ({ event, context }) => {
    if (!assets.has(event.srcAddress.toLowerCase())) return;
    context.ChainEvent.set(row(event, 'Transfer'));
  },
);
