/**
 * Restricted Arc payout executor, run as its own OS process.
 *
 *   forked by scripts/lib/arc-executor-client.ts (never imported by the
 *   Supervisor / model process)
 *
 * It is the only process that loads the operational agent key
 * (~/.synq/arc-agent.key). Over IPC it accepts exactly two requests, each a
 * Kernel grant plus the call it should cover:
 *   - `pay`: admit the grant against the exact vault payment, simulate it,
 *     report the signed transaction's hash and wait for the parent to record
 *     it durably, then broadcast `policy.pay(recipient, amount, ref)` from
 *     the vault operator and reconcile the receipt;
 *   - `admit`: admission only (MAC, expiry, exact call, nonce). Nothing is
 *     signed.
 * The grant key arrives once at start. Keys and grants are never logged.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  encodeFunctionData,
  erc20Abi,
  parseEventLogs,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { contract, token } from '@synq/chain-registry/arc';
import pg from 'pg';
import {
  MemoryNonceFence,
  admitGrant,
  verifyGrant,
  type ExecutionGrant,
  type NonceFence,
} from '@synq/kernel/arc';
import {
  PostgresOutboxStore,
  PostgresGrantFence,
} from '@synq/execution-worker/pg-outbox';
import { executorFenceMode, type ExecutorFenceMode } from './executor-fence.js';
import { connectChain, verifyContract } from '@synq/execution-worker/arc';
import { sendCall } from '@synq/execution-worker/cctp';
import { payGrantOnce } from '@synq/execution-worker/arc-outbox';
import { vaultPayOnce } from '@synq/execution-worker/vault-outbox';
import { money } from '@synq/domain';
import { VAULT_POLICY_ABI, simulate } from '@synq/execution-worker/vault';

export type ExecutorRequest =
  | { type: 'init'; grantKey: string; payoutMode?: 'VAULT' | 'WALLET' }
  | {
      type: 'pay' | 'admit';
      id: number;
      grant: ExecutionGrant;
      call: { recipient: Address; amount: string; ref: Hex };
    }
  | { type: 'ack'; id: number };
export type ExecutorPayout = {
  hash: Hex;
  blockNumber: string;
  explorer: string;
  /** Log index of the USDC Transfer vault -> recipient. */
  logIndex: number;
  payer: Address;
  gasPayer: Address;
  feeWei: string;
};
export type ExecutorMessage =
  | { type: 'ready'; operator: Address; vault: Address; policy: Address }
  | { type: 'hash'; id: number; hash: Hex }
  | { type: 'result'; id: number; ok: true; payout?: ExecutorPayout }
  | { type: 'result'; id: number; ok: false; error: string };

const send = (m: ExecutorMessage) => process.send!(m);
// Decided before the key is read: without a durable grant fence the executor
// refuses to run unless the dev-only in-memory fence was asked for explicitly.
let fenceMode: ExecutorFenceMode;
try {
  fenceMode = executorFenceMode();
} catch (e) {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(78);
}
if (fenceMode.mode === 'DEV_MEMORY')
  process.stderr.write(`${fenceMode.warning}\n`);
const key = readFileSync(
  join(process.env.HOME!, '.synq', 'arc-agent.key'),
  'utf8',
).trim();
const agent = privateKeyToAccount(
  (key.startsWith('0x') ? key : `0x${key}`) as Hex,
);
const usdc = token('arc-testnet', 'USDC');
const policy = contract('arc-testnet', 'SYNQ_ARC_VAULT_POLICY')
  .address as Address;
const vault = contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').address as Address;
// Consumed grants are durable across executor restarts (unique grant id and nonce).
const executionPool =
  fenceMode.mode === 'POSTGRES'
    ? new pg.Pool({ connectionString: fenceMode.url, max: 2 })
    : null;
const outbox = executionPool ? new PostgresOutboxStore(executionPool) : null;
let payoutMode: 'VAULT' | 'WALLET' = 'VAULT';
const fence: NonceFence =
  fenceMode.mode === 'POSTGRES'
    ? new PostgresGrantFence(executionPool!)
    : new MemoryNonceFence();
const fenceReady =
  fence instanceof PostgresGrantFence ? fence.migrate() : Promise.resolve();
const acks = new Map<number, () => void>();
let grantKey: Uint8Array | null = null;
const chainP = connectChain('arc-testnet');

const errorText = (e: unknown) =>
  `${(e as { code?: string }).code ?? (e as Error).name ?? 'ERROR'}: ${(e as Error).message ?? e}`.slice(
    0,
    300,
  );

