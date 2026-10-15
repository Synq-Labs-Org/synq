import { randomBytes } from 'node:crypto';
import {
  getAddress,
  isAddress,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from 'viem';
import { IdentityError } from './errors.js';

/**
 * Authenticated channel ↔ wallet linking.
 *
 * A chat identity (Telegram user, iMessage handle, WhatsApp number) is a
 * lower-trust binding than a wallet. It is linked to a wallet only when both
 * sides prove themselves in one flow:
 *
 *  1. the channel side presents the platform's own cryptographic proof
 *     (Telegram Login / Mini App HMAC, verified by an injected verifier) which
 *     yields the platform's stable user id — never a username or display name;
 *  2. the wallet signs an EIP-712 `ChannelLink` challenge naming exactly that
 *     channel user id, workspace, wallet, a one-use nonce and a short expiry.
 *
 * Handles are display-only: they are not accepted as a channel user id, never
 * looked up, and never part of what decides a binding. A copied `@handle`
 * therefore cannot bind or resolve to someone else's wallet. Unlinking needs a
 * fresh signature from the bound wallet; a chat message never unlinks.
 */

export const LINK_CHANNELS = ['telegram', 'imessage', 'whatsapp'] as const;
export type LinkChannel = (typeof LINK_CHANNELS)[number];
export type LinkPurpose = 'LINK' | 'UNLINK';

/** Stable platform user ids. Telegram ids are numeric; a `@handle` never matches. */
const CHANNEL_USER_ID: Record<LinkChannel, RegExp> = {
  telegram: /^[0-9]{1,20}$/,
  imessage: /^(\+[0-9]{6,15}|[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,190})$/,
  whatsapp: /^[0-9]{6,15}$/,
};
const WORKSPACE_ID = /^[A-Za-z0-9_:.-]{1,128}$/;

/**
 * Verifies a channel's own proof of the acting user (for Telegram, the Login
 * widget or Mini App HMAC keyed by the bot token) and returns the platform's
 * stable user id, or null. The handle it may return is untrusted display text.
 */
export type ChannelProofVerifier = (
  proof: unknown,
  now: number,
) => { channelUserId: string; displayHandle?: string } | null;

export type ChannelLinkChallenge = Readonly<{
  challengeId: string;
  purpose: LinkPurpose;
  workspaceId: string;
  channel: LinkChannel;
  channelUserId: string;
  wallet: Address;
  statement: string;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
  /** Display only; not signed as identity and never used for lookup. */
  displayHandle: string | null;
}>;

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

export interface ChannelLinkStore {
  insertChallenge(challenge: ChannelLinkChallenge): Promise<void>;
  getChallenge(id: string): Promise<{
    challenge: ChannelLinkChallenge;
    consumedAt: number | null;
  } | null>;
  /** Atomically marks the challenge used; false when it already was. */
  consumeChallenge(id: string, now: number): Promise<boolean>;
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
  insertLink(record: ChannelLinkRecord): Promise<void>;
  endLink(linkId: string, now: number, signature: Hex): Promise<void>;
  listLinks(workspaceId: string): Promise<ChannelLinkRecord[]>;
}

export class MemoryChannelLinkStore implements ChannelLinkStore {
  private challenges = new Map<
    string,
    { challenge: ChannelLinkChallenge; consumedAt: number | null }
  >();
  private links: ChannelLinkRecord[] = [];
  async insertChallenge(challenge: ChannelLinkChallenge) {
    if (this.challenges.has(challenge.challengeId))
      throw new IdentityError('CHALLENGE_MISMATCH', 'duplicate challenge id');
    this.challenges.set(challenge.challengeId, { challenge, consumedAt: null });
  }
  async getChallenge(id: string) {
    return this.challenges.get(id) ?? null;
  }
  async consumeChallenge(id: string, now: number) {
    const entry = this.challenges.get(id);
    if (!entry || entry.consumedAt !== null) return false;
    entry.consumedAt = now;
    return true;
  }
  async activeByChannel(
    workspaceId: string,
    channel: LinkChannel,
    channelUserId: string,
  ) {
    return (
      this.links.find(
        (l) =>
          l.unlinkedAt === null &&
          l.workspaceId === workspaceId &&
          l.channel === channel &&
          l.channelUserId === channelUserId,
      ) ?? null
    );
  }
  async activeByWallet(
    workspaceId: string,
    channel: LinkChannel,
    wallet: Address,
  ) {
    return (
      this.links.find(
        (l) =>
          l.unlinkedAt === null &&
          l.workspaceId === workspaceId &&
          l.channel === channel &&
          l.wallet === wallet,
      ) ?? null
    );
  }
  async insertLink(record: ChannelLinkRecord) {
    this.links.push(record);
  }
  async endLink(linkId: string, now: number, signature: Hex) {
    this.links = this.links.map((l) =>
      l.linkId === linkId && l.unlinkedAt === null
        ? { ...l, unlinkedAt: now, unlinkSignature: signature }
        : l,
    );
  }
  async listLinks(workspaceId: string) {
    return this.links.filter((l) => l.workspaceId === workspaceId);
  }
}

export type ChannelLinkConfig = {
  verifiers: Partial<Record<LinkChannel, ChannelProofVerifier>>;
  challengeTtlSeconds?: number;
  now?: () => number;
  randomId?: () => string;
  randomNonce?: () => Hex;
};

function parseChannel(channel: unknown): LinkChannel {
  if (!LINK_CHANNELS.includes(channel as LinkChannel))
    throw new IdentityError('INVALID_INPUT', 'channel');
  return channel as LinkChannel;
}
/** Rejects handles and display names: only the platform's stable id is an identity. */
export function parseChannelUserId(channel: LinkChannel, id: unknown): string {
  if (typeof id !== 'string' || !CHANNEL_USER_ID[channel].test(id))
    throw new IdentityError(
      'INVALID_INPUT',
      `${channel} user id must be the platform's stable id, not a handle`,
    );
  return id;
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

export class ChannelLinkService {
  private readonly ttl: number;
  private readonly now: () => number;
  private readonly randomId: () => string;
  private readonly randomNonce: () => Hex;
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
  }

  private verifyChannelProof(channel: LinkChannel, proof: unknown) {
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
    return {
      channelUserId: parseChannelUserId(channel, proven.channelUserId),
      displayHandle: displayHandle(proven.displayHandle),
    };
  }

  private challenge(input: {
    purpose: LinkPurpose;
    workspaceId: string;
    channel: LinkChannel;
    channelUserId: string;
    wallet: Address;
    displayHandle: string | null;
  }): ChannelLinkChallenge {
    const now = this.now();
    const verb = input.purpose === 'LINK' ? 'Link' : 'Unlink';
    return Object.freeze({
      ...input,
      challengeId: this.randomId(),
      statement: `${verb} ${input.channel} user ${input.channelUserId} ${input.purpose === 'LINK' ? 'to' : 'from'} wallet ${input.wallet} in workspace ${input.workspaceId}. Linking grants no spending authority.`,
      nonce: this.randomNonce(),
      issuedAt: now,
      expiresAt: now + this.ttl,
    });
  }

  /**
   * Step 1 of linking: the channel proves the acting user; the response is a
   * challenge the wallet must sign. Nothing is bound yet.
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
    const proven = this.verifyChannelProof(channel, input.channelProof);
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
    const challenge = this.challenge({
      purpose: 'LINK',
      workspaceId,
      channel,
      channelUserId: proven.channelUserId,
      wallet,
      displayHandle: proven.displayHandle,
    });
    await this.store.insertChallenge(challenge);
    return challenge;
  }

  private async redeem(
    challengeId: string,
    purpose: LinkPurpose,
    rawSignature: unknown,
  ): Promise<{ challenge: ChannelLinkChallenge; signature: Hex; now: number }> {
    const now = this.now();
    const stored = await this.store.getChallenge(challengeId);
    if (!stored || stored.challenge.purpose !== purpose)
      throw new IdentityError('CHALLENGE_NOT_FOUND');
    if (stored.consumedAt !== null)
      throw new IdentityError('CHALLENGE_CONSUMED');
    if (now >= stored.challenge.expiresAt || now < stored.challenge.issuedAt)
      throw new IdentityError('CHALLENGE_EXPIRED');
    if (
      typeof rawSignature !== 'string' ||
      !/^0x[0-9a-fA-F]{130}$/.test(rawSignature)
    )
      throw new IdentityError('SIGNATURE_MISMATCH', 'not a wallet signature');
    const signature = rawSignature as Hex;
    let recovered: Address;
    try {
      recovered = await recoverTypedDataAddress({
        ...channelLinkTypedData(stored.challenge),
        signature,
      });
    } catch {
      throw new IdentityError('SIGNATURE_MISMATCH');
    }
    if (getAddress(recovered) !== stored.challenge.wallet)
      throw new IdentityError('SIGNATURE_MISMATCH');
    if (!(await this.store.consumeChallenge(challengeId, now)))
      throw new IdentityError('CHALLENGE_CONSUMED');
    return { challenge: stored.challenge, signature, now };
  }

  /** Step 2: the wallet's signature over the exact challenge creates the binding. */
  async completeLink(input: {
    challengeId: string;
    signature: string;
  }): Promise<ChannelLinkRecord> {
    const {
      challenge: c,
      signature,
      now,
    } = await this.redeem(input.challengeId, 'LINK', input.signature);
    if (
      await this.store.activeByChannel(
        c.workspaceId,
        c.channel,
        c.channelUserId,
      )
    )
      throw new IdentityError(
        'PRINCIPAL_EXISTS',
        'channel user already linked',
      );
    if (await this.store.activeByWallet(c.workspaceId, c.channel, c.wallet))
      throw new IdentityError('PRINCIPAL_EXISTS', 'wallet already linked');
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
      unlinkSignature: null,
    });
    await this.store.insertLink(record);
    return record;
  }

  /** Unlinking is requested for a bound channel id and must be signed by the bound wallet. */
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
    const challenge = this.challenge({
      purpose: 'UNLINK',
      workspaceId,
      channel,
      channelUserId,
      wallet: link.wallet,
      displayHandle: link.displayHandle,
    });
    await this.store.insertChallenge(challenge);
    return challenge;
  }

  async completeUnlink(input: {
    challengeId: string;
    signature: string;
  }): Promise<ChannelLinkRecord> {
    const {
      challenge: c,
      signature,
      now,
    } = await this.redeem(input.challengeId, 'UNLINK', input.signature);
    const link = await this.store.activeByChannel(
      c.workspaceId,
      c.channel,
      c.channelUserId,
    );
    if (!link || link.wallet !== c.wallet)
      throw new IdentityError('CHALLENGE_MISMATCH', 'link changed');
    await this.store.endLink(link.linkId, now, signature);
    return { ...link, unlinkedAt: now, unlinkSignature: signature };
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
