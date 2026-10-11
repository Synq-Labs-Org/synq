import { expect, it } from 'vitest';
import type { SendRecord } from '@synq/funding';
import { SendExecutor } from '../../apps/demo/src/send-executor.js';

const H = (b: string) => `0x${b.repeat(32)}` as `0x${string}`;
const record = (sendId: string, state: SendRecord['state']): SendRecord =>
  ({
    sendId,
    state,
    draftDigest: H('dd'),
    kernelCode: null,
    proposal: { intent: {}, data: '0x' },
    preview: { recipient: { address: `0x${'c'.repeat(40)}` } },
    receipt: state === 'CONFIRMED' ? { blockNumber: '5' } : null,
  }) as unknown as SendRecord;

it('executes only quorum-satisfied Sends once, reports execution, then reconciles', async () => {
  const states = new Map<string, SendRecord['state']>([
    [H('01'), 'PENDING_APPROVAL'],
    [H('02'), 'PENDING_APPROVAL'],
  ]);
  const satisfied = new Set<string>();
  const posts: string[] = [];
  let executions = 0;
  const executor = new SendExecutor({
    sends: {
      inState: async (s) =>
        [...states].filter(([, v]) => v === s).map(([id]) => record(id, s)),
    },
    quorumSatisfied: async () => satisfied.has('yes'),
    admin: {
      post: async <T>(path: string) => {
        posts.push(path);
        const id = path.split('/')[3]!;
        if (path.endsWith('/authorize'))
          return {
            record: { ...record(id, 'AUTHORIZED') },
            grant: { grantId: id },
          } as T;
        if (path.endsWith('/execution')) {
          states.set(id, 'CONFIRMED');
          return {} as T;
        }
        states.set(id, 'INDEXED');
        return { state: 'INDEXED' } as T;
      },
    },
    execute: async () => {
      executions++;
      return {
        transactionHash: H('ee'),
        blockNumber: 5n,
        submittedAt: 1,
        confirmedAt: 2,
        recipientBalanceBefore: 0n,
        recipientBalanceAfter: 1n,
      };
    },
    catchUp: async () => undefined,
    explorer: (h) => `https://x/${h}`,
    log: () => undefined,
  });
  expect(await executor.tick()).toEqual({ executed: [], reconciled: [] });
  expect(posts).toEqual([]);
  satisfied.add('yes');
  const first = await executor.tick();
  expect(first.executed.sort()).toEqual([H('01'), H('02')]);
  expect(first.reconciled.sort()).toEqual([H('01'), H('02')]);
  expect(executions).toBe(2);
  states.set(H('01'), 'AUTHORIZED');
  await executor.tick();
  expect(executions).toBe(2);
});
