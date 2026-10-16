import {
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import {
  token,
  tokenEntry,
  contract,
  chainProfile,
} from '@synq/chain-registry/arc';
import { Ledger, PostgresLedgerStore, viemIndexerChain } from '@synq/ledger';
import {
  PostgresInvoiceStore,
  extractMemoPayments,
  amountDue,
} from '@synq/invoices';
import {
  SplitRunner,
  PostgresSplitStore,
  mandateFromPolicy,
  policyHash,
  type FinalReceipt,
  type LegCall,
  type LegExecutor,
  type TreasuryBooks,
  type SignedRevenuePolicy,
} from '@synq/allocations';
import { executionCallHash, type AuthorityConfig } from '@synq/kernel/arc';
import { PostgresObligationFence } from '@synq/agent-runtime/finance-stores';
import {
  RiskCaseService,
  screenSafely,
  screeningFlags,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { PostgresRiskCaseStore, migrateRisk } from '@synq/plugin-risk/postgres';
import type { SqlPool } from '@synq/domain/pg';
import { WorkspaceError } from '@synq/workspaces';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspaceRevenue } from '@synq/workspaces/revenue';
import { RevenuePolicyWireSchema } from '@synq/workspaces/revenue-contracts';
import {
  ArcExecutionError,
  verifyCode,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import { PostgresOutboxStore, PostgresGrantFence } from './pg-outbox.js';
import { vaultPayData, type VaultBinding } from './vault-outbox.js';
import { vaultLegExecutor } from './split-executor.js';
import { boundedWorkspaceSigner } from './workspace-signing.js';

/** Models never receive this object, signer or authority key. */
export class WorkspaceSplitWorker {
  readonly revenue: WorkspaceRevenue;
  readonly store: PostgresSplitStore;
  readonly outbox: PostgresOutboxStore;
  readonly risk: RiskCaseService;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly chain: ArcChain,
    private readonly signer: TransferSigner,
    private readonly authority: AuthorityConfig,
    readonly screening: WalletScreeningPort = unavailableScreening(),
    readonly obligationBooks?: (
      workspaceId: string,
    ) => Pick<
      TreasuryBooks,
      'payables' | 'payableHistory' | 'obligations' | 'bills'
    >,
  ) {
    this.revenue = new WorkspaceRevenue(finance);
    this.risk = new RiskCaseService(
      new PostgresRiskCaseStore(finance.workspaces.pool),
      finance.workspaces.now,
      authority.grantKey,
    );
    this.store = new PostgresSplitStore(finance.workspaces.pool);
    this.outbox = new PostgresOutboxStore(finance.workspaces.pool);
  }
  async migrate() {
    await this.finance.migrate();
    await this.store.migrate();
    await this.outbox.migrate();
    await migrateRisk(this.finance.workspaces.pool);
  }
  private async signed(
    workspaceId: string,
    receiptId: string,
  ): Promise<SignedRevenuePolicy | null> {
    const existing = await this.store.byReceipt(receiptId);
    if (!existing)
      return (await this.revenue.active(workspaceId))?.signed ?? null;
    const row = (
      await this.finance.workspaces.pool.query(
        'SELECT data,signatures FROM synq_ws_revenue_policies WHERE workspace_id=$1 AND version=$2',
        [workspaceId, existing.policyVersion],
      )
    ).rows[0];
    if (!row) throw new WorkspaceError('REVENUE_POLICY_NOT_FOUND');
    const policy = RevenuePolicyWireSchema.parse(row.data),
      primary = row.signatures[policy.owner.toLowerCase()];
    if (!primary) throw new WorkspaceError('REVENUE_SIGNATURE_MISSING');
    return {
      policy,
      policySignature: primary.policy,
      mandate: mandateFromPolicy(policy),
      mandateSignature: primary.mandate,
    };
  }
  private async proof(r: FinalReceipt): Promise<FinalReceipt> {
    const row = (
      await this.finance.workspaces.pool.query(
        'SELECT data,state,invoice_id FROM synq_ws_receipts WHERE key=$1',
        [r.receiptId],
      )
    ).rows[0];
    if (
      !row ||
      row.state !== 'PENDING_POLICY' ||
      row.invoice_id !== r.invoiceId
    )
      throw new WorkspaceError('RECEIPT_REVIEW_REQUIRED');
    const usdc = token('arc-testnet', 'USDC'),
      memo = contract('arc-testnet', 'MEMO');
    await verifyCode(this.chain, usdc.address, tokenEntry(usdc).codeHash);
    await verifyCode(this.chain, memo.address, memo.codeHash);
    const finalized = await this.chain.client.getBlock({
      blockTag: 'finalized',
    });
    const receipt = await this.chain.client.getTransactionReceipt({
      hash: r.txHash,
    });
    const canonical = await this.chain.client.getBlock({
      blockNumber: r.blockNumber,
    });
    if (
      finalized.number === null ||
      r.blockNumber > finalized.number ||
      receipt.status !== 'success' ||
      receipt.blockHash !== canonical.hash ||
      receipt.blockHash !== row.data.blockHash ||
      receipt.blockNumber !== r.blockNumber
    )
      throw new WorkspaceError('RECEIPT_NOT_FINAL');
    const logs = await viemIndexerChain(this.chain.client).receiptLogs(
      r.txHash,
    );
    const match = extractMemoPayments({
      chainId: 5042002,
      txHash: r.txHash,
      logs: logs.logs,
      token: token('arc-testnet', 'USDC').address,
      memoContract: contract('arc-testnet', 'MEMO').address,
    }).payments.find((p) => p.logIndex === r.logIndex);
    if (
      !match ||
      match.amount !== r.amount ||
      match.recipient !== r.recipient ||
      match.payer !== r.payer ||
      match.paymentRef !== row.data.paymentRef
    )
      throw new WorkspaceError('RECEIPT_PROVENANCE_MISMATCH');
    return { ...r, finality: 'FINAL' };
  }
  private async current(signed: SignedRevenuePolicy, call: LegCall) {
    if (!this.obligationBooks)
      throw new WorkspaceError('WORKSPACE_OBLIGATION_BOOKS_UNAVAILABLE');
    const p = signed.policy,
      current = await this.revenue.active(p.workspaceId);
    if (!current || policyHash(current.signed.policy) !== policyHash(p))
      throw new WorkspaceError('REVENUE_POLICY_REVOKED');
    const split = (
      await this.finance.workspaces.pool.query(
        'SELECT split_id,data FROM synq_alloc_legs WHERE leg_key=$1',
        [call.legKey],
      )
    ).rows[0];
    const s = split && (await this.store.get(split.split_id));
    if (!s || s.workspaceId !== p.workspaceId)
      throw new WorkspaceError('SPLIT_SCOPE_MISMATCH');
    await this.proof(s.receipt);
    const screened = await screenSafely(this.screening, {
      address: call.recipient,
      chainId: 5042002,
      now: this.finance.workspaces.now(),
    });
    const risk = screeningFlags({
      result: screened,
      amount: call.amount,
      highValueAt: 0n,
      counterpartyVerified: true,
    });
    const holds = await this.risk.holdFlags(
      p.workspaceId,
      `vendor:${split.data.beneficiaryId}`,
    );
    if (
      !risk.available ||
      [...risk.flags, ...holds].some((f) => f.severity === 'HARD')
    )
      throw new WorkspaceError('SPLIT_RISK_HOLD');
    const pool = this.finance.workspaces.pool;
    const budget = (
      await pool.query(
        'SELECT data FROM synq_ws_budgets WHERE workspace_id=$1',
        [p.workspaceId],
      )
    ).rows[0]?.data;
    const payouts = (
      await pool.query(
        "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS spent FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED','PAID') AND (state<>'PAID' OR executed_at>$2)",
        [p.workspaceId, this.finance.workspaces.now() - 86400],
      )
    ).rows[0];
    const splits = (
      await pool.query(
        "SELECT COALESCE(sum(amount),0) AS spent FROM synq_ws_split_admissions WHERE workspace_id=$1 AND state<>'FAILED' AND (state<>'CONFIRMED' OR executed_at>$2)",
        [p.workspaceId, this.finance.workspaces.now() - 86400],
      )
    ).rows[0];
    if (
      !budget ||
      call.amount > BigInt(budget.perPayment) ||
      BigInt(payouts.spent) + BigInt(splits.spent) + call.amount >
        BigInt(budget.daily) ||
      BigInt(splits.spent) + call.amount > BigInt(budget.aiDaily)
    )
      throw new WorkspaceError('SPLIT_BUDGET_EXHAUSTED');
    const balance = await this.chain.client.readContract({
      address: p.token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [p.treasury],
    });
    const held = (
      await pool.query(
        "SELECT COALESCE(sum(h.amount),0) AS held,COALESCE(sum(h.amount) FILTER(WHERE h.purpose='OPERATING_FLOOR'),0) AS floor FROM synq_alloc_reservations h LEFT JOIN synq_ws_split_admissions a ON a.leg_key=h.reservation_id WHERE h.workspace_id=$1 AND h.status='ACTIVE' AND COALESCE(a.state,'')<>'CONFIRMED'",
        [p.workspaceId],
      )
    ).rows[0];
    const pending = (
      await pool.query(
        "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS held FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED')",
        [p.workspaceId],
      )
    ).rows[0];
    const liabilities = await new Ledger(
      new PostgresLedgerStore(pool),
    ).balances(p.workspaceId, token('arc-testnet', 'USDC').assetId);
    const restricted =
      -liabilities.REFUND_LIABILITY -
      liabilities.ESCROW_LIABILITY -
      liabilities.UNAPPLIED_RECEIPTS;
    // This leg is already included in split holds. Retain the larger of signed floor and workspace reserve.
    if (
      balance -
        (BigInt(held.held) - BigInt(held.floor)) -
        BigInt(pending.held) -
        restricted <
      (BigInt(held.floor) > BigInt(budget.reserve)
        ? BigInt(held.floor)
        : BigInt(budget.reserve))
    )
      throw new WorkspaceError('SPLIT_RESERVE_FLOOR');
  }
  private executor(
    signed: SignedRevenuePolicy,
    binding: VaultBinding,
  ): LegExecutor {
    const p = signed.policy,
      pool = this.finance.workspaces.pool,
      now = this.finance.workspaces.now;
    const delegated = vaultLegExecutor({
      chain: this.chain,
      store: this.outbox,
      signer: boundedWorkspaceSigner(this.signer),
      asset: token('arc-testnet', 'USDC'),
      grantKey: this.authority.grantKey,
      fence: new PostgresGrantFence(pool),
      now,
      binding,
      beforeSign: async (call) => {
        const live = await this.finance.authority(p.workspaceId);
        if (
          live.vault !== binding.vault ||
          live.policy !== binding.policy ||
          live.policyCodeHash !== binding.policyCodeHash
        )
          throw new WorkspaceError('SPLIT_VAULT_AUTHORITY_CHANGED');
        if (
          call.grant.executionCallHash !==
          executionCallHash(5042002, {
            to: binding.policy,
            value: 0n,
            data: vaultPayData(call),
          })
        )
          throw new ArcExecutionError('TX_MISMATCH');
        await this.current(signed, call);
      },
      afterAdmit: async (call, sql) => {
        const leg = (
          await sql.query('SELECT data FROM synq_alloc_legs WHERE leg_key=$1', [
            call.legKey,
          ])
        ).rows[0];
        const txPool: SqlPool = {
          query: sql.query.bind(sql),
          connect: async () => {
            throw new Error('nested transaction');
          },
        };
        if (
          !leg ||
          !(await new PostgresObligationFence(
            txPool,
            p.workspaceId,
            now,
          ).reserve(
            String(
              (leg.data as { obligationRef?: string }).obligationRef ??
                call.legKey,
            ),
          ))
        )
          throw new WorkspaceError('OBLIGATION_ALREADY_GRANTED');
        await sql.query(
          "INSERT INTO synq_ws_split_admissions(leg_key,workspace_id,amount,admitted_at,state) VALUES($1,$2,$3,$4,'SIGNED')",
          [call.legKey, p.workspaceId, String(call.amount), now()],
        );
      },
    });
    return {
      onChainReference: true,
      simulate: delegated.simulate,
      recorded: delegated.recorded,
      pay: async (call) => {
        const sql = await pool.connect(),
          lock = `workspace-vault-sender:${this.signer.address.toLowerCase()}`;
        let transaction = false,
          broken = false;
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
          const existing = await this.outbox.get(call.legKey);
          if (existing) {
            const raw = parseTransaction(existing.raw);
            if (
              raw.to?.toLowerCase() !== binding.policy.toLowerCase() ||
              raw.data !== vaultPayData(call) ||
              (raw.value ?? 0n) !== 0n ||
              raw.chainId !== chainProfile('arc-testnet').chainId ||
              keccak256(existing.raw) !== existing.hash ||
              (
                await recoverTransactionAddress({
                  serializedTransaction: existing.raw as TransactionSerialized,
                })
              ).toLowerCase() !== this.signer.address.toLowerCase()
            )
              throw new ArcExecutionError('TX_MISMATCH');
          } else {
            await sql.query('BEGIN');
            transaction = true;
            await sql.query(
              'SELECT id FROM synq_workspaces WHERE id=$1 FOR NO KEY UPDATE',
              [p.workspaceId],
            );
          }
          const result = await delegated.pay(call);
          if (transaction) {
            await sql.query('COMMIT');
            transaction = false;
          }
          await pool.query(
            'UPDATE synq_ws_split_admissions SET state=$2,executed_at=$3 WHERE leg_key=$1',
            [
              call.legKey,
              result.state === 'CONFIRMED'
                ? 'CONFIRMED'
                : result.state === 'FAILED'
                  ? 'FAILED'
                  : 'REVIEW',
              result.state === 'CONFIRMED' ? now() : null,
            ],
          );
          return result;
        } catch (e) {
          if (transaction) await sql.query('ROLLBACK');
          throw e;
        } finally {
          try {
            await sql.query(
              'SELECT pg_advisory_unlock(hashtextextended($1,0))',
              [lock],
            );
          } catch {
            broken = true;
          }
          sql.release(broken);
        }
      },
    };
  }
  async process(
    workspaceId: string,
    receiptId: string,
    opts: Parameters<SplitRunner['run']>[1] = {},
  ) {
    const pool = this.finance.workspaces.pool,
      signed = await this.signed(workspaceId, receiptId);
    if (!signed) return null;
    const p = signed.policy,
      asset = token('arc-testnet', 'USDC');
    const existingSplit = await this.store.byReceipt(receiptId);
    const recorded = existingSplit
      ? (
          await Promise.all(
            (await this.store.legs(existingSplit.splitId)).map((l) =>
              this.outbox.get(l.legKey),
            ),
          )
        ).find((r) => r !== null)
      : null;
    // Recorded bytes reconcile against their original binding, even after owner drift.
    const a: VaultBinding = recorded
      ? {
          vault: p.treasury,
          policy: recorded.prepared.token,
          policyCodeHash: recorded.prepared.codeHash,
        }
      : await this.finance.authority(workspaceId);
    const row = (
      await pool.query(
        'SELECT * FROM synq_ws_receipts WHERE workspace_id=$1 AND key=$2',
        [workspaceId, receiptId],
      )
    ).rows[0];
    if (!row || !row.invoice_id)
      throw new WorkspaceError('INVOICE_RECEIPT_REQUIRED');
    const invoices = new PostgresInvoiceStore(pool),
      invoice = (await invoices.get(row.invoice_id))?.invoice;
    if (!invoice || invoice.workspaceId !== workspaceId)
      throw new WorkspaceError('INVOICE_WORKSPACE_MISMATCH');
    const vendors: TreasuryBooks['vendors'] = async () => {
      const rows = (
        await pool.query(
          'SELECT id,name,address,eligible_at FROM synq_ws_vendors WHERE workspace_id=$1',
          [workspaceId],
        )
      ).rows;
      return rows.map((v) => ({
        vendorId: v.id,
        workspaceId,
        name: v.name,
        kind: 'VENDOR',
        addresses: [
          {
            chainId: 5042002,
            address: getAddress(v.address),
            status:
              Number(v.eligible_at) <= this.finance.workspaces.now()
                ? 'VERIFIED'
                : 'PENDING',
            source: 'SIGNED_WORKSPACE_VENDOR',
            at: Number(v.eligible_at),
            verifiedBy: 'SAFE_QUORUM',
          },
        ],
      }));
    };
    const ledger = new Ledger(new PostgresLedgerStore(pool), {
      verifiedPayout: (id, chainId) =>
        chainId === chainProfile('arc-testnet').chainId
          ? (p.allowedBeneficiaries.find(
              (b) => `vendor:${b.beneficiaryId}` === id,
            )?.address ?? null)
          : null,
    });
    const obligations = this.obligationBooks?.(workspaceId);
    const missingObligations = async (): Promise<never> => {
      throw new WorkspaceError('WORKSPACE_OBLIGATION_BOOKS_UNAVAILABLE');
    };
    const books: TreasuryBooks = {
      vendors,
      payables: obligations?.payables ?? missingObligations,
      payableHistory: obligations?.payableHistory ?? missingObligations,
      obligations: obligations?.obligations ?? missingObligations,
      bills: obligations?.bills ?? missingObligations,
      receivables: async () =>
        (await invoices.list(workspaceId)).map(({ invoice: i }) => ({
          invoiceId: i.invoiceId,
          number: i.number,
          payer: i.payer.name,
          amountDue: amountDue(i),
          dueOn: i.dueDate,
          payerDaysLate: [],
        })),
      position: async () => {
        const block = await this.chain.client.getBlock({
          blockTag: 'finalized',
        });
        if (block.number === null)
          throw new WorkspaceError('FINALITY_UNAVAILABLE');
        const [balance, liabilities, pending] = await Promise.all([
          this.chain.client.readContract({
            address: asset.address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [a.vault],
            blockNumber: block.number,
          }),
          ledger.balances(workspaceId, asset.assetId),
          pool.query(
            "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS held FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED')",
            [workspaceId],
          ),
        ]);
        return {
          treasury: a.vault,
          onChainFinalized: balance,
          observedBlock: block.number,
          observedAt: this.finance.workspaces.now(),
          source: 'FINALIZED_ARC_RPC',
          committedOutgoing: BigInt(pending.rows[0].held),
          escrowLiabilities:
            -liabilities.ESCROW_LIABILITY - liabilities.UNAPPLIED_RECEIPTS,
          refundLiabilities: -liabilities.REFUND_LIABILITY,
          invested: 0n,
        };
      },
    };
    const runner = new SplitRunner({
      store: this.store,
      ledger,
      signedPolicy: signed,
      books,
      kernel: { ...this.authority, riskRequiredAbove: 0n },
      assetId: asset.assetId,
      chain: 'arc-testnet',
      now: this.finance.workspaces.now,
      executor: this.executor(signed, a),
      receipts: { verify: (r) => this.proof(r) },
      executionCall: (call) => ({
        to: a.policy,
        value: 0n,
        data: vaultPayData(call),
      }),
      assessLeg: async (leg) => {
        const result = await screenSafely(this.screening, {
          address: leg.payTo!,
          chainId: 5042002,
          now: this.finance.workspaces.now(),
        });
        const risk = screeningFlags({
          result,
          amount: leg.amount,
          highValueAt: 0n,
          counterpartyVerified: true,
        });
        const holds = await this.risk.holdFlags(
          workspaceId,
          `vendor:${leg.beneficiaryId}`,
        );
        const flags = [...leg.flags, ...risk.flags, ...holds];
        if (flags.some((f) => f.severity === 'HARD'))
          await this.risk.raise({
            workspaceId,
            alertKey: `split:${leg.legKey}:${flags
              .map((f) => f.code)
              .sort()
              .join(',')}`,
            subjectRef: `vendor:${leg.beneficiaryId}`,
            counterparty: `vendor:${leg.beneficiaryId}`,
            flags,
            raisedBy: 'workspace-split-worker',
            at: this.finance.workspaces.now(),
          });
        return { available: risk.available, flags };
      },
      registry: {
        principals: async (id) => {
          const current = await this.revenue.active(id);
          if (!current || policyHash(current.signed.policy) !== policyHash(p))
            throw new WorkspaceError('REVENUE_POLICY_REVOKED');
          const authority = await this.finance.authority(id);
          return {
            treasury: authority.vault,
            owners: authority.owners,
            source: 'LIVE_SAFE_AND_SIGNED_WORKSPACE_QUORUM',
          };
        },
      },
    });
    const existing = await this.store.byReceipt(receiptId);
    const split =
      existing ??
      (
        await runner.trigger({
          receiptId,
          chainId: 5042002,
          token: asset.address,
          txHash: row.data.txHash as Hex,
          logIndex: row.data.logIndex,
          blockNumber: BigInt(row.data.blockNumber),
          amount: BigInt(row.data.amount),
          recipient: getAddress(row.data.vault),
          payer: getAddress(row.data.from),
          invoiceId: invoice.invoiceId,
          invoiceNumber: invoice.number,
          source: 'MEMO_INVOICE',
          finality: 'FINAL',
        })
      ).split;
    return runner.run(split.splitId, opts);
  }
  async pump() {
    const pool = this.finance.workspaces.pool,
      now = this.finance.workspaces.now;
    const rows = await pool.query(
      "SELECT r.key,r.workspace_id FROM synq_ws_receipts r LEFT JOIN synq_alloc_splits s ON s.receipt_id=r.key WHERE r.invoice_id IS NOT NULL AND r.next_at<=$1 AND (s.split_id IS NULL AND r.state='PENDING_POLICY' OR s.state IN ('RECEIPT_FINAL','LIABILITIES_RECONCILED','RESERVATIONS_CREATED','POLICY_VALIDATED','SPLIT_AUTHORIZED','EXECUTING','FAILED','EACH_LEG_RECONCILED')) ORDER BY r.created_at LIMIT 5",
      [now()],
    );
    for (const row of rows.rows) {
      const claimed = await pool.query(
        'UPDATE synq_ws_receipts SET next_at=$2 WHERE key=$1 AND next_at<=$3 RETURNING key',
        [row.key, now() + 30, now()],
      );
      if (!claimed.rowCount) continue;
      try {
        await this.process(row.workspace_id, row.key);
      } catch (e) {
        await pool.query(
          'UPDATE synq_ws_receipts SET last_error=$2 WHERE key=$1',
          [row.key, e instanceof WorkspaceError ? e.code : 'SPLIT_UNAVAILABLE'],
        );
      }
    }
  }
}
