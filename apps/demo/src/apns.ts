import { createPrivateKey, sign, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { connect } from 'node:http2';
import type { PushSender } from '@synq/workspaces/notifications';

/*
 * Apple Push Notification service sender: token-based auth (ES256 JWT from a
 * .p8 key), HTTP/2 to the sandbox or production host chosen per device. The
 * transport is injected so tests never reach Apple. The payload is built here
 * from a fixed shape (generic title, category, event id); nothing else can
 * enter it. Tokens and keys are never logged.
 */

export type ApnsRequest = {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
};
export type ApnsTransport = (
  request: ApnsRequest,
) => Promise<{ status: number; reason?: string }>;

export const APNS_HOSTS = {
  SANDBOX: 'api.sandbox.push.apple.com',
  PRODUCTION: 'api.push.apple.com',
} as const;

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** Default transport: one HTTP/2 request per push, with a timeout. */
export const http2Transport: ApnsTransport = (req) =>
  new Promise((resolve, reject) => {
    const session = connect(`https://${req.host}`);
    const done = (fn: () => void) => {
      session.close();
      fn();
    };
    session.setTimeout(10_000, () =>
      done(() => reject(new Error('APNS_TIMEOUT'))),
    );
    session.on('error', (e) => done(() => reject(e)));
    const stream = session.request({
      ':method': 'POST',
      ':path': req.path,
      ...req.headers,
    });
    let status = 0;
    const chunks: Buffer[] = [];
    stream.on('response', (h) => {
      status = Number(h[':status']);
    });
    stream.on('data', (c: Buffer) => chunks.push(c));
    stream.on('error', (e) => done(() => reject(e)));
    stream.on('end', () => {
      let reason: string | undefined;
      try {
        reason = JSON.parse(Buffer.concat(chunks).toString()).reason;
      } catch {
        reason = undefined;
      }
      done(() => resolve({ status, ...(reason ? { reason } : {}) }));
    });
    stream.end(req.body);
  });

export class ApnsSender implements PushSender {
  private key: KeyObject | null | undefined;
  private jwt: { value: string; at: number } | null = null;

  constructor(
    private readonly options: {
      env?: Record<string, string | undefined>;
      transport?: ApnsTransport;
      /** Epoch seconds. */
      now?: () => number;
      /** Reads the key file; injectable for tests. */
      readKey?: (path: string) => string;
    } = {},
  ) {}

  private get env() {
    return this.options.env ?? process.env;
  }

  private config() {
    const e = this.env;
    const missing = [
      'SYNQ_APNS_KEY_FILE',
      'SYNQ_APNS_KEY_ID',
      'SYNQ_APNS_TEAM_ID',
      'SYNQ_APNS_TOPIC',
    ].filter((k) => !e[k]);
    return { e, missing };
  }

  private loadKey() {
    if (this.key !== undefined) return this.key;
    try {
      const read =
        this.options.readKey ?? ((p: string) => readFileSync(p, 'utf8'));
      this.key = createPrivateKey(read(String(this.env.SYNQ_APNS_KEY_FILE)));
    } catch {
      this.key = null;
    }
    return this.key;
  }

  capability(): { status: 'AVAILABLE' | 'NOT_CONFIGURED'; reason: string } {
    const { missing } = this.config();
    if (missing.length)
      return {
        status: 'NOT_CONFIGURED',
        reason: `Push is not configured: ${missing.join(', ')} not set.`,
      };
    if (!this.loadKey())
      return {
        status: 'NOT_CONFIGURED',
        reason: 'Push is not configured: the APNs key file cannot be read.',
      };
    return {
      status: 'AVAILABLE',
      reason: 'APNs token-based delivery; payloads carry only a generic title.',
    };
  }

  private token() {
    const now = (this.options.now ?? (() => Math.floor(Date.now() / 1000)))();
    // APNs rejects tokens older than an hour and frequent refreshes.
    if (this.jwt && now - this.jwt.at < 40 * 60) return this.jwt.value;
    const head = b64(
      JSON.stringify({ alg: 'ES256', kid: this.env.SYNQ_APNS_KEY_ID }),
    );
    const claims = b64(
      JSON.stringify({ iss: this.env.SYNQ_APNS_TEAM_ID, iat: now }),
    );
    const sig = sign('sha256', Buffer.from(`${head}.${claims}`), {
      key: this.loadKey()!,
      dsaEncoding: 'ieee-p1363',
    });
    const value = `${head}.${claims}.${b64(sig)}`;
    this.jwt = { value, at: now };
    return value;
  }

  async send(
    device: { token: string; environment: 'SANDBOX' | 'PRODUCTION' },
    message: { title: string; category: string; eventId: string },
  ) {
    if (this.capability().status !== 'AVAILABLE')
      throw new Error('APNS_NOT_CONFIGURED');
    const body = JSON.stringify({
      aps: {
        alert: { title: message.title },
        category: message.category,
        'mutable-content': 0,
      },
      eventId: message.eventId,
    });
    return (this.options.transport ?? http2Transport)({
      host: APNS_HOSTS[device.environment],
      path: `/3/device/${device.token}`,
      headers: {
        authorization: `bearer ${this.token()}`,
        'apns-topic': String(this.env.SYNQ_APNS_TOPIC),
        'apns-push-type': 'alert',
        'apns-priority': '10',
        'content-type': 'application/json',
      },
      body,
    });
  }
}
