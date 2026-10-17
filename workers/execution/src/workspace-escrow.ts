import { encodeFunctionData, erc20Abi, getAddress, type Hex } from 'viem';
import {
  ESCROW_PURPOSE,
  escrowTotal,
  escrowValueView,
  type EscrowCall,
} from '@synq/kernel/arc-escrow';
import {
  verifyMandateSignature,
  type AuthorityConfig,
  type ExecutionGrant,
  type PaymentMandate,
} from '@synq/kernel/arc';
import {
  intentApprovalTypedData,
  mandateTypedData,
} from '@synq/kernel/arc-payment-data';
import {
  screenSafely,
  screeningFlags,
  unavailableScreening,
  type WalletScreeningPort,
} from '@synq/plugin-risk';
import { WorkspaceError } from '@synq/workspaces';
import type { WorkspaceDeals } from '@synq/workspaces/deals';
import type { ArcChain, TransferSigner } from './arc.js';
import {
  escrowCalldata,
  executeEscrowDispute,
  executeEscrowOpen,
  executeEscrowRefund,
  executeEscrowRelease,
  probeEscrowFunding,
  readEscrowDeal,
  simulateEscrow,
  type EscrowExecution,
  type EscrowStep,
} from './escrow.js';
import { PostgresEscrowJournal } from './pg-escrow.js';
import { PostgresGrantFence } from './pg-outbox.js';

type Op = 'FUND' | 'RELEASE' | 'REFUND' | 'DISPUTE';
type Stored = {
  call: Record<string, unknown>;
  mandate: Record<string, unknown> | null;
  mandateSignature: Hex | null;
  approval: { nonce: Hex; deadline: number } | null;
  grant: ExecutionGrant | null;
  fromBlock: string;
  execution?: { txs: string[] };
};
const jsonSafe = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'bigint' ? `${x}n` : x,
    ),
  ) as Record<string, unknown>;
const revive = <T>(v: unknown): T =>
  JSON.parse(JSON.stringify(v), (_k, x: unknown) =>
    typeof x === 'string' && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x,
  ) as T;
const wire = (v: unknown) =>
  JSON.parse(
    JSON.stringify(v, (_k, x: unknown) =>
      typeof x === 'bigint' ? String(x) : x,
    ),
  ) as unknown;
const record = (e: EscrowExecution) => ({
  op: e.op,
  escrowDealId: e.escrowDealId,
  milestone: e.milestone,
  txs: e.txs.map((t) => ({
    label: t.label,
    hash: t.hash,
    from: t.from,
    feeWei: t.feeWei,
  })),
  transfers: e.transfers,
});

/**
 * Deal escrow moved by the parties' own wallets. For each operation the
 * server derives the exact escrow call from the signed agreement, the acting
 * party signs a bounded mandate and an approval of that exact call, and the
 * Kernel issues a one-use grant. The party's wallet then broadcasts the
 * prepared transactions; the server never signs for a party. On submission it
 * proves each transaction came from the party with the prepared calldata,
 * admits the grant once, checks the escrow events and transfers on chain, and
 * only then records the deal state and books.
 */
