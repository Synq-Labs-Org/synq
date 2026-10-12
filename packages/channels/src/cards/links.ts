import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Card links carry only proposalId + groupId + a short-lived nonce. The nonce
 * is an HMAC over (group, proposal, action, expiry, randomness) under a
 * server-held key: it proves Synq issued the link for that group and
 * proposal and nothing else. It is not an approval and grants no authority;
 * the page it opens still authenticates the member and asks for a passkey
 * signature over the canonical proposal.
 */
export type CardLinkAction = 'REVIEW' | 'VIEW';
export type CardLinkCheck =
  | { ok: true; action: CardLinkAction; expiresAt: number }
  | { ok: false; code: 'LINK_MALFORMED' | 'LINK_EXPIRED' | 'LINK_INVALID' };

const ACTION_CODE: Record<CardLinkAction, string> = { REVIEW: 'r', VIEW: 'v' };
const NONCE =
  /^v1\.([rv])\.([0-9a-z]{1,10})\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})$/;
export const CARD_PROPOSAL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/;

export class CardLinkIssuer {
  private readonly key: Buffer;
  constructor(
    private readonly options: {
      /** At least 32 bytes; from SYNQ_CARD_LINK_KEY. */
      key: string | Buffer;
      webBaseUrl: string;
      now: () => number;
      ttlSeconds?: number;
      approvePath?: string;
    },
  ) {
    this.key = Buffer.isBuffer(options.key)
      ? options.key
      : Buffer.from(options.key, 'utf8');
    if (this.key.length < 32) throw new Error('CARD_LINK_KEY_TOO_SHORT');
    if (!/^https?:\/\//.test(options.webBaseUrl))
      throw new Error('CARD_LINK_WEB_BASE_URL_INVALID');
  }

  static fromEnv(
    env: Readonly<Record<string, string | undefined>>,
    webBaseUrl: string,
    now: () => number,
  ): CardLinkIssuer | null {
    const key = env.SYNQ_CARD_LINK_KEY ?? '';
    return key.length >= 32
      ? new CardLinkIssuer({
          key,
          webBaseUrl,
          now,
          ...(env.SYNQ_CARD_LINK_TTL_SECONDS
            ? { ttlSeconds: Number(env.SYNQ_CARD_LINK_TTL_SECONDS) }
            : {}),
        })
      : null;
  }

  private mac(
    groupId: string,
    proposalId: string,
    action: string,
    exp: string,
    rand: string,
  ) {
    return createHmac('sha256', this.key)
      .update(
        [
          'synq-card-link:v1',
          groupId.toLowerCase(),
          proposalId,
          action,
          exp,
          rand,
        ].join('|'),
      )
      .digest()
      .subarray(0, 16);
  }

  nonce(input: {
    groupId: string;
    proposalId: string;
    action?: CardLinkAction;
  }): string {
    if (!CARD_PROPOSAL_ID.test(input.proposalId))
      throw new Error('CARD_PROPOSAL_ID_INVALID');
    const action = ACTION_CODE[input.action ?? 'REVIEW'];
    const exp = (
      this.options.now() + (this.options.ttlSeconds ?? 12 * 3600)
    ).toString(36);
    const rand = randomBytes(12).toString('base64url');
    const mac = this.mac(
      input.groupId,
      input.proposalId,
      action,
      exp,
      rand,
    ).toString('base64url');
    return `v1.${action}.${exp}.${rand}.${mac}`;
  }

  url(input: {
    groupId: string;
    proposalId: string;
    action?: CardLinkAction;
  }): string {
    const q = new URLSearchParams({
      p: input.proposalId,
      g: input.groupId,
      n: this.nonce(input),
    });
    return `${this.options.webBaseUrl.replace(/\/$/, '')}${this.options.approvePath ?? '/approve'}?${q}`;
  }

  verify(input: {
    groupId: string;
    proposalId: string;
    nonce: string;
  }): CardLinkCheck {
    const m = NONCE.exec(input.nonce);
    if (!m || !CARD_PROPOSAL_ID.test(input.proposalId))
      return { ok: false, code: 'LINK_MALFORMED' };
    const [, action, exp, rand, mac] = m;
    const expected = this.mac(
      input.groupId,
      input.proposalId,
      action!,
      exp!,
      rand!,
    );
    const given = Buffer.from(mac!, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected))
      return { ok: false, code: 'LINK_INVALID' };
    const expiresAt = parseInt(exp!, 36);
    if (!(expiresAt > this.options.now()))
      return { ok: false, code: 'LINK_EXPIRED' };
    return { ok: true, action: action === 'r' ? 'REVIEW' : 'VIEW', expiresAt };
  }
}
