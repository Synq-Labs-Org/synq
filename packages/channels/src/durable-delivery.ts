import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { InteractiveCardSchema } from '@synq/schemas';
import {
  applyMigrations,
  withTransaction,
  type SqlPool,
} from '@synq/domain/pg';
import {
  ChannelDeliveryError,
  type ChannelAdapter,
  type OutboundMessage,
} from './events.js';

const MessageSchema = z.strictObject({
  text: z.string().min(1).max(4096),
  card: InteractiveCardSchema.optional(),
  buttons: z
    .array(z.strictObject({ label: z.string().max(80), url: z.string().url() }))
    .max(4)
    .optional(),
  idempotencyKey: z.string().max(200).optional(),
});
export const DELIVERY_MIGRATIONS = [
  {
    version: 1,
    up: `CREATE TABLE synq_durable_delivery(id text PRIMARY KEY,event_id text NOT NULL,workspace_id text NOT NULL,channel text NOT NULL,destination text NOT NULL,message jsonb NOT NULL,state text NOT NULL CHECK(state IN ('QUEUED','SENDING','RETRY','SENT','UNKNOWN','REVOKED','FAILED')),lease text,lease_until bigint,attempts int NOT NULL DEFAULT 0,next_at bigint NOT NULL DEFAULT 0,message_id text,last_error text,UNIQUE(event_id,channel,destination));
CREATE FUNCTION synq_delivery_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id<>OLD.id OR NEW.event_id<>OLD.event_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.channel<>OLD.channel OR NEW.destination<>OLD.destination OR NEW.message<>OLD.message THEN RAISE EXCEPTION 'delivery terms are immutable'; END IF; RETURN NEW; END $$;
CREATE TRIGGER synq_delivery_guard BEFORE UPDATE ON synq_durable_delivery FOR EACH ROW EXECUTE FUNCTION synq_delivery_immutable();`,
    down: 'DROP TABLE synq_durable_delivery; DROP FUNCTION synq_delivery_immutable();',
  },
] as const;

/** Money commits before enqueue. An ambiguous provider result is held for review, never re-sent blindly. */
export class PostgresDeliveryQueue {
  constructor(
    readonly pool: SqlPool,
    readonly now: () => number = () => Math.floor(Date.now() / 1000),
  ) {}
  async migrate(target = 1) {
    return applyMigrations(
      this.pool,
      'synq_delivery_migrations',
      DELIVERY_MIGRATIONS,
      target,
    );
  }
  async enqueue(input: {
    eventId: string;
    workspaceId: string;
    channel: 'telegram' | 'imessage';
    destination: string;
    message: OutboundMessage;
  }) {
    const message = MessageSchema.parse(input.message);
    if (
      !input.eventId ||
      input.eventId.length > 200 ||
      !input.workspaceId ||
      input.workspaceId.length > 100 ||
      !input.destination ||
      input.destination.length > 200
    )
      throw new Error('INVALID_DELIVERY');
    const r = await this.pool.query(
      "INSERT INTO synq_durable_delivery(id,event_id,workspace_id,channel,destination,message,state) VALUES($1,$2,$3,$4,$5,$6,'QUEUED') ON CONFLICT(event_id,channel,destination) DO NOTHING RETURNING id",
      [
        randomUUID(),
        input.eventId,
        input.workspaceId,
        input.channel,
        input.destination,
        message,
      ],
    );
    if (r.rows[0]) return String(r.rows[0].id);
    const existing = await this.pool.query(
      'SELECT id,workspace_id,message FROM synq_durable_delivery WHERE event_id=$1 AND channel=$2 AND destination=$3',
      [input.eventId, input.channel, input.destination],
    );
    if (
      existing.rows[0]?.workspace_id !== input.workspaceId ||
      JSON.stringify(existing.rows[0]?.message) !==
        JSON.stringify(JSON.parse(JSON.stringify(message)))
    ) {
      // jsonb canonical key ordering differs from JavaScript ordering; compare canonical forms.
      const equal = await this.pool.query(
        'SELECT id FROM synq_durable_delivery WHERE event_id=$1 AND channel=$2 AND destination=$3 AND workspace_id=$4 AND message=$5::jsonb',
        [
          input.eventId,
          input.channel,
          input.destination,
          input.workspaceId,
          message,
        ],
      );
      if (!equal.rows[0]) throw new Error('DELIVERY_IDEMPOTENCY_CONFLICT');
    }
    return String(existing.rows[0]!.id);
  }
  async pump(
    adapter: ChannelAdapter,
    authorized: (
      workspaceId: string,
      destination: string,
      eventId: string,
    ) => Promise<boolean>,
  ) {
    const claimed = await withTransaction(this.pool, async (sql) => {
      await sql.query(
        "UPDATE synq_durable_delivery SET state='UNKNOWN',last_error='WORKER_OUTCOME_UNKNOWN' WHERE channel=$1 AND state='SENDING' AND lease_until<=$2",
        [adapter.channel, this.now()],
      );
      const r = await sql.query(
        "SELECT * FROM synq_durable_delivery WHERE channel=$1 AND state IN ('QUEUED','RETRY') AND next_at<=$2 ORDER BY next_at,id FOR UPDATE SKIP LOCKED LIMIT 1",
        [adapter.channel, this.now()],
      );
      const row = r.rows[0];
      if (!row) return null;
      const lease = randomUUID();
      await sql.query(
        "UPDATE synq_durable_delivery SET state='SENDING',lease=$2,lease_until=$3,attempts=attempts+1 WHERE id=$1",
        [row.id, lease, this.now() + 120],
      );
      return { ...row, lease } as Record<string, unknown> & { lease: string };
    });
    if (!claimed) return false;
    const finish = async (
      state: string,
      reason: string | null,
      messageId: string | null = null,
    ) =>
      this.pool.query(
        "UPDATE synq_durable_delivery SET state=$3,last_error=$4,message_id=$5,next_at=$6 WHERE id=$1 AND lease=$2 AND state='SENDING'",
        [
          claimed.id,
          claimed.lease,
          state,
          reason,
          messageId,
          this.now() + Math.min(3600, 30 * 2 ** Number(claimed.attempts)),
        ],
      );
    try {
      if (
        !(await authorized(
          String(claimed.workspace_id),
          String(claimed.destination),
          String(claimed.event_id),
        ))
      ) {
        await finish('REVOKED', 'CHANNEL_PROOF_REVOKED');
        return true;
      }
      const result = await adapter.send(
        String(claimed.destination),
        MessageSchema.parse(claimed.message),
      );
      await finish('SENT', null, result.messageId);
    } catch (error) {
      // Only an explicit rate-limit or provider rejection proves non-delivery.
      const safe =
        error instanceof ChannelDeliveryError &&
        ['RATE_LIMITED', 'PROVIDER_REJECTED', 'CHANNEL_UNAVAILABLE'].includes(
          error.code,
        );
      await finish(
        safe ? (Number(claimed.attempts) >= 4 ? 'FAILED' : 'RETRY') : 'UNKNOWN',
        error instanceof ChannelDeliveryError
          ? error.code
          : 'PROVIDER_OUTCOME_UNKNOWN',
      );
    }
    return true;
  }
  async status(workspaceId: string) {
    return (
      await this.pool.query(
        'SELECT event_id,channel,state,attempts,last_error FROM synq_durable_delivery WHERE workspace_id=$1 ORDER BY id LIMIT 100',
        [workspaceId],
      )
    ).rows;
  }
}
