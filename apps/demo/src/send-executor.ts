import type { Hex } from 'viem';
import type { ExecutionGrant } from '@synq/schemas';
import type { SendRecord } from '@synq/funding';
import type { SendProposal } from '@synq/api/send-routes';

export type SendExecution = {
  transactionHash: Hex;
  blockNumber: bigint;
  submittedAt: number;
  confirmedAt: number;
  recipientBalanceBefore: bigint;
  recipientBalanceAfter: bigint;
};

export type SendExecutorDeps = {
  sends: { inState(state: SendRecord['state']): Promise<SendRecord[]> };
  /** Verified approvals from the identity ledger only. */
  quorumSatisfied(draftDigest: string): Promise<boolean>;
  /** Admin calls into the Send API (authorize, execution report, reconcile). */
  admin: { post<T>(path: string, body: unknown): Promise<T> };
  execute(input: {
    sendId: string;
    grant: ExecutionGrant;
    proposal: SendProposal;
    recipient: `0x${string}`;
  }): Promise<SendExecution>;
  catchUp(block?: bigint): Promise<void>;
  explorer(hash: Hex): string;
  log(message: string): void;
};

/**
 * The process that turns an owner-approved Send into a Monad transaction and
 * reports it back: authorize (Kernel re-check with verified approvals) →
 * grant-bound execution → /execution → /reconcile once indexed.
 */
export class SendExecutor {
  private readonly attempted = new Set<string>();
  constructor(private readonly deps: SendExecutorDeps) {}

  async tick(): Promise<{ executed: string[]; reconciled: string[] }> {
    const executed: string[] = [];
    const reconciled: string[] = [];
    const ready = [
      ...(await this.deps.sends.inState('PENDING_APPROVAL')),
      ...(await this.deps.sends.inState('AUTHORIZED')),
    ];
    for (const r of ready) {
      if (this.attempted.has(r.sendId)) continue;
      if (
        r.state === 'PENDING_APPROVAL' &&
        (!r.draftDigest || !(await this.deps.quorumSatisfied(r.draftDigest)))
      )
        continue;
      const outcome = await this.deps.admin.post<{
        record: SendRecord;
        grant: ExecutionGrant | null;
      }>(`/v1/send/${r.sendId}/authorize`, {});
      if (!outcome.grant || !outcome.record.proposal) {
        this.deps.log(
          `send ${r.sendId} not authorized: ${outcome.record.state} ${outcome.record.kernelCode ?? ''}`,
        );
        continue;
      }
      this.attempted.add(r.sendId);
      try {
        const done = await this.deps.execute({
          sendId: r.sendId,
          grant: outcome.grant,
          proposal: outcome.record.proposal as SendProposal,
          recipient: outcome.record.preview.recipient.address,
        });
        await this.deps.admin.post(`/v1/send/${r.sendId}/execution`, {
          transactionHash: done.transactionHash,
          blockNumber: String(done.blockNumber),
          submittedAt: done.submittedAt,
          confirmedAt: done.confirmedAt,
          recipientBalanceBefore: String(done.recipientBalanceBefore),
          recipientBalanceAfter: String(done.recipientBalanceAfter),
          explorer: this.deps.explorer(done.transactionHash),
        });
        executed.push(r.sendId);
        this.deps.log(`send ${r.sendId} executed ${done.transactionHash}`);
      } catch (error) {
        this.deps.log(
          `send ${r.sendId} execution needs reconciliation: ${String(error).slice(0, 200)}`,
        );
      }
    }
    const confirmed = await this.deps.sends.inState('CONFIRMED');
    if (confirmed.length) {
      await this.deps.catchUp();
      for (const r of confirmed) {
        const after = await this.deps.admin.post<SendRecord>(
          `/v1/send/${r.sendId}/reconcile`,
          {},
        );
        if (after.state === 'INDEXED') reconciled.push(r.sendId);
      }
    }
    return { executed, reconciled };
  }
}
