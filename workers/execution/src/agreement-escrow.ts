import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import {
  escrowTotal,
  validateEscrowCall,
  type EscrowOpenCall,
} from '@synq/kernel/arc-escrow';
import { WorkspaceError } from '@synq/workspaces';
import type {
  AgreementRow,
  WorkspaceAgreements,
} from '@synq/workspaces/agreements';
import type { ProofLevel } from '@synq/workspaces/agent-events';
import type { ArcChain } from './arc.js';
import {
  escrowCalldata,
  mustTransfer,
  readEscrowDeal,
  usdcTransfers,
  verifyEscrow,
} from './escrow.js';
import { MILESTONE_ESCROW_ABI } from './vault.js';

/*
 * Escrow funding for an agreement signed by an outside client. The server
 * prepares the exact approve and open calls from the signed agreement; the
 * client's own wallet broadcasts them (the server never signs for the
 * client). The client then submits the open transaction hash and the server
 * proves it before anything is recorded: the transaction is from the client
 * wallet to the registry escrow with exactly the prepared calldata, it is
 * mined and succeeded, the escrow's DealOpened event and the escrow's own
 * stored deal carry the agreed payee, arbiter, terms hash and milestone
 * amounts, and exactly the total moved from the client into the escrow.
 * A transaction without a receipt is only pending; a CCTP burn, a wrong
 * amount or a different payee never matches and never marks the deal funded.
 */

export type EscrowTarget = {
  escrow: Address;
  token: Address;
  chainId: number;
  /** LIVE_ARC_TESTNET only when the escrow's code was verified against the registry pin. */
  proofLevel: ProofLevel;
};

const lower = (a: string) => a.toLowerCase();
/** After the last milestone is due, the client can take back unreleased funds. */
const REFUND_GRACE_DAYS = 30;
const iso = (s: number) => new Date(s * 1000).toISOString();

export class AgreementEscrow {
  constructor(
    readonly agreements: WorkspaceAgreements,
    private readonly client: PublicClient,
    private readonly target: () => Promise<EscrowTarget>,
  ) {}

  /** The registry escrow, its code checked against the pinned hash. */
  static forChain(agreements: WorkspaceAgreements, chain: ArcChain) {
    return new AgreementEscrow(agreements, chain.client, async () => {
      const e = await verifyEscrow(chain);
      return {
        escrow: e.address,
        token: e.token,
        chainId: chain.profile.chainId,
        proofLevel: 'LIVE_ARC_TESTNET' as const,
      };
    });
  }

  private openCall(a: AgreementRow, t: EscrowTarget, refundAfter: number) {
    const f = a.fields;
    const call: EscrowOpenCall = {
      op: 'OPEN',
      chainId: t.chainId,
      escrow: t.escrow,
      token: t.token,
      sender: f.clientWallet,
      termsHash: a.agreementHash,
      payee: f.payee,
      arbiter: f.arbiter,
      refundAfter,
      amounts: f.milestones.map((m) => BigInt(m.units)),
    };
    validateEscrowCall(call);
    return call;
  }

