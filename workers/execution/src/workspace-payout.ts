import { PostgresSplitStore } from '@synq/allocations';
import { boundedWorkspaceSigner } from './workspace-signing.js';
import { Ledger, PostgresLedgerStore, walletTag } from '@synq/ledger';
import {
  erc20Abi,
  getAddress,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  stringToHex,
  type Hex,
  type TransactionSerialized,
} from 'viem';
import { token, chainProfile } from '@synq/chain-registry/arc';
import {
  decide,
  admitGrant,
  verifyGrant,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  PostgresApprovalNonceFence,
  PostgresObligationFence,
  migrateFinanceTeam,
} from '@synq/agent-runtime/finance-stores';
import {
  RiskCaseService,
  screenSafely,
  screeningFlags,
  unavailableScreening,
  type WalletScreeningPort,
  type RiskFlag,
} from '@synq/plugin-risk';
import { migrateRisk, PostgresRiskCaseStore } from '@synq/plugin-risk/postgres';
import { WorkspaceError } from '@synq/workspaces';
import type { WorkspaceFinance } from '@synq/workspaces/finance';
import { WorkspacePayouts, type PayoutRecord } from '@synq/workspaces/payouts';
import {
  payoutIntent,
  payoutMandate,
} from '@synq/workspaces/finance-contracts';
import type { SqlPool } from '@synq/domain/pg';
import {
  ArcExecutionError,
  type ArcChain,
  type TransferSigner,
} from './arc.js';
import type { OutboxRecord } from './arc-outbox.js';
import { PostgresOutboxStore } from './pg-outbox.js';
import {
  recoverVaultPay,
  vaultPayData,
  vaultPayOnce,
  readVaultWindow,
  type VaultBinding,
} from './vault-outbox.js';
import { simulate } from './vault.js';