async function admit(
  grant: ExecutionGrant,
  call: { recipient: Address; amount: string },
) {
  if (!grantKey) throw new Error('executor not initialised');
  await fenceReady;
  await admitGrant({
    grantKey,
    grant,
    call: {
      chainId: usdc.chainId,
      token: usdc.address,
      payer: payoutMode === 'WALLET' ? agent.address : vault,
      recipient: call.recipient,
      amount: BigInt(call.amount),
    },
    now: Math.floor(Date.now() / 1000),
    mandateRevoked: false,
    fence,
  });
}

async function pay(
  id: number,
  grant: ExecutionGrant,
  call: { recipient: Address; amount: string; ref: Hex },
): Promise<ExecutorPayout> {
  const chain = await chainP;
  if (!grantKey) throw new Error('executor not initialised');
  await fenceReady;
  const at = () => Math.floor(Date.now() / 1000);
  const afterRecord = async (record: { hash: Hex }) => {
    send({ type: 'hash', id, hash: record.hash });
    await new Promise<void>((resolve) => acks.set(id, resolve));
  };
  let hash: Hex;
  if (outbox) {
    if (payoutMode === 'WALLET') {
      const result = await payGrantOnce({
        key: `team:${grant.intentId}`,
        store: outbox,
        fence,
        grant,
        grantKey,
        mandateRevoked: false,
        chain,
        signer: agent,
        transfer: {
          from: agent.address,
          to: call.recipient,
          amount: money(usdc, BigInt(call.amount)),
        },
        now: at,
        afterRecord,
      });
      hash = result.record.hash;
    } else {
      const result = await vaultPayOnce({
        key: `team:${grant.intentId}`,
        store: outbox,
        grant,
        chain,
        signer: agent,
        asset: usdc,
        call: {
          recipient: call.recipient,
          amount: BigInt(call.amount),
          ref: call.ref,
        },
        authorize: async () => {
          verifyGrant({
            grantKey: grantKey!,
            grant,
            call: {
              chainId: usdc.chainId,
              token: usdc.address,
              payer: vault,
              recipient: call.recipient,
              amount: BigInt(call.amount),
            },
            now: at(),
            mandateRevoked: false,
          });
        },
        now: at,
        afterRecord,
      });
      hash = result.record.hash;
    }
  } else {
    if (payoutMode === 'WALLET')
      throw new Error('wallet payouts require durable outbox');
    await verifyContract(chain, 'SYNQ_ARC_VAULT_POLICY');
    await admit(grant, call);
    const data = encodeFunctionData({
      abi: VAULT_POLICY_ABI,
      functionName: 'pay',
      args: [call.recipient, BigInt(call.amount), call.ref],
    });
    const sim = await simulate(chain, agent.address, policy, data);
    if (!sim.ok) throw new Error('vault pay simulation reverted');
    hash = await sendCall(chain, agent, policy, data, (h) =>
      afterRecord({ hash: h }),
    );
  }
  const r = await chain.client.getTransactionReceipt({ hash });
  const transfer = parseEventLogs({
    abi: erc20Abi,
    eventName: 'Transfer',
    logs: r.logs,
  }).find(
    (l) =>
      l.address.toLowerCase() === usdc.address.toLowerCase() &&
      l.args.from.toLowerCase() ===
        (payoutMode === 'WALLET' ? agent.address : vault).toLowerCase() &&
      l.args.to.toLowerCase() === call.recipient.toLowerCase() &&
      l.args.value === BigInt(call.amount),
  );
  if (!transfer)
    throw new Error('receipt has no exact vault -> recipient USDC transfer');
  return {
    hash,
    blockNumber: String(r.blockNumber),
    explorer: `${chain.profile.explorer}/tx/${hash}`,
    logIndex: transfer.logIndex!,
    payer: payoutMode === 'WALLET' ? agent.address : vault,
    gasPayer: agent.address,
    feeWei: String(r.gasUsed * r.effectiveGasPrice),
  };
}

process.on('message', (m: ExecutorRequest) => {
  if (m.type === 'init') {
    grantKey = Buffer.from(m.grantKey, 'hex');
    payoutMode = m.payoutMode ?? 'VAULT';
    send({ type: 'ready', operator: agent.address, vault, policy });
    return;
  }
  if (m.type === 'ack') {
    acks.get(m.id)?.();
    acks.delete(m.id);
    return;
  }
  const run =
    m.type === 'admit'
      ? admit(m.grant, m.call).then(() => undefined)
      : pay(m.id, m.grant, m.call);
  run.then(
    (payout) =>
      send({
        type: 'result',
        id: m.id,
        ok: true,
        ...(payout ? { payout } : {}),
      }),
    (e) => send({ type: 'result', id: m.id, ok: false, error: errorText(e) }),
  );
});
process.on('disconnect', () => process.exit(0));
