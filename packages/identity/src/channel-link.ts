import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { IdentityError } from './errors.js';
import { canonicalJson } from './providers/common.js';

/**
 * Authenticated channel ↔ wallet linking.
 *
 * A chat identity (Telegram user, iMessage handle, WhatsApp number) is a
 * lower-trust binding than a wallet. It is linked to a wallet only when both
 * sides prove themselves inside one challenge:
 *
 *  1. the channel side presents the platform's own cryptographic proof
 *     (Telegram Login / Mini App HMAC, checked by an injected verifier), which
 *     yields the platform's stable user id, never a username. Each proof is
 *     accepted once, so a captured login payload cannot be replayed;
 *  2. the bot then delivers a one-time code privately to that user id (an
 *     injected `deliverCode`, e.g. a Telegram DM). Completing the link needs
 *     that code, so holding someone's login payload is not enough;
 *  3. the wallet signs an EIP-712 `ChannelLink` challenge naming exactly that
 *     channel user id, workspace, wallet, a one-use nonce and a short expiry.
 *
 * Handles are display-only: they are not accepted as a channel user id, never
 * looked up, and never decide a binding. Unlinking is possible with either the
 * bound wallet's signature or a fresh channel proof plus a delivered code, so a
 * user who lost the wallet can still detach their chat identity. A chat
 * message alone never links or unlinks. The store enforces one active link per
 * channel id and per wallet atomically.
 */

export const LINK_CHANNELS = ['telegram', 'imessage', 'whatsapp'] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];
export type LinkPurpose = 'LINK' | 'UNLINK';
/** Who authorises the challenge: the wallet (signature) or the channel (proof + code). */
export type LinkAuthority = 'WALLET' | 'CHANNEL';

/** Stable platform user ids. Telegram ids are numeric; a `@handle` never matches. */
const CHANNEL_USER_ID: Record<LinkChannel, RegExp> = {
  telegram: /^[1-9][0-9]{0,19}$/,
  imessage: /^(\+[1-9][0-9]{5,14}|[a-z0-9._%+-]{1,64}@[a-z0-9.-]{1,190})$/,
  whatsapp: /^[1-9][0-9]{5,14}$/,
};
const WORKSPACE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;
const MAX_CODE_ATTEMPTS = 3;

/**
 * Verifies a channel's own proof of the acting user (for Telegram, the Login
 * widget or Mini App HMAC keyed by the bot token) and returns the platform's
 * stable user id, or null. The handle it may return is untrusted display text.
 */
export type ChannelProofVerifier = (
  proof: unknown,
  now: number,
) => { channelUserId: string; displayHandle?: string } | null;

/** Delivers a one-time code privately to the platform user (e.g. bot DM). */
export type ChannelCodeSender = (input: {
  channel: LinkChannel;
  channelUserId: string;
  workspaceId: string;
  challengeId: string;
  purpose: LinkPurpose;
  code: string;
}) => Promise<void>;

export type ChannelLinkChallenge = Readonly<{
  challengeId: string;
  purpose: LinkPurpose;
  authority: LinkAuthority;
  workspaceId: string;
  channel: LinkChannel;
  channelUserId: string;
  wallet: Address;
  statement: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  /** Display only; never used for lookup. */
  displayHandle: string | null;
}>;

export type StoredChannelChallenge = {
  challenge: ChannelLinkChallenge;
  /** sha256 of the delivered code (bound to the challenge id), or null when none is needed. */
  codeHash: Hex | null;
  failedAttempts: number;
  consumedAt: number | null;
};

export type ChannelLinkRecord = Readonly<{
  linkId: string;
  workspaceId: string;
  channel: LinkChannel;
  channelUserId: string;
  wallet: Address;
  displayHandle: string | null;
  linkChallengeId: string;
  linkSignature: Hex;
  linkedAt: number;
  unlinkedAt: number | null;
  unlinkedBy: LinkAuthority | null;
  unlinkSignature: Hex | null;
}>;

