import { PostgresSplitStore, allocationCard } from '@synq/allocations';
import { formatUnits } from 'viem';
import { z } from 'zod';
import {
  arcCardBase,
  ContractorPaymentCardSchema,
  InvoiceCardSchema,
} from '@synq/schemas';
import { renderTelegramCard } from '@synq/channels/cards';
import { PostgresDeliveryQueue } from '@synq/channels/durable-delivery';
import type { ChannelAdapter } from '@synq/channels';
import { riskHoldCard, redact, type RiskCase } from '@synq/plugin-risk';
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
  async deliveryAuthorized(
    workspaceId: string,
    destination: string,
    eventId: string,
  ) {
    if (!(await this.authorized(workspaceId, destination))) return false;
    if (eventId.startsWith('allocation:')) {
      const parts = eventId.split(':');
      const row = await this.links.workspaces.pool.query(
        'SELECT r.state,s.rev FROM synq_alloc_splits s JOIN synq_ws_receipts r ON r.key=s.receipt_id WHERE s.split_id=$1 AND s.workspace_id=$2',
        [parts[1], workspaceId],
      );
      return (
        row.rows[0]?.state === parts[3] && String(row.rows[0]?.rev) === parts[2]
      );
    }
    if (!eventId.startsWith('invoice.payment_applied:')) return true;
    const row = await this.links.workspaces.pool.query(
      'SELECT state FROM synq_ws_receipts WHERE workspace_id=$1 AND key=$2',
      [workspaceId, eventId.slice('invoice.payment_applied:'.length)],
    );
    return row.rows[0]?.state === 'PENDING_POLICY';
  }
  private async defer(eventId: string) {
    await this.links.workspaces.pool.query(
      'INSERT INTO synq_ws_notification_deferred(event_id,next_at) VALUES($1,$2) ON CONFLICT(event_id) DO UPDATE SET next_at=EXCLUDED.next_at',
      [eventId, this.links.workspaces.now() + 60],
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
  async relayInvoices() {
    const pool = this.links.workspaces.pool;
    const events = await pool.query(
      "SELECT o.event_id,o.payload FROM synq_event_outbox o JOIN synq_workspaces w ON w.id::text=o.payload->>'workspaceId' LEFT JOIN synq_ws_notification_deferred d ON d.event_id=o.event_id WHERE o.published_at IS NULL AND o.topic='invoice.payment_applied' AND COALESCE(d.next_at,0)<=$1 ORDER BY o.seq LIMIT 20",
      [this.links.workspaces.now()],
    );
    for (const row of events.rows) {
      const e = z
        .object({
          workspaceId: z.string().uuid(),
          invoiceId: z.string(),
          occurredAt: z.number().int().nonnegative(),
          card: z.record(z.string(), z.unknown()),
        })
        .parse(row.payload);
      const proof = await pool.query(
        'SELECT state FROM synq_ws_receipts WHERE workspace_id=$1 AND key=$2',
        [
          e.workspaceId,
          String(row.event_id).slice('invoice.payment_applied:'.length),
        ],
      );
      if (proof.rows[0]?.state !== 'PENDING_POLICY') {
        await this.defer(String(row.event_id));
        continue;
      }
      const content = e.card;
      const issuer = z
        .object({ label: z.string(), address: z.string() })
        .parse(content.issuer);
      const label = (s: string) => {
        const clean = redact(s).value;
        return typeof clean === 'string'
          ? clean.replace(/[\r\n]/g, ' ').slice(0, 120)
          : '[REDACTED]';
      };
      const card = InvoiceCardSchema.parse({
        ...arcCardBase(
          {
            groupId: e.workspaceId,
            groupLabel: label(issuer.label),
            issuedAt: e.occurredAt,
            executionMode: this.mode,
            actions: [],
          },
          e.occurredAt,
          'invoice-receipt',
          row.event_id,
        ),
        ...content,
        issuer: { ...issuer, label: label(issuer.label) },
        number: label(z.string().parse(content.number)).slice(0, 40),
        payer: label(z.string().parse(content.payer)),
      });
      if (card.invoiceId !== e.invoiceId)
        throw new Error('INVOICE_EVENT_SCOPE_MISMATCH');
      if (
        await this.enqueue(
          String(row.event_id),
          e.workspaceId,
          renderTelegramCard(card),
        )
      )
        await pool.query(
          'UPDATE synq_event_outbox SET published_at=now() WHERE event_id=$1',
          [row.event_id],
        );
      else await this.defer(String(row.event_id));
    }
  }
  async relayAllocations() {
    const pool = this.links.workspaces.pool,
      store = new PostgresSplitStore(pool);
    const rows = await pool.query(
      "SELECT s.split_id,s.workspace_id,r.state,w.display_name FROM synq_alloc_splits s JOIN synq_ws_receipts r ON r.key=s.receipt_id JOIN synq_workspaces w ON w.id::text=s.workspace_id LEFT JOIN synq_ws_notification_deferred d ON d.event_id='allocation:'||s.split_id||':'||s.rev::text||':'||r.state WHERE COALESCE(d.next_at,0)<=$1 AND NOT EXISTS(SELECT 1 FROM synq_durable_delivery q WHERE q.event_id='allocation:'||s.split_id||':'||s.rev::text||':'||r.state) ORDER BY s.created_at LIMIT 20",
      [this.links.workspaces.now()],
    );
    for (const row of rows.rows) {
      const split = await store.get(row.split_id);
      if (!split) continue;
      const eventId = `allocation:${split.splitId}:${split.rev}:${row.state}`;
      const card = allocationCard(
        {
          split,
          legs: await store.legs(split.splitId),
          reservations: await store.reservations(
            `${split.receipt.chainId}:${split.receipt.token.toLowerCase()}:${split.receipt.recipient.toLowerCase()}`,
          ),
          receiptReview: row.state === 'REVIEW',
        },
        {
          groupId: row.workspace_id,
          groupLabel: String(row.display_name),
          issuedAt: split.updatedAt,
          executionMode: this.mode,
        },
      );
      if (
        !(await this.enqueue(
          eventId,
          row.workspace_id,
          renderTelegramCard(card),
        ))
      )
        await this.defer(eventId);
    }
  }
  async relay() {
    await this.relayInvoices();
    await this.relayAllocations();
    const pool = this.links.workspaces.pool;
    const events = await pool.query(
      "SELECT o.event_id,o.payload,w.display_name,w.threshold,p.executed_at FROM synq_event_outbox o JOIN synq_workspaces w ON w.id::text=o.payload->>'workspaceId' JOIN synq_ws_payouts p ON p.id::text=o.payload->>'payoutId' LEFT JOIN synq_ws_notification_deferred d ON d.event_id=o.event_id WHERE o.published_at IS NULL AND o.topic='workspace.money' AND p.state='PAID' AND COALESCE(d.next_at,0)<=$1 ORDER BY o.seq LIMIT 20",
      [this.links.workspaces.now()],
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
      else await this.defer(String(e.event_id));
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
    return this.queue.pump(adapter, (ws, dest, eventId) =>
      this.deliveryAuthorized(ws, dest, eventId),
    );
  }
}
