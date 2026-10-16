import { expect } from 'vitest';
import {
  encodeFunctionData,
  erc20Abi,
  keccak256,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { connectChain } from '@synq/execution-worker/arc';
import { MILESTONE_ESCROW_ABI } from '@synq/execution-worker/vault';
import {
  sendEscrowCall,
  type EscrowBroadcastJournal,
  type EscrowStep,
} from '@synq/execution-worker/escrow';
import { AGENT_JOBS_ABI } from '@synq/execution-worker/agent-stack';
import { contract } from '@synq/chain-registry/arc';
import {
  GroupFundService,
  contributionRef,
  transferKey,
  type FundStore,
} from '@synq/treasury';
import {
  NOW,
  accountFor,
  charterFor,
  expectCode,
  transfer,
  usdc,
} from '../group-funds/helpers.js';
import { USDC, callChain, countingSigner } from './crash-fixtures.js';

const ESCROW = contract('arc-testnet', 'SYNQ_MILESTONE_ESCROW').address;
const JOBS = contract('arc-testnet', 'ERC8183_AGENTIC_COMMERCE').address;

/**
 * Group-fund refund: authorized, execution started (persisted before the
 * pool signer moves money), then the process dies. A fresh service over the
 * same store must neither re-admit the execution, nor authorize a second
 * refund of the same claim, and must credit exactly one on-chain refund.
 */
export async function groupFundRefundCrash(
  store: () => FundStore,
  fundId: string,
) {
  const ana = accountFor(`${fundId}:ana`);
  const ben = accountFor(`${fundId}:ben`);
  const pool = accountFor(`${fundId}:pool`).address;
  const members = [
    { memberId: 'ana', account: ana },
    { memberId: 'ben', account: ben },
  ];
  const svc = new GroupFundService(store());
  await svc.open(charterFor({ fundId, members, pool }), NOW);
  for (const [id, acct, amount] of [
    ['ana', ana, usdc(7)],
    ['ben', ben, usdc(5)],
  ] as const) {
    const t = transfer({
      from: acct.address,
      to: pool,
      amount,
      ref: contributionRef(fundId, id),
    });
    await svc.run(fundId, (f) => f.observeDeposit(t, NOW));
    await svc.run(fundId, (f) => f.finalizeDeposit(transferKey(t), 500n, NOW));
  }
  await svc.run(fundId, (f) =>
    f.requestRefund(
      { refundId: 'rf_ana', memberId: 'ana', reason: 'changed plans' },
      NOW + 10,
    ),
  );
  await svc.run(fundId, (f) => f.beginRefundExecution('rf_ana', NOW + 11));
  // ---- crash: the executing process is gone; a new one loads the log.
  const restarted = new GroupFundService(store());
  const after = await restarted.load(fundId);
  expect(after.refunds.get('rf_ana')!.status).toBe('EXECUTING');
  expect(after.refundInstruction('rf_ana')).toEqual({
    to: ana.address,
    amount: usdc(7),
  });
  // The ambiguous execution is never re-admitted and the claim is reserved.
  await expectCode(
    restarted.run(fundId, (f) => f.beginRefundExecution('rf_ana', NOW + 20)),
    'REFUND_STATE',
  );
  await expectCode(
    restarted.run(fundId, (f) =>
      f.requestRefund(
        { refundId: 'rf_ana_again', memberId: 'ana', reason: 'retry' },
        NOW + 20,
      ),
    ),
    'REFUND_NOT_ALLOWED',
  );
  // Two recovering processes racing to start: the store admits one writer.
  const racers = await Promise.allSettled([
    new GroupFundService(store()).run(fundId, (f) =>
      f.requestRefund(
        { refundId: 'rf_ben_1', memberId: 'ben', reason: 'race' },
        NOW + 30,
      ),
    ),
    new GroupFundService(store()).run(fundId, (f) =>
      f.requestRefund(
        { refundId: 'rf_ben_2', memberId: 'ben', reason: 'race' },
        NOW + 30,
      ),
    ),
  ]);
  const won = racers.filter((r) => r.status === 'fulfilled').length;
  expect(won).toBe(1);
  // The loser either lost the append race (CONFLICT) or loaded after the
  // winner committed and found the claim already reserved.
  for (const r of racers)
    if (r.status === 'rejected')
      expect(['CONFLICT', 'REFUND_NOT_ALLOWED']).toContain(
        (r.reason as { code?: string }).code,
      );
  // Reconcile the one on-chain refund that the dead process sent.
  const paid = transfer({ from: pool, to: ana.address, amount: usdc(7) });
  await restarted.run(fundId, (f) =>
    f.recordRefundExecution('rf_ana', paid, NOW + 40),
  );
  // Replaying the same observation is a no-op; a second transfer is refused.
  const again = await restarted.run(fundId, (f) =>
    f.recordRefundExecution('rf_ana', paid, NOW + 41),
  );
  await expectCode(
    restarted.run(fundId, (f) =>
      f.recordRefundExecution(
        'rf_ana',
        transfer({ from: pool, to: ana.address, amount: usdc(7) }),
        NOW + 42,
      ),
    ),
    'REFUND_STATE',
  );
  const v = again.view();
  expect(again.refunds.get('rf_ana')!.status).toBe('EXECUTED');
  expect(v.refunded).toBe(usdc(7));
  expect(v.spent).toBe(0n);
  // Conservation: custody (12 in − 7 refunded) is fully explained by the
  // unreserved claims plus Ben's single authorized, unexecuted refund.
  expect(v.custody).toBe(usdc(12) - usdc(7));
  expect(v.refundInFlight).toBe(usdc(5));
  expect(v.free + v.refundableUnbound + v.refundInFlight + v.committed).toBe(
    v.custody,
  );
}

/** Exact calldata for each shared signed-call step under test. */
export function stepData(
  step: EscrowStep,
  to: Address,
): { to: Address; data: Hex } {
  switch (step) {
    case 'APPROVE':
    case 'JOB_APPROVE':
      return {
        to: USDC.address,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [to, 30_000n],
        }),
      };
    case 'OPEN':
      return {
        to: ESCROW,
        data: encodeFunctionData({
          abi: MILESTONE_ESCROW_ABI,
          functionName: 'open',
          args: [
            accountFor('payee').address,
            accountFor('arbiter').address,
            BigInt(NOW + 86_400),
            keccak256(toHex('terms')),
            [10_000n, 20_000n],
          ],
        }),
      };
    case 'RELEASE':
    case 'REFUND':
      return {
        to: ESCROW,
        data: encodeFunctionData({
          abi: MILESTONE_ESCROW_ABI,
          functionName: step === 'RELEASE' ? 'release' : 'refund',
          args: [7n, 0n],
        }),
      };
    case 'JOB_FUND':
      return {
        to: JOBS,
        data: encodeFunctionData({
          abi: AGENT_JOBS_ABI,
          functionName: 'fund',
          args: [3n, '0x'],
        }),
      };
    case 'JOB_COMPLETE':
      return {
        to: JOBS,
        data: encodeFunctionData({
          abi: AGENT_JOBS_ABI,
          functionName: 'complete',
          args: [3n, keccak256(toHex('accepted')), '0x'],
        }),
      };
    default:
      throw new Error(`no fixture calldata for ${step}`);
  }
}