export const CHANNEL_LINK_DOMAIN = {
  name: 'Synq Channel Link',
  version: '1',
} as const;
export const CHANNEL_LINK_TYPES = {
  ChannelLink: [
    { name: 'purpose', type: 'string' },
    { name: 'statement', type: 'string' },
    { name: 'challengeId', type: 'string' },
    { name: 'workspaceId', type: 'string' },
    { name: 'channel', type: 'string' },
    { name: 'channelUserId', type: 'string' },
    { name: 'wallet', type: 'address' },
    { name: 'nonce', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint64' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const;

export function channelLinkTypedData(c: ChannelLinkChallenge) {
  return {
    domain: CHANNEL_LINK_DOMAIN,
    types: CHANNEL_LINK_TYPES,
    primaryType: 'ChannelLink' as const,
    message: {
      purpose: c.purpose,
      statement: c.statement,
      challengeId: c.challengeId,
      workspaceId: c.workspaceId,
      channel: c.channel,
      channelUserId: c.channelUserId,
      wallet: c.wallet,
      nonce: c.nonce,
      issuedAt: BigInt(c.issuedAt),
      expiresAt: BigInt(c.expiresAt),
    },
  };
}

export type InsertLinkResult = 'OK' | 'CHANNEL_LINKED' | 'WALLET_LINKED';

export interface ChannelLinkStore {
  insertChallenge(stored: StoredChannelChallenge): Promise<void>;
  getChallenge(id: string): Promise<StoredChannelChallenge | null>;
  /** Increments and returns the failed code attempts. */
  recordFailedCode(id: string): Promise<number>;
  /** Atomically marks the challenge used; false when it already was. */
  consumeChallenge(id: string, now: number): Promise<boolean>;
  /** An unconsumed, unexpired challenge of this purpose for the channel id. */
  pendingChallenge(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
    purpose: LinkPurpose,
    now: number,
  ): Promise<ChannelLinkChallenge | null>;
  /** Atomically records a channel proof as used; false on replay. */
  consumeProof(proofHash: Hex, now: number): Promise<boolean>;
  activeByChannel(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
  ): Promise<ChannelLinkRecord | null>;
  activeByWallet(
    workspaceId: string,
    channel: LinkChannel,
    wallet: Address,
  ): Promise<ChannelLinkRecord | null>;
  /**
   * Inserts atomically under two unique constraints: one active link per
   * (workspace, channel, channelUserId) and per (workspace, channel, wallet).
   */
  insertLink(record: ChannelLinkRecord): Promise<InsertLinkResult>;
  /** Ends an active link; false when it was not active. */
  endLink(
    linkId: string,
    now: number,
    by: LinkAuthority,
    signature: Hex | null,
  ): Promise<boolean>;
  listLinks(workspaceId: string): Promise<ChannelLinkRecord[]>;
}

/** In-memory store; each method body is synchronous, so check-and-write is atomic. */
export class MemoryChannelLinkStore implements ChannelLinkStore {
  private challenges = new Map<string, StoredChannelChallenge>();
  private proofs = new Map<Hex, number>();
  private links: ChannelLinkRecord[] = [];
  async insertChallenge(stored: StoredChannelChallenge) {
    if (this.challenges.has(stored.challenge.challengeId))
      throw new IdentityError('CHALLENGE_MISMATCH', 'duplicate challenge id');
    this.challenges.set(stored.challenge.challengeId, { ...stored });
  }
  async getChallenge(id: string) {
    const s = this.challenges.get(id);
    return s ? { ...s } : null;
  }
  async recordFailedCode(id: string) {
    const s = this.challenges.get(id);
    if (!s) return MAX_CODE_ATTEMPTS;
    s.failedAttempts += 1;
    return s.failedAttempts;
  }
  async consumeChallenge(id: string, now: number) {
    const s = this.challenges.get(id);
    if (!s || s.consumedAt !== null) return false;
    s.consumedAt = now;
    return true;
  }
  async pendingChallenge(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
    purpose: LinkPurpose,
    now: number,
  ) {
    for (const s of this.challenges.values()) {
      const c = s.challenge;
      if (
        s.consumedAt === null &&
        now < c.expiresAt &&
        c.purpose === purpose &&
        c.workspaceId === workspaceId &&
        c.channel === channel &&
        c.channelUserId === channelUserId
      )
        return c;
    }
    return null;
  }
  async consumeProof(proofHash: Hex, now: number) {
    if (this.proofs.has(proofHash)) return false;
    this.proofs.set(proofHash, now);
    return true;
  }
  private active(
    workspaceId: string,
    channel: LinkChannel,
    match: (l: ChannelLinkRecord) => boolean,
  ) {
    return (
      this.links.find(
        (l) =>
          l.unlinkedAt === null &&
          l.workspaceId === workspaceId &&
          l.channel === channel &&
          match(l),
      ) ?? null
    );
  }
  async activeByChannel(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
  ) {
    return this.active(
      workspaceId,
      channel,
      (l) => l.channelUserId === channelUserId,
    );
  }
  async activeByWallet(
    workspaceId: string,
    channel: LinkChannel,
    wallet: Address,
  ) {
    return this.active(workspaceId, channel, (l) => l.wallet === wallet);
  }
  async insertLink(record: ChannelLinkRecord): Promise<InsertLinkResult> {
    const { workspaceId, channel } = record;
    if (
      this.active(
        workspaceId,
        channel,
        (l) => l.channelUserId === record.channelUserId,
      )
    )
      return 'CHANNEL_LINKED';
    if (this.active(workspaceId, channel, (l) => l.wallet === record.wallet))
      return 'WALLET_LINKED';
    this.links.push(record);
    return 'OK';
  }
  async endLink(
    linkId: string,
    now: number,
    by: LinkAuthority,
    signature: Hex | null,
  ) {
    const i = this.links.findIndex(
      (l) => l.linkId === linkId && l.unlinkedAt === null,
    );
    if (i < 0) return false;
    this.links[i] = {
      ...this.links[i]!,
      unlinkedAt: now,
      unlinkedBy: by,
      unlinkSignature: signature,
    };
    return true;
  }
  async listLinks(workspaceId: string) {
    return this.links.filter((l) => l.workspaceId === workspaceId);
  }
}

export type ChannelLinkConfig = {
  verifiers: Partial<Record<LinkChannel, ChannelProofVerifier>>;
  deliverCode: ChannelCodeSender;
  challengeTtlSeconds?: number;
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => Hex;
  randomCode?: () => string;
};

function parseChannel(channel: unknown): LinkChannel {
  if (!LINK_CHANNELS.includes(channel as LinkChannel))
    throw new IdentityError('INVALID_INPUT', 'channel');
  return channel as LinkChannel;
}
/** Rejects handles and display names: only the platform's stable id is an identity. */
export function parseChannelUserId(channel: LinkChannel, id: unknown): string {
  const canonical =
    typeof id === 'string'
      ? channel === 'imessage'
        ? id.trim().toLowerCase()
        : id.trim()
      : null;
  if (canonical === null || !CHANNEL_USER_ID[channel].test(canonical))
    throw new IdentityError(
      'INVALID_INPUT',
      `${channel} user id must be the platform's stable id, not a handle`,
    );
  return canonical;
}
function parseWallet(wallet: unknown): Address {
  if (typeof wallet !== 'string' || !isAddress(wallet, { strict: false }))
    throw new IdentityError('INVALID_INPUT', 'wallet');
  return getAddress(wallet);
}
function parseWorkspace(workspaceId: unknown): string {
  if (typeof workspaceId !== 'string' || !WORKSPACE_ID.test(workspaceId))
    throw new IdentityError('INVALID_INPUT', 'workspaceId');
  return workspaceId;
}
const displayHandle = (h: unknown): string | null =>
  typeof h === 'string' && /^@?[A-Za-z0-9_]{1,64}$/.test(h)
    ? h.replace(/^@/, '')
    : null;
const sha256 = (s: string): Hex =>
  `0x${createHash('sha256').update(s).digest('hex')}`;
const codeHashOf = (challengeId: string, code: string) =>
  sha256(`${challengeId}:${code}`);

export class ChannelLinkService {
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomNonce: () => Hex;
  private readonly randomCode: () => string;
  constructor(
    readonly store: ChannelLinkStore,
    private readonly config: ChannelLinkConfig,
  ) {
    const ttl = config.challengeTtlSeconds ?? 300;
    if (!Number.isSafeInteger(ttl) || ttl < 10 || ttl > 900)
      throw new IdentityError('INVALID_INPUT', 'challenge ttl');
    this.ttl = ttl;
    this.now = config.now ?? (() => Math.floor(Date.now() / 1000));
    this.randomId =
      config.randomId ?? (() => `lnk_${randomBytes(16).toString('hex')}`);
    this.randomNonce =
      config.randomNonce ?? (() => `0x${randomBytes(32).toString('hex')}`);
    this.randomCode =
      config.randomCode ??
      (() => String(randomInt(0, 100_000_000)).padStart(8, '0'));
  }

  /** Verifies the channel's own proof and consumes it, so it cannot be replayed. */
  private async consumeChannelProof(channel: LinkChannel, proof: unknown) {
    const verifier = this.config.verifiers[channel];
    if (!verifier)
      throw new IdentityError('UNAUTHORIZED', `no ${channel} proof verifier`);
    let proven: ReturnType<ChannelProofVerifier>;
    try {
      proven = verifier(proof, this.now());
    } catch {
      proven = null;
    }
    if (!proven)
      throw new IdentityError('UNAUTHORIZED', 'channel proof invalid');
    const channelUserId = parseChannelUserId(channel, proven.channelUserId);
    let proofHash: Hex;
    try {
      proofHash = sha256(`${channel}:${canonicalJson(proof)}`);
    } catch {
      throw new IdentityError('UNAUTHORIZED', 'channel proof invalid');
    }
    if (!(await this.store.consumeProof(proofHash, this.now())))
      throw new IdentityError('UNAUTHORIZED', 'channel proof already used');
    return {
      channelUserId,
      displayHandle: displayHandle(proven.displayHandle),
    };
  }

  private async issue(input: {
    purpose: LinkPurpose;
    authority: LinkAuthority;
    workspaceId: string;
    channel: LinkChannel;
    channelUserId: string;
    wallet: Address;
    displayHandle: string | null;
    withCode: boolean;
  }): Promise<ChannelLinkChallenge> {
    const now = this.now();
    if (
      await this.store.pendingChallenge(
        input.workspaceId,
        input.channel,
        input.channelUserId,
        input.purpose,
        now,
      )
    )
      throw new IdentityError(
        'RATE_LIMITED',
        'a challenge for this channel user is already pending',
      );
    const { withCode, ...fields } = input;
    const verb = input.purpose === 'LINK' ? 'Link' : 'Unlink';
    const challenge: ChannelLinkChallenge = Object.freeze({
      ...fields,
      challengeId: this.randomId(),
      statement: `${verb} ${input.channel} user ${input.channelUserId} ${input.purpose === 'LINK' ? 'to' : 'from'} wallet ${input.wallet} in workspace ${input.workspaceId}. Linking grants no spending authority.`,
      nonce: this.randomNonce(),
      issuedAt: now,
      expiresAt: now + this.ttl,
    });
    const code = withCode ? this.randomCode() : null;
    await this.store.insertChallenge({
      challenge,
      codeHash: code ? codeHashOf(challenge.challengeId, code) : null,
      failedAttempts: 0,
      consumedAt: null,
    });
    if (code)
      await this.config.deliverCode({
        channel: challenge.channel,
        channelUserId: challenge.channelUserId,
        workspaceId: challenge.workspaceId,
        challengeId: challenge.challengeId,
        purpose: challenge.purpose,
        code,
      });
    return challenge;
  }

  /**
   * Step 1 of linking: the channel proves the acting user (proof consumed);
   * a one-time code is delivered privately to that user id; the response is
   * the challenge the wallet must sign. Nothing is bound yet.
   */
  async requestLink(input: {
    workspaceId: string;
    channel: LinkChannel;
    channelProof: unknown;
    wallet: string;
  }): Promise<ChannelLinkChallenge> {
    const workspaceId = parseWorkspace(input.workspaceId);
    const channel = parseChannel(input.channel);
    const wallet = parseWallet(input.wallet);
    const proven = await this.consumeChannelProof(channel, input.channelProof);
    if (
      await this.store.activeByChannel(
        workspaceId,
        channel,
        proven.channelUserId,
      )
    )
      throw new IdentityError(
        'PRINCIPAL_EXISTS',
        'channel user already linked',
      );
    if (await this.store.activeByWallet(workspaceId, channel, wallet))
      throw new IdentityError('PRINCIPAL_EXISTS', 'wallet already linked');
    return this.issue({
      purpose: 'LINK',
      authority: 'WALLET',
      workspaceId,
      channel,
      channelUserId: proven.channelUserId,
      wallet,
      displayHandle: proven.displayHandle,
      withCode: true,
    });
  }

  private async load(
    challengeId: string,
    purpose: LinkPurpose,
    authority: LinkAuthority,
    now: number,
  ): Promise<StoredChannelChallenge> {
    const stored = await this.store.getChallenge(challengeId);
    if (
      !stored ||
      stored.challenge.purpose !== purpose ||
      stored.challenge.authority !== authority
    )
      throw new IdentityError('CHALLENGE_NOT_FOUND');
    if (stored.consumedAt !== null)
      throw new IdentityError('CHALLENGE_CONSUMED');
    if (now >= stored.challenge.expiresAt || now < stored.challenge.issuedAt)
      throw new IdentityError('CHALLENGE_EXPIRED');
    return stored;
  }

  /** The delivered code proves the channel user saw this exact challenge. */
  private async checkCode(stored: StoredChannelChallenge, code: unknown) {
    const id = stored.challenge.challengeId;
    if (!stored.codeHash) throw new IdentityError('CHALLENGE_MISMATCH', 'code');
    const given = Buffer.from(
      codeHashOf(id, typeof code === 'string' ? code : '').slice(2),
      'hex',
    );
    const expected = Buffer.from(stored.codeHash.slice(2), 'hex');
    if (timingSafeEqual(given, expected)) return;
    if ((await this.store.recordFailedCode(id)) >= MAX_CODE_ATTEMPTS)
      await this.store.consumeChallenge(id, this.now());
    throw new IdentityError(
      'CHALLENGE_MISMATCH',
      'channel code does not match the code delivered to this user',
    );
  }

  private async checkSignature(
    c: ChannelLinkChallenge,
    rawSignature: unknown,
  ): Promise<Hex> {
    if (
      typeof rawSignature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(rawSignature)
    )
      throw new IdentityError('SIGNATURE_MISMATCH', 'not a wallet signature');
    const signature = rawSignature as Hex;
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({
        ...channelLinkTypedData(c),
        signature,
      });
    } catch {
      throw new IdentityError('SIGNATURE_MISMATCH');
    }
    if (getAddress(recovered) !== c.wallet)
      throw new IdentityError('SIGNATURE_MISMATCH');
    return signature;
  }

  /**
   * Step 2: the code delivered to the channel user plus the wallet's signature
   * over the exact challenge create the binding, atomically.
   */
  async completeLink(input: {
    challengeId: string;
    channelCode: string;
    signature: string;
  }): Promise<ChannelLinkRecord> {
    const now = this.now();
    const stored = await this.load(input.challengeId, 'LINK', 'WALLET', now);
    await this.checkCode(stored, input.channelCode);
    const c = stored.challenge;
    const signature = await this.checkSignature(c, input.signature);
    if (!(await this.store.consumeChallenge(c.challengeId, now)))
      throw new IdentityError('CHALLENGE_CONSUMED');
    const record: ChannelLinkRecord = Object.freeze({
      linkId: `${c.workspaceId}/${c.channel}/${c.channelUserId}/${c.challengeId}`,
      workspaceId: c.workspaceId,
      channel: c.channel,
      channelUserId: c.channelUserId,
      wallet: c.wallet,
      displayHandle: c.displayHandle,
      linkChallengeId: c.challengeId,
      linkSignature: signature,
      linkedAt: now,
      unlinkedAt: null,
      unlinkedBy: null,
      unlinkSignature: null,
    });
    const result = await this.store.insertLink(record);
    if (result !== 'OK')
      throw new IdentityError(
        'PRINCIPAL_EXISTS',
        result === 'CHANNEL_LINKED'
          ? 'channel user already linked'
          : 'wallet already linked',
      );
    return record;
  }

  /**
   * Wallet-authorised unlink of a bound channel id. One pending request per
   * link at a time, so the endpoint cannot be used to flood challenges.
   */
  async requestUnlink(input: {
    workspaceId: string;
    channel: LinkChannel;
    channelUserId: string;
  }): Promise<ChannelLinkChallenge> {
    const workspaceId = parseWorkspace(input.workspaceId);
    const channel = parseChannel(input.channel);
    const channelUserId = parseChannelUserId(channel, input.channelUserId);
    const link = await this.store.activeByChannel(
      workspaceId,
      channel,
      channelUserId,
    );
    if (!link) throw new IdentityError('PRINCIPAL_NOT_FOUND', 'no active link');
    return this.issue({
      purpose: 'UNLINK',
      authority: 'WALLET',
      workspaceId,
      channel,
      channelUserId,
      wallet: link.wallet,
      displayHandle: link.displayHandle,
      withCode: false,
    });
  }

  async completeUnlink(input: {
    challengeId: string;
    signature: string;
  }): Promise<ChannelLinkRecord> {
    const now = this.now();
    const stored = await this.load(input.challengeId, 'UNLINK', 'WALLET', now);
    const c = stored.challenge;
    const signature = await this.checkSignature(c, input.signature);
    return this.end(c, now, 'WALLET', signature);
  }

  /**
   * Channel-authorised unlink: the user proves their own channel id with a
   * fresh proof, and confirms with the code delivered privately to it. This
   * works without the wallet, so a user can always detach their chat identity.
   */
  async requestChannelUnlink(input: {
    workspaceId: string;
    channel: LinkChannel;
    channelProof: unknown;
  }): Promise<ChannelLinkChallenge> {
    const workspaceId = parseWorkspace(input.workspaceId);
    const channel = parseChannel(input.channel);
    const proven = await this.consumeChannelProof(channel, input.channelProof);
    const link = await this.store.activeByChannel(
      workspaceId,
      channel,
      proven.channelUserId,
    );
    if (!link) throw new IdentityError('PRINCIPAL_NOT_FOUND', 'no active link');
    return this.issue({
      purpose: 'UNLINK',
      authority: 'CHANNEL',
      workspaceId,
      channel,
      channelUserId: proven.channelUserId,
      wallet: link.wallet,
      displayHandle: link.displayHandle,
      withCode: true,
    });
  }

  async completeChannelUnlink(input: {
    challengeId: string;
    channelCode: string;
  }): Promise<ChannelLinkRecord> {
    const now = this.now();
    const stored = await this.load(input.challengeId, 'UNLINK', 'CHANNEL', now);
    await this.checkCode(stored, input.channelCode);
    return this.end(stored.challenge, now, 'CHANNEL', null);
  }

  private async end(
    c: ChannelLinkChallenge,
    now: number,
    by: LinkAuthority,
    signature: Hex | null,
  ): Promise<ChannelLinkRecord> {
    if (!(await this.store.consumeChallenge(c.challengeId, now)))
      throw new IdentityError('CHALLENGE_CONSUMED');
    const link = await this.store.activeByChannel(
      c.workspaceId,
      c.channel,
      c.channelUserId,
    );
    if (
      !link ||
      link.wallet !== c.wallet ||
      !(await this.store.endLink(link.linkId, now, by, signature))
    )
      throw new IdentityError('CHALLENGE_MISMATCH', 'link changed');
    return {
      ...link,
      unlinkedAt: now,
      unlinkedBy: by,
      unlinkSignature: signature,
    };
  }

  /** Resolves only by the platform's stable id; a handle is rejected, not searched. */
  async resolve(input: {
    workspaceId: string;
    channel: LinkChannel;
    channelUserId: string;
  }): Promise<Address | null> {
    const channel = parseChannel(input.channel);
    const link = await this.store.activeByChannel(
      parseWorkspace(input.workspaceId),
      channel,
      parseChannelUserId(channel, input.channelUserId),
    );
    return link?.wallet ?? null;
  }
}