export class WorkspacePayoutExecutor {
  readonly payouts: WorkspacePayouts;
  readonly outbox: PostgresOutboxStore;
  readonly risk: RiskCaseService;
  constructor(
    readonly finance: WorkspaceFinance,
    readonly chain: ArcChain,
    private readonly signer: TransferSigner,
    private readonly authority: AuthorityConfig,
    readonly screening: WalletScreeningPort = unavailableScreening(),
  ) {
    this.payouts = new WorkspacePayouts(finance);
    this.outbox = new PostgresOutboxStore(finance.workspaces.pool);
    this.risk = new RiskCaseService(
      new PostgresRiskCaseStore(finance.workspaces.pool),
      finance.workspaces.now,
      authority.grantKey,
    );
  }
  async migrate() {
    await this.finance.migrate();
    await new PostgresSplitStore(this.finance.workspaces.pool).migrate();
    await this.outbox.migrate();
    await migrateFinanceTeam(this.finance.workspaces.pool);
    await migrateRisk(this.finance.workspaces.pool);
    await new PostgresLedgerStore(this.finance.workspaces.pool).migrate();
  }
  private call(p: PayoutRecord) {
    return {
      recipient: p.data.recipient,
      amount: BigInt(p.data.amount),
      ref: keccak256(stringToHex(`workspace-payout:${p.data.id}`)),
    };
  }
  private async assertRecord(
    record: OutboxRecord,
    p: PayoutRecord,
    binding: VaultBinding,
  ) {
    const tx = parseTransaction(record.raw);
    if (
      record.key !== `workspace-payout:${p.data.id}` ||
      record.hash !== keccak256(record.raw) ||
      tx.to?.toLowerCase() !== binding.policy.toLowerCase() ||
      tx.data !== vaultPayData(this.call(p)) ||
      (tx.value ?? 0n) !== 0n ||
      tx.chainId !== chainProfile('arc-testnet').chainId ||
      record.prepared.from.toLowerCase() !==
        this.signer.address.toLowerCase() ||
      record.prepared.to.toLowerCase() !== p.data.recipient.toLowerCase() ||
      record.prepared.amount.baseUnits !== BigInt(p.data.amount) ||
      record.prepared.token.toLowerCase() !== binding.policy.toLowerCase() ||
      record.prepared.data !== tx.data ||
      (
        await recoverTransactionAddress({
          serializedTransaction: record.raw as TransactionSerialized,
        })
      ).toLowerCase() !== this.signer.address.toLowerCase()
    )
      throw new ArcExecutionError('TX_MISMATCH');
  }
  async execute(id: string, afterRecord?: () => Promise<void>) {
    const store = this.finance.workspaces,
      sql = await store.pool.connect();
    const senderLock = `workspace-vault-sender:${this.signer.address.toLowerCase()}`;
    let inTx = false;
    try {
      await sql.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        senderLock,
      ]);
      if (
        this.chain.profile.name !== 'arc-testnet' ||
        !this.chain.profile.mutationEnabled ||
        (await this.chain.client.getChainId()) !==
          chainProfile('arc-testnet').chainId
      )
        throw new ArcExecutionError('WRONG_CHAIN');
      const p = await this.payouts.record(id);
      if (!p) throw new WorkspaceError('PAYOUT_NOT_FOUND', 404);
      const asset = token('arc-testnet', 'USDC'),
        key = `workspace-payout:${id}`;
      const existing = await this.outbox.get(key);
      if (existing) {
        const binding = {
          vault: p.data.vault,
          policy: existing.prepared.token,
          policyCodeHash: existing.prepared.codeHash,
        };
        await this.assertRecord(existing, p, binding);
        const result = await recoverVaultPay(
          this.outbox,
          this.chain,
          existing,
          asset,
          store.now,
          binding,
        );
        await this.settle(p, result.record);
        return result;
      }
      if (p.data.route === 'SAFE_QUORUM')
        throw new WorkspaceError('SAFE_QUORUM_ROUTE');
      if (p.state !== 'READY') throw new WorkspaceError('PAYOUT_NOT_READY');
      await sql.query('BEGIN');
      inTx = true;
      await sql.query('SELECT id FROM synq_workspaces WHERE id=$1 FOR UPDATE', [
        p.data.workspaceId,
      ]);
      const current = await sql.query(
        'SELECT state FROM synq_ws_payouts WHERE id=$1 FOR UPDATE',
        [id],
      );
      if (current.rows[0]?.state !== 'READY')
        throw new WorkspaceError('PAYOUT_NOT_READY');
      const a = await this.finance.authority(p.data.workspaceId);
      if (
        a.vault !== getAddress(p.data.vault) ||
        a.token !== getAddress(p.data.token)
      )
        throw new WorkspaceError('PAYOUT_VAULT_MISMATCH');
      await this.payouts.verifyQuorum(p, a);
      const vendor = await sql.query(
        'SELECT address,eligible_at,change_hash FROM synq_ws_vendors WHERE workspace_id=$1 AND id=$2',
        [p.data.workspaceId, p.data.vendorId],
      );
      const budget = await sql.query(
        'SELECT change_hash FROM synq_ws_budgets WHERE workspace_id=$1',
        [p.data.workspaceId],
      );
      const flags: RiskFlag[] = [];
      const hard = (code: string) =>
        flags.push({ code, severity: 'HARD', detail: code });
      const v = vendor.rows[0];
      if (
        !v ||
        String(v.address).toLowerCase() !== p.data.recipient.toLowerCase() ||
        v.change_hash !== p.data.vendorChangeHash
      )
        hard('PAYOUT_ADDRESS_CHANGED');
      if (v && Number(v.eligible_at) > store.now()) hard('VENDOR_COOLING');
      if (budget.rows[0]?.change_hash !== p.data.budgetChangeHash)
        hard('BUDGET_CHANGED');
      const sum = await sql.query(
        "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS spent FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED','PAID') AND (state<>'PAID' OR executed_at>$2) AND COALESCE(data->>'route','VAULT_POLICY')='VAULT_POLICY'",
        [p.data.workspaceId, store.now() - 86400],
      );
      const splitSpent = await sql.query(
        "SELECT COALESCE(sum(amount),0) AS spent FROM synq_ws_split_admissions WHERE workspace_id=$1 AND state<>'FAILED' AND (state<>'CONFIRMED' OR executed_at>$2)",
        [p.data.workspaceId, store.now() - 86400],
      );
      if (
        BigInt(sum.rows[0].spent) + BigInt(splitSpent.rows[0].spent) >
        BigInt(p.data.budget.daily)
      )
        hard('DAILY_BUDGET_EXHAUSTED');
      const balance = await this.chain.client.readContract({
        address: asset.address,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [a.vault],
      });
      const reserved = await sql.query(
        "SELECT COALESCE(sum((data->>'amount')::numeric),0) AS reserved FROM synq_ws_payouts WHERE workspace_id=$1 AND state IN ('READY','HOLD','SIGNED')",
        [p.data.workspaceId],
      );
      const splitHeld = await sql.query(
        "SELECT COALESCE(sum(h.amount),0) AS held,COALESCE(sum(h.amount) FILTER(WHERE h.purpose='OPERATING_FLOOR'),0) AS floor FROM synq_alloc_reservations h LEFT JOIN synq_ws_split_admissions a ON a.leg_key=h.reservation_id WHERE h.workspace_id=$1 AND h.status='ACTIVE' AND COALESCE(a.state,'')<>'CONFIRMED'",
        [p.data.workspaceId],
      );
      const liabilities = await new Ledger(
        new PostgresLedgerStore(sql),
      ).balances(p.data.workspaceId, asset.assetId);
      const restricted =
        -liabilities.REFUND_LIABILITY -
        liabilities.ESCROW_LIABILITY -
        liabilities.UNAPPLIED_RECEIPTS;
      const floor =
        BigInt(splitHeld.rows[0].floor) > BigInt(p.data.budget.reserve)
          ? BigInt(splitHeld.rows[0].floor)
          : BigInt(p.data.budget.reserve);
      if (
        balance -
          BigInt(reserved.rows[0].reserved) -
          BigInt(splitHeld.rows[0].held) +
          BigInt(splitHeld.rows[0].floor) -
          restricted <
        floor
      )
        hard('RESERVE_FLOOR');
      const window = await readVaultWindow(this.chain, a);
      if (
        window.paused ||
        BigInt(p.data.amount) > window.perPaymentCap ||
        BigInt(p.data.amount) > window.remaining
      )
        hard('VAULT_OPERATOR_CAP');
      const screened = await screenSafely(this.screening, {
        address: p.data.recipient,
        chainId: 5042002,
        now: store.now(),
      });
      const screening = screeningFlags({
        result: screened,
        amount: BigInt(p.data.amount),
        highValueAt: 0n,
        counterpartyVerified: !!v,
      });
      flags.push(
        ...screening.flags,
        ...(await this.risk.holdFlags(
          p.data.workspaceId,
          `vendor:${p.data.vendorId}`,
        )),
      );
      const call = this.call(p),
        executionCall = { to: a.policy, value: 0n, data: vaultPayData(call) };
      const simulation = await simulate(
        this.chain,
        this.signer.address,
        a.policy,
        executionCall.data,
      );
      const decision = await decide({
        config: { ...this.authority, riskRequiredAbove: 0n },
        mandate: payoutMandate(p.data),
        mandateSignature: p.mandateSignature!,
        state: {
          revoked: budget.rows[0]?.change_hash !== p.data.budgetChangeHash,
          spends: [],
        },
        intent: payoutIntent(p.data),
        risk: { available: screening.available, flags },
        simulationOk: simulation.ok,
        now: store.now(),
        requireOwnerApproval: true,
        ownerApproval: {
          ...p.data.approval,
          nonce: p.data.approval.nonce as Hex,
          signature: p.signatures[p.data.primaryOwner.toLowerCase()]!,
        },
        executionCall,
      });
      if (decision.outcome !== 'ALLOW') {
        const reason =
          flags.find((v) => v.severity === 'HARD')?.code ?? 'KERNEL_DENIED';
        await sql.query(
          "UPDATE synq_ws_payouts SET state='HOLD',reason=$2 WHERE id=$1",
          [id, reason],
        );
        await sql.query('COMMIT');
        inTx = false;
        await this.risk.raise({
          workspaceId: p.data.workspaceId,
          alertKey: `payout:${id}:${reason}`,
          subjectRef: `vendor:${p.data.vendorId}`,
          counterparty: `vendor:${p.data.vendorId}`,
          flags: flags.length
            ? flags
            : [{ code: reason, severity: 'HARD', detail: reason }],
          raisedBy: 'workspace-executor',
          at: store.now(),
        });
        return { state: 'HOLD', reason };
      }
      const g = decision.grant;
      const check = {
        grant: g,
        grantKey: this.authority.grantKey,
        call: payoutIntent(p.data),
        now: store.now(),
        mandateRevoked: false,
        executionCall,
      };
      const exactSigner = boundedWorkspaceSigner(this.signer);
      const result = await vaultPayOnce({
        store: this.outbox,
        key,
        grant: g,
        binding: a,
        chain: this.chain,
        signer: exactSigner,
        asset,
        call,
        now: store.now,
        authorize: async () => {
          verifyGrant(check);
        },
        admit: async (fence, query) => {
          await admitGrant({ ...check, now: store.now(), fence });
          const txPool: SqlPool = {
            query: query.query.bind(query),
            connect: async () => {
              throw new Error('nested transaction');
            },
          };
          if (
            !(await new PostgresApprovalNonceFence(
              txPool,
              p.data.workspaceId,
              store.now,
            ).redeem(p.data.approval.nonce as Hex))
          )
            throw new WorkspaceError('APPROVAL_REPLAYED');
          if (
            !(await new PostgresObligationFence(
              txPool,
              p.data.workspaceId,
              store.now,
            ).reserve(p.data.obligation))
          )
            throw new WorkspaceError('OBLIGATION_ALREADY_GRANTED');
        },
        afterRecord: async (record) => {
          await this.assertRecord(record, p, a);
          await afterRecord?.();
        },
      });
      await sql.query('COMMIT');
      inTx = false;
      await this.settle(p, result.record);
      return result;
    } catch (error) {
      if (inTx) await sql.query('ROLLBACK');
      throw error;
    } finally {
      let broken = false;
      try {
        await sql.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [
          senderLock,
        ]);
      } catch {
        broken = true;
      }
      sql.release(broken);
    }
  }
  private async settle(p: PayoutRecord, r: OutboxRecord) {
    const state = r.state === 'CONFIRMED' ? 'PAID' : r.state;
    await this.finance.workspaces.transaction(async (sql) => {
      if (state === 'PAID') {
        const evidence = r.evidence as
          | import('./vault-outbox.js').VaultPayEvidence
          | null;
        if (
          !evidence ||
          evidence.vault.toLowerCase() !== p.data.vault.toLowerCase() ||
          evidence.to.toLowerCase() !== p.data.recipient.toLowerCase() ||
          evidence.amount.baseUnits !== BigInt(p.data.amount)
        )
          throw new ArcExecutionError('TRANSFER_MISMATCH');
        await bookWorkspacePayout(sql, p, {
          txHash: r.hash,
          logIndex: evidence.logIndex,
          now: this.finance.workspaces.now(),
          grantKey: this.authority.grantKey,
        });
        return;
      }
      await sql.query(
        'UPDATE synq_ws_payouts SET state=$2,tx_hash=$3,reason=$4 WHERE id=$1',
        [p.data.id, state, r.hash, r.note],
      );
    });
  }
}