  /** Step 1: the exact calls the client wallet sends, in order. */
  async prepare(principalId: string, leadId: string) {
    const { agreement: a } = await this.agreements.forFunding(
      principalId,
      leadId,
    );
    if (a.status === 'FUNDED')
      throw new WorkspaceError('AGREEMENT_ALREADY_FUNDED', 409);
    const t = await this.target();
    const now = this.agreements.store.now();
    const f = a.fields;
    let prepared = a.funding?.prepared;
    const usable =
      prepared &&
      lower(prepared.escrow) === lower(t.escrow) &&
      lower(prepared.token) === lower(t.token) &&
      prepared.chainId === t.chainId &&
      prepared.refundAfter > now + 3600;
    if (!usable) {
      if (a.expiresAt <= now)
        throw new WorkspaceError('AGREEMENT_EXPIRED', 409);
      const total = escrowTotal(f.milestones.map((m) => BigInt(m.units)));
      const balance = await this.client.readContract({
        address: t.token,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [f.clientWallet],
      });
      if (balance < total) throw new WorkspaceError('INSUFFICIENT_FUNDS', 409);
      const refundAfter = now + (f.deliveryDays + REFUND_GRACE_DAYS) * 86400;
      const call = this.openCall(a, t, refundAfter);
      prepared = {
        refundAfter,
        escrow: t.escrow,
        token: t.token,
        chainId: t.chainId,
        openData: escrowCalldata.open(call),
        approveData: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: [t.escrow, total],
        }),
      };
      await this.agreements.savePrepared(a.id, prepared);
    }
    const p = prepared!;
    return {
      agreementId: a.id,
      chainId: t.chainId,
      from: f.clientWallet,
      transactions: [
        {
          step: 'APPROVE' as const,
          label: 'Allow the escrow to take exactly the deal total',
          to: getAddress(p.token),
          data: p.approveData,
          value: '0' as const,
        },
        {
          step: 'OPEN' as const,
          label: 'Fund the milestone escrow',
          to: getAddress(p.escrow),
          data: p.openData,
          value: '0' as const,
        },
      ],
      refundAfter: iso(p.refundAfter),
    };
  }

  /** Step 2: the hash of the open transaction the client wallet broadcast. */
  async submit(principalId: string, leadId: string, openTxHash: string) {
    const { agreement: a } = await this.agreements.forFunding(
      principalId,
      leadId,
    );
    const hash = openTxHash.toLowerCase() as Hex;
    if (a.status === 'FUNDED') {
      if (a.openTxHash?.toLowerCase() !== hash)
        throw new WorkspaceError('AGREEMENT_ALREADY_FUNDED', 409);
      return this.agreements.view(a);
    }
    const prepared = a.funding?.prepared;
    if (a.status !== 'FUNDING_PENDING' || !prepared)
      throw new WorkspaceError('ESCROW_NOT_PREPARED', 409);
    const t = await this.target();
    if (
      lower(prepared.escrow) !== lower(t.escrow) ||
      lower(prepared.token) !== lower(t.token) ||
      prepared.chainId !== t.chainId
    )
      throw new WorkspaceError('ESCROW_TARGET_CHANGED', 409);
    const f = a.fields;
    const amounts = f.milestones.map((m) => BigInt(m.units));
    const total = escrowTotal(amounts);
    // The calldata is rebuilt from the signed fields, never trusted from storage alone.
    const expected = escrowCalldata.open(
      this.openCall(a, t, prepared.refundAfter),
    );
    if (lower(expected) !== lower(prepared.openData))
      throw new WorkspaceError('ESCROW_MISMATCH', 422);

    const tx = await this.client.getTransaction({ hash }).catch(() => null);
    if (!tx) throw new WorkspaceError('TX_NOT_FOUND', 409);
    if (
      lower(tx.from) !== lower(f.clientWallet) ||
      lower(tx.to ?? '0x') !== lower(t.escrow) ||
      lower(tx.input) !== lower(expected) ||
      (tx.value ?? 0n) !== 0n ||
      (tx.chainId !== undefined && tx.chainId !== (await this.chainId()))
    )
      throw new WorkspaceError('ESCROW_TX_MISMATCH', 422);

    const receipt = await this.client
      .getTransactionReceipt({ hash })
      .catch(() => null);
    if (!receipt) {
      // Broadcast but not mined: nothing is funded yet.
      return this.agreements.view(
        await this.agreements.savePending(a.id, hash),
      );
    }
    if (receipt.status !== 'success')
      throw new WorkspaceError('ESCROW_TX_REVERTED', 422);
    const events = parseEventLogs({
      abi: MILESTONE_ESCROW_ABI,
      eventName: 'DealOpened',
      logs: receipt.logs,
    }).filter((l) => lower(l.address) === lower(t.escrow));
    const ev = events[0];
    if (
      events.length !== 1 ||
      !ev ||
      lower(ev.args.payer) !== lower(f.clientWallet) ||
      lower(ev.args.payee) !== lower(f.payee) ||
      lower(ev.args.arbiter) !== lower(f.arbiter) ||
      lower(ev.args.termsHash) !== lower(a.agreementHash) ||
      ev.args.total !== total ||
      ev.args.refundAfter !== BigInt(prepared.refundAfter)
    )
      throw new WorkspaceError('ESCROW_MISMATCH', 422);
    try {
      mustTransfer('escrow open', usdcTransfers(receipt, t.token), {
        from: f.clientWallet,
        to: t.escrow,
        value: total,
      });
    } catch {
      throw new WorkspaceError('ESCROW_MISMATCH', 422);
    }
    // The escrow's own stored deal, read back from chain state.
    const state = await readEscrowDeal(
      { client: this.client } as ArcChain,
      t.escrow,
      ev.args.dealId,
    );
    if (
      lower(state.payer) !== lower(f.clientWallet) ||
      lower(state.payee) !== lower(f.payee) ||
      lower(state.arbiter) !== lower(f.arbiter) ||
      lower(state.termsHash) !== lower(a.agreementHash) ||
      state.milestones.length !== amounts.length ||
      state.milestones.some(
        (m, i) => m.amount !== amounts[i] || m.status !== 'Funded',
      )
    )
      throw new WorkspaceError('ESCROW_MISMATCH', 422);
    const funded = await this.agreements.markFunded(a.id, {
      openTxHash: hash,
      escrowDealId: String(ev.args.dealId),
      proofLevel: t.proofLevel,
    });
    return this.agreements.view(funded);
  }

  private async chainId() {
    return this.client.getChainId();
  }
}