export class WorkspaceDealEscrow {
  readonly journal: PostgresEscrowJournal;
  readonly fence: PostgresGrantFence;
  constructor(
    readonly deals: WorkspaceDeals,
    readonly chain: ArcChain,
    private readonly authority: AuthorityConfig,
    readonly screening: WalletScreeningPort = unavailableScreening(),
  ) {
    this.journal = new PostgresEscrowJournal(deals.workspaces.pool);
    this.fence = new PostgresGrantFence(deals.workspaces.pool);
  }
  private get pool() {
    return this.deals.workspaces.pool;
  }
  private get now() {
    return this.deals.workspaces.now;
  }
  private key(dealId: string, op: Op, milestone: number | null, v: number) {
    return `${dealId}:${op}:${milestone ?? 'deal'}:v${v}`;
  }
  private async callFor(dealId: string, op: Op, milestone: number | null) {
    const s = this.deals.service;
    if (op === 'FUND') return (await s.fundingCall(dealId)).call;
    if (milestone === null) throw new WorkspaceError('MILESTONE_REQUIRED');
    if (op === 'RELEASE') return (await s.releaseCall(dealId, milestone)).call;
    if (op === 'REFUND') return (await s.refundCall(dealId, milestone)).call;
    throw new WorkspaceError('UNSUPPORTED_ESCROW_OP');
  }
  private async load(key: string, principalId: string) {
    const r = (
      await this.pool.query('SELECT * FROM synq_ws_escrow_ops WHERE key=$1', [
        key,
      ])
    ).rows[0];
    if (!r || r.principal_id !== principalId)
      throw new WorkspaceError('ESCROW_OP_NOT_FOUND', 404);
    return {
      key: String(r.key),
      dealId: String(r.deal_id),
      op: r.op as Op,
      milestone: r.milestone === null ? null : Number(r.milestone),
      sender: getAddress(String(r.sender)),
      state: String(r.state),
      data: r.data as Stored,
    };
  }
  private async save(key: string, state: string, data: Stored, error?: string) {
    await this.pool.query(
      'UPDATE synq_ws_escrow_ops SET state=$2,data=$3,last_error=$4,updated_at=$5 WHERE key=$1',
      [key, state, data, error ?? null, this.now()],
    );
  }
  /** Transactions the party's wallet sends, in order, for a granted call. */
  private transactions(op: Op, call: EscrowCall | null, escrowDealId: bigint) {
    if (op === 'DISPUTE')
      return [
        {
          step: 'DISPUTE',
          label: 'Raise the dispute on the escrow',
          to: this.escrowAddress(),
          data: escrowCalldata.dispute(escrowDealId),
        },
      ];
    if (!call) throw new WorkspaceError('ESCROW_CALL_MISSING');
    if (call.op === 'OPEN')
      return [
        {
          step: 'APPROVE',
          label: 'Allow the escrow to take exactly the deal total',
          to: call.token,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: 'approve',
            args: [call.escrow, escrowTotal(call.amounts)],
          }),
        },
        {
          step: 'OPEN',
          label: 'Fund the escrow',
          to: call.escrow,
          data: escrowCalldata.open(call),
        },
      ];
    if (call.op === 'RELEASE')
      return [
        {
          step: 'RELEASE',
          label: `Release milestone ${call.index + 1}`,
          to: call.escrow,
          data: escrowCalldata.milestone(
            'release',
            call.escrowDealId,
            call.index,
          ),
        },
        {
          step: 'WITHDRAW',
          label: `Pay milestone ${call.index + 1} to the payee`,
          to: call.escrow,
          data: escrowCalldata.milestone(
            'withdraw',
            call.escrowDealId,
            call.index,
          ),
        },
      ];
    return [
      {
        step: 'REFUND',
        label: `Refund milestone ${call.index + 1} to the funder`,
        to: call.escrow,
        data: escrowCalldata.milestone('refund', call.escrowDealId, call.index),
      },
    ];
  }
  private escrowAddress() {
    return getAddress(
      this.deals.service.config.escrow ??
        (() => {
          throw new WorkspaceError('ESCROW_UNAVAILABLE');
        })(),
    );
  }

  /** Step 1: the exact call and the bounded mandate the acting party signs. */
  async prepare(
    workspaceId: string,
    principalId: string,
    dealId: string,
    op: Op,
    milestone: number | null,
  ) {
    const { view, wallet } = await this.deals.role(
      workspaceId,
      principalId,
      dealId,
    );
    const key = this.key(dealId, op, milestone, view.current.version);
    const fromBlock = String(await this.chain.client.getBlockNumber());
    if (op === 'DISPUTE') {
      if (!view.deal.escrow) throw new WorkspaceError('DEAL_NOT_FUNDED');
      if (!view.deal.dispute)
        throw new WorkspaceError('DISPUTE_ATTESTATION_REQUIRED');
      await this.pool.query(
        "INSERT INTO synq_ws_escrow_ops(key,workspace_id,deal_id,op,milestone,principal_id,sender,data,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'GRANTED',$9,$9) ON CONFLICT(key) DO NOTHING",
        [
          key,
          workspaceId,
          dealId,
          op,
          milestone,
          principalId,
          wallet.toLowerCase(),
          {
            call: {},
            mandate: null,
            mandateSignature: null,
            approval: null,
            grant: null,
            fromBlock,
          },
          this.now(),
        ],
      );
      return {
        key,
        state: 'GRANTED',
        transactions: wire(
          this.transactions(op, null, BigInt(view.deal.escrow.escrowDealId)),
        ),
      };
    }
    const call = await this.callFor(dealId, op, milestone);
    if (getAddress(call.sender) !== wallet)
      throw new WorkspaceError('ESCROW_SENDER_REQUIRED', 403);
    const value = escrowValueView(call);
    const now = this.now();
    const mandate: PaymentMandate = {
      mandateId: `ws-escrow:${key}`,
      version: 1,
      workspaceId,
      owner: wallet,
      chainId: value.chainId,
      token: value.token,
      payer: value.payer,
      recipients: [value.recipient],
      purposes: [ESCROW_PURPOSE[call.op]],
      perActionCap: value.amount,
      periodBudget: value.amount,
      periodSeconds: 86400,
      validFrom: now - 60,
      validUntil: now + 3600,
    };
    const existing = (
      await this.pool.query(
        'SELECT state FROM synq_ws_escrow_ops WHERE key=$1',
        [key],
      )
    ).rows[0];
    if (existing && existing.state !== 'FAILED')
      throw new WorkspaceError('ESCROW_OP_IN_PROGRESS');
    await this.pool.query(
      `INSERT INTO synq_ws_escrow_ops(key,workspace_id,deal_id,op,milestone,principal_id,sender,data,state,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'MANDATE',$9,$9)
       ON CONFLICT(key) DO UPDATE SET data=EXCLUDED.data,state='MANDATE',last_error=NULL,updated_at=EXCLUDED.updated_at WHERE synq_ws_escrow_ops.state='FAILED'`,
      [
        key,
        workspaceId,
        dealId,
        op,
        milestone,
        principalId,
        wallet.toLowerCase(),
        {
          call: jsonSafe(call),
          mandate: jsonSafe(mandate),
          mandateSignature: null,
          approval: null,
          grant: null,
          fromBlock,
        },
        now,
      ],
    );
    return {
      key,
      state: 'MANDATE',
      call: wire(call),
      mandateTypedData: wire(mandateTypedData(mandate)),
    };
  }

  /**
   * Step 2: the signed mandate, then the signed approval of the exact call.
   * Returns the approval to sign, or, once granted, the transactions to send.
   */
  async authorize(
    workspaceId: string,
    principalId: string,
    key: string,
    input: { mandateSignature: Hex; approvalSignature?: Hex },
  ) {
    const op = await this.load(key, principalId);
    const { view } = await this.deals.role(workspaceId, principalId, op.dealId);
    if (op.state === 'GRANTED')
      return this.granted(op.op, op.data, view.deal.escrow?.escrowDealId);
    if (op.state !== 'MANDATE' && op.state !== 'APPROVAL')
      throw new WorkspaceError('ESCROW_OP_NOT_AUTHORIZABLE');
    const mandate = revive<PaymentMandate>(op.data.mandate);
    await verifyMandateSignature(mandate, input.mandateSignature).catch(() => {
      throw new WorkspaceError('INVALID_MANDATE_SIGNATURE', 403);
    });
    const call = revive<EscrowCall>(op.data.call);
    const value = escrowValueView(call);
    const screened =
      call.op === 'OPEN'
        ? null
        : await screenSafely(this.screening, {
            address: value.recipient,
            chainId: value.chainId,
            now: this.now(),
          });
    const risk = screened
      ? screeningFlags({
          result: screened,
          amount: value.amount,
          highValueAt: 0n,
          counterpartyVerified: true,
        })
      : { available: true, flags: [] };
    let simulationOk = true;
    if (call.op === 'OPEN') {
      const balance = await this.chain.client.readContract({
        address: call.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [call.sender],
      });
      simulationOk = balance >= escrowTotal(call.amounts);
    } else
      simulationOk = (
        await simulateEscrow(
          this.chain,
          call.sender,
          call.op === 'RELEASE' ? 'release' : 'refund',
          call.escrowDealId,
          call.index,
        )
      ).ok;
    const k = {
      config: this.authority,
      mandate,
      mandateSignature: input.mandateSignature,
      state: { revoked: false, spends: [] },
      risk: { available: risk.available, flags: risk.flags },
      simulationOk,
      requireOwnerApproval: true,
      ...(input.approvalSignature && op.data.approval
        ? {
            ownerApproval: {
              ...op.data.approval,
              signature: input.approvalSignature,
            },
          }
        : {}),
    };
    const s = this.deals.service;
    const r =
      call.op === 'OPEN'
        ? await s.authorizeFunding(op.dealId, k)
        : call.op === 'RELEASE'
          ? await s.authorizeRelease(op.dealId, call.index, k)
          : await s.authorizeRefund(op.dealId, call.index, k);
    if (r.decision.outcome === 'DENY') {
      await this.save(
        key,
        'FAILED',
        op.data,
        r.decision.reasons.join('; ').slice(0, 300),
      );
      throw new WorkspaceError('KERNEL_DENIED', 403);
    }
    if (r.decision.outcome === 'REQUIRE_OWNER_APPROVAL') {
      const data = {
        ...op.data,
        mandateSignature: input.mandateSignature,
        approval: r.decision.approval,
      };
      await this.save(key, 'APPROVAL', data);
      return {
        key,
        state: 'APPROVAL',
        approvalTypedData: wire(
          intentApprovalTypedData(r.intent, r.decision.approval),
        ),
      };
    }
    const data = {
      ...op.data,
      mandateSignature: input.mandateSignature,
      grant: r.decision.grant,
    };
    await this.save(key, 'GRANTED', data);
    return this.granted(op.op, data, view.deal.escrow?.escrowDealId);
  }
  private granted(op: Op, data: Stored, escrowDealId?: string) {
    const call =
      op === 'DISPUTE' ? null : revive<EscrowCall>(data.call as never);
    return {
      state: 'GRANTED',
      expiresAt: data.grant?.expiresAt ?? null,
      transactions: wire(
        this.transactions(op, call, BigInt(escrowDealId ?? 0)),
      ),
    };
  }

  /**
   * Step 3: the hashes the party's wallet broadcast. Each is proven against
   * the prepared call before the deal records anything.
   */
  async submit(
    workspaceId: string,
    principalId: string,
    key: string,
    hashes: Partial<Record<EscrowStep, Hex>>,
  ) {
    const op = await this.load(key, principalId);
    const { view } = await this.deals.role(workspaceId, principalId, op.dealId);
    if (op.state === 'DONE')
      return this.deals.get(workspaceId, principalId, op.dealId);
    if (op.state !== 'GRANTED') throw new WorkspaceError('ESCROW_NOT_GRANTED');
    const party: TransferSigner = {
      address: op.sender,
      signTransaction: () => {
        throw new WorkspaceError('PARTY_WALLET_SIGNS');
      },
    };
    const s = this.deals.service;
    try {
      if (op.op === 'DISPUTE') {
        const exec = await executeEscrowDispute({
          chain: this.chain,
          signer: party,
          escrowDealId: BigInt(view.deal.escrow!.escrowDealId),
          journal: this.journal,
          submitted: hashes.DISPUTE,
        });
        await s.recordDispute({ dealId: op.dealId, execution: record(exec) });
      } else {
        const call = revive<EscrowCall>(op.data.call);
        const granted = {
          chain: this.chain,
          signer: party,
          grant: op.data.grant!,
          grantKey: this.authority.grantKey,
          fence: this.fence,
          journal: this.journal,
          mandateRevoked: false,
          now: this.now(),
          submitted: hashes,
        };
        if (call.op === 'OPEN') {
          const exec = await executeEscrowOpen({ ...granted, call });
          const d = await readEscrowDeal(
            this.chain,
            call.escrow,
            exec.escrowDealId,
          );
          await s.recordFunded({
            dealId: op.dealId,
            execution: record(exec),
            chain: {
              token: call.token,
              payer: d.payer,
              payee: d.payee,
              arbiter: d.arbiter,
              refundAfter: d.refundAfter,
              termsHash: d.termsHash,
              milestones: d.milestones,
            },
          });
        } else if (call.op === 'RELEASE') {
          const exec = await executeEscrowRelease({ ...granted, call });
          await s.recordReleased({
            dealId: op.dealId,
            milestone: call.index,
            execution: record(exec),
          });
        } else {
          const exec = await executeEscrowRefund({ ...granted, call });
          await s.recordRefunded({
            dealId: op.dealId,
            milestone: call.index,
            execution: record(exec),
          });
        }
      }
      await this.save(key, 'DONE', {
        ...op.data,
        execution: { txs: Object.values(hashes).filter(Boolean) as string[] },
      });
    } catch (error) {
      const reason = (error instanceof Error ? error.message : 'error').slice(
        0,
        300,
      );
      if (op.op === 'FUND' && view.deal.status === 'FUNDING') {
        // Back to ACCEPTED only with chain proof that no escrow deal opened.
        const call = revive<EscrowCall>(op.data.call);
        const probe = await probeEscrowFunding(this.chain, {
          openHash: hashes.OPEN ?? null,
          payer: op.sender,
          termsHash: call.termsHash,
          fromBlock: BigInt(op.data.fromBlock),
        }).catch(() => null);
        await s
          .fundingFailed(op.dealId, {
            reason,
            broadcast: Object.entries(hashes).map(([step, hash]) => ({
              step,
              hash: hash!,
            })),
            ...(probe ? { chain: probe } : {}),
          })
          .catch(() => undefined);
        await this.save(key, 'FAILED', op.data, reason);
      } else await this.save(key, 'GRANTED', op.data, reason);
      throw error;
    }
    return this.deals.get(workspaceId, principalId, op.dealId);
  }
}
