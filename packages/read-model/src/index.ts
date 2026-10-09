import { z } from 'zod';
import type { Address, Hex } from 'viem';

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const amount = z.string().regex(/^(0|[1-9][0-9]*)$/);
const base = z.object({
  schemaVersion: z.literal(1),
  chainId: integer.positive(),
  blockNumber: integer,
  blockHash: hash,
  transactionHash: hash,
  transactionIndex: integer,
  logIndex: integer,
  contract: address,
});
const group = { groupId: hash, account: address };
export const ChainEventSchema = z.discriminatedUnion('eventName', [
  base.extend({
    eventName: z.literal('MandateConfigured'),
    payload: z
      .object({
        ...group,
        mandateId: hash,
        version: amount,
        target: address,
        selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
        inputToken: address,
        maxPerCall: amount,
        cumulativeCap: amount,
        maxValue: amount,
        validUntil: amount,
      })
      .strict(),
  }),
  base.extend({
    eventName: z.literal('MandateRevoked'),
    payload: z.object({ ...group, mandateId: hash, version: amount }).strict(),
  }),
  base.extend({
    eventName: z.literal('PauseChanged'),
    payload: z.object({ ...group, paused: z.boolean() }).strict(),
  }),
  base.extend({
    eventName: z.literal('GrantExecuted'),
    payload: z
      .object({
        ...group,
        intentHash: hash,
        mandateId: hash,
        mandateVersion: amount,
        executor: address,
        pluginId: hash,
        chainId: amount,
        nonce: amount,
        grantHash: hash,
        target: address,
        selector: z.string().regex(/^0x[0-9a-fA-F]{8}$/),
        calldataHash: hash,
        inputToken: address,
        recipient: address,
        inputAmount: amount,
        value: amount,
        outputAmount: amount,
      })
      .strict(),
  }),
  base.extend({
    eventName: z.literal('Transfer'),
    payload: z.object({ from: address, to: address, value: amount }).strict(),
  }),
]);
export type ChainEvent = z.infer<typeof ChainEventSchema>;
export type GroupBinding = {
  groupId: Hex;
  account: Address;
  registry: Address;
  module: Address;
  members: readonly { memberId: string; signer: Address }[];
};
export type GroupState = {
  groupId: string;
  account: string;
  members: { memberId: string; signer: Address }[];
  mandates: Record<
    string,
    { version: string; active: boolean; terms: Record<string, string> }
  >;
  paused: boolean;
  treasuryBalance: string;
  executed: Record<
    string,
    {
      intentHash: string;
      mandateId: string;
      inputAmount: string;
      value: string;
      transactionHash: string;
    }
  >;
};
export type GroupSnapshot = GroupState & {
  schemaVersion: 1;
  chainId: number;
  indexedThroughBlock: number;
  observedHeadBlock: number;
  lagBlocks: number;
  generatedAt: number;
  generation: number;
};
export function eventId(event: ChainEvent): string {
  return `${event.chainId}:${event.blockHash.toLowerCase()}:${event.transactionHash.toLowerCase()}:${event.logIndex}`;
}
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_, x: unknown) =>
    typeof x === 'bigint' ? x.toString() : x,
  );
}

