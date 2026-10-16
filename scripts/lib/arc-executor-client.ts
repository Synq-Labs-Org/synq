import type { ChildProcess } from 'node:child_process';
import type { Hex } from 'viem';
import type { ExecutorMessage, ExecutorRequest } from './arc-executor-child.js';
import {
  DEV_MEMORY_FENCE_FLAG,
  devMemoryFenceRequested,
} from './executor-fence.js';
import { forkChild, nextMessage, stopChild } from './child-process-rpc.js';
import type { ExecutorPort } from './freelancer-demo.js';

/**
 * The live restricted executor: a separate process holding the vault
 * operator key. This side only forwards {grant, call} and records the
 * payout hash it reports before broadcast.
 */
export function liveExecutor(): ExecutorPort {
  let child: ChildProcess | null = null;
  let seq = 0;
  const request = async (
    m: Extract<ExecutorRequest, { type: 'pay' | 'admit' }>,
    onHash?: (h: Hex) => Promise<void>,
  ) => {
    const c = child!;
    const hashes = (msg: unknown) => {
      const x = msg as ExecutorMessage;
      if (x.type === 'hash' && x.id === m.id)
        void Promise.resolve(onHash?.(x.hash)).then(
          () => c.send({ type: 'ack', id: m.id } satisfies ExecutorRequest),
          () => c.kill(),
        );
    };
    c.on('message', hashes);
    try {
      const result = nextMessage(c, (msg) => {
        const x = msg as ExecutorMessage;
        return x.type === 'result' && x.id === m.id ? x : undefined;
      });
      c.send(m);
      return await result;
    } finally {
      c.off('message', hashes);
    }
  };
  return {
    label: 'SEPARATE_PROCESS',
    async start(grantKey) {
      // The child refuses to start without a durable grant fence unless the
      // parent itself was started with the dev-only flag.
      child = forkChild(
        './arc-executor-child.ts',
        devMemoryFenceRequested() ? [DEV_MEMORY_FENCE_FLAG] : [],
      );
      const ready = nextMessage(child, (m) => {
        const x = m as ExecutorMessage;
        return x.type === 'ready' ? x : undefined;
      });
      child.send({
        type: 'init',
        grantKey: Buffer.from(grantKey).toString('hex'),
      } satisfies ExecutorRequest);
      const r = await ready;
      return {
        operator: r.operator,
        vault: r.vault,
        policy: r.policy,
        pid: child.pid ?? null,
      };
    },
    async pay({ grant, recipient, amount, ref, onHash }) {
      const r = await request(
        {
          type: 'pay',
          id: ++seq,
          grant,
          call: { recipient, amount: String(amount), ref },
        },
        onHash,
      );
      if (!r.ok) throw new Error(r.error);
      const p = r.payout!;
      return {
        hash: p.hash,
        blockNumber: BigInt(p.blockNumber),
        explorer: p.explorer,
        logIndex: p.logIndex,
        payer: p.payer,
        gasPayer: p.gasPayer,
        feeWei: BigInt(p.feeWei),
      };
    },
    async admit({ grant, recipient, amount }) {
      const r = await request({
        type: 'admit',
        id: ++seq,
        grant,
        call: {
          recipient,
          amount: String(amount),
          ref: `0x${'00'.repeat(32)}`,
        },
      });
      return r.ok ? 'ADMITTED' : r.error;
    },
    async stop() {
      if (child) await stopChild(child);
    },
  };
}