/**
 * Books a confirmed payout once: balanced ledger entry, PAYOUT_SENT event for
 * receipt relays, risk audit, and the PAID state. Shared by the vault-policy
 * route and the Safe-quorum route; idempotent on the ledger entry id.
 */
export async function bookWorkspacePayout(
  sql: { query: SqlPool['query'] },
  p: PayoutRecord,
  input: { txHash: Hex; logIndex: number; now: number; grantKey: Uint8Array },
) {
  const id = `workspace-payout:${p.data.id}:settled`,
    cp = `vendor:${p.data.vendorId}`,
    amount = BigInt(p.data.amount),
    assetId = token('arc-testnet', 'USDC').assetId;
  const ledger = new Ledger(new PostgresLedgerStore(sql), {
    verifiedPayout: (counterparty, chainId) =>
      counterparty === cp && chainId === chainProfile('arc-testnet').chainId
        ? p.data.recipient
        : null,
  });
  const posted = await ledger.post(
    {
      entryId: id,
      workspaceId: p.data.workspaceId,
      occurredAt: input.now,
      memo: p.data.purpose,
      source: { kind: 'CHAIN_TX', ref: p.data.id },
      evidence: {
        chainId: 5042002,
        txHash: input.txHash,
        logIndex: input.logIndex,
        recipient: p.data.recipient,
      },
      idempotencyKey: id,
      reversalOf: null,
      postings: [
        {
          account: 'CONTRACTOR_EXPENSE',
          assetId,
          amount,
          counterpartyId: cp,
          documentRef: p.data.obligation,
        },
        {
          // Tagged with the paying vault so per-vault cash reconciles to its on-chain balance.
          account: 'CASH_ARC_USDC',
          assetId,
          amount: -amount,
          counterpartyId: walletTag(getAddress(p.data.vault)),
          documentRef: p.data.obligation,
        },
      ],
    },
    [
      {
        eventId: id,
        topic: 'workspace.money',
        payload: {
          eventId: id,
          kind: 'PAYOUT_SENT',
          workspaceId: p.data.workspaceId,
          payoutId: p.data.id,
          amount: p.data.amount,
          chainId: 5042002,
          txHash: input.txHash,
          recipientHint: `${p.data.recipient.slice(0, 6)}…${p.data.recipient.slice(-4)}`,
        },
      },
    ],
  );
  if (posted.created)
    await new RiskCaseService(
      new PostgresRiskCaseStore({ query: sql.query.bind(sql) }),
      () => input.now,
      input.grantKey,
    ).record(p.data.workspaceId, 'workspace-executor', 'PAYOUT_CONFIRMED', {
      payoutId: p.data.id,
      txHash: input.txHash,
      amount: p.data.amount,
      route: p.data.route,
    });
  await sql.query(
    "UPDATE synq_ws_payouts SET state='PAID',tx_hash=$2,executed_at=COALESCE(executed_at,$3),reason=NULL WHERE id=$1",
    [p.data.id, input.txHash, input.now],
  );
}
