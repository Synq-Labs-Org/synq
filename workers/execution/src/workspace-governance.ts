import {
  erc20Abi,
  getAddress,
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
  safeActionGrantCall,
} from '@synq/kernel/arc-safe-action';
import {
  screenSafely,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { WorkspacePayouts } from '@synq/workspaces/payouts';
import { Ledger, PostgresLedgerStore, walletTag } from '@synq/ledger';
import { bookWorkspacePayout } from './workspace-payout.js';
import { assertTreasuryAction } from './workspace-treasury.js';
import {
  WorkspaceContributions,
  memberTag,
} from '@synq/workspaces/contributions';
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
  'event CapsChanged(uint256 perPaymentCap,uint256 windowCap)',
]);
/**
 * Most native-USDC gas the operator may commit to relaying one vault action.
 * A Safe calling Circle's App Kit adapter runs a multi-step swap, so it gets a
 * larger (still bounded) ceiling than allowlist, cap and transfer actions.
 */
export const relayFeeCap = (a: { kind: string }) =>
  a.kind === 'TREASURY_EXECUTE'
    ? 150_000_000_000_000_000n
    : 50_000_000_000_000_000n;
export class WorkspaceGovernanceExecutor {
  readonly governance: WorkspaceGovernance;
  readonly outbox: PostgresOutboxStore;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly chain: ArcChain,
    private readonly signer: TransferSigner,
    private readonly authority: AuthorityConfig,
    readonly screening: WalletScreeningPort = unavailableScreening(),
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
      (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n) > relayFeeCap(p.action) ||
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
        const vendor =
          'vendorId' in a
            ? (
                await sql.query(
                  'SELECT address,change_hash,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
                  [a.workspaceId, a.vendorId],
                )
              ).rows[0]
            : null;
        if ('vendorId' in a && !vendor)
          throw new WorkspaceError('VENDOR_NOT_VERIFIED');
        await assertTreasuryAction(sql, a);
        if (a.kind === 'REFUND_MEMBER') {
          const r = (
            await sql.query(
              'SELECT * FROM synq_ws_refunds WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
              [a.refundId, a.workspaceId],
            )
          ).rows[0];
          const owed =
            (
              await new WorkspaceContributions(this.finance).equity(
                a.workspaceId,
              )
            ).get(a.principalId) ?? 0n;
          if (
            !r ||
            r.state !== 'REVIEW' ||
            r.action_id !== a.id ||
            r.principal_id !== a.principalId ||
            String(r.recipient).toLowerCase() !== a.recipient.toLowerCase() ||
            String(r.amount) !== a.amount ||
            BigInt(a.amount) > owed
          )
            throw new WorkspaceError('REFUND_ACTION_MISMATCH');
        }
        if (a.kind === 'PAY_VENDOR') {
          const refuse = async (reason: string) => {
            await sql.query(
              "UPDATE synq_ws_safe_actions SET state='FAILED',last_error=$2 WHERE id=$1",
              [id, reason],
            );
            await sql.query(
              "UPDATE synq_ws_payouts SET reason=$2 WHERE id=$1 AND state='REVIEW'",
              [a.payoutId, reason],
            );
            await sql.query('COMMIT');
            inTx = false;
            return { state: 'FAILED' as const, reason };
          };
          const payout = (
            await sql.query(
              'SELECT state,data FROM synq_ws_payouts WHERE id=$1 AND workspace_id=$2 FOR UPDATE',
              [a.payoutId, a.workspaceId],
            )
          ).rows[0];
          if (payout?.state !== 'REVIEW')
            return refuse('PAYOUT_NOT_REVIEWABLE');
          const screened = await screenSafely(this.screening, {
            address: a.vendorAddress,
            chainId: a.chainId,
            now: store.now(),
          });
          if (screened.verdict !== 'CLEAR')
            return refuse(
              screened.verdict === 'HIT'
                ? 'SCREENING_HIT'
                : 'SCREENING_UNAVAILABLE',
            );
          const balance = await this.chain.client.readContract({
            address: a.token,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [a.safe],
          });
          const reserved = await sql.query(
            "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS reserved FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED')",
            [a.workspaceId],
          );
          const budget = (
            await sql.query(
              "SELECT data->>'reserve' AS reserve FROM synq_ws_budgets WHERE workspace_id=$1",
              [a.workspaceId],
            )
          ).rows[0];
          const held = await sql.query(
            "SELECT COALESCE(sum(h.amount),0) AS held FROM synq_alloc_reservations h LEFT JOIN synq_ws_split_admissions x ON x.leg_key=h.reservation_id WHERE h.workspace_id=$1 AND h.status='ACTIVE' AND COALESCE(x.state,'')<>'CONFIRMED'",
            [a.workspaceId],
          );
          // Money held for others (refunds, escrow, unmatched receipts) is never spendable.
          const liabilities = await new Ledger(
            new PostgresLedgerStore(sql),
          ).balances(a.workspaceId, token('arc-testnet', 'USDC').assetId);
          const restricted =
            -liabilities.REFUND_LIABILITY -
            liabilities.ESCROW_LIABILITY -
            liabilities.UNAPPLIED_RECEIPTS;
          if (
            balance -
              BigInt(reserved.rows[0].reserved) -
              BigInt(held.rows[0].held) -
              restricted -
              BigInt(a.amount) <
            BigInt(budget?.reserve ?? 0)
          )
            return refuse('RESERVE_FLOOR');
        }
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
          vendor: vendor
            ? {
                address: vendor.address,
                changeHash: vendor.change_hash,
                eligibleAt: Number(vendor.eligible_at),
              }
            : null,
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
            if (cost > relayFeeCap(a))
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
          call: safeActionGrantCall(a),
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
        if (a.kind === 'PAY_VENDOR')
          await sql.query(
            "UPDATE synq_ws_payouts SET state='SIGNED',tx_hash=$2,reason=NULL WHERE id=$1 AND state='REVIEW'",
            [a.payoutId, record.hash],
          );
        if (a.kind === 'REFUND_MEMBER')
          await sql.query(
            "UPDATE synq_ws_refunds SET state='SIGNED',tx_hash=$2 WHERE id=$1 AND state='REVIEW'",
            [a.refundId, record.hash],
          );
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
        if (a.kind === 'PAY_VENDOR')
          await store.pool.query(
            "UPDATE synq_ws_payouts SET state=$2,reason=$3 WHERE id=$1 AND state='SIGNED'",
            [a.payoutId, state, outcome],
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
      if (a.kind === 'QUEUE_VENDOR' || a.kind === 'QUEUE_CAPS') {
        const expected =
          'perPaymentCap' in a
            ? safeActionCall({ ...a, kind: 'SET_CAPS' })
            : safeActionCall({ ...a, kind: 'ALLOW_VENDOR' });
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
      } else if (a.kind === 'PAY_VENDOR') {
        const paid = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Transfer',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.token.toLowerCase() &&
            getAddress(e.args.from) === getAddress(a.safe) &&
            getAddress(e.args.to) === getAddress(a.vendorAddress) &&
            e.args.value === BigInt(a.amount),
        );
        if (paid.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'vendor transfer receipt is missing',
          );
        evidence = {
          ...evidence,
          payoutId: a.payoutId,
          amount: a.amount,
          logIndex: paid[0]!.logIndex,
        };
        const payout = await new WorkspacePayouts(this.finance).record(
          a.payoutId,
        );
        if (
          !payout ||
          payout.data.recipient.toLowerCase() !==
            a.vendorAddress.toLowerCase() ||
          payout.data.amount !== a.amount
        )
          throw new ArcExecutionError('TRANSFER_MISMATCH');
        await store.transaction((tx) =>
          bookWorkspacePayout(tx, payout, {
            txHash: record!.hash,
            logIndex: paid[0]!.logIndex!,
            now: store.now(),
            grantKey: this.authority.grantKey,
          }),
        );
      } else if (a.kind === 'REFUND_MEMBER') {
        const sent = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Transfer',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.token.toLowerCase() &&
            getAddress(e.args.from) === getAddress(a.safe) &&
            getAddress(e.args.to) === getAddress(a.recipient) &&
            e.args.value === BigInt(a.amount),
        );
        if (sent.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'member refund receipt is missing',
          );
        const usdc = token('arc-testnet', 'USDC'),
          id = `refund:${a.refundId}`;
        await store.transaction(async (sql) => {
          await new Ledger(new PostgresLedgerStore(sql)).post({
            entryId: id,
            workspaceId: a.workspaceId,
            occurredAt: store.now(),
            memo: 'Group fund refund to a member',
            source: { kind: 'CHAIN_TX', ref: a.refundId },
            evidence: {
              chainId: 5042002,
              txHash: record!.hash,
              logIndex: sent[0]!.logIndex,
              recipient: getAddress(a.recipient),
            },
            idempotencyKey: id,
            reversalOf: null,
            postings: [
              {
                account: 'OWNER_EQUITY',
                assetId: usdc.assetId,
                amount: BigInt(a.amount),
                counterpartyId: memberTag(a.principalId),
              },
              {
                account: 'CASH_ARC_USDC',
                assetId: usdc.assetId,
                amount: -BigInt(a.amount),
                counterpartyId: walletTag(getAddress(a.safe)),
              },
            ],
          });
          await sql.query(
            "UPDATE synq_ws_refunds SET state='PAID',tx_hash=$2 WHERE id=$1",
            [a.refundId, record!.hash],
          );
        });
        evidence = { ...evidence, refundId: a.refundId, amount: a.amount };
      } else if (a.kind === 'TREASURY_APPROVE') {
        const ok = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Approval',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.approveToken.toLowerCase() &&
            getAddress(e.args.owner) === getAddress(a.safe) &&
            getAddress(e.args.spender) === getAddress(a.spender) &&
            e.args.value === BigInt(a.amount),
        );
        if (ok.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'treasury approval receipt is missing',
          );
        await store.pool.query(
          "UPDATE synq_ws_treasury_ops SET state='EXECUTE',updated_at=$2 WHERE id=$1 AND state='APPROVE'",
          [a.treasuryOpId, store.now()],
        );
      } else if (a.kind === 'TREASURY_EXECUTE') {
        const transfers = parseEventLogs({
          abi: erc20Abi,
          eventName: 'Transfer',
          logs: receipt.logs,
        });
        const safe = getAddress(a.safe);
        const out = transfers.filter((e) => getAddress(e.args.from) === safe);
        const spent = out
          .filter((e) => getAddress(e.address) === getAddress(a.tokenIn))
          .reduce((n, e) => n + e.args.value, 0n);
        const received = transfers
          .filter(
            (e) =>
              getAddress(e.args.to) === safe &&
              getAddress(e.address) === getAddress(a.tokenOut),
          )
          .reduce((n, e) => n + e.args.value, 0n);
        // Arc's native-USDC mirror log (0xffff…fffe) is not a second asset.
        const foreign = out.filter(
          (e) =>
            getAddress(e.address) !== getAddress(a.tokenIn) &&
            !e.address
              .toLowerCase()
              .startsWith('0xffffffffffffffffffffffffffffffffffff'),
        );
        if (
          spent === 0n ||
          spent > BigInt(a.amountIn) ||
          received < BigInt(a.minOut) ||
          foreign.length
        )
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            `treasury execution moved ${spent} in and ${received} out outside its terms`,
          );
        evidence = {
          ...evidence,
          treasuryOpId: a.treasuryOpId,
          spent: String(spent),
          received: String(received),
        };
        const assetOf = (address: string) => {
          for (const symbol of ['USDC', 'EURC'] as const) {
            const t = token('arc-testnet', symbol);
            if (getAddress(t.address) === getAddress(address)) return t;
          }
          throw new ArcExecutionError('TRANSFER_MISMATCH', 'unknown asset');
        };
        const tin = assetOf(a.tokenIn),
          tout = assetOf(a.tokenOut),
          id = `treasury-op:${a.treasuryOpId}:settled`,
          tag = walletTag(safe);
        const leg = (t: typeof tin, amount: bigint) =>
          t.symbol === 'USDC'
            ? {
                account: 'CASH_ARC_USDC' as const,
                assetId: t.assetId,
                amount,
                counterpartyId: tag,
              }
            : {
                account: 'TREASURY_HOLDINGS' as const,
                assetId: t.assetId,
                amount,
              };
        await store.transaction(async (sql) => {
          await new Ledger(new PostgresLedgerStore(sql)).post({
            entryId: id,
            workspaceId: a.workspaceId,
            occurredAt: store.now(),
            memo: `Treasury swap ${tin.symbol} to ${tout.symbol}`,
            source: { kind: 'CHAIN_TX', ref: a.treasuryOpId },
            evidence: {
              chainId: 5042002,
              txHash: record!.hash,
              logIndex: out[0]!.logIndex,
            },
            idempotencyKey: id,
            reversalOf: null,
            postings: [
              leg(tin, -spent),
              { account: 'FX_CLEARING', assetId: tin.assetId, amount: spent },
              leg(tout, received),
              {
                account: 'FX_CLEARING',
                assetId: tout.assetId,
                amount: -received,
              },
            ],
          });
          await sql.query(
            "UPDATE synq_ws_treasury_ops SET state='DONE',evidence=$2,last_error=NULL,updated_at=$3 WHERE id=$1",
            [
              a.treasuryOpId,
              {
                hash: record!.hash,
                spent: String(spent),
                received: String(received),
              },
              store.now(),
            ],
          );
        });
      } else if ('perPaymentCap' in a) {
        const set = parseEventLogs({
          abi: recipientAbi,
          eventName: 'CapsChanged',
          logs: receipt.logs,
        }).filter(
          (e) =>
            e.address.toLowerCase() === a.policy.toLowerCase() &&
            e.args.perPaymentCap === BigInt(a.perPaymentCap) &&
            e.args.windowCap === BigInt(a.windowCap),
        );
        if (set.length !== 1)
          throw new ArcExecutionError(
            'TRANSFER_MISMATCH',
            'cap change receipt is missing',
          );
        evidence = {
          ...evidence,
          perPaymentCap: a.perPaymentCap,
          windowCap: a.windowCap,
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
