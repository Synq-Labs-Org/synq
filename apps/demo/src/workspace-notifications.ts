import { formatUnits } from 'viem';
import { z } from 'zod';
import { arcCardBase, ContractorPaymentCardSchema } from '@synq/schemas';
import { renderTelegramCard } from '@synq/channels/cards';
import { PostgresDeliveryQueue } from '@synq/channels/durable-delivery';
import type { ChannelAdapter } from '@synq/channels';
import { riskHoldCard, type RiskCase } from '@synq/plugin-risk';
import type { WorkspaceChannelLinks } from '@synq/workspaces';
import type { WorkspacePayouts } from '@synq/workspaces/payouts';

const Destination = z.strictObject({
  channel: z.literal('telegram'),
  kind: z.enum(['DIRECT', 'GROUP']),
  chatId: z.string().regex(/^-?[1-9][0-9]{0,19}$/),
});
export class WorkspaceNotifications {
  readonly queue: PostgresDeliveryQueue;
  constructor(
    readonly links: WorkspaceChannelLinks,
    readonly payouts: WorkspacePayouts,
    readonly mode: 'LIVE_ARC_TESTNET' | 'LOCAL_FIXTURE',
  ) {
    this.queue = new PostgresDeliveryQueue(
      links.workspaces.pool,
      links.workspaces.now,
    );
  }
  async authorized(workspaceId: string, chatId: string) {
    const r = await this.links.workspaces.pool.query(
      "SELECT destination,identity_link_id FROM synq_ws_channel_bindings WHERE workspace_id=$1 AND channel='telegram' AND destination->>'chatId'=$2",
      [workspaceId, chatId],
    );
    const binding = r.rows[0];
    if (!binding) return false;
    const dest = Destination.parse(binding.destination);
    const proof = (await this.links.identity.listLinks(workspaceId)).find(
      (v) => v.linkId === binding.identity_link_id && v.unlinkedAt === null,
    );
    if (!proof) return false;
    return (
      (await this.links.resolve(dest.chatId, dest.kind, proof.channelUserId))
        ?.workspaceId === workspaceId
    );
  }
  private async enqueue(
    eventId: string,
    workspaceId: string,
    message: ReturnType<typeof renderTelegramCard>,
  ) {
    const rows = await this.links.workspaces.pool.query(
      "SELECT destination FROM synq_ws_channel_bindings WHERE workspace_id=$1 AND channel='telegram'",
      [workspaceId],
    );
    let enqueued = false;
    for (const r of rows.rows) {
      const destination = Destination.parse(r.destination);
      if (!(await this.authorized(workspaceId, destination.chatId))) continue;
      await this.queue.enqueue({
        eventId,
        workspaceId,
        channel: 'telegram',
        destination: destination.chatId,
        message: { ...message, idempotencyKey: eventId },
      });
      enqueued = true;
    }
    return enqueued;
  }
  async relay() {
    const pool = this.links.workspaces.pool;
    const events = await pool.query(
      "SELECT o.event_id,o.payload,w.display_name,w.threshold,p.executed_at FROM synq_event_outbox o JOIN synq_workspaces w ON w.id::text=o.payload->>'workspaceId' JOIN synq_ws_payouts p ON p.id::text=o.payload->>'payoutId' WHERE o.published_at IS NULL AND o.topic='workspace.money' AND p.state='PAID' ORDER BY o.seq LIMIT 20",
    );
    for (const e of events.rows) {
      const payload = z
        .object({
          kind: z.literal('PAYOUT_SENT'),
          workspaceId: z.string().uuid(),
          payoutId: z.string().uuid(),
          txHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        })
        .parse(e.payload);
      const payout = await this.payouts.record(payload.payoutId);
      if (
        !payout ||
        payout.state !== 'PAID' ||
        payout.data.workspaceId !== payload.workspaceId ||
        payout.txHash !== payload.txHash
      )
        continue;
      const p = payout.data,
        at = Number(e.executed_at);
      const card = ContractorPaymentCardSchema.parse({
        ...arcCardBase(
          {
            groupId: p.workspaceId,
            groupLabel: String(e.display_name),
            issuedAt: at,
            executionMode: this.mode,
            actions: [
              {
                kind: 'EXPLORER',
                label: 'View receipt',
                url: `https://explorer.testnet.arc.io/tx/${payout.txHash}`,
                style: 'SECONDARY',
              },
            ],
          },
          at,
          'payout',
          p.id,
          payout.txHash!,
        ),
        type: 'CONTRACTOR_PAYMENT',
        chainId: 5042002,
        paymentId: p.id,
        recipient: {
          label: 'Verified supplier',
          address: p.recipient,
          verified: true,
        },
        amount: { amount: formatUnits(BigInt(p.amount), 6), symbol: 'USDC' },
        route: 'VAULT_POLICY_PAY',
        obligationRef: null,
        approvals: {
          counted: Object.keys(payout.signatures).length,
          required: Number(e.threshold),
        },
        status: 'CONFIRMED',
        transactionHash: payout.txHash,
        evidenceHash: p.vendorChangeHash,
      });
      if (
        await this.enqueue(
          String(e.event_id),
          p.workspaceId,
          renderTelegramCard(card),
        )
      )
        await pool.query(
          'UPDATE synq_event_outbox SET published_at=now() WHERE event_id=$1',
          [e.event_id],
        );
    }
    const cases = await pool.query(
      "SELECT c.data,w.display_name FROM synq_risk_cases c JOIN synq_workspaces w ON w.id::text=c.workspace_id WHERE c.status IN ('HELD','IN_REVIEW','APPEALED','BLOCKED') ORDER BY c.case_id LIMIT 100",
    );
    for (const row of cases.rows) {
      const c = row.data as RiskCase;
      const at = Math.max(c.openedAt, ...c.events.map((e) => e.at));
      const card = riskHoldCard(c, {
        groupId: c.workspaceId,
        groupLabel: String(row.display_name),
        issuedAt: at,
        executionMode: this.mode,
        chainId: 5042002,
        subjectLabel: 'Workspace payout',
      });
      await this.enqueue(
        `risk:${c.caseId}:${c.rev}`,
        c.workspaceId,
        renderTelegramCard(card),
      );
    }
  }
  async pump(adapter: ChannelAdapter) {
    await this.relay();
    return this.queue.pump(adapter, (ws, dest) => this.authorized(ws, dest));
  }
}
