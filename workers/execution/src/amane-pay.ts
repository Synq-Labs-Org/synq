import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { token } from '@synq/chain-registry/arc';
import { isLocalChain } from '@synq/chain-registry';
import { money } from '@synq/domain';
import type { SqlPool } from '@synq/domain/pg';
import {
  admitGrant,
  decideAmaneLeasedPay,
  type AuthorityConfig,
} from '@synq/kernel/arc';
import {
  PostgresObligationFence,
  migrateFinanceTeam,
} from '@synq/agent-runtime/finance-stores';
import {
  screenSafely,
  screeningFlags,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { Ledger, PostgresLedgerStore, walletTag } from '@synq/ledger';
import {
  executeCalldata,
  intentHash,
  intentTypedData,
  payIntent,
  readLeaseState,
  validateAction,
  verifyExecution,
  type ActionIntent,
} from '@synq/plugin-amane';
import { WorkspaceError } from '@synq/workspaces';
import type { WorkspaceAmane } from '@synq/workspaces/amane';
import type { AgentEvents } from '@synq/workspaces/agent-events';
import {
  ArcExecutionError,
  transactionOf,
  type PreparedTransfer,
  type TransferEvidence,
  type TransferSigner,
} from './arc.js';
import type { OutboxRecord } from './arc-outbox.js';
import { PostgresOutboxStore } from './pg-outbox.js';
import { boundedWorkspaceSigner } from './workspace-signing.js';

/*
 * Pays a contractor inside a standing Amane lease, with no new human
 * signature. The order is fixed: trigger met → read the lease from the
 * enforcing contract → SDK validation → recipient screening → agent key signs
 * the exact intent → simulation → Kernel grant bound to the exact call →
 * signed bytes recorded with the grant consumed → broadcast → the contract's
 * Executed event verified → ledger booked. Every step is an agent event. A
 * refusal moves no money. The relay uses the same per-sender lock as the
 * workspace vault relays because the operator key is shared.
 */

/** Signs only Amane intents; the agent key never leaves the execution worker. */
export type AgentIntentSigner = {
  address: Address;
  signIntent: (typed: ReturnType<typeof intentTypedData>) => Promise<Hex>;
};

export type AmaneChain = {
  client: PublicClient;
  chainId: number;
  mutationEnabled: boolean;
  /** Arc's fee floor; executors never bid below it. */
  minMaxFeePerGasWei: bigint;
  explorer: string;
};

const TRANSFER = erc20Abi.filter(
  (x) => x.type === 'event' && x.name === 'Transfer',
);

export class AmanePayExecutor {
  readonly outbox: PostgresOutboxStore;
  private readonly pool: SqlPool;

  constructor(
    private readonly amane: WorkspaceAmane,
    private readonly chain: AmaneChain,
    private readonly operator: TransferSigner,
    private readonly agent: AgentIntentSigner,
    private readonly authority: AuthorityConfig,
    private readonly screening: WalletScreeningPort = unavailableScreening(),
    private readonly events?: AgentEvents,
  ) {
    this.pool = amane.store.pool as unknown as SqlPool;
    this.outbox = new PostgresOutboxStore(amane.store.pool);
  }

  async migrate() {
    await this.outbox.migrate();
    await migrateFinanceTeam(this.amane.store.pool);
    await new PostgresLedgerStore(this.amane.store.pool).migrate();
  }

  private proof() {
    return isLocalChain(this.chain.chainId)
      ? ('LOCAL_FIXTURE' as const)
      : ('LIVE_ARC_TESTNET' as const);
  }

  private async step(
    jobId: string,
    workspaceId: string,
    key: string,
    e: Omit<
      Parameters<AgentEvents['record']>[1],
      'semanticKey' | 'correlationId' | 'sourceKind' | 'proofLevel'
    > & {
      sourceKind?: string;
      proofLevel?: 'LIVE_ARC_TESTNET' | 'LOCAL_FIXTURE' | 'NOT_VERIFIED';
    },
  ) {
    if (!this.events) return;
    const j = await this.amane.job(jobId);
    const runId = await this.events.run(workspaceId, `amane-job:${jobId}`, {
      title: `Pay contractor: ${j.purpose}`,
      trigger:
        j.triggerKind === 'INVOICE_PAID' ? 'INVOICE_SETTLED' : 'OWNER_REQUEST',
      amountUnits: String(j.amount),
    });
    await this.events.record(runId, {
      ...e,
      semanticKey: `amane-job:${jobId}:${key}`,
      correlationId: `amane-job:${jobId}`,
      sourceKind: e.sourceKind ?? 'AMANE_EXECUTOR',
      proofLevel: e.proofLevel ?? 'NOT_VERIFIED',
    });
  }

  private async refuse(jobId: string, workspaceId: string, reason: string) {
    await this.amane.mark(jobId, 'REFUSED', { reason: reason.slice(0, 300) });
    await this.step(jobId, workspaceId, 'refused', {
      kind: 'REJECTED',
      actor: 'DETERMINISTIC',
      status: 'BLOCKED',
      summary: `Payment refused before any money moved: ${reason}`.slice(
        0,
        400,
      ),
    });
    return { state: 'REFUSED' as const, reason };
  }

  async execute(jobId: string) {
    const sql = await this.amane.store.pool.connect();
    const lock = `workspace-vault-sender:${this.operator.address.toLowerCase()}`;
    try {
      await sql.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
        lock,
      ]);
      return await this.run(jobId);
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

  private async run(jobId: string) {
    if (!this.chain.mutationEnabled)
      throw new ArcExecutionError('MUTATION_DISABLED');
    if ((await this.chain.client.getChainId()) !== this.chain.chainId)
      throw new ArcExecutionError('WRONG_CHAIN');
    const j = await this.amane.job(jobId);
    if (j.state === 'PAID' || j.state === 'REFUSED') return { state: j.state };
    const a = await this.amane.account(j.workspaceId, j.accountId);
    const key = `amane-job:${jobId}`;
    const existing = await this.outbox.get(key);
    if (existing) return this.finish(jobId, existing);
    if (j.state !== 'READY') throw new WorkspaceError('JOB_NOT_READY', 409);
    const account = getAddress(a.account);

    await this.step(jobId, j.workspaceId, 'trigger', {
      kind: 'DECISION',
      actor: 'DETERMINISTIC',
      status: 'PENDING',
      summary:
        j.triggerKind === 'INVOICE_PAID'
          ? 'The client invoice settled in full; the contractor job is due.'
          : 'An owner asked for this contractor payment.',
      amountUnits: String(j.amount),
    });

    // One nonce per job, never reused (unique per lease in the database).
    let nonce = j.nonce;
    if (nonce === null) {
      nonce = await this.amane.nextNonce(j.leaseId);
      await this.amane.recordNonce(jobId, nonce);
      nonce = (await this.amane.job(jobId)).nonce!;
    }
    const live = await readLeaseState(
      this.chain.client,
      account,
      a.codeHash as Hex,
      j.leaseId as Hex,
      nonce,
    );
    const intent: ActionIntent = payIntent({
      leaseId: j.leaseId as Hex,
      nonce,
      token: a.token as Address,
      recipient: a.recipient as Address,
      adapterId: a.adapterId as Hex,
      amount: j.amount,
      deadline: live.state.now + 600n,
      planHash: keccak256(stringToHex(`synq-amane-job:${jobId}`)),
    });
    try {
      validateAction(live.root, live.rootHash, live.lease, intent, live.state);
    } catch (error) {
      return this.refuse(
        jobId,
        j.workspaceId,
        `lease check: ${(error as Error).message}`,
      );
    }
    const screened = await screenSafely(this.screening, {
      address: intent.recipient,
      chainId: this.chain.chainId,
      now: this.amane.store.now(),
    });
    const screening = screeningFlags({
      result: screened,
      amount: j.amount,
      highValueAt: 0n,
      counterpartyVerified: true,
    });
    const hash = intentHash(this.chain.chainId, account, intent);
    const signature = await this.agent.signIntent(
      intentTypedData(this.chain.chainId, account, intent),
    );
    const data = executeCalldata(intent, signature);
    const executionCall = { to: account, value: 0n, data };
    let simulationOk = true;
    try {
      await this.chain.client.call({
        account: this.operator.address,
        to: account,
        data,
      });
    } catch {
      simulationOk = false;
    }
    const decision = await decideAmaneLeasedPay({
      config: this.authority,
      job: {
        jobId,
        workspaceId: j.workspaceId,
        account,
        token: getAddress(a.token),
        recipient: getAddress(a.recipient),
        amount: j.amount,
        chainId: this.chain.chainId,
      },
      intent: {
        leaseId: intent.leaseId,
        nonce,
        token: intent.token,
        recipient: intent.recipient,
        amount: intent.amount,
        deadline: intent.deadline,
        intentHash: hash,
      },
      onchain: {
        leaseLive: live.leaseLive,
        paused: live.state.paused,
        nonceUsed: live.state.nonceUsed,
        rootRecipient: live.root.recipient,
        rootToken: live.root.token,
        remaining: live.remaining,
      },
      risk: { available: screening.available, flags: screening.flags },
      simulationOk,
      now: this.amane.store.now(),
      executionCall,
    });
    if (decision.outcome !== 'ALLOW')
      return this.refuse(jobId, j.workspaceId, decision.reasons.join('; '));
    const grant = decision.grant;
    await this.step(jobId, j.workspaceId, 'grant', {
      kind: 'GRANT',
      actor: 'DETERMINISTIC',
      status: 'AUTHORIZED',
      summary: `Kernel allowed one payment of this job inside the lease (lease remaining ${live.remaining.leaseTotal}).`,
      amountUnits: String(j.amount),
      evidenceHash: hash,
    });

    const [gasEstimate, txNonce, fees, nativeBalance] = await Promise.all([
      this.chain.client.estimateGas({
        account: this.operator.address,
        to: account,
        data,
      }),
      this.chain.client.getTransactionCount({
        address: this.operator.address,
        blockTag: 'pending',
      }),
      this.chain.client.estimateFeesPerGas(),
      this.chain.client.getBalance({ address: this.operator.address }),
    ]);
    const gas = (gasEstimate * 130n) / 100n;
    const tip =
      fees.maxPriorityFeePerGas && fees.maxPriorityFeePerGas > 0n
        ? fees.maxPriorityFeePerGas
        : 1_000_000_000n;
    let maxFeePerGas = fees.maxFeePerGas ?? 0n;
    if (maxFeePerGas < this.chain.minMaxFeePerGasWei)
      maxFeePerGas = this.chain.minMaxFeePerGasWei;
    if (maxFeePerGas < tip) maxFeePerGas = tip;
    if (nativeBalance < gas * maxFeePerGas)
      throw new ArcExecutionError(
        'INSUFFICIENT_GAS',
        'operator cannot pay gas',
      );
    const asset = token('arc-testnet', 'USDC');
    const prepared: PreparedTransfer = Object.freeze({
      chain: 'arc-testnet',
      chainId: this.chain.chainId,
      from: this.operator.address,
      to: intent.recipient,
      amount: money(asset, j.amount),
      token: account,
      data,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas: tip,
      nonce: txNonce,
      maxGasCostWei: gas * maxFeePerGas,
      codeHash: a.codeHash as Hex,
    });
    const raw = await boundedWorkspaceSigner(this.operator).signTransaction(
      transactionOf(prepared),
    );
    const record: OutboxRecord = {
      key,
      state: 'SIGNED',
      prepared,
      raw,
      hash: keccak256(raw),
      evidence: null,
      note: `amane-pay account=${account} lease=${j.leaseId} nonce=${nonce} intent=${hash}`,
      updatedAt: this.amane.store.now(),
    };
    const created = await this.outbox.createAdmittingGrant(
      record,
      grant,
      async (fence, q) => {
        await admitGrant({
          grant,
          grantKey: this.authority.grantKey,
          call: {
            chainId: this.chain.chainId,
            token: getAddress(a.token),
            payer: account,
            recipient: getAddress(a.recipient),
            amount: j.amount,
          },
          now: this.amane.store.now(),
          mandateRevoked: false,
          executionCall,
          fence,
        });
        const txPool: SqlPool = {
          query: q.query.bind(q),
          connect: async () => {
            throw new Error('nested transaction');
          },
        };
        if (
          !(await new PostgresObligationFence(
            txPool,
            j.workspaceId,
            this.amane.store.now,
          ).reserve(key))
        )
          throw new WorkspaceError('OBLIGATION_ALREADY_GRANTED');
      },
    );
    if (created === 'KEY_EXISTS')
      return this.finish(jobId, (await this.outbox.get(key))!);
    await this.amane.mark(jobId, 'SENT', {
      intent,
      intentHash: hash,
      agentSignature: signature,
      txHash: record.hash,
    });
    await this.step(jobId, j.workspaceId, 'broadcast', {
      kind: 'BROADCAST',
      actor: 'DETERMINISTIC',
      status: 'BROADCAST',
      summary: 'Relayed the agent-signed intent to the Amane account.',
      amountUnits: String(j.amount),
      txHash: record.hash,
      chainId: this.chain.chainId,
      proofLevel: this.proof(),
    });
    await this.chain.client.sendRawTransaction({ serializedTransaction: raw });
    return this.finish(jobId, record);
  }

  /** Proves the payment from the receipt and books it once; safe to repeat after a crash. */
  private async finish(jobId: string, record: OutboxRecord) {
    const j = await this.amane.job(jobId);
    const a = await this.amane.account(j.workspaceId, j.accountId);
    if (record.state === 'CONFIRMED') {
      await this.book(j, a, record);
      return { state: 'PAID' as const, txHash: record.hash };
    }
    if (record.state === 'FAILED' || record.state === 'NEEDS_REVIEW')
      return { state: 'NEEDS_REVIEW' as const, txHash: record.hash };
    try {
      await this.chain.client.sendRawTransaction({
        serializedTransaction: record.raw,
      });
    } catch {
      // Already known or mined: the receipt decides.
    }
    const receipt = await this.chain.client.waitForTransactionReceipt({
      hash: record.hash,
    });
    if (receipt.status !== 'success') {
      await this.outbox.update({
        ...record,
        state: 'FAILED',
        note: 'reverted',
        updatedAt: this.amane.store.now(),
      });
      await this.amane.mark(jobId, 'NEEDS_REVIEW', {
        reason: 'transaction reverted',
      });
      await this.step(jobId, j.workspaceId, 'reverted', {
        kind: 'REJECTED',
        actor: 'CHAIN',
        status: 'REJECTED',
        summary:
          'The Amane account refused the transaction on chain; no money moved.',
        txHash: record.hash,
        chainId: this.chain.chainId,
        proofLevel: this.proof(),
      });
      return { state: 'NEEDS_REVIEW' as const, txHash: record.hash };
    }
    const intent = (
      await this.amane.store.pool.query(
        'SELECT intent FROM synq_amane_jobs WHERE id=$1',
        [jobId],
      )
    ).rows[0]?.intent as Record<string, string | number> | null;
    if (!intent)
      throw new ArcExecutionError('TRANSFER_MISMATCH', 'intent missing');
    const parsed: ActionIntent = payIntent({
      leaseId: intent.leaseId as Hex,
      nonce: BigInt(intent.nonce!),
      token: intent.token as Address,
      recipient: intent.recipient as Address,
      adapterId: intent.adapterId as Hex,
      amount: BigInt(intent.amount!),
      deadline: BigInt(intent.deadline!),
      planHash: intent.planHash as Hex,
    });
    // The contract's own measured Executed event, at the deployed code hash.
    await verifyExecution(
      this.chain.client,
      getAddress(a.account),
      a.codeHash as Hex,
      parsed,
      record.hash,
    );
    const transfers = receipt.logs.flatMap((log) => {
      try {
        const d = decodeEventLog({
          abi: TRANSFER,
          data: log.data,
          topics: log.topics,
        });
        return log.address.toLowerCase() === a.token.toLowerCase() &&
          d.args.to.toLowerCase() === a.recipient.toLowerCase() &&
          d.args.value === j.amount
          ? [{ log, from: d.args.from }]
          : [];
      } catch {
        return [];
      }
    });
    if (transfers.length !== 1)
      throw new ArcExecutionError(
        'TRANSFER_MISMATCH',
        'expected one transfer to the recipient',
      );
    const fee = receipt.gasUsed * receipt.effectiveGasPrice;
    const evidence: TransferEvidence = {
      chain: 'arc-testnet',
      chainId: this.chain.chainId,
      hash: record.hash,
      blockNumber: receipt.blockNumber,
      blockHash: receipt.blockHash,
      from: getAddress(transfers[0]!.from),
      to: getAddress(a.recipient),
      amount: money(token('arc-testnet', 'USDC'), j.amount),
      gasUsed: receipt.gasUsed,
      effectiveGasPrice: receipt.effectiveGasPrice,
      feeWei: fee,
      feeUsdc: null,
      explorer: `${this.chain.explorer}/tx/${record.hash}`,
    };
    const done: OutboxRecord = {
      ...record,
      state: 'CONFIRMED',
      evidence,
      updatedAt: this.amane.store.now(),
    };
    await this.outbox.update(done);
    await this.step(jobId, j.workspaceId, 'final', {
      kind: 'FINALIZED',
      actor: 'CHAIN',
      status: 'FINALIZED',
      summary:
        'The Amane contract executed the payment and emitted its measured Executed event.',
      amountUnits: String(j.amount),
      txHash: record.hash,
      chainId: this.chain.chainId,
      proofLevel: this.proof(),
    });
    await this.book(j, a, done, transfers[0]!.log.logIndex ?? 0);
    return { state: 'PAID' as const, txHash: record.hash };
  }

  private async book(
    j: Awaited<ReturnType<WorkspaceAmane['job']>>,
    a: Awaited<ReturnType<WorkspaceAmane['account']>>,
    record: OutboxRecord,
    logIndex = 0,
  ) {
    const id = `amane-job:${j.id}:settled`;
    const assetId = token('arc-testnet', 'USDC').assetId;
    await this.amane.store.transaction(async (sql) => {
      const ledger = new Ledger(new PostgresLedgerStore(sql), {
        verifiedPayout: (counterparty) =>
          counterparty === `amane-recipient:${a.recipient.toLowerCase()}`
            ? getAddress(a.recipient)
            : null,
      });
      await ledger.post(
        {
          entryId: id,
          workspaceId: j.workspaceId,
          occurredAt: this.amane.store.now(),
          memo: j.purpose,
          source: { kind: 'CHAIN_TX', ref: j.id },
          evidence: {
            chainId: this.chain.chainId,
            txHash: record.hash,
            logIndex,
            recipient: getAddress(a.recipient),
          },
          idempotencyKey: id,
          reversalOf: null,
          postings: [
            {
              account: 'CONTRACTOR_EXPENSE',
              assetId,
              amount: j.amount,
              counterpartyId: `amane-recipient:${a.recipient.toLowerCase()}`,
              documentRef: j.triggerRef,
            },
            {
              // Tagged with the paying Amane account so its cash reconciles to its balance.
              account: 'CASH_ARC_USDC',
              assetId,
              amount: -j.amount,
              counterpartyId: walletTag(getAddress(a.account)),
              documentRef: j.triggerRef,
            },
          ],
        },
        [],
      );
    });
    await this.amane.mark(j.id, 'PAID', { txHash: record.hash });
    await this.step(j.id, j.workspaceId, 'reconciled', {
      kind: 'RECONCILED',
      actor: 'DETERMINISTIC',
      status: 'RECONCILED',
      summary: 'Booked once in the workspace ledger against the Amane account.',
      amountUnits: String(j.amount),
      txHash: record.hash,
      chainId: this.chain.chainId,
      proofLevel: this.proof(),
    });
  }
}
