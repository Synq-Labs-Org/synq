import { z } from 'zod';
import { IdSchema, TimestampSchema } from './common.js';

/*
 * Native device sessions. Sign-in reuses the /v2 EIP-712 login challenge with
 * audience "native"; the signature proves wallet ownership only and never
 * approves money. A device session pairs a short access token with a rotating
 * refresh token; reusing an old refresh token revokes the whole device session.
 */

const Token = z.string().regex(/^[0-9a-f]{64}$/);

export const DeviceSchema = z.strictObject({
  deviceId: IdSchema.describe('Random per-install id kept in the Keychain'),
  name: z.string().trim().min(1).max(64),
  platform: z.enum(['ios', 'web']),
});

export const DeviceSessionRequestSchema = z.strictObject({
  challengeId: IdSchema,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  device: DeviceSchema,
});

/** Same device session, from a one-time code made by a signed-in web session (/v2/auth/native-code). */
export const DeviceCodeSessionRequestSchema = z.strictObject({
  code: z.string().regex(/^[0-9a-f]{48}$/),
  device: DeviceSchema,
});

export const RefreshRequestSchema = z.strictObject({
  deviceId: IdSchema,
  refreshToken: Token,
});

export const DeviceSessionSchema = z.strictObject({
  principalId: z.string().max(80),
  sessionId: IdSchema,
  accessToken: Token,
  accessExpiresAt: TimestampSchema,
  refreshToken: Token,
  refreshExpiresAt: TimestampSchema,
});

export const SessionSummarySchema = z.strictObject({
  sessionId: IdSchema,
  deviceName: z.string().max(64),
  platform: z.enum(['ios', 'web']),
  createdAt: TimestampSchema,
  lastSeenAt: TimestampSchema,
  current: z.boolean(),
});
export const SessionListSchema = z.strictObject({
  sessions: z.array(SessionSummarySchema),
});
export const RevokeAllSchema = z.strictObject({
  revoked: z.number().int().min(0),
});