/**
 * A multi-step signed-call workflow (deal funding: APPROVE→OPEN; agent job
 * funding: JOB_APPROVE→JOB_FUND; single steps RELEASE/REFUND/JOB_COMPLETE)
 * crashes at each boundary and is resumed by a fresh process:
 *  1. after step k's signed bytes are durable, before its broadcast marker;
 *  2. after step k is broadcast, while waiting for its receipt.
 * Every step is signed exactly once and included exactly once.
 */
export async function signedStepsCrash(input: {
  steps: readonly EscrowStep[];
  grantId: string;
  /** Durable journal as seen by a fresh process. */
  journal: () => EscrowBroadcastJournal;
  /** Same durable journal, but `record` throws (crash after signed bytes). */
  crashing: () => EscrowBroadcastJournal;
}) {
  const acct = privateKeyToAccount(keccak256(toHex(`crash:${input.grantId}`)));
  const fake = callChain();
  const chain = await connectChain('arc-testnet', undefined, fake.client);
  const signer = countingSigner(acct);
  const send = (step: EscrowStep, journal: EscrowBroadcastJournal) => {
    const c = stepData(step, step === 'JOB_APPROVE' ? JOBS : ESCROW);
    return sendEscrowCall(chain, signer, `crash ${step}`, c.to, c.data, {
      journal,
      grantId: input.grantId,
      step,
    });
  };
  const hashes: Hex[] = [];
  for (const [k, step] of input.steps.entries()) {
    // Crash 1: signed and durable, never broadcast.
    await expect(send(step, input.crashing())).rejects.toThrow(/crash/);
    expect(fake.mined.size).toBe(k);
    // Crash 2: a fresh process broadcasts, then dies waiting for the receipt.
    fake.fail.wait = 1;
    await expect(send(step, input.journal())).rejects.toThrow(/worker died/);
    expect(fake.mined.size).toBe(k + 1);
    // Recovery: settles from the receipt by hash; nothing is re-signed.
    const r = await send(step, input.journal());
    hashes.push(r.tx.hash);
    // A later resume of the whole workflow replays every earlier step as a
    // read: same hashes, no new signature, no new inclusion.
    for (const [j, earlier] of input.steps.slice(0, k + 1).entries())
      expect((await send(earlier, input.journal())).tx.hash).toBe(hashes[j]);
  }
  expect(signer.count).toBe(input.steps.length);
  expect(fake.mined.size).toBe(input.steps.length);
  expect(fake.distinct()).toBe(input.steps.length);
  // The calls that landed are exactly the approved calldata, in order.
  expect([...fake.mined.values()].map((m) => m.data)).toEqual(
    input.steps.map(
      (s) => stepData(s, s === 'JOB_APPROVE' ? JOBS : ESCROW).data,
    ),
  );
}
