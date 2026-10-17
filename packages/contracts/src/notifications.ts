import { z } from 'zod';
import { CursorSchema, IdSchema, TimestampSchema, pageOf } from './common.js';

/*
 * Notifications, push devices and the live event stream. Push payloads carry
 * only a category and an opaque event id; details are fetched after sign-in
 * and a membership check. A device token never authenticates anything.
 */

export const NotificationCategorySchema = z.enum([
  'NEW_LEAD',
  'OFFER_ACCEPTED',
  'CLIENT_DEPOSIT_FINALIZED',
  'AGENT_PAYMENT_FINALIZED',
  'PAYMENT_BLOCKED',
  'RISK_REVIEW',
  'ESCROW_DISPUTED',
  'CIRCLE_CONTRIBUTION_RECEIVED',
  'FUND_PROPOSAL',
  'APPROVAL_REQUESTED',
  'LEASE_EXPIRING',
  'SECURITY_PAUSE',
]);

export const NotificationSchema = z.strictObject({
  notificationId: IdSchema,
  eventId: IdSchema,
  category: NotificationCategorySchema,
  workspaceId: IdSchema.nullable(),
  title: z
    .string()
    .max(120)
    .describe('Generic; never a name, price or address'),
  deepLink: z
    .string()
    .regex(/^\/[A-Za-z0-9/_-]{1,200}$/)
    .describe('Path on the web host'),
  createdAt: TimestampSchema,
  readAt: TimestampSchema.nullable(),
});
export const NotificationPageSchema = z.strictObject({
  items: z.array(NotificationSchema),
  nextCursor: CursorSchema.nullable(),
  unreadCount: z.number().int().min(0),
});
export const MarkReadSchema = z.strictObject({
  notificationIds: z.array(IdSchema).min(1).max(200),
});

export const DeviceRegistrationSchema = z.strictObject({
  deviceId: IdSchema,
  apnsToken: z.string().regex(/^[0-9a-f]{64,200}$/),
  environment: z.enum(['SANDBOX', 'PRODUCTION']),
  locale: z.string().max(20),
  mutedCategories: z.array(NotificationCategorySchema),
  quietHours: z
    .strictObject({
      start: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
      end: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/),
      timeZone: z.string().max(60),
    })
    .nullable(),
});
export const DeviceRegisteredSchema = z.strictObject({
  deviceId: IdSchema,
  registeredAt: TimestampSchema,
});

/**
 * One server-sent event (`GET /v3/events`, `text/event-stream`). The SSE `id`
 * is `cursor`; reconnect with `?cursor=` (or Last-Event-ID) to replay. Events
 * only say what changed; clients refetch the entity. Duplicates share eventId.
 */
export const StreamEventSchema = z.strictObject({
  cursor: CursorSchema,
  eventId: IdSchema,
  type: z.enum([
    'LEAD_UPDATED',
    'LEAD_MESSAGE',
    'OFFER_UPDATED',
    'AGENT_EVENT',
    'APPROVAL_CHANGED',
    'BALANCE_CHANGED',
    'NOTIFICATION',
    'CONTEXT_REVOKED',
  ]),
  workspaceId: IdSchema.nullable(),
  entityId: z.string().max(80).nullable(),
  observedAt: TimestampSchema,
});
export const StreamEventPageSchema = pageOf(StreamEventSchema);