export class DeterministicReadModel {
  private journal = new Map<string, ChainEvent>();
  private states = new Map<string, GroupState>();
  private checkpoint = 0;
  private generation = 0;
  constructor(
    readonly chainId: number,
    readonly treasuryToken: Address,
    readonly bindings: readonly GroupBinding[],
  ) {
    if (
      new Set(bindings.map((x) => x.groupId.toLowerCase())).size !==
        bindings.length ||
      new Set(bindings.map((x) => x.account.toLowerCase())).size !==
        bindings.length
    )
      throw new Error('Duplicate group binding');
    this.project();
  }
  ingest(raw: readonly unknown[], indexedThroughBlock: number): void {
    integer.parse(indexedThroughBlock);
    if (indexedThroughBlock < this.checkpoint)
      throw new Error('Checkpoint regression requires explicit rollback');
    const next = new Map(this.journal);
    const blockHashes = new Map<number, string>();
    for (const e of [
      ...next.values(),
      ...raw.map((x) => ChainEventSchema.parse(x)),
    ]) {
      if (e.chainId !== this.chainId || e.blockNumber > indexedThroughBlock)
        throw new Error('Invalid chain/checkpoint');
      const priorHash = blockHashes.get(e.blockNumber);
      if (priorHash && priorHash !== e.blockHash.toLowerCase())
        throw new Error('Fork detected; rollback required');
      blockHashes.set(e.blockNumber, e.blockHash.toLowerCase());
      const id = eventId(e);
      const previous = next.get(id);
      if (previous && encodeJson(previous) !== encodeJson(e))
        throw new Error('Conflicting duplicate event');
      next.set(id, structuredClone(e));
    }
    const old = this.journal;
    this.journal = next;
    try {
      this.project();
    } catch (error) {
      this.journal = old;
      throw error;
    }
    this.checkpoint = indexedThroughBlock;
    this.generation++;
  }
  rollback(fromBlock: number): void {
    integer.parse(fromBlock);
    this.journal = new Map(
      [...this.journal].filter(([, e]) => e.blockNumber < fromBlock),
    );
    this.checkpoint = Math.min(this.checkpoint, Math.max(0, fromBlock - 1));
    this.project();
    this.generation++;
  }
  rebuild(events: readonly unknown[], checkpoint: number): void {
    const rebuilt = new DeterministicReadModel(
      this.chainId,
      this.treasuryToken,
      this.bindings,
    );
    rebuilt.ingest(events, checkpoint);
    this.journal = rebuilt.journal;
    this.states = rebuilt.states;
    this.checkpoint = checkpoint;
    this.generation++;
  }
  events(): ChainEvent[] {
    return structuredClone([...this.journal.values()]);
  }
  snapshot(groupId: string, headBlock: number, now: number): GroupSnapshot {
    integer.parse(headBlock);
    integer.parse(now);
    if (headBlock < this.checkpoint)
      throw new Error('Observed head behind checkpoint');
    const state = this.states.get(groupId.toLowerCase());
    if (!state) throw new Error('Unknown group');
    return structuredClone({
      ...state,
      schemaVersion: 1,
      chainId: this.chainId,
      indexedThroughBlock: this.checkpoint,
      observedHeadBlock: headBlock,
      lagBlocks: headBlock - this.checkpoint,
      generatedAt: now,
      generation: this.generation,
    });
  }
  private project(): void {
    const states = new Map(
      this.bindings.map((b) => [
        b.groupId.toLowerCase(),
        {
          groupId: b.groupId.toLowerCase(),
          account: b.account.toLowerCase(),
          members: [...b.members],
          mandates: {},
          paused: false,
          treasuryBalance: '0',
          executed: {},
        } as GroupState,
      ]),
    );
    const sorted = [...this.journal.values()].sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.transactionIndex - b.transactionIndex ||
        a.logIndex - b.logIndex,
    );
    const positions = new Set<string>();
    for (const event of sorted) {
      const position = `${event.blockNumber}:${event.logIndex}`;
      if (positions.has(position)) throw new Error('Conflicting log position');
      positions.add(position);
      if (event.eventName === 'Transfer') {
        if (event.contract.toLowerCase() !== this.treasuryToken.toLowerCase())
          throw new Error('Untrusted treasury token');
        for (const state of states.values()) {
          let balance = BigInt(state.treasuryBalance);
          if (event.payload.to.toLowerCase() === state.account)
            balance += BigInt(event.payload.value);
          if (event.payload.from.toLowerCase() === state.account)
            balance -= BigInt(event.payload.value);
          if (balance < 0n) throw new Error('Missing treasury history');
          state.treasuryBalance = balance.toString();
        }
        continue;
      }
      const p = event.payload;
      const binding = this.bindings.find(
        (b) => b.groupId.toLowerCase() === p.groupId.toLowerCase(),
      );
      const state = states.get(p.groupId.toLowerCase());
      if (!binding || !state || state.account !== p.account.toLowerCase())
        throw new Error('Unknown account/group');
      const expected =
        event.eventName === 'MandateConfigured' ||
        event.eventName === 'MandateRevoked'
          ? binding.registry
          : binding.module;
      if (expected.toLowerCase() !== event.contract.toLowerCase())
        throw new Error('Untrusted event source');
      if (event.eventName === 'MandateConfigured') {
        const p = event.payload,
          id = p.mandateId.toLowerCase(),
          old = state.mandates[id];
        if (BigInt(p.version) !== BigInt(old?.version ?? '0') + 1n)
          throw new Error('Mandate version gap/regression');
        state.mandates[id] = {
          version: p.version,
          active: true,
          terms: { ...p },
        };
      } else if (event.eventName === 'MandateRevoked') {
        const p = event.payload,
          old = state.mandates[p.mandateId.toLowerCase()];
        if (!old || old.version !== p.version)
          throw new Error('Invalid revocation version');
        old.active = false;
      } else if (event.eventName === 'PauseChanged')
        state.paused = event.payload.paused;
      else {
        const p = event.payload,
          mandate = state.mandates[p.mandateId.toLowerCase()];
        if (
          !mandate?.active ||
          mandate.version !== p.mandateVersion ||
          state.paused ||
          BigInt(p.chainId) !== BigInt(this.chainId)
        )
          throw new Error('Execution conflicts with authorization state');
        if (state.executed[p.nonce]) throw new Error('Execution nonce reused');
        state.executed[p.nonce] = {
          intentHash: p.intentHash,
          mandateId: p.mandateId,
          inputAmount: p.inputAmount,
          value: p.value,
          transactionHash: event.transactionHash,
        };
      }
    }
    this.states = states;
  }
}

export async function verifyFresh(
  snapshot: GroupSnapshot,
  head: number,
  maxLag: number,
  directVerify?: (snapshot: GroupSnapshot, head: number) => Promise<boolean>,
): Promise<'indexed' | 'direct'> {
  integer.parse(head);
  integer.parse(maxLag);
  if (head < snapshot.indexedThroughBlock)
    throw new Error('Inconsistent chain head');
  if (head - snapshot.indexedThroughBlock <= maxLag) return 'indexed';
  if (!directVerify || !(await directVerify(snapshot, head)))
    throw new Error('Stale index; financial authorization paused');
  return 'direct';
}
