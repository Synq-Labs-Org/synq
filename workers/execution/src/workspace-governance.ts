import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  parseEventLogs,
  parseAbi,
  hashTypedData,
  type TransactionSerialized,
} from 'viem';
import { contract, token, chainProfile } from '@synq/chain-registry/arc';
import { money } from '@synq/domain';
import {
  decideWorkspaceSafeAction,
  admitGrant,
  verifyGrant,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  safeActionTypedData,
  safeActionExecution,
  safeActionCall,
} from '@synq/kernel/arc-safe-action';
import { WorkspaceError } from '@synq/workspaces';
import {
  WorkspaceGovernance,
  type SafeActionRecord,
} from '@synq/workspaces/governance';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import {
  ArcExecutionError,
  verifyCode,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import { PostgresOutboxStore } from './pg-outbox.js';
import type { OutboxRecord } from './arc-outbox.js';
import { signCall, settleSignedCall } from './cctp.js';
import { SAFE_ABI, VAULT_POLICY_ABI, simulate } from './vault.js';
const recipientAbi = parseAbi([
  'event RecipientSet(address indexed recipient,bool allowed)',
]);
export class WorkspaceGovernanceExecutor {
  readonly governance: WorkspaceGovernance;
  readonly outbox: PostgresOutboxStore;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly chain: ArcChain,
    private readonly signer: TransferSigner,
    private readonly authority: AuthorityConfig,
  ) {
    this.governance = new WorkspaceGovernance(finance);
    this.outbox = new PostgresOutboxStore(finance.workspaces.pool);
  }
  private async assertRecord(r: OutboxRecord, p: SafeActionRecord) {
    const tx = parseTransaction(r.raw),
      call = safeActionExecution(p.action, p.signatures);
    if (
      r.key !== `workspace-action:${p.action.id}` ||
      r.hash !== keccak256(r.raw) ||
      tx.chainId !== chainProfile('arc-testnet').chainId ||
      tx.to?.toLowerCase() !== p.action.safe.toLowerCase() ||
      tx.data !== call.data ||
      (tx.value ?? 0n) !== 0n ||
      tx.nonce !== r.prepared.nonce ||
      (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > 50_000_000_000_000_000n ||
      (
        await recoverTransactionAddress({
          serializedTransaction: r.raw as TransactionSerialized,
        })
      ).toLowerCase() !== this.signer.address.toLowerCase()
    )
      throw new ArcExecutionError('TX_MISMATCH');
  }
  async execute(id: string, afterRecord?: () => Promise<void>) {
    const store = this.finance.workspaces,
      sql = await store.pool.connect(),
      lock = `workspace-vault-sender:${this.signer.address.toLowerCase()}`;
    let inTx = false;
    try {
      await sql.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        lock,
      ]);
      if (
        this.chain.profile.name !== 'arc-testnet' ||
        !this.chain.profile.mutationEnabled ||
        (await this.chain.client.getChainId()) !==
          chainProfile('arc-testnet').chainId
      )
        throw new ArcExecutionError('WRONG_CHAIN');
      const p = await this.governance.record(id);
      if (!p) throw new WorkspaceError('ACTION_NOT_FOUND', 404);
      const a = p.action,
        key = `workspace-action:${id}`;
      let record = await this.outbox.get(key);
      if (!record) {
        if (p.state !== 'READY') throw new WorkspaceError('ACTION_NOT_READY');
        await sql.query('BEGIN');
        inTx = true;
        await sql.query(
          'SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE',
          [a.workspaceId],
        );
        const custody = await this.finance.authority(a.workspaceId);
        if (a.expiresAt <= store.now() || BigInt(a.nonce) !== custody.nonce) {
          const reason =
            a.expiresAt <= store.now()
              ? 'ACTION_EXPIRED'
              : 'SAFE_NONCE_CHANGED';
          await sql.query(
            "UPDATE synq_ws_safe_actions SET state='FAILED',last_error=$2 WHERE id=$1",
            [id, reason],
          );
          await sql.query('COMMIT');
          inTx = false;
          return { state: 'FAILED', reason };
        }
        const v = await sql.query(
          'SELECT address,change_hash,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
          [a.workspaceId, a.vendorId],
        );
        if (!v.rows[0]) throw new WorkspaceError('VENDOR_NOT_VERIFIED');
        const call = safeActionExecution(a, p.signatures);
        const sim = await simulate(
          this.chain,
          this.signer.address,
          a.safe,
          call.data,
        );
        const decision = await decideWorkspaceSafeAction({
          config: this.authority,
          action: a,
          signatures: p.signatures,
          custody: {
            safe: custody.vault,
            policy: custody.policy,
            owners: custody.owners,
            threshold: custody.threshold,
            nonce: custody.nonce,
          },
          vendor: {
            address: v.rows[0].address,
            changeHash: v.rows[0].change_hash,
            eligibleAt: Number(v.rows[0].eligible_at),
          },
          simulationOk: sim.ok,
          now: store.now(),
        });
        if (decision.outcome !== 'ALLOW')
          throw new WorkspaceError('KERNEL_ACTION_DENIED', 403);
        const codeHash = await verifyCode(
          this.chain,
          a.safe,
          contract('arc-testnet', 'SYNQ_ARC_VAULT_SAFE').codeHash,
        );
        const checkedSigner: TransferSigner = {
          address: this.signer.address,
          signTransaction: async (tx) => {
            const cost = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n);
            if (cost > 50_000_000_000_000_000n)
              throw new ArcExecutionError('FEE_ABOVE_CAP');
            if (
              (await this.chain.client.getBalance({
                address: this.signer.address,
              })) < cost
            )
              throw new ArcExecutionError('INSUFFICIENT_GAS');
            const raw = await this.signer.signTransaction(tx),
              parsed = parseTransaction(raw);
            if (
              parsed.chainId !== tx.chainId ||
              parsed.to?.toLowerCase() !== tx.to?.toLowerCase() ||
              parsed.data !== tx.data ||
              (parsed.value ?? 0n) !== (tx.value ?? 0n) ||
              parsed.nonce !== tx.nonce ||
              parsed.gas !== tx.gas ||
              parsed.maxFeePerGas !== tx.maxFeePerGas ||
              parsed.maxPriorityFeePerGas !== tx.maxPriorityFeePerGas
            )
              throw new ArcExecutionError('TX_MISMATCH');
            return raw;
          },
        };
        const check = {
          grant: decision.grant,
          grantKey: this.authority.grantKey,
          call: {
            chainId: a.chainId,
            token: a.token,
            payer: a.safe,
            recipient: a.policy,
            amount: 0n,
          },
          executionCall: call,
          now: store.now(),
          mandateRevoked: false,
        };
        verifyGrant(check);
        const signed = await signCall(
            this.chain,
            checkedSigner,
            a.safe,
            call.data,
          ),
          tx = parseTransaction(signed.raw);
        record = {
          key,
          state: 'SIGNED',
          raw: signed.raw,
          hash: signed.hash,
          evidence: null,
          note: `workspace-action:${a.kind}`,
          updatedAt: store.now(),
          prepared: {
            chain: 'arc-testnet',
            chainId: a.chainId,
            from: this.signer.address,
            to: a.safe,
            token: a.safe,
            amount: money(token('arc-testnet', 'USDC'), 0n),
            data: call.data,
            gas: tx.gas!,
            maxFeePerGas: tx.maxFeePerGas!,
            maxPriorityFeePerGas: tx.maxPriorityFeePerGas!,
            maxGasCostWei: tx.gas! * tx.maxFeePerGas!,
            nonce: signed.nonce,
            codeHash,
          },
        };
        await this.assertRecord(record, p);
        const created = await this.outbox.createAdmittingGrant(
          record,
          decision.grant,
          (fence) => admitGrant({ ...check, now: store.now(), fence }),
        );
        if (created === 'KEY_EXISTS') {
          record = await this.outbox.get(key);
          if (!record) throw new ArcExecutionError('TX_MISMATCH');
          await this.assertRecord(record, p);
        }
        await sql.query('COMMIT');
        inTx = false;
        await afterRecord?.();
      }
      await this.assertRecord(record, p);
      if (record.state === 'FAILED' || record.state === 'NEEDS_REVIEW')
        return { state: record.state };
      const outcome = await settleSignedCall(this.chain, {
        chainId: a.chainId,
        from: this.signer.address,
        to: a.safe,
        nonce: record.prepared.nonce,
        raw: record.raw,
        hash: record.hash,
      });
      if (outcome !== 'SUCCESS') {
        const state = outcome === 'REVERTED' ? 'FAILED' : 'NEEDS_REVIEW';
        await this.outbox.update({
          ...record,
          state,
          note: outcome,
          updatedAt: store.now(),
        });
        await store.pool.query(
          'UPDATE synq_ws_safe_actions SET state=$2,last_error=$3 WHERE id=$1',
          [id, state, outcome],
        );
        return { state };
      }
      const receipt = await this.chain.client.getTransactionReceipt({
        hash: record.hash,
      });
      const success = parseEventLogs({
        abi: SAFE_ABI,
        eventName: 'ExecutionSuccess',
        logs: receipt.logs,
      }).filter(
        (e) =>
          e.address.toLowerCase() === a.safe.toLowerCase() &&
          e.args.txHash === hashTypedData(safeActionTypedData(a)),
      );
      if (success.length !== 1)
        throw new ArcExecutionError(
          'TRANSFER_MISMATCH',
          'Safe execution receipt is missing',
        );
      let evidence: Record<string, unknown> = {
        hash: record.hash,
        kind: a.kind,
        blockNumber: String(receipt.blockNumber),
      };
      if (a.kind === 'QUEUE_VENDOR') {
        const expected = safeActionCall({ ...a, kind: 'ALLOW_VENDOR' });
        const queued = parseEventLogs({
          abi: VAULT_POLICY_ABI,
          eventName: 'OperationQueued',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.policy.toLowerCase() &&
            e.args.to.toLowerCase() === a.policy.toLowerCase() &&
            e.args.value === 0n &&
            e.args.operation === 0 &&
            e.args.data === expected.data,
        );
        if (queued.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'governance queue receipt is missing',
          );
        evidence = {
          ...evidence,
          readyAt: String(queued[0]!.args.eta),
          operationId: queued[0]!.args.id,
        };
      } else {
        const set = parseEventLogs({
          abi: recipientAbi,
          eventName: 'RecipientSet',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.policy.toLowerCase() &&
            e.args.recipient.toLowerCase() === a.vendorAddress.toLowerCase() &&
            e.args.allowed === (a.kind === 'ALLOW_VENDOR'),
        );
        if (set.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'recipient change receipt is missing',
          );
      }
      await store.pool.query(
        "UPDATE synq_ws_safe_actions SET state='CONFIRMED',evidence=$2,last_error=NULL WHERE id=$1",
        [id, evidence],
      );
      if (record.state === 'SIGNED')
        await this.outbox.update({
          ...record,
          state: 'CONFIRMED',
          updatedAt: store.now(),
        });
      return { state: 'CONFIRMED', evidence };
    } catch (error) {
      if (inTx) await sql.query('ROLLBACK');
      throw error;
    } finally {
      let broken = false;
      try {
        await sql.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          lock,
        ]);
      } catch {
        broken = true;
      }
      sql.release(broken);
    }
  }
}
